/**
 * QiitaPublisher(design.md §5.7「QiitaPublisher」、FR-25/FR-30、T-21 / issue #26。
 * issue #82 で qiita-cli サブプロセス方式を廃止し、Qiita API v2 直叩き方式へ移行)。
 *
 * **背景(issue #82)**: 従来の実装は `@qiita/qiita-cli` を `npx --no-install qiita publish`
 * として子プロセス起動していた。しかし qiita-cli の `publish` コマンドは、対象ノートの
 * 投稿に先立って**利用者の Qiita 記事を無条件に全件同期する**(`node_modules/@qiita/qiita-cli/
 * dist/qiita-api/index.js` の実装。1ページ100件 × 最大100ページ = 最大10,000件を毎回取得)。
 * 投稿数の多いアカウントではこの全件同期だけで note2web の子プロセスタイムアウト(5分、
 * `src/subprocess.ts` `DEFAULT_TIMEOUTS.default`)を超過し、かつ記事本文一式がローカルの
 * qiita-cli ワークスペースへ丸ごとダウンロードされてしまう(ディスク肥大化・意図しない
 * データ保持)。本モジュールはこの問題を、dev.to(`src/publishers/devto.ts`)・
 * はてな(`src/publishers/hatena.ts`)と同じ「HTTP クライアントを注入できる薄い API 直叩き」
 * 方式へ置き換えることで解消する——qiita-cli サブプロセスは一切起動しない。
 *
 * **Qiita API v2 の wire contract(issue #82 のプランに基づく。`qiita-api/index.js` の実装で
 * 検証済み。公式ドキュメント https://qiita.com/api/v2/docs は本環境からアクセスできず未参照)**:
 *
 *   - 認証ヘッダ: `Authorization: Bearer <トークン>` / `Content-Type: application/json`
 *   - 新規: `POST https://qiita.com/api/v2/items`。更新: `PATCH https://qiita.com/api/v2/items/{item_id}`
 *     (`{item_id}` は状態 JSON の `remoteId`)
 *   - リクエストボディ(新規・更新共通): `{ body, title, tags: [{ name, versions: [] }], private }`。
 *     `private` は本ツールでは常に `false`(非公開投稿は対象外)
 *   - 成功レスポンスの `id`(文字列)→ `remoteId`、`url` → `url`
 *
 * **応答不明時の重複防止**は dev.to(`src/publishers/devto.ts`)と同じ規約に従う: HTTP
 * タイムアウト30秒。**新規作成(POST)は自動リトライしない**。更新(PATCH)は同一内容の
 * 再送が冪等なので、接続系エラーに限り1回だけ再試行してよい。**dev.to/はてなと異なり、
 * タイトル一致による既存記事の照合(「remoteId の無いノートを新規作成する前に一覧 API で
 * 探す」)は行わない**——issue #82 のプランが明示的に単純化した点で、`prev.remoteId` の
 * 有無だけで PATCH/POST を振り分ける(下記 `publishOnce` 参照)。
 *
 * **タグ制約(design.md §5.7)**: 1〜5個必須・スペース不可。`resolveQiitaTags` が
 * (1) 先頭の `#` を1つ除去(Zenn の `stripLeadingHash` と同じ規約) → (2) 半角スペースを
 * 含むタグを除外して警告 → (3) 除外後 6個以上なら先頭5個へ切り詰めて警告 → (4) 除外後 0個
 * なら `QiitaNoTagsRemainingError` を投げる、の順に処理する(issue #82 でも変更なし)。
 * (4) はレンダリング段で投げるため、`src/sync.ts` の `processNote` が当該ノートのみを
 * `'failed'` として隔離し、他ノートの処理は継続する(NFR-06。`renderZennArticle` の
 * `InvalidZennTypeError` と同じ扱い)。
 *
 * **`RenderedArticle` の使い方(dev.to と同じ形、`src/publishers/types.ts` 参照)**: Qiita は
 * frontmatter ファイルを書かない API モードのため、`renderQiitaArticle` は
 * `renderGenericArticle` 相当の最小限のエントリ(`title`/`tags`)を frontmatter 相当の
 * 文字列として組み立て、それを実際には書き出さずにハッシュ化のみに使う(`artifact`/
 * `contentHash`)。`bodyMarkdown`(変換済み本文そのもの)・`tags`(`resolveQiitaTags` 適用後の
 * 確定済みタグ列)を Publisher が API リクエストボディの組み立てにそのまま使う。
 * `artifactPath` は設定しない(API モードのためファイル出力を持たない)。
 *
 * **contentHash の入力(issue #82 で再定義)**: 旧実装は frontmatter に `remoteId`/
 * `updated_at`/`organization_url_name`/`slide`/`id` を含めていたため、初回配信後に
 * 状態が変わる(id が書き戻される)たびにハッシュも変わり、「1回の成功配信の直後ではなく
 * 2回目の配信を経て初めてハッシュが安定する」という直感に反する挙動があった
 * (旧 `test/integration.test.ts` のコメント参照)。新実装は dev.to
 * (`renderDevtoArticle`)と同じ方針で、`title` + タグ(`resolveQiitaTags` 適用後) + 変換済み
 * 本文 Markdown のみをハッシュ対象とし、`remoteId`/更新日時等の配信結果に左右される値は
 * 一切含めない——これにより「1回の成功配信で確定的にハッシュが安定する」という他6サービス
 * 共通の性質を Qiita にも取り戻す(README の移行注記も参照)。
 *
 * **HTTP クライアントの注入・タイムアウト・接続系エラーの判定・リトライ実装は
 * `src/publishers/devto.ts` をそのままミラーする**(dev.to/はてなの慣例どおり、共有
 * モジュールへ切り出さずローカルに複製する。挙動は完全に同一)。
 *
 * **API モードのため `prepare`/`finalize` は実装しない**(`src/publishers/types.ts` 冒頭
 * JSDoc「API/CLI 系 Publisher はこの2メソッドを実装しなくてよい」)。
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
// Renderer: タグ制約とエラー型(design.md §5.7、issue #82 でも変更なし)。
// ---------------------------------------------------------------------------

/** Qiita が許可するタグの最大数(design.md §5.7「1〜5個必須」)。 */
const QIITA_MAX_TAGS = 5;

/**
 * タグを除外・切り詰めた結果、0個になったことを表す(design.md §5.7「除外後0個ならそのノートは
 * 失敗扱い(エラーログ。タグを付けて再実行してもらう)」)。`src/sync.ts` の `processNote` が
 * `renderNote` 呼び出しを囲む try/catch で捕捉し、当該ノートのみを `'failed'` として隔離する
 * (`InvalidZennTypeError` と同じパターン)。
 */
export class QiitaNoTagsRemainingError extends Error {
  /** 検証に失敗したノートの UUID(ログでどのノートかを特定するため)。 */
  readonly noteUuid: string;

  constructor(noteUuid: string) {
    super(
      'Qiita requires at least 1 tag (1-5, no half-width spaces) after removing tags that ' +
        `contain a half-width space (design.md §5.7 QiitaPublisher); note "${noteUuid}" has ` +
        'none remaining — add at least one space-free tag and re-run',
    );
    this.name = 'QiitaNoTagsRemainingError';
    this.noteUuid = noteUuid;
  }
}

/**
 * タグ先頭の `#` を1つだけ除去する(`src/publishers/zenn.ts`/`devto.ts` の
 * `stripLeadingHash` と同じ規約をミラーする。design.md §5.7 はタグの `#` 除去そのものには
 * 触れていないが、Qiita のタグはハッシュタグ記法ではなくプレーンな語であるべきという判断は
 * Zenn の `topics` と同じ——`Note#tags` は先頭 `#` を含めたまま保持される、design.md §5.3
 * 「差分」節、FR-07)。
 */
function stripLeadingHash(tag: string): string {
  return tag.startsWith('#') ? tag.slice(1) : tag;
}

interface ResolveQiitaTagsParams {
  noteUuid: string;
  title: string;
  tags: readonly string[];
  logger: Logger | undefined;
}

/**
 * design.md §5.7 のタグ制約を順に適用する:
 * (1) 先頭の `#` を除去(除去後に空になったタグは除外して警告)
 * → (2) 半角スペースを含むタグを除外して警告
 * → (3) 除外後6個以上なら先頭5個に切り詰めて警告 → (4) 除外後0個なら
 * `QiitaNoTagsRemainingError`。警告は `service`/`noteUuid`/`title` を伴う `logger.warn`
 * イベントとして発行する(`src/logger.ts` `WarnPayload`)。
 */
function resolveQiitaTags(params: ResolveQiitaTagsParams): string[] {
  const { noteUuid, title, tags, logger } = params;
  const stripped = tags.map(stripLeadingHash);

  // `#` 除去後に空文字列となるタグ(元が `#` のみ等)は Qiita のタグとして成立しないため、
  // スペース含みタグと同様に除外して警告する。
  const empty = stripped.filter((tag) => tag.length === 0);
  if (empty.length > 0) {
    logger?.warn({
      service: 'qiita',
      noteUuid,
      title,
      message:
        `dropped ${String(empty.length)} tag(s) that became empty after stripping the ` +
        'leading "#" (design.md §5.7)',
    });
  }
  const nonEmpty = stripped.filter((tag) => tag.length > 0);

  const spaced = nonEmpty.filter((tag) => tag.includes(' '));
  let remaining = nonEmpty.filter((tag) => !tag.includes(' '));
  if (spaced.length > 0) {
    logger?.warn({
      service: 'qiita',
      noteUuid,
      title,
      message:
        `dropped ${String(spaced.length)} tag(s) containing a half-width space ` +
        `(Qiita rejects tags with spaces, design.md §5.7): ${spaced.map((tag) => JSON.stringify(tag)).join(', ')}`,
    });
  }

  if (remaining.length > QIITA_MAX_TAGS) {
    const kept = remaining.slice(0, QIITA_MAX_TAGS);
    logger?.warn({
      service: 'qiita',
      noteUuid,
      title,
      message:
        `truncated tags from ${String(remaining.length)} to Qiita's limit of ` +
        `${String(QIITA_MAX_TAGS)} (design.md §5.7): kept ${kept.map((tag) => JSON.stringify(tag)).join(', ')}`,
    });
    remaining = kept;
  }

  if (remaining.length === 0) {
    throw new QiitaNoTagsRemainingError(noteUuid);
  }

  return remaining;
}

// ---------------------------------------------------------------------------
// Renderer 本体。
// ---------------------------------------------------------------------------

/**
 * Qiita 向け `NoteRenderer`(design.md §5.7 QiitaPublisher 行、FR-25、T-21。issue #82 で
 * API モードへ移行)。dev.to(`renderDevtoArticle`)と同じ形——`title`/`tags`(タグ制約
 * 適用後)を frontmatter 相当のエントリとして含め、変換済み本文と連結してハッシュ化する
 * (`title`/`tags` のいずれかが変わればハッシュも変わり、再配信される)。この文字列
 * (`artifact`)は実際にはファイルへ書き出さない(API モードのため)。
 *
 * タグ制約(`resolveQiitaTags`)はレンダリング段で適用し、確定済みのタグ列を
 * `RenderedArticle.tags` にそのまま渡す——dev.to と異なり、Publisher 側での再加工
 * (`#` 除去・個数切り詰め)は行わない。`QiitaNoTagsRemainingError` をレンダリング段で
 * 投げる方針(モジュール冒頭 JSDoc 参照)は旧実装から変更していない。
 */
export const renderQiitaArticle: NoteRenderer = ({
  note,
  markdown,
  logger,
}: RenderNoteInput): RenderedArticle => {
  const tags = resolveQiitaTags({
    noteUuid: note.uuid,
    title: note.title,
    tags: note.tags,
    logger,
  });

  // renderGenericArticle/renderDevtoArticle と同じ最小限のエントリ(title/tags)で
  // 冪等判定用のハッシュを作る。実際には書き出さない(API モードのため)。
  const entries: FrontmatterEntry[] = [
    ['title', note.title],
    ['tags', tags],
  ];
  const artifact = renderArtifact(entries, markdown);
  const contentHash = computeContentHash(artifact);

  return {
    noteUuid: note.uuid,
    title: note.title,
    artifact,
    contentHash,
    bodyMarkdown: markdown,
    tags,
  };
};

// ---------------------------------------------------------------------------
// HTTP クライアントの注入点(`src/publishers/devto.ts` の `DevtoHttpClient` と同じ
// 注入パターン)。
// ---------------------------------------------------------------------------

/** Qiita API v2 へのリクエスト1件。 */
export interface QiitaHttpRequest {
  method: 'POST' | 'PATCH';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** Qiita API v2 のレスポンス。ステータスコードと生のボディ文字列のみを持つ最小限の形。 */
export interface QiitaHttpResponse {
  status: number;
  body: string;
}

/** Qiita API v2 呼び出しの注入点(テスト用)。既定は本物の `fetch`(`defaultQiitaHttpClient`)。 */
export type QiitaHttpClient = (request: QiitaHttpRequest) => Promise<QiitaHttpResponse>;

/** HTTP タイムアウト(dev.to/はてなと同じ30秒。issue #82 プラン)。 */
export const QIITA_HTTP_TIMEOUT_MS = 30_000;

/** Qiita API v2 のベース URL(issue #82 プラン)。 */
export const QIITA_API_BASE_URL = 'https://qiita.com';

/**
 * 既定の `QiitaHttpClient`。グローバル `fetch`(Node 20+ 標準搭載)を
 * `AbortSignal.timeout(QIITA_HTTP_TIMEOUT_MS)` 付きで呼ぶ。`fetch` 自体が接続失敗で投げる
 * 例外はそのまま呼び出し元へ伝播させる(`isRetryableConnectionError` が判定に使う)。
 */
const defaultQiitaHttpClient: QiitaHttpClient = async ({
  method,
  url,
  headers,
  body,
}: QiitaHttpRequest): Promise<QiitaHttpResponse> => {
  const response = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(QIITA_HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  return { status: response.status, body: text };
};

// ---------------------------------------------------------------------------
// 接続系エラーの判定(`src/publishers/devto.ts` のミラー)。
// ---------------------------------------------------------------------------

/** Node の `NodeJS.ErrnoException`(`code` を持つ)かどうかの型ガード(`src/lock.ts` と同じ)。 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * errno 系エラーのうち、接続レイヤの一時的失敗としてリトライしてよいコードの許可リスト
 * (`src/publishers/devto.ts` の `RETRYABLE_ERRNO_CODES` と同一)。
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
// Qiita API v2 のリクエストボディ組み立て・レスポンス解析。
// ---------------------------------------------------------------------------

/** `POST /api/v2/items` / `PATCH /api/v2/items/{item_id}` のリクエストボディ(issue #82 プラン)。 */
interface QiitaItemRequestBody {
  body: string;
  title: string;
  tags: { name: string; versions: string[] }[];
  private: boolean;
}

/**
 * issue #82 プランの wire contract どおりリクエストボディを組み立てる。タグは
 * `{ name, versions: [] }` の形へ変換する(`versions` は Qiita API の仕様上必須のフィールド
 * だが本ツールではバージョン管理を行わないため常に空配列)。`private` は常に `false`
 * (非公開投稿は対象外)。
 */
function buildQiitaRequestBody(params: {
  title: string;
  bodyMarkdown: string;
  tags: readonly string[];
}): QiitaItemRequestBody {
  const { title, bodyMarkdown, tags } = params;
  return {
    body: bodyMarkdown,
    title,
    tags: tags.map((name) => ({ name, versions: [] })),
    private: false,
  };
}

/** `POST /api/v2/items` / `PATCH /api/v2/items/{item_id}` の成功レスポンスから取り出す値。 */
interface QiitaArticleResponse {
  id: string;
  url: string | undefined;
}

/**
 * `response.body` を JSON として解析し、`id`(文字列)・`url` を取り出す(issue #82 プラン
 * 「成功レスポンスの `id` を状態 JSON の `remoteId` に、`url` を `url` に保存する」)。
 */
function parseQiitaArticleResponse(body: string, noteUuid: string): QiitaArticleResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(
      `QiitaPublisher: could not parse the Qiita API response JSON for note "${noteUuid}": ` +
        errorMessage(error),
      { cause: error },
    );
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(
      `QiitaPublisher: unexpected Qiita API response shape for note "${noteUuid}" (not a JSON object)`,
    );
  }
  const record = parsed as Record<string, unknown>;
  const { id } = record;
  if (typeof id !== 'string') {
    throw new Error(
      `QiitaPublisher: Qiita API response is missing a string "id" for note "${noteUuid}"`,
    );
  }
  const { url } = record;
  return { id, url: typeof url === 'string' ? url : undefined };
}

/**
 * 2xx 以外のレスポンスを、トークンを含めない説明的なエラーとして投げる(`src/publishers/
 * devto.ts` の `assertOk` と同じ形)。ボディはログ肥大化・機微情報の意図しない露出を避ける
 * ため500文字で打ち切る。
 */
function assertOk(response: QiitaHttpResponse, description: string): void {
  if (response.status >= 200 && response.status < 300) {
    return;
  }
  const truncatedBody =
    response.body.length > 500 ? `${response.body.slice(0, 500)}…` : response.body;
  throw new Error(
    `QiitaPublisher: ${description} failed with HTTP ${String(response.status)}: ${truncatedBody}`,
  );
}

// ---------------------------------------------------------------------------
// Publisher 本体。
// ---------------------------------------------------------------------------

/** `createQiitaPublisher` のオプション。 */
export interface CreateQiitaPublisherOptions {
  /** 検証済み設定。`config.qiita` が必須(`src/config.ts` の `qiitaSchema` 参照)。 */
  config: Config;
  /** Qiita API v2 呼び出しの注入点(テスト用)。既定は本物の `fetch`(`defaultQiitaHttpClient`)。 */
  httpClient?: QiitaHttpClient;
  /** ログ出力先(任意)。タグ切り詰め等の警告は Renderer 側(`renderQiitaArticle`)が使う。 */
  logger?: Logger;
  /** 環境変数の参照元(`qiita.token_env` の解決元、テスト用)。既定は `process.env`。 */
  env?: NodeJS.ProcessEnv;
}

/** design.md §7 の `qiita` ブロック(`token_env`。issue #82 で `workspace` を廃止)。 */
type QiitaConfig = NonNullable<Config['qiita']>;

/**
 * `config.qiita` の存在を検証して返す(`src/publishers/devto.ts` の `requireDevtoConfig` と
 * 同じ防御パターン。`src/publishers/factory.ts` が `config.service === 'qiita'` かつ
 * `config.qiita !== undefined` を確認してから呼ぶ想定だが、念のため検証する)。
 */
function requireQiitaConfig(config: Config): QiitaConfig {
  if (config.qiita === undefined) {
    throw new Error(
      `internal error: createQiitaPublisher requires config.qiita (service "${config.service}" has none)`,
    );
  }
  return config.qiita;
}

/**
 * `POST`/`PATCH` リクエストを送る。`retryOnConnectionError: true`(PATCH のみ)の場合、
 * 接続系エラー(`isRetryableConnectionError`)に限り1回だけ再送する(モジュール冒頭 JSDoc
 * 「応答不明時の重複防止」)。HTTP ステータスによる失敗(`httpClient` が正常に応答を返した
 * 場合)はここでは扱わない——呼び出し元の `assertOk` がリトライせずエラーを投げる。
 */
async function sendItemWrite(params: {
  httpClient: QiitaHttpClient;
  method: 'POST' | 'PATCH';
  url: string;
  headers: Record<string, string>;
  body: string;
  noteUuid: string;
  retryOnConnectionError: boolean;
}): Promise<QiitaHttpResponse> {
  const { httpClient, method, url, headers, body, noteUuid, retryOnConnectionError } = params;
  const request: QiitaHttpRequest = { method, url, headers, body };
  try {
    return await httpClient(request);
  } catch (error) {
    if (!retryOnConnectionError || !isRetryableConnectionError(error)) {
      // 接続系エラー(リトライ対象外の POST を含む)と、注入されたクライアントの実装
      // エラー等それ以外の例外とで文言を分ける(原因切り分けのため。PR #83 CodeRabbit
      // レビュー)。
      const kind = isRetryableConnectionError(error)
        ? 'connection-layer failure'
        : 'request failure';
      throw new Error(
        `QiitaPublisher: ${method} request to the Qiita API failed for note "${noteUuid}" ` +
          `(${kind}): ${errorMessage(error)}`,
        { cause: error },
      );
    }
    // 接続系エラーに限り1回だけ再試行する。再試行後の失敗はそのまま伝播させる
    // (さらなる再試行はしない)。
    try {
      return await httpClient(request);
    } catch (retryError) {
      throw new Error(
        `QiitaPublisher: ${method} request to the Qiita API failed for note "${noteUuid}" even ` +
          `after 1 retry (connection-layer failure): ${errorMessage(retryError)}`,
        { cause: retryError },
      );
    }
  }
}

/** `sendItemWrite` のレスポンスを検証し `PublishResult` へ変換する。 */
function finalizeWriteResult(
  response: QiitaHttpResponse,
  result: 'created' | 'updated',
  noteUuid: string,
  description: string,
): PublishResult {
  assertOk(response, description);
  const { id, url } = parseQiitaArticleResponse(response.body, noteUuid);
  return { result, remoteId: id, url };
}

/**
 * QiitaPublisher を実装する `Publisher` を作る(T-21 / issue #26。issue #82 で API 直叩き
 * 方式へ移行)。API モードのため `prepare`/`finalize` は実装しない(モジュール冒頭 JSDoc)。
 *
 * `config.qiita` が未定義の場合は即座に例外を投げる(`requireQiitaConfig`)。トークンは
 * `publish()` 呼び出し時(HTTP リクエストの直前)に `env[config.qiita.token_env]` から
 * 読む——未設定なら HTTP 呼び出しを一切行わずに例外を投げる。値そのものはログ・エラー
 * メッセージに一切含めない(FR-30)。
 *
 * `prev.remoteId` の有無だけで新規作成(POST)/更新(PATCH)を振り分ける(dev.to/はてなの
 * ような一覧 API でのタイトル一致照合は行わない。モジュール冒頭 JSDoc「応答不明時の
 * 重複防止」参照)。
 */
export function createQiitaPublisher(options: CreateQiitaPublisherOptions): Publisher {
  const { config, httpClient = defaultQiitaHttpClient, env = process.env } = options;
  const qiitaConfig = requireQiitaConfig(config);

  async function publish(article: RenderedArticle, prev: NoteState | null): Promise<PublishResult> {
    const token = env[qiitaConfig.token_env];
    if (token === undefined || token === '') {
      throw new Error(
        `QiitaPublisher.publish: environment variable "${qiitaConfig.token_env}" ` +
          '(qiita.token_env) is not set; cannot authenticate with the Qiita API (FR-30)',
      );
    }
    if (article.bodyMarkdown === undefined) {
      throw new Error(
        `QiitaPublisher.publish: note "${article.noteUuid}" has no bodyMarkdown ` +
          '(renderQiitaArticle must set one)',
      );
    }
    // 通常フローでは renderQiitaArticle(resolveQiitaTags)がタグ0個を
    // QiitaNoTagsRemainingError として弾くため、ここに空のタグ列は届かない。防御的に
    // Publisher 側でも 1〜QIITA_MAX_TAGS 個の範囲を検証し、契約外の RenderedArticle を
    // Qiita API のエラーより手前で明確に失敗させる(PR #83 CodeRabbit レビュー)。
    const tags = article.tags;
    if (tags === undefined || tags.length === 0 || tags.length > QIITA_MAX_TAGS) {
      throw new Error(
        `QiitaPublisher.publish: note "${article.noteUuid}" must carry 1-${String(QIITA_MAX_TAGS)} ` +
          `resolved tags (renderQiitaArticle must set them); got ${String(tags?.length ?? 'none')}`,
      );
    }

    // issue #82 プランの wire contract のヘッダ。
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const requestBody = JSON.stringify(
      buildQiitaRequestBody({
        title: article.title,
        bodyMarkdown: article.bodyMarkdown,
        tags,
      }),
    );

    if (prev !== null && prev.remoteId !== null) {
      const response = await sendItemWrite({
        httpClient,
        method: 'PATCH',
        // remoteId は通常 Qiita API の応答由来だが、状態 JSON は利用者が手で編集できる
        // (README の移行手順参照)。`/` 等を含む値でパスが意図しないエンドポイントへ
        // 変わらないよう、URL パスへ埋め込む前にエンコードする(PR #83 CodeRabbit レビュー)。
        url: `${QIITA_API_BASE_URL}/api/v2/items/${encodeURIComponent(prev.remoteId)}`,
        headers,
        body: requestBody,
        noteUuid: article.noteUuid,
        retryOnConnectionError: true,
      });
      return finalizeWriteResult(
        response,
        'updated',
        article.noteUuid,
        'PATCH /api/v2/items/{item_id}',
      );
    }

    // 0件: 新規作成。POST は自動リトライしない(モジュール冒頭 JSDoc「応答不明時の重複防止」
    // ——重複記事を作らないため)。
    const response = await sendItemWrite({
      httpClient,
      method: 'POST',
      url: `${QIITA_API_BASE_URL}/api/v2/items`,
      headers,
      body: requestBody,
      noteUuid: article.noteUuid,
      retryOnConnectionError: false,
    });
    return finalizeWriteResult(response, 'created', article.noteUuid, 'POST /api/v2/items');
  }

  return { publish };
}
