/**
 * Publisher ファクトリ(design.md §5.7)。
 *
 * T-16(issue #21)で GitRepoPublisher(zenn/hugo/jekyll 共通基盤)が揃ったため、Git モードの
 * 3サービスはここで配線する。Zenn は T-17(issue #22)で `src/publishers/zenn.ts` の
 * `renderZennArticle`、Hugo は T-18(issue #23)で `src/publishers/hugo.ts` の
 * `renderHugoArticle`、Jekyll は T-19(issue #24)で `src/publishers/jekyll.ts` の
 * `renderJekyllArticle` が揃ったため、`resolveRenderer` で service 別に選択する(下記)。
 * Qiita/dev.to/note.com/はてな(T-21〜T-25)はまだ存在しないため、引き続き
 * `PublisherNotImplementedError` を投げて「まだ配信できない」ことを明示する
 * ——`src/sync.ts` 自体は Publisher を注入で受け取る形で完成しており(モック Publisher で
 * 駆動する E2E テストは `test/sync.test.ts`)、実サービスへの接続だけが後続タスク待ちで
 * あることが分かるようにするための境界。
 */

import { PRECONDITION_FAILURE } from '../exit-codes.js';
import type { Config, ServiceName } from '../config.js';
import type { Logger } from '../logger.js';
import { createGitRepoPublisher } from './git-repo.js';
import { renderHugoArticle } from './hugo.js';
import { renderJekyllArticle } from './jekyll.js';
import { isGitModeService } from './mode.js';
import { renderGenericArticle, type NoteRenderer } from './render.js';
import type { Publisher } from './types.js';
import { renderZennArticle } from './zenn.js';

/**
 * `createPublisher` がまだ実装の無いサービスを要求されたことを表す。
 * `src/lock.ts` の `LockError` 等と同じ `exitCode` プロパティ規約に従い、
 * `cli.ts` が「何も配信せず exit 2」として扱えるようにする。
 */
export class PublisherNotImplementedError extends Error {
  readonly exitCode = PRECONDITION_FAILURE;
  readonly service: string;

  constructor(service: string) {
    super(
      `no Publisher implementation is registered yet for service "${service}"; ` +
        'real Publisher implementations land in T-16 (git repo modes: zenn/hugo/jekyll) and ' +
        'T-21〜T-25 (qiita/devto/note/hatena) per tasks.md. T-14 wires the sync flow itself ' +
        '(src/sync.ts) and is exercised with a mock Publisher in test/sync.test.ts, per design.md §5.7.',
    );
    this.name = 'PublisherNotImplementedError';
    this.service = service;
  }
}

/** `createPublisher` のオプション。 */
export interface CreatePublisherOptions {
  /**
   * ログ出力先(任意)。Git モードでは `createGitRepoPublisher` へそのまま渡す
   * ——差分ゼロでのブランチ破棄など診断的な `warn` を発行するため(CodeRabbit review, PR #49。
   * 未指定のままだと本番実行でその `warn` が一切発行されない)。
   */
  logger?: Logger;
}

/**
 * `config.service` に対応する Publisher を生成する。Git モード(zenn/hugo/jekyll)は
 * `createGitRepoPublisher`(T-16)を返す(`options.logger` を渡す)。それ以外のサービスは
 * 後続タスク(T-21〜T-25)待ちのため `PublisherNotImplementedError` を投げる(上記 JSDoc 参照)。
 */
export function createPublisher(config: Config, options: CreatePublisherOptions = {}): Publisher {
  if (isGitModeService(config.service) && config.git !== undefined) {
    return createGitRepoPublisher({ config, logger: options.logger });
  }
  throw new PublisherNotImplementedError(config.service);
}

/**
 * service 別の `NoteRenderer` 選択(design.md §5.7 サービス別表、T-17 / issue #22)。
 *
 * `createPublisher` が Publisher の実装を service 別に振り分けるのと同じ形で、レンダリング
 * (`src/publishers/render.ts` の `NoteRenderer`、design.md §6 手順6c)も service 別に振り分ける
 * ——`Publisher.publish()` は既にレンダリング済みの `RenderedArticle` を受け取るだけで
 * (`src/publishers/types.ts` 冒頭 JSDoc)、frontmatter の組み立ては Publisher の外側
 * (sync フローが注入する `NoteRenderer`)の責務であるため、Publisher とは独立してここに
 * 選択ロジックを置く。呼び出し側(`src/cli.ts`)は `createPublisher` と対になる形で
 * `resolveRenderer(config.service)` を `runSync({ renderNote: … })` に渡す。
 *
 * - `zenn`: `renderZennArticle`(`src/publishers/zenn.ts`、T-17)——slug/type/emoji/topics の
 *   Zenn 固有規約(FR-23/FR-24)を扱う。
 * - `hugo`: `renderHugoArticle`(`src/publishers/hugo.ts`、T-18)——`date`/`lastmod`/
 *   `categories`/`tags` の Hugo 固有規約(design.md §5.7 Hugo 行)を扱う。
 * - `jekyll`: `renderJekyllArticle`(`src/publishers/jekyll.ts`、T-19)——
 *   `_posts/YYYY-MM-DD-<uuid>.md` のファイル名固定規約(design.md §4)と `title`/`date`/
 *   `categories`/`tags` の Jekyll 固有規約(design.md §5.7 Jekyll 行)を扱う。
 * - それ以外(qiita/devto/note/hatena): 後続タスク(T-21〜T-25)でサービス別 Renderer が
 *   揃うまでの暫定として `renderGenericArticle`(`src/publishers/render.ts`、T-14)を返す
 *   ——`runSync` 自身の既定値と同じにすることで、`renderNote` を明示的に渡す(cli.ts)場合と
 *   渡さない場合(test/sync.test.ts 等の既存テスト)とで挙動が変わらない。
 */
export function resolveRenderer(service: ServiceName): NoteRenderer {
  if (service === 'zenn') {
    return renderZennArticle;
  }
  if (service === 'hugo') {
    return renderHugoArticle;
  }
  if (service === 'jekyll') {
    return renderJekyllArticle;
  }
  return renderGenericArticle;
}
