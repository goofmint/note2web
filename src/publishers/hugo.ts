/**
 * Hugo 向け NoteRenderer(design.md §5.7 サービス別差分の表「Hugo」行、T-18 / issue #23)。
 *
 * GitRepoPublisher(`src/publishers/git-repo.ts`、T-16)は Zenn / Hugo / Jekyll に共通する
 * Git リポジトリ出力(ブランチ作成・ファイル書き込み・コミット・PR 作成)のみを担い、
 * サービス固有のファイルパス・frontmatter は関知しない(同ファイル冒頭 JSDoc)。本モジュールは
 * その「サービス固有」部分——Hugo のファイルパス・frontmatter 規約——を、
 * `src/publishers/render.ts` の `NoteRenderer` 契約に沿う形で埋める。T-17(issue #22)の
 * `src/publishers/zenn.ts`(`renderZennArticle`)と同じ構造を踏襲する。
 *
 * design.md §5.7 Hugo 行:
 * `<output_dir>/<uuid>.md` / `title`・`date`(作成日時)・`lastmod`(更新日時)・
 * `categories: [フォルダ名]`・`tags` /「`output_dir` は設定で指定(例 `content/posts`)」。
 *
 * **Zenn 行との対比で明確になる、Hugo 行が「明記していない」こと**:
 * - ファイルパスは `<output_dir>/<uuid>.md` であり、Zenn 行の `<uuid小文字>` のような
 *   「小文字化」の指示が無い。したがって `note.uuid` をそのまま(大文字小文字を変換せず)
 *   使う——Zenn の `resolveZennSlug` のような正規化・検証は行わない。
 * - `type`(フォルダ名の妥当性検証。FR-24)や `emoji` 既定値のような Hugo 固有の制約は
 *   §5.7 表に記載が無い。`categories` は「フォルダ名」をそのまま単一要素配列にするだけで、
 *   Zenn の `type` のような許可値検証(`tech`/`idea` 限定)は行わない——Hugo の
 *   `categories` は任意のフォルダ名を受け付けるカテゴリ名であり、Zenn の `type` のような
 *   固定語彙の制約は無い。
 * - `tags` の変換規約(design.md §5.7 が明記していない部分の決定): Zenn 行は「topics」の
 *   節で `#` を含まないプレーンな語であるべきという実装判断(`stripLeadingHash`、
 *   `zenn.ts` 冒頭 JSDoc)を行ったが、Hugo 行にはそのような追加の変換・切り詰めの明記が
 *   一切無い(Qiita 行のような文字種制約も無い)。`Note#tags` は先頭 `#` を含めたまま保持
 *   される(design.md §5.3「差分」節、FR-07「そのまま」)。design.md に明記の無い制約を
 *   勝手に作らないという `zenn.ts` と同じ方針を Hugo にも適用し、本実装は `note.tags` を
 *   **一切変換せず**(`#` を保持したまま)そのまま frontmatter の `tags` に使う
 *   (CodeRabbit issue plan、issue #23 コメントの Phase 1 Task 1 も同じ結論:
 *   「`tags` = `note.tags`(先頭の `#` はそのまま保持する)」)。
 *
 * **日時のフォーマット**: `date`/`lastmod` は `formatTimestamp`(`src/transform/normalize.ts`
 * 経由で `src/logger.ts` から re-export、T-12 の規約)で `config.timezone` の固定オフセット
 * 秒精度 ISO-8601 に整形する。`note.createdAt`/`note.updatedAt`(ノート自身の日時)のみを
 * 使い、実行時刻(`new Date()` 等)は一切使わない——`renderArtifact` 冒頭 JSDoc の
 * 「frontmatter エントリに実行時刻など毎回変わる値を含めてはならない」(FR-15 の冪等判定が
 * 壊れるため)という制約を満たすために必須。
 */

import type { RenderNoteInput, NoteRenderer } from './render.js';
import type { RenderedArticle } from './types.js';
import {
  computeContentHash,
  renderArtifact,
  HUGO_FRONTMATTER_KEY_ORDER,
  type FrontmatterEntry,
} from '../transform/frontmatter.js';
import { formatTimestamp } from '../transform/normalize.js';
import type { Config } from '../config.js';

// ---------------------------------------------------------------------------
// config.git の存在検証。
// ---------------------------------------------------------------------------

/** design.md §7 の `git` ブロック(`repo_path`/`base_branch`/`output_dir`/`auto_merge`)。 */
type GitConfig = NonNullable<Config['git']>;

/**
 * `config.git` の存在を検証して返す。`src/config.ts` の `configSchema` は
 * `service: 'hugo'` のとき `git` ブロックを必須とするため、実行時にここへ到達する頃には
 * 常に存在するはずだが、`Config['git']` は型上は任意のまま(サービスで判別されない)なので
 * 防御的に検証する(`src/publishers/git-repo.ts` の `requireGitConfig` と同じパターン)。
 */
function requireHugoGitConfig(config: Config): GitConfig {
  if (config.git === undefined) {
    throw new Error(
      `internal error: renderHugoArticle requires config.git (service "${config.service}" has none)`,
    );
  }
  return config.git;
}

// ---------------------------------------------------------------------------
// Renderer 本体。
// ---------------------------------------------------------------------------

/**
 * Hugo 向け `NoteRenderer`(design.md §5.7 Hugo 行)。frontmatter のキー順は
 * `HUGO_FRONTMATTER_KEY_ORDER`(`src/transform/frontmatter.ts`。
 * `title`/`date`/`lastmod`/`categories`/`tags`)のとおり組み立てる。
 *
 * `config.git.output_dir` からファイルパスを組み立てるため(Zenn と異なり `articles/` 固定
 * ではない)、`config` を参照する。
 */
export const renderHugoArticle: NoteRenderer = ({
  note,
  markdown,
  config,
}: RenderNoteInput): RenderedArticle => {
  const gitConfig = requireHugoGitConfig(config);

  const date = formatTimestamp(note.createdAt, config.timezone);
  const lastmod = formatTimestamp(note.updatedAt, config.timezone);
  const categories = [note.folder];

  // HUGO_FRONTMATTER_KEY_ORDER の並び(title/date/lastmod/categories/tags)どおりに組み立てる。
  const entries: FrontmatterEntry[] = [
    [HUGO_FRONTMATTER_KEY_ORDER[0], note.title],
    [HUGO_FRONTMATTER_KEY_ORDER[1], date],
    [HUGO_FRONTMATTER_KEY_ORDER[2], lastmod],
    [HUGO_FRONTMATTER_KEY_ORDER[3], categories],
    [HUGO_FRONTMATTER_KEY_ORDER[4], note.tags],
  ];

  const artifact = renderArtifact(entries, markdown);
  const contentHash = computeContentHash(artifact);
  const artifactPath = `${gitConfig.output_dir}/${note.uuid}.md`;

  return { noteUuid: note.uuid, title: note.title, artifact, contentHash, artifactPath };
};
