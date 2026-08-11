/**
 * メタデータ抽出層(design.md §5.3「Note モデルとメタデータ抽出」、T-10)。
 *
 * Exporter(`src/exporter/apple-notes.ts`、T-09)が返す `Note` の骨格は、`uuid` /
 * `folder` / `createdAt` / `updatedAt` / `bodyHtml` / `attachments` に加え、
 * `tags`(JSON `hashtags` フィールドをそのまま = 文字列配列。design.md §5.3 の
 * 「差分」節を参照)まで埋まっている。`title` / `emoji` の2つだけが未確定のまま
 * (`''` / `null`)残っており、本モジュールの `completeNoteMetadata` がそれを埋めて
 * 完成した `Note` を返す。
 *
 * **タグの情報源についての決定(design.md §5.3 の更新を踏まえる)**: `tags` は
 * 本文 HTML の正規表現走査では取得しない。parser の JSON `hashtags` を唯一の
 * 情報源とし、Exporter がその配列をそのまま `Note#tags` に詰める(本モジュールでは
 * 順序を保った重複排除のみ行う)。値は先頭の `#` を含めたまま保持する
 * ——FR-07「ノート内のハッシュタグを**そのまま**タグとして扱う」の文言どおり、
 * JSON `hashtags` が返す文字列(例 `"#planning"`)を加工せずに使うのが最も素直な
 * 解釈であり、design.md §5.7 のサービス別 frontmatter 表にも `#` を外すという
 * 規約の記載は無いため。サービス固有のタグ整形(文字数・個数制約、`#` の要否等)は
 * 各 Publisher(§5.7、T-15 以降)の責務とする。
 *
 * **ハッシュタグのみで構成される行の除去可否判定**については、引き続き本文 HTML
 * 側のテキスト解析が必要(design.md §5.3)。本モジュールは判定(`findHashtagOnlyLineIndexes`)
 * のみを提供し、実際に本文からその行を取り除く処理(BodyTransformer、T-11)は行わない。
 */

import { extractLines, firstLine } from './html.js';
import type { Note } from '../model/note.js';

// ---------------------------------------------------------------------------
// エラー型。
// ---------------------------------------------------------------------------

/**
 * bodyHtml からメタデータ(1行目)を導出できなかったことを表すエラー。
 * 本文が空、またはテキストを一切含まない(装飾要素のみ等)場合にのみ投げる。
 */
export class MetadataExtractionError extends Error {
  /** 抽出に失敗したノートの UUID(FR-09)。ログ出力時にどのノートかを特定するために持つ。 */
  readonly noteUuid: string;

  constructor(message: string, noteUuid: string) {
    super(message);
    this.name = 'MetadataExtractionError';
    this.noteUuid = noteUuid;
  }
}

// ---------------------------------------------------------------------------
// タイトル・絵文字抽出(design.md §5.3「絵文字判定」、FR-04/FR-05)。
// ---------------------------------------------------------------------------

/** `\p{Extended_Pictographic}` にマッチする grapheme cluster を絵文字として扱う(design.md §5.3)。 */
const EXTENDED_PICTOGRAPHIC_PATTERN = /\p{Extended_Pictographic}/u;

/**
 * 国旗絵文字(Regional Indicator のペア。例 🇯🇵)。RI 記号は
 * `\p{Extended_Pictographic}` に含まれないため個別に判定する。
 */
const REGIONAL_INDICATOR_PAIR_PATTERN = /^\p{Regional_Indicator}{2}$/u;

/**
 * キーキャップ絵文字(例 #️⃣・1️⃣)。ベース文字(`#` `*` `0-9`)+ 任意の VS16(U+FE0F)+
 * COMBINING ENCLOSING KEYCAP(U+20E3)の並び。ベース文字自体は
 * `\p{Extended_Pictographic}` に含まれないため個別に判定する。単独の `#`
 * (例 "#planning" の先頭)は U+20E3 を伴わないためマッチしない。
 */
const KEYCAP_SEQUENCE_PATTERN = /^[0-9#*]\u{FE0F}?\u{20E3}$/u;

/** 先頭 grapheme cluster が絵文字かどうか(FR-05。上記3パターンのいずれか)。 */
function isEmojiCluster(cluster: string): boolean {
  return (
    EXTENDED_PICTOGRAPHIC_PATTERN.test(cluster) ||
    REGIONAL_INDICATOR_PAIR_PATTERN.test(cluster) ||
    KEYCAP_SEQUENCE_PATTERN.test(cluster)
  );
}

/**
 * grapheme cluster 単位の分割器。ZWJ で連結された絵文字(例 👨‍👩‍👧‍👦)や
 * 肌色修飾子付きの絵文字も、Unicode の拡張書記素クラスタ規則により1クラスタとして
 * 扱われる(`Intl.Segmenter` の仕様どおり。ロケール非依存)。
 */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** `extractTitleAndEmoji` / `splitTitleAndEmoji` の戻り値。 */
export interface TitleAndEmoji {
  /** 絵文字を除去した(絵文字が無ければそのままの)タイトル(FR-04)。 */
  title: string;
  /** 1行目先頭の grapheme(絵文字の場合のみ)。絵文字でなければ `null`(FR-05)。 */
  emoji: string | null;
}

/**
 * 1行分のテキスト(`html.ts` の `firstLine`/`extractLines` が返すもの)から
 * タイトルと絵文字を分離する(design.md §5.3・FR-04/FR-05)。
 *
 * 先頭 grapheme cluster を取得し、`\p{Extended_Pictographic}` にマッチする場合、
 * または国旗(RI ペア)・キーキャップ列の場合のみ絵文字として扱う。
 * 絵文字だった場合、タイトルは先頭 grapheme と直後の空白を
 * 除去した残り。空文字列を渡した場合は `{ title: '', emoji: null }` を返す
 * (呼び出し側で「行が取得できない」ことのハンドリングは別途行う。下記
 * `completeNoteMetadata` を参照)。
 */
export function splitTitleAndEmoji(line: string): TitleAndEmoji {
  const firstSegment = graphemeSegmenter.segment(line)[Symbol.iterator]().next();
  if (firstSegment.done) {
    return { title: line, emoji: null };
  }

  const cluster = firstSegment.value.segment;
  if (!isEmojiCluster(cluster)) {
    return { title: line, emoji: null };
  }

  const rest = line.slice(cluster.length);
  const title = rest.replace(/^\s+/, '');
  return { title, emoji: cluster };
}

// ---------------------------------------------------------------------------
// ハッシュタグのみで構成される行の識別(design.md §5.3「ハッシュタグ」)。
// ---------------------------------------------------------------------------

/** 1トークンのハッシュタグ形式(`#` + 1文字以上の文字・数字・アンダースコア)。 */
const HASHTAG_TOKEN_PATTERN = /^#[\p{L}\p{N}_]+$/u;

/**
 * 1行がハッシュタグのみ(空白区切りで1個以上のハッシュタグが並ぶだけ)で
 * 構成されているかどうかを判定する。文中に現れるハッシュタグ(他のテキストと
 * 混在する行)は対象外(design.md §5.3「文中に現れるタグは本文に残す」)。
 * 空行(トリム後に空文字)は対象外とする。
 */
export function isHashtagOnlyLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') {
    return false;
  }
  return trimmed.split(/\s+/u).every((token) => HASHTAG_TOKEN_PATTERN.test(token));
}

/**
 * bodyHtml を `html.ts` の `extractLines` で行に分解し、ハッシュタグのみで
 * 構成される行の索引(`extractLines` が返す配列でのインデックス)を集合として返す。
 * 実際に本文からその行を取り除くのは BodyTransformer(design.md §5.4、T-11)の
 * 責務であり、ここでは判定のみを行う。
 */
export function findHashtagOnlyLineIndexes(bodyHtml: string): Set<number> {
  const indexes = new Set<number>();
  extractLines(bodyHtml).forEach((line, index) => {
    if (isHashtagOnlyLine(line)) {
      indexes.add(index);
    }
  });
  return indexes;
}

// ---------------------------------------------------------------------------
// タグの正規化(design.md §5.3「差分」節。JSON `hashtags` を情報源とする)。
// ---------------------------------------------------------------------------

/**
 * 順序を保ったまま重複を除去する。JSON `hashtags` は本文中の同じタグを複数回
 * 含みうる(例: 文中に1回・タグ置き場の行にもう1回)ため、Exporter(T-09)・
 * 本モジュールの双方から使えるよう公開する。
 */
export function dedupeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    if (!seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// エントリ関数。
// ---------------------------------------------------------------------------

/**
 * `Note` の骨格(Exporter が埋めた `tags` はそのまま、`title` は `''`、
 * `emoji` は `null`)を受け取り、`bodyHtml` の1行目からタイトル・絵文字を導出して
 * 埋めた新しい `Note` を返す(design.md §5.3、FR-04/FR-05)。`tags` は
 * `dedupeTags` で正規化するのみで、値の情報源は変更しない。
 *
 * `bodyHtml` から1行目すら取得できない(空・装飾要素のみでテキストが無い)場合は
 * `MetadataExtractionError` を投げる。それ以外の入力(絵文字の有無、ハッシュタグの
 * 有無)ではエラーにしない。
 */
export function completeNoteMetadata(note: Note): Note {
  const line = firstLine(note.bodyHtml);
  if (line === '') {
    throw new MetadataExtractionError(
      `could not derive a first line from bodyHtml for note "${note.uuid}" (empty or textless HTML)`,
      note.uuid,
    );
  }

  const { title, emoji } = splitTitleAndEmoji(line);
  return { ...note, title, emoji, tags: dedupeTags(note.tags) };
}
