/**
 * 決定的な frontmatter YAML serializer とコンテンツハッシュ(design.md §5.6
 * 「Renderer と冪等判定」、FR-15、T-12 / issue #17)。
 *
 * `yaml` パッケージ等の既定 `stringify` はキー並べ替え・引用符ヒューリスティック
 * (文字列の内容によって引用の要否・スタイルを変える)を持ち、ライブラリの
 * バージョンや値の内容によって同じ論理的入力でも直列化結果が変わりうる。
 * これは「変換後の Markdown + frontmatter のコンテンツハッシュのみで再配信要否を
 * 判定する」(FR-15)という冪等性の前提を壊すため、本モジュールは YAML の暗黙の
 * 型付け・スタイル選択に一切依存しない自前の serializer を持つ。
 *
 * **直列化の正規化規約(design.md §5.6)**:
 * - 文字列値は内容にかかわらず常に JSON 互換のダブルクォート + エスケープで出力する。
 *   `null` のように見える文字列("null")、数値のように見える文字列("123")、
 *   日時のように見える文字列、`:` `#` を含む文字列も、YAML の暗黙型変換を経由せず
 *   常に文字列として一意に復元できる形にする。
 * - 非文字列のスカラ値は真偽値・整数のみを許可し、クォートなしで出力する
 *   (`FrontmatterValue` の型で非許可の値———浮動小数点等———を排除する)。
 * - 配列はフロー表記(`["a","b"]`)で決定的に出力する(design.md §5.7 のサービス別表
 *   自体が `categories: [フォルダ名]` のようにフロー表記で frontmatter 形状を示している)。
 * - キー順は呼び出し側(§5.7 のサービス別表に従う各 Publisher の Renderer。T-17〜T-21)が
 *   決める。本 serializer はエントリの並びをそのまま出力するのみで、並べ替えは行わない
 *   ——キー順が仕様で厳密に規定される以上、順序を型・値として明示できる
 *   `[key, value]` の順序付きエントリ配列を入力形式として採用した
 *   (`Record` の挿入順に暗黙で依存しないため)。
 *
 * **§5.7 サービス別 frontmatter キー順(参考情報)**: 実際に `Note` からこれらの
 * エントリ配列を組み立てる Renderer は T-17〜T-21 の各 Publisher の責務であり、本
 * モジュールの範囲外(T-12 は §5.6 の直列化・ハッシュ規約のみを担う)。ここでは
 * design.md §5.7 の表に記載された順序を後続タスクが参照する定数としてのみ持つ。
 */

import { createHash } from 'node:crypto';
import { normalizeText } from './normalize.js';

// ---------------------------------------------------------------------------
// 値の型。
// ---------------------------------------------------------------------------

/**
 * frontmatter に許可するスカラ値。文字列・真偽値・整数・`null` のみ
 * (design.md §5.6「非文字列型は真偽値・整数のみ許可」)。`null` は YAML の
 * `null` トークンとして無クォートで出力される(例: Qiita の `id: null`、§5.7)。
 * 文字列としての `"null"` とは型レベルで区別される。
 *
 * 整数以外の `number`(浮動小数点・`NaN`・`Infinity`)は型では排除しきれないため、
 * `serializeScalar` が実行時に検証して拒否する。
 */
export type FrontmatterScalar = string | boolean | number | null;

/** スカラ値、またはスカラ値の配列(design.md §5.7 の `topics` / `tags` / `categories` 等)。 */
export type FrontmatterValue = FrontmatterScalar | readonly FrontmatterScalar[];

/**
 * 順序付きの frontmatter エントリ。キー順がそのまま出力順になる
 * (`serializeFrontmatter` は並べ替えを行わない)。
 */
export type FrontmatterEntry = readonly [key: string, value: FrontmatterValue];

// ---------------------------------------------------------------------------
// スカラ直列化。
// ---------------------------------------------------------------------------

function assertFrontmatterInteger(value: number): void {
  if (!Number.isInteger(value)) {
    throw new RangeError(
      `frontmatter: number values must be integers (got ${String(value)}); ` +
        'floating-point values are not part of the allowed FrontmatterValue types',
    );
  }
}

/**
 * 文字列値を JSON 互換のダブルクォート文字列として直列化する
 * (design.md §5.6「文字列値は内容にかかわらず常に JSON 互換のダブルクォート + エスケープ」)。
 * `JSON.stringify` のエスケープ(`\"` `\\` `\n` `\r` `\t` 制御文字の `\u00XX` 化等)は
 * YAML のダブルクォートスタイルのエスケープの厳密なサブセットであり、そのまま
 * 有効な YAML 二重引用符スカラとして解釈できる。値は出力前に `normalizeText` で
 * 改行 LF・Unicode NFC に正規化する(design.md §5.6)。
 */
function serializeStringScalar(value: string): string {
  return JSON.stringify(normalizeText(value));
}

/**
 * frontmatter のスカラ値を一意に復元可能な YAML トークン列へ直列化する
 * (design.md §5.6)。YAML の暗黙の型付け(プレーンスカラの型推論)には一切依存しない:
 * - 文字列: 内容によらず常にダブルクォート(`serializeStringScalar`)
 * - 真偽値: `true` / `false`(無クォート)
 * - 整数: 10進表記(無クォート)。整数以外の `number` は例外を投げる
 * - `null`: `null`(無クォート)
 */
export function serializeFrontmatterScalar(value: FrontmatterScalar): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    assertFrontmatterInteger(value);
    return String(value);
  }
  return serializeStringScalar(value);
}

/**
 * frontmatter の配列値をフロー表記(`["a","b"]`、区切りはカンマのみ・空白なし)で
 * 直列化する。ブロック表記(`- a`)ではなくフロー表記を採用したのは、design.md §5.7
 * のサービス別表自体が `categories: [フォルダ名]` のようにフロー表記で frontmatter の
 * 形状を示しており、それに合わせるのが最も直接的なためである。各要素は
 * `serializeFrontmatterScalar` で直列化する(要素も文字列は常にダブルクォート)。
 */
export function serializeFrontmatterArray(values: readonly FrontmatterScalar[]): string {
  return `[${values.map((item) => serializeFrontmatterScalar(item)).join(',')}]`;
}

function serializeFrontmatterValue(value: FrontmatterValue): string {
  if (Array.isArray(value)) {
    return serializeFrontmatterArray(value);
  }
  return serializeFrontmatterScalar(value as FrontmatterScalar);
}

// ---------------------------------------------------------------------------
// frontmatter ブロック全体の直列化。
// ---------------------------------------------------------------------------

/**
 * frontmatter キーとして安全な文字集合。design.md §5.7 の全キー(`title` /
 * `emoji` / `published_at` 等)は ASCII の英数字とアンダースコアのみで構成される。
 * 改行・引用符・`:` 等を含むキーは YAML の構造を壊しうるため、クォートで守るの
 * ではなく検証で拒否する(キーは呼び出し側=Renderer が §5.7 の定数から渡す前提で、
 * 動的な値が来ること自体が誤用であるため)。
 */
const SAFE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 1エントリを `key: value` の1行(末尾改行なし)に直列化する。キーは NFC 正規化し、安全な文字集合のみ許可する。 */
export function serializeFrontmatterEntry(entry: FrontmatterEntry): string {
  const [rawKey, value] = entry;
  const key = rawKey.normalize('NFC');
  if (!SAFE_KEY_PATTERN.test(key)) {
    throw new RangeError(
      `frontmatter key must match ${SAFE_KEY_PATTERN.source} (got ${JSON.stringify(rawKey)})`,
    );
  }
  return `${key}: ${serializeFrontmatterValue(value)}`;
}

/**
 * 順序付きエントリ配列から、先頭・末尾の `---` 区切りを含む frontmatter ブロック
 * 文字列(末尾は改行付きの `---\n`)を生成する(design.md §5.6)。エントリの並びは
 * そのまま出力順になり、キーの並べ替えは行わない——キー順の決定(design.md §5.7 の
 * サービス別表に従う)は呼び出し側(各 Publisher の Renderer)の責務である。
 */
export function serializeFrontmatter(entries: readonly FrontmatterEntry[]): string {
  // NFC 正規化後のキーで重複を検出する(重複キーの YAML は読み手により解釈が
  // 割れるため、黙って後勝ち・両方出力にはせず誤用として拒否する)。
  const seenKeys = new Set<string>();
  const lines = entries
    .map((entry) => {
      const normalizedKey = entry[0].normalize('NFC');
      if (seenKeys.has(normalizedKey)) {
        throw new RangeError(`duplicate frontmatter key: ${JSON.stringify(normalizedKey)}`);
      }
      seenKeys.add(normalizedKey);
      return `${serializeFrontmatterEntry(entry)}\n`;
    })
    .join('');
  return `---\n${lines}---\n`;
}

// ---------------------------------------------------------------------------
// 最終成果物の連結とコンテンツハッシュ。
// ---------------------------------------------------------------------------

/**
 * frontmatter ブロックと変換済み Markdown 本文を連結し、最終成果物の文字列を
 * 組み立てる(design.md §5.6)。frontmatter ブロックの直後に空行を1つ挟んで本文を
 * 続ける(`---\n<entries>---\n\n<body>`)、Zenn / Hugo / Jekyll 等が読む Markdown +
 * frontmatter ファイルの一般的な形。
 *
 * 連結後に `normalizeText`(LF 統一・NFC 正規化)を最終適用する。frontmatter 側の
 * 文字列値・配列要素は `serializeFrontmatterScalar` の時点で既に正規化済みだが、
 * 本文側(呼び出し側から渡される変換済み Markdown)に CRLF や NFD が残っていた
 * 場合の安全網として、連結後の全体にもう一度正規化をかける(冪等な操作のため
 * 二重適用しても結果は変わらない)。
 *
 * **重要**: frontmatter エントリに実行時刻など毎回変わる値を含めてはならない
 * (含めるとコンテンツハッシュが実行ごとに変わり、FR-15 の冪等判定が壊れる)。
 * 日時を含める場合は、ノートの作成 / 更新日時を `formatTimestamp`
 * (`./normalize.js` 経由で re-export、設定 `timezone` の固定オフセット)で
 * 整形した文字列のみを渡すこと。
 */
export function renderArtifact(entries: readonly FrontmatterEntry[], body: string): string {
  const frontmatter = serializeFrontmatter(entries);
  return normalizeText(`${frontmatter}\n${body}`);
}

/**
 * 最終成果物の文字列(`renderArtifact` の戻り値)に対する SHA-256 コンテンツハッシュを
 * 計算する(design.md §5.6・§8、FR-15)。UTF-8 バイト列としてハッシュし、
 * `sha256:` + 小文字 hex の形式で返す(`src/state/store.ts` の `NoteState.contentHash`
 * / `AssetState` のキー表記(§8 の例 `"sha256:ab12…"`)と揃える)。
 *
 * ノートの更新日時は判定に使わない(FR-15)——この関数はハッシュ計算のみを担い、
 * 「何をハッシュ対象の文字列に含めるか」(実行時刻を含めない等)は `renderArtifact`
 * 呼び出し側の責務である。
 */
export function computeContentHash(artifact: string): string {
  const digest = createHash('sha256').update(artifact, 'utf8').digest('hex');
  return `sha256:${digest}`;
}

// ---------------------------------------------------------------------------
// §5.7 サービス別 frontmatter キー順(参考定数。実際の Renderer 実装は T-17〜T-21)。
// ---------------------------------------------------------------------------

/** Zenn の frontmatter キー順(design.md §5.7)。`type` はフォルダ名、絵文字未設定時は既定 `📝`。 */
export const ZENN_FRONTMATTER_KEY_ORDER = [
  'title',
  'emoji',
  'type',
  'topics',
  'published',
] as const;

/** Hugo の frontmatter キー順(design.md §5.7)。`categories` はフォルダ名の単一要素配列。 */
export const HUGO_FRONTMATTER_KEY_ORDER = [
  'title',
  'date',
  'lastmod',
  'categories',
  'tags',
] as const;

/** Jekyll の frontmatter キー順(design.md §5.7)。`date` は作成日。 */
export const JEKYLL_FRONTMATTER_KEY_ORDER = ['title', 'date', 'categories', 'tags'] as const;

/**
 * Qiita の frontmatter キー順(design.md §5.7)。`id` は初回 `null`、以後 qiita-cli が書き戻す値。
 * `slide` は当初の想定(`title`/`tags`/`private`/`id` の4項目)には無かったが、T-21(§13-3)の
 * 調査で qiita-cli の frontmatter 型チェック(`dist/lib/check-frontmatter-type.js`
 * `checkSlide`)が `slide` を真偽値として必須にしていると判明したため追加した
 * (`src/publishers/qiita.ts` 冒頭 JSDoc 参照)。
 */
export const QIITA_FRONTMATTER_KEY_ORDER = ['title', 'tags', 'private', 'slide', 'id'] as const;

/**
 * note.com(`noet`)の frontmatter キー順(design.md §5.7 NotePublisher 節、§13-4、T-25)。
 * `noet` の `parse_markdown_file` が実際に読むキーは `title`/`tags`/`header_image` の3つ
 * のみ(§13-4)で、本タスク(T-25)の範囲では見出し画像(`header_image`)を扱わないため
 * `title`/`tags` の2キーのみとする(`src/publishers/note.ts` 冒頭 JSDoc「frontmatter」参照)。
 */
export const NOTE_FRONTMATTER_KEY_ORDER = ['title', 'tags'] as const;
