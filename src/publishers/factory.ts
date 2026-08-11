/**
 * Publisher ファクトリ(design.md §5.7)。
 *
 * サービス別 Publisher の実装(GitRepoPublisher 系は T-16〜T-19、Qiita/dev.to/note.com/
 * はてなは T-21〜T-25)はまだ存在しない。本モジュールは `src/cli.ts` が `sync` を
 * 実配線するために必要とするファクトリの置き場所を用意しつつ、現時点では
 * `PublisherNotImplementedError` を投げて「まだ配信できない」ことを明示する
 * ——`src/sync.ts` 自体は Publisher を注入で受け取る形で完成しており(モック Publisher で
 * 駆動する E2E テストは `test/sync.test.ts`)、実サービスへの接続だけが後続タスク待ちで
 * あることが分かるようにするための境界。
 */

import { PRECONDITION_FAILURE } from '../exit-codes.js';
import type { Config } from '../config.js';
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

/**
 * `config.service` に対応する Publisher を生成する。T-14 時点では全サービスについて
 * `PublisherNotImplementedError` を投げる(上記 JSDoc 参照)。後続タスクがサービスごとの
 * 分岐を追加していく想定の唯一の差し込み口。
 */
export function createPublisher(config: Config): Publisher {
  throw new PublisherNotImplementedError(config.service);
}
