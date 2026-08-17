/**
 * Zenn 向け NoteRenderer(design.md §5.7 サービス別差分の表「Zenn」行、FR-23/FR-24、
 * T-17 / issue #22)。
 *
 * GitRepoPublisher(`src/publishers/git-repo.ts`、T-16)は Zenn / Hugo / Jekyll に共通する
 * Git リポジトリ出力(ブランチ作成・ファイル書き込み・コミット・PR 作成)のみを担い、
 * サービス固有のファイルパス・frontmatter は関知しない(同ファイル冒頭 JSDoc)。本モジュールは
 * その「サービス固有」部分——Zenn の slug/type/emoji/topics 規約とファイルパス——を、
 * `src/publishers/render.ts` の `NoteRenderer` 契約に沿う形で埋める。
 *
 * design.md §5.7 Zenn 行:
 * `articles/<uuid小文字>.md` / `title`・`emoji`・`type`・`topics`・`published: true` /
 * 「slug = UUID 小文字化(FR-23)。`type` はフォルダ名。`tech`/`idea` 以外のフォルダ名なら
 * 設定不正としてそのノートを失敗扱い(FR-24)。絵文字が無いノートは既定値 `📝`」。
 *
 * **`type` 不正エラーはレンダリング段で投げ、`prepare()` では投げない**: `src/sync.ts` の
 * `processNote` は `renderNote(...)` 呼び出しを独立した `try/catch` で囲んでおり、ここで
 * 投げた例外は当該ノートのみを `'failed'` に変換し、他ノートの処理は継続する(NFR-06)。
 * 逆に `Publisher.prepare()`(ブランチ作成)で例外を投げると `runSync` が実行全体を
 * `runAborted` として打ち切ってしまう(`src/sync.ts` の `runLockedSync` 参照)ため、
 * 型検証はここ(Renderer)でのみ行う——CodeRabbit issue plan(issue #22 コメント)の
 * Phase 1 Task 2 と同じ結論。
 *
 * **topics の変換規約(design.md §5.7 Zenn 行、issue #76)**: `Note#tags` は先頭 `#` を
 * 含めたまま保持される(design.md §5.3「差分」節、FR-07「そのまま」)。Zenn 公式ガイド
 * (https://zenn.dev/zenn/articles/zenn-cli-guide、issue #76 のコメントに原文引用あり)は
 * `topics` の個数上限を最大5個と明記するが、文字種については明記が無い(issue #76 の
 * CodeRabbit issue plan Design Choice 1)。したがって `resolveZennTopics` は
 * `src/publishers/qiita.ts` の `resolveQiitaTags` と同じ処理順で
 * (1) 先頭の `#` を1つ除去 → (2) 除去後に空になったタグを警告して除外 →
 * (3) 半角スペースを含むタグを警告して除外 → (4) 除外後6個以上なら先頭5個へ切り詰めて警告、
 * の4段階のサニタイズのみを行い、文字種のさらなる検証(強制)は行わない(利用者のタグを
 * 予期せず失わせないため。design.md §5.7 に根拠を記録)。**Qiita と異なりサニタイズ後
 * 0個になっても失敗にしない**——Zenn は `topics` の省略・空配列を許容するため、そのまま
 * 空配列 `[]` を返す(issue #76 CodeRabbit issue plan Design Choice 2)。
 * 重複除去は `completeNoteMetadata`(`src/transform/metadata.ts`)が `#` 付きの値に対して
 * 既に行っているため、ここでの再重複除去は行わない(CodeRabbit issue plan 同フェーズ
 * Task 1「重複除去は Note.tags で適用済みのため、追加の変換は最小限にする」)。
 */

import type { Logger } from '../logger.js';
import type { RenderNoteInput, NoteRenderer } from './render.js';
import type { RenderedArticle } from './types.js';
import {
  computeContentHash,
  renderArtifact,
  ZENN_FRONTMATTER_KEY_ORDER,
  type FrontmatterEntry,
} from '../transform/frontmatter.js';

// ---------------------------------------------------------------------------
// エラー型。
// ---------------------------------------------------------------------------

/** Zenn が許可する `type`(design.md §5.7、FR-24)。 */
const ZENN_ALLOWED_TYPES = ['tech', 'idea'] as const;
type ZennType = (typeof ZENN_ALLOWED_TYPES)[number];

/**
 * ノートのフォルダ名が Zenn の `type` として許可された値(`tech`/`idea`)以外だったことを
 * 表す(design.md §5.7「`tech`/`idea` 以外のフォルダ名なら設定不正としてそのノートを
 * 失敗扱い」、FR-24)。`src/sync.ts` の `processNote` がこの例外を捕捉し、当該ノートのみ
 * `'failed'` として隔離する(他ノートは継続。NFR-06)。
 */
export class InvalidZennTypeError extends Error {
  /** 検証に失敗したノートの UUID(ログでどのノートかを特定するため)。 */
  readonly noteUuid: string;
  /** 実際のフォルダ名(許可値でなかったもの)。 */
  readonly folder: string;

  constructor(noteUuid: string, folder: string) {
    super(
      `Zenn requires a note's folder to be exactly "tech" or "idea" to use as \`type\` ` +
        `(design.md §5.7, FR-24); note "${noteUuid}" has folder ${JSON.stringify(folder)}`,
    );
    this.name = 'InvalidZennTypeError';
    this.noteUuid = noteUuid;
    this.folder = folder;
  }
}

/** Zenn の slug 制約(design.md §5.7・FR-23):`a-z0-9`・ハイフン・アンダースコアの12〜50字。 */
const ZENN_SLUG_PATTERN = /^[a-z0-9_-]{12,50}$/;

/**
 * UUID を小文字化した slug が Zenn の制約(`ZENN_SLUG_PATTERN`)を満たさなかったことを表す。
 * Apple Notes の UUID は通常36文字(ハイフン込み)で常にこの制約を満たすはずだが
 * (FR-23 の注記どおり)、想定外の `uuid` 値(空文字・極端に短い/長い値等)に備えた
 * 防御的な検証として、満たさない場合はノートを失敗扱いにする
 * (`InvalidZennTypeError` と同様、レンダリング段で投げ `src/sync.ts` の per-note 隔離に乗せる)。
 */
export class InvalidZennSlugError extends Error {
  /** 検証に失敗したノートの UUID。 */
  readonly noteUuid: string;
  /** 制約を満たさなかった slug(UUID 小文字化後の値)。 */
  readonly slug: string;

  constructor(noteUuid: string, slug: string) {
    super(
      `Zenn slug must match ${ZENN_SLUG_PATTERN.source} (12-50 chars of a-z0-9/hyphen/underscore, ` +
        `design.md §5.7, FR-23); derived slug ${JSON.stringify(slug)} for note "${noteUuid}" does not`,
    );
    this.name = 'InvalidZennSlugError';
    this.noteUuid = noteUuid;
    this.slug = slug;
  }
}

// ---------------------------------------------------------------------------
// フィールド導出。
// ---------------------------------------------------------------------------

/** ノートに絵文字が無い場合の既定値(design.md §5.7「Zenn は emoji 必須のため」)。 */
const ZENN_DEFAULT_EMOJI = '📝';

/** Zenn のファイルパスは `output_dir` 設定に関わらず常にこの固定ディレクトリ(design.md §7「zenn は articles 固定」)。 */
const ZENN_ARTICLES_DIR = 'articles';

/** `note.folder` を Zenn の `type` として検証する(FR-24)。不正なら `InvalidZennTypeError`。 */
function resolveZennType(noteUuid: string, folder: string): ZennType {
  if ((ZENN_ALLOWED_TYPES as readonly string[]).includes(folder)) {
    return folder as ZennType;
  }
  throw new InvalidZennTypeError(noteUuid, folder);
}

/** `note.uuid` を小文字化して slug を求め、Zenn の制約を検証する(FR-23)。 */
function resolveZennSlug(noteUuid: string): string {
  const slug = noteUuid.toLowerCase();
  if (!ZENN_SLUG_PATTERN.test(slug)) {
    throw new InvalidZennSlugError(noteUuid, slug);
  }
  return slug;
}

/**
 * タグ先頭の `#` を1つだけ除去する(モジュール冒頭 JSDoc「topics の変換規約」参照)。
 * `#` を持たない値はそのまま返す(防御的。`Note#tags` の情報源である JSON `hashtags` は
 * 常に `#` 付きだが、型としては保証されないため)。`src/publishers/qiita.ts` の同名関数と
 * 同じ規約をミラーする(重複実装。既存の Qiita 側もローカル定義のままであり、これに揃える)。
 */
function stripLeadingHash(tag: string): string {
  return tag.startsWith('#') ? tag.slice(1) : tag;
}

/** Zenn 公式ガイドが明記する `topics` の個数上限(モジュール冒頭 JSDoc「topics の変換規約」)。 */
const ZENN_MAX_TOPICS = 5;

/** `resolveZennTopics` のパラメータ(`src/publishers/qiita.ts` の `ResolveQiitaTagsParams` と同形)。 */
interface ResolveZennTopicsParams {
  noteUuid: string;
  title: string;
  tags: readonly string[];
  logger: Logger | undefined;
}

/**
 * モジュール冒頭 JSDoc「topics の変換規約」の4段階を順に適用する(`resolveQiitaTags`
 * (`src/publishers/qiita.ts`)を参照実装とする。処理順序: 先頭 `#` 除去 → 空タグ除外(警告)
 * → 半角スペース含みタグ除外(警告) → 6個以上なら先頭5個へ切り詰め(警告)。Qiita と異なり
 * サニタイズ後0個になっても例外を投げず、空配列 `[]` をそのまま返す(Zenn は `topics` の
 * 省略・空配列を許容するため)。警告は `service`/`noteUuid`/`title` を伴う `logger.warn`
 * イベントとして発行する(`src/logger.ts` `WarnPayload`)。`logger` 未注入時は no-op。
 */
function resolveZennTopics(params: ResolveZennTopicsParams): string[] {
  const { noteUuid, title, tags, logger } = params;
  const stripped = tags.map(stripLeadingHash);

  // `#` 除去後に空文字列となったタグ(元が `#` のみ等)は Zenn の topics として成立しないため、
  // スペース含みタグと同様に除外して警告する。
  const empty = stripped.filter((tag) => tag.length === 0);
  if (empty.length > 0) {
    logger?.warn({
      service: 'zenn',
      noteUuid,
      title,
      message:
        `dropped ${String(empty.length)} topic(s) that became empty after stripping the ` +
        'leading "#" (design.md §5.7)',
    });
  }
  const nonEmpty = stripped.filter((tag) => tag.length > 0);

  const spaced = nonEmpty.filter((tag) => tag.includes(' '));
  let remaining = nonEmpty.filter((tag) => !tag.includes(' '));
  if (spaced.length > 0) {
    logger?.warn({
      service: 'zenn',
      noteUuid,
      title,
      message:
        `dropped ${String(spaced.length)} topic(s) containing a half-width space ` +
        `(Zenn rejects topics with spaces, design.md §5.7): ${spaced.map((tag) => JSON.stringify(tag)).join(', ')}`,
    });
  }

  if (remaining.length > ZENN_MAX_TOPICS) {
    const kept = remaining.slice(0, ZENN_MAX_TOPICS);
    logger?.warn({
      service: 'zenn',
      noteUuid,
      title,
      message:
        `truncated topics from ${String(remaining.length)} to Zenn's limit of ` +
        `${String(ZENN_MAX_TOPICS)} (design.md §5.7): kept ${kept.map((tag) => JSON.stringify(tag)).join(', ')}`,
    });
    remaining = kept;
  }

  // Qiita の `resolveQiitaTags` と異なり、0個になっても例外を投げない(design.md §5.7、
  // issue #76 CodeRabbit issue plan Design Choice 2「Zenn は topics 未指定を許容する」)。
  return remaining;
}

/**
 * grapheme cluster 単位の分割器(`src/transform/metadata.ts` の `graphemeSegmenter` と
 * 同じ設定)。`resolveZennEmoji` の防御的チェック専用。
 */
const zennEmojiSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * `note.emoji` を Zenn の `emoji` frontmatter 値として確定する(design.md §5.7「絵文字が
 * 無いノートは既定値 `📝`」)。`note.emoji` が `null` なら既定値。非 `null` の場合、
 * `splitTitleAndEmoji`(`src/transform/metadata.ts`)が単一 grapheme cluster であることを
 * 既に保証しているため、本来は素通しでよい。ここでの `Intl.Segmenter` によるセグメント数
 * 確認は**あくまで防御的**なもの(issue #76 CodeRabbit issue plan Phase 2 Task 1)——万一
 * 何らかの経路で複数 grapheme(例 '😸😸')や非絵文字文字列(例 'ab')が紛れ込んでも、
 * Zenn が要求する「絵文字1文字だけ」に違反したまま出力してしまわないよう、例外を投げずに
 * 既定値へフォールバックする。
 */
function resolveZennEmoji(emoji: string | null): string {
  if (emoji === null) {
    return ZENN_DEFAULT_EMOJI;
  }
  const segments = [...zennEmojiSegmenter.segment(emoji)];
  if (segments.length !== 1) {
    return ZENN_DEFAULT_EMOJI;
  }
  return emoji;
}

// ---------------------------------------------------------------------------
// Renderer 本体。
// ---------------------------------------------------------------------------

/**
 * Zenn 向け `NoteRenderer`(design.md §5.7 Zenn 行、FR-23/FR-24)。`config` は参照しない
 * ——Zenn のファイルパスは `git.output_dir` 設定に関わらず常に `articles/` 固定
 * (design.md §7「zenn は articles 固定」)であり、frontmatter の内容も `Note` のみから
 * 決まるため。
 *
 * frontmatter のキー順は `ZENN_FRONTMATTER_KEY_ORDER`(`src/transform/frontmatter.ts`。
 * `title`/`emoji`/`type`/`topics`/`published`)のとおり組み立てる。
 */
export const renderZennArticle: NoteRenderer = ({
  note,
  markdown,
  logger,
}: RenderNoteInput): RenderedArticle => {
  const type = resolveZennType(note.uuid, note.folder);
  const slug = resolveZennSlug(note.uuid);
  const emoji = resolveZennEmoji(note.emoji);
  const topics = resolveZennTopics({
    noteUuid: note.uuid,
    title: note.title,
    tags: note.tags,
    logger,
  });

  // ZENN_FRONTMATTER_KEY_ORDER の並び(title/emoji/type/topics/published)どおりに組み立てる。
  const entries: FrontmatterEntry[] = [
    [ZENN_FRONTMATTER_KEY_ORDER[0], note.title],
    [ZENN_FRONTMATTER_KEY_ORDER[1], emoji],
    [ZENN_FRONTMATTER_KEY_ORDER[2], type],
    [ZENN_FRONTMATTER_KEY_ORDER[3], topics],
    [ZENN_FRONTMATTER_KEY_ORDER[4], true],
  ];

  const artifact = renderArtifact(entries, markdown);
  const contentHash = computeContentHash(artifact);
  const artifactPath = `${ZENN_ARTICLES_DIR}/${slug}.md`;

  return { noteUuid: note.uuid, title: note.title, artifact, contentHash, artifactPath };
};
