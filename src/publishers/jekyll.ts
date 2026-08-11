/**
 * Jekyll 向け NoteRenderer(design.md §4「Jekyll のファイル名規約」および §5.7 サービス別差分の
 * 表「Jekyll」行、T-19 / issue #24)。
 *
 * GitRepoPublisher(`src/publishers/git-repo.ts`、T-16)は Zenn / Hugo / Jekyll に共通する
 * Git リポジトリ出力(ブランチ作成・ファイル書き込み・コミット・PR 作成)のみを担い、
 * サービス固有のファイルパス・frontmatter は関知しない(同ファイル冒頭 JSDoc)。本モジュールは
 * その「サービス固有」部分——Jekyll のファイル名固定規約と frontmatter——を、
 * `src/publishers/render.ts` の `NoteRenderer` 契約に沿う形で埋める。T-17(issue #22)の
 * `src/publishers/zenn.ts`(`renderZennArticle`)・T-18(issue #23)の `src/publishers/hugo.ts`
 * (`renderHugoArticle`)と同じ構造を踏襲する。
 *
 * design.md §5.7 Jekyll 行:
 * `_posts/YYYY-MM-DD-<uuid>.md` / `title`・`date`・`categories`・`tags` /
 * 「日付は作成日。初回のファイル名を状態に記録し固定(§4)」。
 *
 * design.md §4「Jekyll のファイル名規約」(未決事項の結論):
 * 「`_posts/YYYY-MM-DD-<uuid>.md`。日付はノートの**作成日**を使う。初回配信時のファイル名を
 * 状態 JSON に記録し、以後は作成日が変わっても**記録済みファイル名を使い続ける**
 * (URL の安定性を優先)」。
 *
 * **`output_dir` は使わない(Hugo との対比)**: Hugo 行は `<output_dir>/<uuid>.md` と明記し、
 * `output_dir` 設定を参照する(`hugo.ts` 冒頭 JSDoc)。Jekyll 行・§4 のどちらにも
 * `output_dir` への言及が無く、パスは常に `_posts/` に固定される——Zenn 行の `articles/` 固定
 * (`zenn.ts` の `ZENN_ARTICLES_DIR`)と同じ扱いであり、`config.git` を一切参照しない
 * (`renderZennArticle` と同様、`config` を destructure しない)。
 *
 * **ファイル名固定ロジック(§4 の核心)**: `input.prev`(T-19 で `RenderNoteInput` に追加。
 * `src/publishers/render.ts` 冒頭 JSDoc、`src/sync.ts` の `processNote` が
 * `state.getNote(note.uuid)` をレンダリング前に取得して渡す)の `artifactPath` が存在すれば、
 * それを**そのまま**再利用する。ノートの作成日が変わっても(Apple Notes の同期・復元等で
 * `createdAt` が変化しても)ファイル名は変わらない。初回配信(`prev` が `null`、または
 * `prev.artifactPath` が未設定)のときのみ、`note.createdAt` から新規にパスを算出する。
 *
 * **日付部分のフォーマット**: `formatTimestamp(note.createdAt, config.timezone)`
 * (`src/transform/normalize.ts` 経由で再エクスポート、T-12 の規約。`config.timezone` の
 * 固定オフセット秒精度 ISO-8601)の出力先頭10文字(`YYYY-MM-DD` の日付部分。`formatTimestamp`
 * は常に `YYYY-MM-DD` を先頭10文字として返す固定長フォーマットのため、`slice(0, 10)` で
 * 安全に切り出せる)を使う。**タイムゾーンで日付が変わりうる**ため
 * (例: UTC 深夜のノートは `Asia/Tokyo` では翌日扱いになる)、実行時刻ではなくノート自身の
 * `createdAt` と `config.timezone` から決定的に導出する(`renderArtifact` 冒頭 JSDoc の
 * 「frontmatter エントリに実行時刻を含めてはならない」と同じ理由で、パスも実行時刻非依存
 * であるべき)。
 *
 * **frontmatter の `date`**: パスの日付部分とは異なり、`date` フィールドは
 * `formatTimestamp(note.createdAt, config.timezone)` の**完全な** ISO-8601 文字列を使う
 * (Hugo 行の `date` と同じ規約。§5.7 Jekyll 行は「日付は作成日」とのみ言うが、Hugo 行が
 * `date`(作成日時)を完全な ISO-8601 で表現している前例に倣う——Jekyll には `updatedAt` に
 * 対応する `lastmod` 相当のキーが frontmatter キー順(`JEKYLL_FRONTMATTER_KEY_ORDER`)に
 * 無いため、`updatedAt` は一切使わない)。
 *
 * **categories/tags の変換規約(design.md §5.7 が明記していない部分の決定)**: Jekyll 行にも
 * Zenn 行の topics 変換や Qiita 行のタグ制約のような追加の切り詰め・文字種制約の明記が無い。
 * Hugo 行と同じ前例(`hugo.ts` 冒頭 JSDoc)に倣い、`categories` は `note.folder` を単一要素
 * 配列にするだけ(型検証なし)、`tags` は `note.tags` を**一切変換せず**(先頭 `#` を保持した
 * まま)そのまま使う(design.md に明記の無い制約を勝手に作らない、という Zenn/Hugo と同じ方針)。
 */

import type { RenderNoteInput, NoteRenderer } from './render.js';
import type { RenderedArticle } from './types.js';
import {
  computeContentHash,
  renderArtifact,
  JEKYLL_FRONTMATTER_KEY_ORDER,
  type FrontmatterEntry,
} from '../transform/frontmatter.js';
import { formatTimestamp } from '../transform/normalize.js';

// ---------------------------------------------------------------------------
// ファイルパス。
// ---------------------------------------------------------------------------

/** Jekyll のファイルパスは `output_dir` 設定に関わらず常にこの固定ディレクトリ(design.md §4/§5.7)。 */
const JEKYLL_POSTS_DIR = '_posts';

/** `formatTimestamp` の出力(`YYYY-MM-DDTHH:mm:ss±HH:mm`)先頭10文字が `YYYY-MM-DD` の日付部分。 */
const DATE_PREFIX_LENGTH = 10;

/**
 * 新規配信時の `_posts/YYYY-MM-DD-<uuid>.md` を算出する(design.md §4)。日付は
 * `note.createdAt` を `config.timezone` で整形した先頭10文字(`YYYY-MM-DD`)。
 */
function computeInitialArtifactPath(noteUuid: string, createdAt: Date, timezone: string): string {
  const datePrefix = formatTimestamp(createdAt, timezone).slice(0, DATE_PREFIX_LENGTH);
  return `${JEKYLL_POSTS_DIR}/${datePrefix}-${noteUuid}.md`;
}

/**
 * ファイル名固定ロジック(design.md §4 の核心)。`prev.artifactPath` が存在すれば
 * そのまま再利用し(作成日が変わっても変わらない、URL 安定性優先)、無ければ
 * `note.createdAt` から新規に算出する。
 */
function resolveJekyllArtifactPath(input: RenderNoteInput): string {
  const previousPath = input.prev?.artifactPath;
  if (previousPath !== undefined) {
    return previousPath;
  }
  return computeInitialArtifactPath(input.note.uuid, input.note.createdAt, input.config.timezone);
}

// ---------------------------------------------------------------------------
// Renderer 本体。
// ---------------------------------------------------------------------------

/**
 * Jekyll 向け `NoteRenderer`(design.md §4、§5.7 Jekyll 行)。frontmatter のキー順は
 * `JEKYLL_FRONTMATTER_KEY_ORDER`(`src/transform/frontmatter.ts`。
 * `title`/`date`/`categories`/`tags`)のとおり組み立てる。
 *
 * `config.git`(`output_dir` 等)は参照しない——Jekyll のファイルパスは常に `_posts/` 固定
 * (design.md §4、§5.7 Jekyll 行に `output_dir` への言及なし)であり、`config.timezone` の
 * みを `date` の整形・ファイル名の日付導出に使う。
 */
export const renderJekyllArticle: NoteRenderer = (input: RenderNoteInput): RenderedArticle => {
  const { note, markdown, config } = input;

  const date = formatTimestamp(note.createdAt, config.timezone);
  const categories = [note.folder];

  // JEKYLL_FRONTMATTER_KEY_ORDER の並び(title/date/categories/tags)どおりに組み立てる。
  const entries: FrontmatterEntry[] = [
    [JEKYLL_FRONTMATTER_KEY_ORDER[0], note.title],
    [JEKYLL_FRONTMATTER_KEY_ORDER[1], date],
    [JEKYLL_FRONTMATTER_KEY_ORDER[2], categories],
    [JEKYLL_FRONTMATTER_KEY_ORDER[3], note.tags],
  ];

  const artifact = renderArtifact(entries, markdown);
  const contentHash = computeContentHash(artifact);
  const artifactPath = resolveJekyllArtifactPath(input);

  return { noteUuid: note.uuid, title: note.title, artifact, contentHash, artifactPath };
};
