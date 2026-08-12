/**
 * DevtoPublisher(design.md §5.7「DevtoPublisher」・「応答不明時の重複防止」、FR-26/FR-30、
 * T-22 / issue #27)。
 *
 * design.md §5.7 は Forem API v1 を CLI を介さず直接呼ぶことを定める:
 *
 *   - 新規: `POST /api/articles`。更新: `PUT /api/articles/{id}`(`{id}` は状態 JSON の `remoteId`)
 *   - ヘッダ: `api-key: <トークン>` / `Content-Type: application/json` /
 *     `Accept: application/vnd.forem.api-v1+json`
 *   - ボディ(新規・更新共通): `{"article": {"title", "body_markdown", "published": true,
 *     "tags": "<カンマ区切り・最大4個>", "canonical_url"?}}`。`canonical_url` は設定
 *     `canonical_base_url` がある場合のみ含める
 *   - 成功レスポンスの `id` → `remoteId`、`url` → `url`
 *   - タグは先頭4個に切り詰め(超過時は警告ログ)
 *   - 認証トークンは環境変数(既定 `DEVTO_API_KEY`。実際の変数名は設定 `devto.api_key_env`)
 *
 * 「応答不明時の重複防止」(design.md §5.7 共通節)は dev.to について次を定める:
 *
 *   - HTTP タイムアウト30秒。**新規作成(POST)は自動リトライしない**。更新(PUT)は
 *     同一内容の再送が冪等なので、接続系エラーに限り1回だけ再試行してよい
 *   - `remoteId` の無いノートを新規作成する前に、自分の記事一覧 API からタイトル一致で検索する
 *   - **ちょうど1件一致**のみその ID を採用し PUT(更新)。**0件**は POST(新規作成)。
 *     **複数一致**は誤った記事への紐付け・重複作成を避けるため failed とし状態を更新しない
 *     (警告ログを出し、手動解決を促す)
 *
 * **canonical_url の組み立て規約(design.md §5.7 が明記していない部分の決定)**: design.md
 * §5.7 は「設定 `canonical_base_url` がある場合のみ含める」とだけ述べ、具体的な URL の
 * 組み立て方(ベース URL に何を連結するか)までは規定していない。本実装は
 * `canonical_base_url`(末尾に `/` が無ければ1つ補う)+ ノートの UUID(`RenderedArticle.noteUuid`。
 * 大文字小文字はそのまま、変換しない)を連結する。根拠:
 *
 *   - FR-09「記事の識別子には Apple Notes の UUID を用いる。slug は設けない」——note2web
 *     全体で記事を一意に指し示す値は UUID のみであり、canonical_url もこれを使うのが
 *     唯一整合する選択(Zenn の slug 小文字化(FR-23)は Zenn 自身の slug 文字種制約への
 *     対応であり、dev.to の canonical_url には同様の制約が無いため UUID をそのまま使う)
 *   - design.md §7 の設定例 `canonical_base_url: https://example.com/articles/`(末尾 `/`
 *     付き)は、Git モードの Zenn/Qiita が採用する `articles/<uuid>` 系のパス規約(design.md
 *     §5.7 サービス別表)と同じ「ベース + UUID」の形を示唆している
 *
 * この解釈は design.md に明記の無い実装判断であり、`buildCanonicalUrl` に閉じ込める。
 *
 * **タグの `#` 除去(design.md §5.7 が明記していない部分の決定)**: `Note#tags` は先頭 `#`
 * を含めたまま保持される(design.md §5.3「差分」節、FR-07「そのまま」)。design.md §5.7 の
 * dev.to 行はタグの文字種変換に触れていないが、`src/publishers/zenn.ts`(`stripLeadingHash`)
 * ・`src/publishers/qiita.ts`(同名関数)と同じ理由——`#` 付きのハッシュタグ表記ではなく
 * プレーンな語であるべき——により、`Publisher.publish()` の配信時点(§5.7 の「タグは先頭4個に
 * 切り詰め」の直前)で同じ変換を適用する。**Renderer(`renderDevtoArticle`)側の
 * `RenderedArticle.tags` はこの変換を行わず `Note#tags` をそのまま渡す**——切り詰め同様、
 * サービス固有のタグ正規化は Renderer ではなく Publisher.publish() の責務とする方針
 * (`src/publishers/types.ts` の `RenderedArticle.tags` JSDoc 参照)。
 *
 * **HTTP クライアントの注入(`src/publishers/git-repo.ts` の `GitRepoRunner` と同じ注入
 * パターン)**: 既定実装はグローバル `fetch`(Node 20+ 標準搭載)を `AbortSignal.timeout
 * (DEVTO_HTTP_TIMEOUT_MS)` 付きで呼ぶ。テストでは注入したフェイクで実際の HTTP 通信を行わない。
 *
 * **接続系エラーの判定(`isRetryableConnectionError`)**: design.md §5.7 は「接続系エラーに
 * 限り1回だけ再試行してよい」とだけ述べ、判定基準までは規定していない。本実装は
 * `src/lock.ts`/`src/state/store.ts` の `isErrnoException` と同じ形の型ガードを流用し、
 * 次のいずれかを接続系エラーとして扱う: (1) `fetch` 自体が投げる `TypeError`(DNS 解決失敗・
 * 接続拒否等、Node の undici 実装がこの型で投げる)、(2) `AbortSignal.timeout` によるタイムアウト
 * (`DOMException`/`Error` の `name` が `"AbortError"`/`"TimeoutError"`)、(3) `code` プロパティを
 * 持つ Node の errno 例外(`ECONNRESET`/`ETIMEDOUT` 等)。HTTP ステータスによる失敗
 * (`assertOk` が投げるもの)はここに含めない——「HTTP ステータス起因の失敗はリトライしない」
 * という design.md の要求どおり。
 *
 * **API/CLI モードのため `prepare`/`finalize` は実装しない**(`src/publishers/types.ts` 冒頭
 * JSDoc「API/CLI 系 Publisher はこの2メソッドを実装しなくてよい」、`src/publishers/qiita.ts`
 * と同じ方針)。
 */

import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { NoteState } from '../state/store.js';
import {
  computeContentHash,
  renderArtifact,
  type FrontmatterEntry,
} from '../transform/frontmatter.js';
import type { RenderNoteInput, NoteRenderer } from './render.js';
import type { Publisher, PublishResult, RenderedArticle } from './types.js';

// ---------------------------------------------------------------------------
// Renderer 本体。
// ---------------------------------------------------------------------------

/**
 * dev.to 向け `NoteRenderer`(design.md §5.7 DevtoPublisher 節、T-22)。dev.to は API モード
 * のため Git モードのような frontmatter ファイルは書かないが、`RenderedArticle.artifact`/
 * `contentHash` は「変更のあったノートのみ配信する」冪等判定(design.md §5.6・FR-15)に
 * 引き続き使われるため、`renderGenericArticle`(`src/publishers/render.ts`)と同じ形——
 * `title`/`tags` を frontmatter 相当のエントリとして含め、変換済み本文と連結してハッシュ化
 * する——を踏襲する(`title`/`tags` のいずれかが変わればハッシュも変わり、再配信される)。
 *
 * `bodyMarkdown`(frontmatter を含まない純粋な本文)と `tags`(未加工)は
 * `Publisher.publish()`(`createDevtoPublisher`)が Forem API のリクエストボディを組み立てる
 * 際にそのまま使う(`src/publishers/types.ts` の該当フィールド JSDoc 参照)。dev.to はファイル
 * 出力を持たないサービスのため `artifactPath` は設定しない(API モード)。
 */
export const renderDevtoArticle: NoteRenderer = ({
  note,
  markdown,
}: RenderNoteInput): RenderedArticle => {
  // renderGenericArticle と同じ最小限のエントリ(title/tags)で冪等判定用のハッシュを作る。
  // dev.to はこの frontmatter 相当の文字列を実際には書き出さない(API モードのため)。
  const entries: FrontmatterEntry[] = [
    ['title', note.title],
    ['tags', note.tags],
  ];
  const artifact = renderArtifact(entries, markdown);
  const contentHash = computeContentHash(artifact);

  return {
    noteUuid: note.uuid,
    title: note.title,
    artifact,
    contentHash,
    bodyMarkdown: markdown,
    tags: note.tags,
  };
};

// ---------------------------------------------------------------------------
// HTTP クライアントの注入点。
// ---------------------------------------------------------------------------

/** Forem API へのリクエスト1件(`src/publishers/git-repo.ts` の `GitRepoRunner` と同じ注入パターン)。 */
export interface DevtoHttpRequest {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** Forem API のレスポンス。ステータスコードと生のボディ文字列のみを持つ最小限の形。 */
export interface DevtoHttpResponse {
  status: number;
  body: string;
}

/** Forem API 呼び出しの注入点(テスト用)。既定は本物の `fetch`(`defaultDevtoHttpClient`)。 */
export type DevtoHttpClient = (request: DevtoHttpRequest) => Promise<DevtoHttpResponse>;

/** HTTP タイムアウト(design.md §5.7「応答不明時の重複防止」: HTTP はタイムアウト30秒)。 */
export const DEVTO_HTTP_TIMEOUT_MS = 30_000;

/** Forem API のベース URL(design.md §5.7・§8「target … devto: API ホスト」)。 */
export const DEVTO_API_BASE_URL = 'https://dev.to';

/**
 * 既定の `DevtoHttpClient`。グローバル `fetch`(Node 20+ 標準搭載)を
 * `AbortSignal.timeout(DEVTO_HTTP_TIMEOUT_MS)` 付きで呼ぶ。`fetch` 自体が接続失敗で投げる
 * 例外はそのまま呼び出し元へ伝播させる(`isRetryableConnectionError` が判定に使う)。
 */
const defaultDevtoHttpClient: DevtoHttpClient = async ({
  method,
  url,
  headers,
  body,
}: DevtoHttpRequest): Promise<DevtoHttpResponse> => {
  const response = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(DEVTO_HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  return { status: response.status, body: text };
};

// ---------------------------------------------------------------------------
// 接続系エラーの判定(モジュール冒頭 JSDoc「接続系エラーの判定」参照)。
// ---------------------------------------------------------------------------

/** Node の `NodeJS.ErrnoException`(`code` を持つ)かどうかの型ガード(`src/lock.ts` と同じ)。 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * errno 系エラーのうち、接続レイヤの一時的失敗としてリトライしてよいコードの許可リスト。
 * `code` プロパティを持つだけの例外(アプリケーション例外や `SyntaxError` 等)を誤って
 * リトライ対象にしないため、既知の接続系コードに限定する。
 */
const RETRYABLE_ERRNO_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
]);

/**
 * 接続系エラー(タイムアウト・DNS 失敗・接続拒否等)かどうかを判定する。HTTP ステータスに
 * よる失敗はここに含めない(`assertOk` が別途、リトライしないエラーとして投げる)。
 * モジュール冒頭 JSDoc「接続系エラーの判定」参照。
 */
function isRetryableConnectionError(error: unknown): boolean {
  if (error instanceof TypeError) {
    return true;
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return true;
  }
  return (
    isErrnoException(error) && error.code !== undefined && RETRYABLE_ERRNO_CODES.has(error.code)
  );
}

/** エラーからログ/例外メッセージ用の文字列を取り出す(`src/sync.ts` の `errorMessage` と同じ形)。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// タグ制約(design.md §5.7「タグは先頭4個に切り詰め(超過時は警告ログ)」)。
// ---------------------------------------------------------------------------

/** dev.to が許可するタグの最大数(design.md §5.7)。 */
const DEVTO_MAX_TAGS = 4;

/**
 * タグ先頭の `#` を1つだけ除去する(`src/publishers/zenn.ts`/`src/publishers/qiita.ts` の
 * `stripLeadingHash` と同じ規約をミラーする。モジュール冒頭 JSDoc「タグの `#` 除去」参照)。
 */
function stripLeadingHash(tag: string): string {
  return tag.startsWith('#') ? tag.slice(1) : tag;
}

interface ResolveDevtoTagsParams {
  noteUuid: string;
  title: string;
  tags: readonly string[];
  logger: Logger | undefined;
}

/**
 * `#` を除去したうえで先頭4個へ切り詰める(design.md §5.7)。超過時は `service`/`noteUuid`/
 * `title` を伴う `logger.warn` を1件発行する(`src/publishers/qiita.ts` の
 * `resolveQiitaTags` と同じ警告の形)。
 */
function resolveDevtoTags(params: ResolveDevtoTagsParams): string[] {
  const { noteUuid, title, tags, logger } = params;
  const stripped = tags.map(stripLeadingHash);
  if (stripped.length <= DEVTO_MAX_TAGS) {
    return stripped;
  }
  const kept = stripped.slice(0, DEVTO_MAX_TAGS);
  logger?.warn({
    service: 'devto',
    noteUuid,
    title,
    message:
      `truncated tags from ${String(stripped.length)} to dev.to's limit of ` +
      `${String(DEVTO_MAX_TAGS)} (design.md §5.7): kept ${kept.map((tag) => JSON.stringify(tag)).join(', ')}`,
  });
  return kept;
}

// ---------------------------------------------------------------------------
// canonical_url の組み立て(モジュール冒頭 JSDoc「canonical_url の組み立て規約」参照)。
// ---------------------------------------------------------------------------

/** design.md §7 の `devto` ブロック(`api_key_env`/`canonical_base_url`)。 */
type DevtoConfig = NonNullable<Config['devto']>;

/**
 * `canonical_base_url`(末尾 `/` を1つ保証)+ ノート UUID を連結する。`canonical_base_url`
 * が未設定なら `undefined`(design.md §5.7「`canonical_url` は設定 `canonical_base_url` が
 * ある場合のみ含める」)。
 */
function buildCanonicalUrl(devtoConfig: DevtoConfig, noteUuid: string): string | undefined {
  if (devtoConfig.canonical_base_url === undefined) {
    return undefined;
  }
  const base = devtoConfig.canonical_base_url.endsWith('/')
    ? devtoConfig.canonical_base_url
    : `${devtoConfig.canonical_base_url}/`;
  return `${base}${noteUuid}`;
}

// ---------------------------------------------------------------------------
// Forem API のレスポンス解析。
// ---------------------------------------------------------------------------

/** `POST /api/articles` / `PUT /api/articles/{id}` の成功レスポンスから取り出す値。 */
interface DevtoArticleResponse {
  id: string;
  url: string | undefined;
}

/**
 * `response.body` を JSON として解析し、`id`(数値または文字列)・`url` を取り出す
 * (design.md §5.7「成功レスポンスの `id` を状態 JSON の `remoteId` に、`url` を `url` に
 * 保存する」)。`remoteId`(`NoteState.remoteId`)は文字列型のため `id` は文字列化する。
 */
function parseArticleResponse(body: string, noteUuid: string): DevtoArticleResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(
      `DevtoPublisher: could not parse the Forem API response JSON for note "${noteUuid}": ` +
        errorMessage(error),
      { cause: error },
    );
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(
      `DevtoPublisher: unexpected Forem API response shape for note "${noteUuid}" (not a JSON object)`,
    );
  }
  const record = parsed as Record<string, unknown>;
  const { id } = record;
  if (typeof id !== 'number' && typeof id !== 'string') {
    throw new Error(
      `DevtoPublisher: Forem API response is missing a numeric/string "id" for note "${noteUuid}"`,
    );
  }
  const { url } = record;
  return { id: String(id), url: typeof url === 'string' ? url : undefined };
}

/** タイトル照合(`GET /api/articles/me`)の1件分の最小限の形。 */
interface DevtoListedArticle {
  id: string;
  title: string;
}

/** `GET /api/articles/me` の1ページ分のレスポンスボディを解析する。 */
function parseArticleListResponse(body: string): DevtoListedArticle[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(
      `DevtoPublisher: could not parse the Forem API response JSON from GET /api/articles/me: ` +
        errorMessage(error),
      { cause: error },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('DevtoPublisher: expected a JSON array response from GET /api/articles/me');
  }
  return parsed.map((item, index) => {
    if (item === null || typeof item !== 'object') {
      throw new Error(
        `DevtoPublisher: unexpected item at index ${String(index)} in the GET /api/articles/me ` +
          'response (not a JSON object)',
      );
    }
    const record = item as Record<string, unknown>;
    const { id, title } = record;
    if ((typeof id !== 'number' && typeof id !== 'string') || typeof title !== 'string') {
      throw new Error(
        `DevtoPublisher: item at index ${String(index)} in the GET /api/articles/me response is ` +
          'missing a numeric/string "id" or a string "title"',
      );
    }
    return { id: String(id), title };
  });
}

/**
 * 2xx 以外のレスポンスを、トークンを含めない説明的なエラーとして投げる(design.md §5.7
 * 「Non-2xx → descriptive Error(no token in message)」)。ボディはログ肥大化・機微情報の
 * 意図しない露出を避けるため500文字で打ち切る。
 */
function assertOk(response: DevtoHttpResponse, description: string): void {
  if (response.status >= 200 && response.status < 300) {
    return;
  }
  const truncatedBody =
    response.body.length > 500 ? `${response.body.slice(0, 500)}…` : response.body;
  throw new Error(
    `DevtoPublisher: ${description} failed with HTTP ${String(response.status)}: ${truncatedBody}`,
  );
}

// ---------------------------------------------------------------------------
// Publisher 本体。
// ---------------------------------------------------------------------------

/** `createDevtoPublisher` のオプション。 */
export interface CreateDevtoPublisherOptions {
  /** 検証済み設定。`config.devto` が必須(`src/config.ts` の `devtoSchema` 参照)。 */
  config: Config;
  /** Forem API 呼び出しの注入点(テスト用)。既定は本物の `fetch`(`defaultDevtoHttpClient`)。 */
  httpClient?: DevtoHttpClient;
  /** ログ出力先(任意)。タグ切り詰め・複数一致時の警告に使う。 */
  logger?: Logger;
  /** 環境変数の参照元(`devto.api_key_env` の解決元、テスト用)。既定は `process.env`。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * `config.devto` の存在を検証して返す(`src/publishers/qiita.ts` の `requireQiitaConfig` と
 * 同じ防御パターン。`src/publishers/factory.ts` が `config.service === 'devto'` かつ
 * `config.devto !== undefined` を確認してから呼ぶ想定だが、念のため検証する)。
 */
function requireDevtoConfig(config: Config): DevtoConfig {
  if (config.devto === undefined) {
    throw new Error(
      `internal error: createDevtoPublisher requires config.devto (service "${config.service}" has none)`,
    );
  }
  return config.devto;
}

/** dev.to 記事のリクエストボディ(design.md §5.7 wire contract)。 */
interface DevtoArticleRequestBody {
  title: string;
  body_markdown: string;
  published: true;
  tags: string;
  canonical_url?: string;
}

/**
 * design.md §5.7 の wire contract どおりリクエストボディを組み立てる。
 * `canonical_url` は `buildCanonicalUrl` が `undefined` を返した場合、キー自体を含めない
 * (`JSON.stringify` は `undefined` 値のキーを出力しないため、明示的に条件分岐する)。
 */
function buildRequestBody(params: {
  title: string;
  bodyMarkdown: string;
  tagsCsv: string;
  canonicalUrl: string | undefined;
}): { article: DevtoArticleRequestBody } {
  const { title, bodyMarkdown, tagsCsv, canonicalUrl } = params;
  const article: DevtoArticleRequestBody = {
    title,
    body_markdown: bodyMarkdown,
    published: true,
    tags: tagsCsv,
  };
  if (canonicalUrl !== undefined) {
    article.canonical_url = canonicalUrl;
  }
  return { article };
}

/**
 * `POST`/`PUT` リクエストを送る。`retryOnConnectionError: true`(PUT のみ)の場合、接続系
 * エラー(`isRetryableConnectionError`)に限り1回だけ再送する(design.md §5.7「応答不明時の
 * 重複防止」)。HTTP ステータスによる失敗(`httpClient` が正常に応答を返した場合)は
 * ここでは扱わない——呼び出し元の `assertOk` がリトライせずエラーを投げる。
 */
async function sendArticleWrite(params: {
  httpClient: DevtoHttpClient;
  method: 'POST' | 'PUT';
  url: string;
  headers: Record<string, string>;
  body: string;
  noteUuid: string;
  retryOnConnectionError: boolean;
}): Promise<DevtoHttpResponse> {
  const { httpClient, method, url, headers, body, noteUuid, retryOnConnectionError } = params;
  const request: DevtoHttpRequest = { method, url, headers, body };
  try {
    return await httpClient(request);
  } catch (error) {
    if (!retryOnConnectionError || !isRetryableConnectionError(error)) {
      throw new Error(
        `DevtoPublisher: ${method} request to the Forem API failed for note "${noteUuid}" ` +
          `(connection-layer failure, design.md §5.7): ${errorMessage(error)}`,
        { cause: error },
      );
    }
    // 接続系エラーに限り1回だけ再試行する(design.md §5.7)。再試行後の失敗はそのまま伝播させる
    // (さらなる再試行はしない)。
    try {
      return await httpClient(request);
    } catch (retryError) {
      throw new Error(
        `DevtoPublisher: ${method} request to the Forem API failed for note "${noteUuid}" even ` +
          `after 1 retry (connection-layer failure, design.md §5.7): ${errorMessage(retryError)}`,
        { cause: retryError },
      );
    }
  }
}

/** `sendArticleWrite` のレスポンスを検証し `PublishResult` へ変換する。 */
function finalizeWriteResult(
  response: DevtoHttpResponse,
  result: 'created' | 'updated',
  noteUuid: string,
  description: string,
): PublishResult {
  assertOk(response, description);
  const { id, url } = parseArticleResponse(response.body, noteUuid);
  return { result, remoteId: id, url };
}

/**
 * Forem API の1ページあたりの最大件数。dev.to `per_page` の許容最大値(1000)を使い、
 * ページ数を最小化する。
 */
export const DEVTO_LIST_PAGE_SIZE = 1000;

/**
 * `GET /api/articles/me` を `page`/`per_page` でページングし尽くし、自分の記事一覧を全件
 * 取得する(design.md §5.7「自分の記事一覧 API からタイトル一致で検索」の下ごしらえ)。
 * 終了条件は「空ページが返った時点」とする。「件数が `per_page` 未満になったら最終ページ」
 * という判定は、サーバが `per_page` をクランプして要求より少ない件数を返す場合に
 * 途中で打ち切ってしまう(→ 照合漏れから重複 POST につながる)ため使わない。
 */
async function fetchAllArticles(
  httpClient: DevtoHttpClient,
  headers: Record<string, string>,
): Promise<DevtoListedArticle[]> {
  const items: DevtoListedArticle[] = [];
  let page = 1;
  for (;;) {
    const url = `${DEVTO_API_BASE_URL}/api/articles/me?page=${String(page)}&per_page=${String(DEVTO_LIST_PAGE_SIZE)}`;
    const response = await httpClient({ method: 'GET', url, headers });
    assertOk(response, 'GET /api/articles/me (title-match recovery)');
    const pageItems = parseArticleListResponse(response.body);
    if (pageItems.length === 0) {
      break;
    }
    items.push(...pageItems);
    page += 1;
  }
  return items;
}

/**
 * 複数一致(応答不明時の重複防止の照合で2件以上ヒット)を表す(design.md §5.7「複数一致の場合は
 * …そのノートを failed とし状態を更新しない」)。`src/sync.ts` の `processNote` がこの例外を
 * 捕捉し、当該ノートのみを `'failed'` として隔離する(`InvalidZennTypeError` と同じパターン)。
 */
export class DevtoAmbiguousTitleMatchError extends Error {
  /** 検証に失敗したノートの UUID。 */
  readonly noteUuid: string;
  /** 一致した dev.to 記事の件数(常に2以上)。 */
  readonly matchCount: number;

  constructor(noteUuid: string, title: string, matchCount: number) {
    super(
      `DevtoPublisher.publish: found ${String(matchCount)} existing dev.to articles with a title ` +
        `exactly matching note "${noteUuid}" (${JSON.stringify(title)}); refusing to guess which ` +
        'one corresponds to this note (design.md §5.7 "応答不明時の重複防止": 複数一致は failed ' +
        'とし状態を更新しない — manual resolution required)',
    );
    this.name = 'DevtoAmbiguousTitleMatchError';
    this.noteUuid = noteUuid;
    this.matchCount = matchCount;
  }
}

/**
 * design.md §5.7 DevtoPublisher を実装する `Publisher` を作る(T-22 / issue #27)。
 * API モードのため `prepare`/`finalize` は実装しない(モジュール冒頭 JSDoc)。
 *
 * `config.devto` が未定義の場合は即座に例外を投げる(`requireDevtoConfig`)。API キーは
 * `publish()` 呼び出し時(HTTP リクエストの直前)に `env[config.devto.api_key_env]` から
 * 読む——未設定なら HTTP 呼び出しを一切行わずに例外を投げる。値そのものはログ・エラー
 * メッセージに一切含めない(FR-30)。
 */
export function createDevtoPublisher(options: CreateDevtoPublisherOptions): Publisher {
  const { config, httpClient = defaultDevtoHttpClient, logger, env = process.env } = options;
  const devtoConfig = requireDevtoConfig(config);

  // 同一実行内での記事一覧のキャッシュ。remoteId 欠落ノートが N 件ある実行(初回同期等)で
  // ノートごとに全ページを取得し直すのを避け、リクエスト数を「全ページ1回分」に抑える。
  // 新規作成(POST)成功時はキャッシュへ追記し、同一実行内の後続ノートとの照合にも使う。
  let articleListCache: DevtoListedArticle[] | null = null;

  async function publish(article: RenderedArticle, prev: NoteState | null): Promise<PublishResult> {
    const apiKey = env[devtoConfig.api_key_env];
    if (apiKey === undefined || apiKey === '') {
      throw new Error(
        `DevtoPublisher.publish: environment variable "${devtoConfig.api_key_env}" ` +
          '(devto.api_key_env) is not set; cannot authenticate with the Forem API (design.md §5.7, FR-30)',
      );
    }
    if (article.bodyMarkdown === undefined) {
      throw new Error(
        `DevtoPublisher.publish: note "${article.noteUuid}" has no bodyMarkdown ` +
          '(renderDevtoArticle must set one; design.md §5.7)',
      );
    }

    // design.md §5.7 wire contract のヘッダ(3つ固定)。
    const headers: Record<string, string> = {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.forem.api-v1+json',
    };

    const tags = resolveDevtoTags({
      noteUuid: article.noteUuid,
      title: article.title,
      tags: article.tags ?? [],
      logger,
    });
    const canonicalUrl = buildCanonicalUrl(devtoConfig, article.noteUuid);
    const requestBody = JSON.stringify(
      buildRequestBody({
        title: article.title,
        bodyMarkdown: article.bodyMarkdown,
        tagsCsv: tags.join(','),
        canonicalUrl,
      }),
    );

    // design.md §5.7「`remoteId` の無いノートを新規作成する前に、既存記事の照合を行う」——
    // 逆に言えば `remoteId` があれば照合不要でそのまま更新してよい。
    if (prev !== null && prev.remoteId !== null) {
      const response = await sendArticleWrite({
        httpClient,
        method: 'PUT',
        url: `${DEVTO_API_BASE_URL}/api/articles/${prev.remoteId}`,
        headers,
        body: requestBody,
        noteUuid: article.noteUuid,
        retryOnConnectionError: true,
      });
      return finalizeWriteResult(response, 'updated', article.noteUuid, 'PUT /api/articles/{id}');
    }

    // design.md §5.7「ちょうど1件一致した場合のみその ID を remoteId に採用し、更新として
    // 配信する。0件なら記事は未作成と判断して新規作成する。複数一致の場合は…failed」。
    if (articleListCache === null) {
      articleListCache = await fetchAllArticles(httpClient, headers);
    }
    const matches = articleListCache.filter((item) => item.title === article.title);

    if (matches.length === 1) {
      const match = matches[0];
      if (match === undefined) {
        throw new Error('internal error: matches.length === 1 but matches[0] is undefined');
      }
      const response = await sendArticleWrite({
        httpClient,
        method: 'PUT',
        url: `${DEVTO_API_BASE_URL}/api/articles/${match.id}`,
        headers,
        body: requestBody,
        noteUuid: article.noteUuid,
        retryOnConnectionError: true,
      });
      return finalizeWriteResult(response, 'updated', article.noteUuid, 'PUT /api/articles/{id}');
    }

    if (matches.length >= 2) {
      logger?.warn({
        service: 'devto',
        noteUuid: article.noteUuid,
        title: article.title,
        message:
          `found ${String(matches.length)} existing dev.to articles with a title exactly matching ` +
          'this note (GET /api/articles/me); refusing to guess which one corresponds to this note ' +
          '— resolve manually (design.md §5.7 "応答不明時の重複防止")',
      });
      throw new DevtoAmbiguousTitleMatchError(article.noteUuid, article.title, matches.length);
    }

    // 0件: 新規作成。POST は自動リトライしない(design.md §5.7「新規作成(POST)は自動
    // リトライしない」——重複記事を作らないため)。
    const response = await sendArticleWrite({
      httpClient,
      method: 'POST',
      url: `${DEVTO_API_BASE_URL}/api/articles`,
      headers,
      body: requestBody,
      noteUuid: article.noteUuid,
      retryOnConnectionError: false,
    });
    const created = finalizeWriteResult(
      response,
      'created',
      article.noteUuid,
      'POST /api/articles',
    );
    // 作成成功をキャッシュに反映し、同一実行内の後続ノートの照合で「既に作成済み」と
    // 判定できるようにする(重複作成防止)。
    if (created.remoteId !== undefined && created.remoteId !== null) {
      articleListCache.push({ id: created.remoteId, title: article.title });
    }
    return created;
  }

  return { publish };
}
