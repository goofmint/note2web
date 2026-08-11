/**
 * T-14 用の汎用 Renderer(design.md §6 手順6c「frontmatter + 本文をレンダリング → SHA-256」)。
 *
 * design.md §5.7 のサービス別 frontmatter 表(Zenn の `emoji`/`type`、Hugo の
 * `categories`/`lastmod` 等)に基づく本来の Renderer は各 Publisher(T-17〜T-21)の
 * 責務であり、本モジュールの範囲外(`src/publishers/types.ts` の JSDoc も参照。
 * design.md §5.7 の `Publisher` インターフェースはレンダリングを持たない)。
 *
 * sync フロー(`src/sync.ts`)がハッシュ判定(FR-15)を行うにはレンダリング結果が
 * 要るため、ここでは `title`/`tags` のみを frontmatter に含める最小限の実装を提供する。
 * `NoteRenderer` は sync フローの注入点であり、E2E テストではこの既定実装のまま
 * 使うことも、テスト専用の Renderer に差し替えることもできる。
 *
 * **`artifactPath`(Git モードのみ)**: design.md §8 の状態 JSON スキーマ例
 * (`"artifactPath": "articles/5c1c2c3d-….md"`)に合わせ、Git モードでは
 * `<config.git.output_dir>/<uuid小文字ではなく Note#uuid そのまま>.md` を組み立てる。
 * サービス別の実際のパス規約(Zenn は UUID 小文字化、Jekyll は日付付きファイル名を
 * 初回のまま固定、等。design.md §5.7 のサービス別表)は各 Publisher の Renderer
 * (T-17 以降)が担い、ここでは §8 の例に沿った最小限の共通規約にとどめる
 * (CodeRabbit review, PR #47)。
 */

import type { Config } from '../config.js';
import type { Note } from '../model/note.js';
import {
  computeContentHash,
  renderArtifact,
  type FrontmatterEntry,
} from '../transform/frontmatter.js';
import { isGitModeService } from './mode.js';
import type { RenderedArticle } from './types.js';

/** `NoteRenderer` の入力。 */
export interface RenderNoteInput {
  /** メタデータ抽出済み(`completeNoteMetadata` 適用後)の `Note`。 */
  note: Note;
  /** アセットプレースホルダ解決済みの Markdown 本文(`processNoteBody` の出力)。 */
  markdown: string;
  /** 検証済み設定(タイムゾーン等、サービス別 Renderer が参照する)。 */
  config: Config;
}

/** sync フローに注入する Renderer の関数シグネチャ。 */
export type NoteRenderer = (input: RenderNoteInput) => RenderedArticle;

/**
 * T-14 の既定 Renderer。frontmatter は `title` / `tags` の2キーのみ(design.md §5.7 の
 * サービス別キー順には従わない、汎用の暫定実装)。`renderArtifact` / `computeContentHash`
 * (`src/transform/frontmatter.ts`、T-12)の正規化規約(UTF-8/LF/NFC・決定的 YAML)を
 * そのまま利用するため、ハッシュの安定性(FR-15)は T-12 の保証を継承する。
 */
export function renderGenericArticle({ note, markdown, config }: RenderNoteInput): RenderedArticle {
  const entries: FrontmatterEntry[] = [
    ['title', note.title],
    ['tags', note.tags],
  ];
  const artifact = renderArtifact(entries, markdown);
  const contentHash = computeContentHash(artifact);
  const artifactPath =
    isGitModeService(config.service) && config.git !== undefined
      ? `${config.git.output_dir}/${note.uuid}.md`
      : undefined;
  return { noteUuid: note.uuid, title: note.title, artifact, contentHash, artifactPath };
}
