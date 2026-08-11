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
 */

import type { Config } from '../config.js';
import type { Note } from '../model/note.js';
import {
  computeContentHash,
  renderArtifact,
  type FrontmatterEntry,
} from '../transform/frontmatter.js';
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
export function renderGenericArticle({ note, markdown }: RenderNoteInput): RenderedArticle {
  const entries: FrontmatterEntry[] = [
    ['title', note.title],
    ['tags', note.tags],
  ];
  const artifact = renderArtifact(entries, markdown);
  const contentHash = computeContentHash(artifact);
  return { noteUuid: note.uuid, title: note.title, artifact, contentHash };
}
