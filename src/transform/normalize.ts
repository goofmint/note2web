/**
 * 正規化プリミティブ(design.md §5.6「Renderer と冪等判定」/ 直列化の正規化規約、T-12)。
 *
 * コンテンツハッシュ(FR-15)が実行環境に依存せず同一入力から同一値になるための
 * 最小の共通処理をここに集約する。文字コードは UTF-8 を前提とし(ハッシュ計算・
 * ファイル書き込みはこの正規化後の文字列を UTF-8 バイト列として扱う)、改行は LF に
 * 統一、テキストは Unicode NFC に正規化する。body / frontmatter の文字列値の
 * どちらにも適用できる汎用関数として、`frontmatter.ts` から共有利用する。
 *
 * 日時の整形(秒精度 ISO 8601・設定 `timezone` の固定オフセット)は `src/logger.ts` の
 * `formatTimestamp`(design.md §9 のログ用タイムスタンプと全く同じ規約: `Intl.DateTimeFormat`
 * の `timeZoneName: 'longOffset'` を使い、実行マシンの TZ・ロケールに依存しない)を
 * そのまま再利用する(design.md §5.6 と §9 は同一の整形規約を指しており、実装を
 * 重複させない)。ここでは frontmatter からの利用点を明確にするため re-export のみ行う。
 */

export { formatTimestamp } from '../logger.js';

/** CRLF・CR の各種改行を LF に統一する。 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n|\r/g, '\n');
}

/**
 * 改行を LF に統一した上で Unicode 正規化形式 NFC を適用する
 * (design.md §5.6「テキストは Unicode NFC に正規化」)。
 * CRLF/NFD で書かれた入力と LF/NFC で書かれた論理的に同一の入力が、
 * 同一の正規化結果(ひいては同一のコンテンツハッシュ)になることを保証する。
 */
export function normalizeText(text: string): string {
  return normalizeLineEndings(text).normalize('NFC');
}
