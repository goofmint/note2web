/**
 * Publisher ファクトリ(design.md §5.7)。
 *
 * T-16(issue #21)で GitRepoPublisher(zenn/hugo/jekyll 共通基盤)が揃ったため、Git モードの
 * 3サービスはここで配線する。Zenn は T-17(issue #22)で `src/publishers/zenn.ts` の
 * `renderZennArticle`、Hugo は T-18(issue #23)で `src/publishers/hugo.ts` の
 * `renderHugoArticle`、Jekyll は T-19(issue #24)で `src/publishers/jekyll.ts` の
 * `renderJekyllArticle`、Qiita は T-21(issue #26)で `src/publishers/qiita.ts` の
 * `createQiitaPublisher`/`renderQiitaArticle`、dev.to は T-22(issue #27)で
 * `src/publishers/devto.ts` の `createDevtoPublisher`/`renderDevtoArticle`、はてなは
 * T-23(issue #28)で `src/publishers/hatena.ts` の `createHatenaPublisher`/
 * `renderHatenaArticle`、note.com は T-25(issue #30)で `src/publishers/note.ts` の
 * `createNotePublisher`/`renderNoteArticle` が揃ったため、それぞれここで配線する
 * (`resolveRenderer` で service 別に選択、下記)。これで design.md §7 `SERVICES` の
 * 7サービス全てに実装が揃った。`PublisherNotImplementedError` に到達するのは、
 * (a) zod 検証を経ない `Config` で `config.service` に未知の値が入った場合、または
 * (b) 実装は存在するがサービス固有の設定ブロック(`config.note` 等)が欠けている場合
 * (通常は zod の service 別必須ブロック検証が弾くため、検証を迂回した場合のみ)——
 * クラス自体は `createPublisher` の網羅性チェック(default 分岐)用の防御として残す
 * (`src/dependencies.ts` `checkDependencies` の `exhaustiveCheck: never` と同じ役割。
 * `config.service` に将来サービスが追加されコンパイルが壊れる前に、実行時にも
 * 意味のあるエラーで検出できるようにする)。
 */

import { PRECONDITION_FAILURE } from '../exit-codes.js';
import type { Config, ServiceName } from '../config.js';
import type { Logger } from '../logger.js';
import { createDevtoPublisher, renderDevtoArticle } from './devto.js';
import { createGitRepoPublisher } from './git-repo.js';
import { createHatenaPublisher, renderHatenaArticle } from './hatena.js';
import { renderHugoArticle } from './hugo.js';
import { renderJekyllArticle } from './jekyll.js';
import { isGitModeService } from './mode.js';
import { createNotePublisher, renderNoteArticle } from './note.js';
import { createQiitaPublisher, renderQiitaArticle } from './qiita.js';
import { renderGenericArticle, type NoteRenderer } from './render.js';
import type { Publisher } from './types.js';
import { renderZennArticle } from './zenn.js';

/**
 * `createPublisher` が(型上到達不能なはずの)未知のサービスを要求されたことを表す。
 * `src/lock.ts` の `LockError` 等と同じ `exitCode` プロパティ規約に従い、
 * `cli.ts` が「何も配信せず exit 2」として扱えるようにする。
 */
export class PublisherNotImplementedError extends Error {
  readonly exitCode = PRECONDITION_FAILURE;
  readonly service: string;

  constructor(service: string) {
    super(
      `internal error: no Publisher was selected for service "${service}"; ` +
        'design.md §7 SERVICES lists 7 services and src/publishers/factory.ts wires all of them ' +
        '(T-16/T-21/T-22/T-23/T-25) — this indicates the service-specific config block ' +
        '(e.g. config.note) is missing, config.service bypassed the zod schema ' +
        '(src/config.ts), or a new service was added without updating createPublisher.',
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
 * `createGitRepoPublisher`(T-16)を、qiita は `createQiitaPublisher`(T-21)を、devto は
 * `createDevtoPublisher`(T-22)を、hatena は `createHatenaPublisher`(T-23)を、note は
 * `createNotePublisher`(T-25)を返す(いずれも `options.logger` を渡す)。
 * `config.service` は `ServiceName`(design.md §7 SERVICES の7値)の型で保証されており、
 * 上記のいずれにも一致しない実行時の値は起こり得ないはずだが、`config.<service>` ブロック
 * (`config.qiita`/`config.devto`/…)が `superRefine` の検証をすり抜けて `undefined` のまま
 * 渡された場合の防御として `PublisherNotImplementedError` を投げる(上記 JSDoc 参照)。
 */
export function createPublisher(config: Config, options: CreatePublisherOptions = {}): Publisher {
  if (isGitModeService(config.service) && config.git !== undefined) {
    return createGitRepoPublisher({ config, logger: options.logger });
  }
  if (config.service === 'qiita' && config.qiita !== undefined) {
    return createQiitaPublisher({ config, logger: options.logger });
  }
  if (config.service === 'devto' && config.devto !== undefined) {
    return createDevtoPublisher({ config, logger: options.logger });
  }
  if (config.service === 'hatena' && config.hatena !== undefined) {
    return createHatenaPublisher({ config, logger: options.logger });
  }
  if (config.service === 'note' && config.note !== undefined) {
    return createNotePublisher({ config, logger: options.logger });
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
 * - `qiita`: `renderQiitaArticle`(`src/publishers/qiita.ts`、T-21)——`title`/`tags`/
 *   `private`/`slide`/`id` の Qiita 固有規約(design.md §5.7 Qiita 行)とタグ制約
 *   (1〜5個・スペース不可)を扱う。
 * - `devto`: `renderDevtoArticle`(`src/publishers/devto.ts`、T-22)——API モードのため
 *   frontmatter ファイルは書かないが、`title`/`tags` を含めたハッシュで冪等判定を成立させ、
 *   `bodyMarkdown`/`tags` を `RenderedArticle` の専用フィールドへ渡す(design.md §5.7
 *   DevtoPublisher 行)。
 * - `hatena`: `renderHatenaArticle`(`src/publishers/hatena.ts`、T-23)——API モードのため
 *   frontmatter ファイルは書かないが、`artifact` に AtomPub `<entry>` XML そのものを
 *   持たせ、それを冪等判定のハッシュにも POST/PUT のリクエストボディにもそのまま使う
 *   (design.md §5.7 HatenaPublisher 行)。
 * - `note`: `renderNoteArticle`(`src/publishers/note.ts`、T-25)——`noet` が実際に読む
 *   `title`/`tags` の2キーのみの最小限 frontmatter を書き、本文に Markdown 画像参照が
 *   含まれる場合は `NoteImagesUnsupportedError` を投げる(design.md §5.7 NotePublisher 行、
 *   §13-6 の画像非対応方針)。
 * - それ以外: 型上到達不能(`ServiceName` は上記7値で尽きる)。`renderGenericArticle`
 *   (`src/publishers/render.ts`、T-14)を防御的なフォールバックとして返す——`runSync` 自身の
 *   既定値と同じにすることで、`renderNote` を明示的に渡す(cli.ts)場合と渡さない場合
 *   (test/sync.test.ts 等の既存テスト)とで挙動が変わらない。
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
  if (service === 'qiita') {
    return renderQiitaArticle;
  }
  if (service === 'devto') {
    return renderDevtoArticle;
  }
  if (service === 'hatena') {
    return renderHatenaArticle;
  }
  if (service === 'note') {
    return renderNoteArticle;
  }
  return renderGenericArticle;
}
