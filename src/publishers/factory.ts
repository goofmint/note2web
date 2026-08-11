/**
 * Publisher ファクトリ(design.md §5.7)。
 *
 * T-16(issue #21)で GitRepoPublisher(zenn/hugo/jekyll 共通基盤)が揃ったため、Git モードの
 * 3サービスはここで配線する。Zenn/Hugo/Jekyll 固有のファイルパス・frontmatter
 * (design.md §5.7 サービス別表)は本タスクの範囲外(T-17〜T-19)で、現時点では
 * `src/publishers/render.ts` の汎用 `NoteRenderer` がそれを担う暫定実装のまま。
 * Qiita/dev.to/note.com/はてな(T-21〜T-25)はまだ存在しないため、引き続き
 * `PublisherNotImplementedError` を投げて「まだ配信できない」ことを明示する
 * ——`src/sync.ts` 自体は Publisher を注入で受け取る形で完成しており(モック Publisher で
 * 駆動する E2E テストは `test/sync.test.ts`)、実サービスへの接続だけが後続タスク待ちで
 * あることが分かるようにするための境界。
 */

import { PRECONDITION_FAILURE } from '../exit-codes.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { createGitRepoPublisher } from './git-repo.js';
import { isGitModeService } from './mode.js';
import type { Publisher } from './types.js';

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
