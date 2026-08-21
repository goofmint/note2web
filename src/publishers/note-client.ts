/**
 * note.com 非公式 API クライアント(issue #86 Phase 2。CodeRabbit 実装プラン承認済み)。
 *
 * 出典は「note非公式APIを徹底調査|2026年版エンドポイント一覧完全版」
 * (https://note.com/marie_222/n/n6a10366298b0、以下「元記事」)。同記事の調査結果を wire
 * contract として扱う(本モジュールの JSDoc で引用する仕様はすべてこの記事に基づく)。
 *
 * **認証**: 全リクエストに `Cookie: _note_session_v5=<値>` を付与する。note.com へのプログラム
 * によるログインは reCAPTCHA v3 でブロックされているため、cookie の値は利用者がブラウザから
 * 手動で取得し、`note.session_cookie_env` が指す環境変数へ設定する(`src/publishers/note.ts`
 * 参照)。cookie の値そのものは常に `Cookie` ヘッダにのみ現れ、ログ・エラーメッセージ・例外
 * には一切含めない(`src/git-auth.ts` の秘匿情報の扱いと同じ規約)。
 *
 * **500 罠(元記事が報告する、空ボディだと 500 になる4項目)**: 本モジュール自身は罠1〜3
 * (`image_keys`/`lead_form`・`line_add_friend`/`body_length`)を関知しない——ペイロードの
 * 組み立ては呼び出し側(`src/publishers/note.ts`)の責務であり、本モジュールは組み立て済みの
 * ペイロードをそのまま JSON 化して送るだけ。罠4(`slug` 必須)も同様。
 *
 * **実機確認課題**: 元記事の調査はブラウザの DevTools ネットワークタブの観察に基づくもので、
 * 本タスクの実行環境には note.com アカウントも実ブラウザも無く実機検証はできていない。次の
 * 項目は実装を1箇所に閉じ込めてあり、実機確認で書式が異なると判明した場合はそこだけを
 * 差し替えればよい:
 *   (b) 書き込み系リクエストに追加ヘッダが要るか — `buildNoteHeaders` に `Origin`/`Referer`/
 *       `X-Requested-With` を固定で付与している(一箇所に集約)
 *   (c) presigned レスポンスから `<KEY>` を導出する方法 — `deriveImageKey` に分離してある
 */

// ---------------------------------------------------------------------------
// HTTP クライアントの注入点(`src/publishers/devto.ts` の `DevtoHttpClient` と同じ注入
// パターン)。
// ---------------------------------------------------------------------------

/** note.com API へのリクエスト1件。`body` は JSON 文字列、または S3 マルチポストの `FormData`。 */
export interface NoteHttpRequest {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers: Record<string, string>;
  body?: string | FormData;
}

/** note.com API のレスポンス。ステータスコードと生のボディ文字列のみを持つ最小限の形。 */
export interface NoteHttpResponse {
  status: number;
  body: string;
}

/** note.com API 呼び出しの注入点(テスト用)。既定は本物の `fetch`(`defaultNoteHttpClient`)。 */
export type NoteHttpClient = (request: NoteHttpRequest) => Promise<NoteHttpResponse>;

/** HTTP タイムアウト(`src/publishers/devto.ts` の `DEVTO_HTTP_TIMEOUT_MS` と同じ30秒)。 */
export const NOTE_HTTP_TIMEOUT_MS = 30_000;

/** note.com のベース URL(元記事のエンドポイントはすべてこのホスト配下)。 */
export const NOTE_API_BASE_URL = 'https://note.com';

/**
 * 既定の `NoteHttpClient`。グローバル `fetch`(Node 20+ 標準搭載)を
 * `AbortSignal.timeout(NOTE_HTTP_TIMEOUT_MS)` 付きで呼ぶ。`body` が `FormData` の場合、
 * `fetch` 自身がマルチパートの `Content-Type`(boundary 込み)を自動設定するため、
 * こちらから `Content-Type` は一切指定しない。
 */
export const defaultNoteHttpClient: NoteHttpClient = async ({
  method,
  url,
  headers,
  body,
}: NoteHttpRequest): Promise<NoteHttpResponse> => {
  const response = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(NOTE_HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  return { status: response.status, body: text };
};

// ---------------------------------------------------------------------------
// 接続系エラーの判定(`src/publishers/devto.ts` のミラー。dev.to/Qiita/はてなと同じ
// ローカル複製の慣習)。
// ---------------------------------------------------------------------------

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

const RETRYABLE_ERRNO_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
]);

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// 認証エラー。
// ---------------------------------------------------------------------------

/**
 * note.com への認証が成立していない(401/403 相当)ことを表す。cookie の値は絶対に含めず、
 * ブラウザでの再取得手順のみをメッセージに含める(FR-30 と同じ秘匿情報の扱い)。
 */
export class NoteAuthError extends Error {
  constructor(description: string, status: number) {
    super(
      `NoteClient: ${description} failed with HTTP ${String(status)} (not authenticated with ` +
        'note.com). The session cookie has likely expired or was never valid. Re-acquire it: ' +
        'ブラウザで note.com にログイン → DevTools → Application → Cookies → ' +
        '`_note_session_v5` の値を env ファイルへ(note.session_cookie_env が指す環境変数に設定)。',
    );
    this.name = 'NoteAuthError';
  }
}

/**
 * 2xx 以外のレスポンスを検証する。401/403 は `NoteAuthError`(cookie の再取得を促す)、
 * それ以外は cookie を含まない説明的な `Error`(`src/publishers/devto.ts` の `assertOk` と
 * 同じ形。ボディは500文字で打ち切る)。
 */
function assertNoteApiOk(response: NoteHttpResponse, description: string): void {
  if (response.status >= 200 && response.status < 300) {
    return;
  }
  if (response.status === 401 || response.status === 403) {
    throw new NoteAuthError(description, response.status);
  }
  const truncatedBody =
    response.body.length > 500 ? `${response.body.slice(0, 500)}…` : response.body;
  throw new Error(
    `NoteClient: ${description} failed with HTTP ${String(response.status)}: ${truncatedBody}`,
  );
}

// ---------------------------------------------------------------------------
// ヘッダ組み立て(実機確認課題 (b): 追加ヘッダの要否を一箇所に集約)。
// ---------------------------------------------------------------------------

/**
 * 全リクエスト共通のヘッダを組み立てる(`Cookie` + 実機確認課題(b)の追加ヘッダ)。
 * cookie の値は `Cookie` ヘッダ以外(argv・ログ・例外メッセージ等)には一切現れない。
 */
function buildNoteHeaders(
  cookie: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Cookie: `_note_session_v5=${cookie}`,
    // 実機確認課題(b): 書き込み系エンドポイントがこれらのヘッダを要求するかは未確認。
    // ブラウザからの通常アクセスを模す一般的なヘッダとして固定で付与する。
    Origin: 'https://note.com',
    Referer: 'https://note.com/',
    'X-Requested-With': 'XMLHttpRequest',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 送信(リトライ規約): PUT(publishNote)は接続系エラーに限り1回だけ再試行してよい。
// POST(create/presigned/S3)は自動リトライしない(devto.ts「応答不明時の重複防止」と同じ
// 方針。draft 予約・画像アップロードは非冪等な「作成」操作のため)。
// ---------------------------------------------------------------------------

async function sendNoteRequest(params: {
  httpClient: NoteHttpClient;
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers: Record<string, string>;
  body?: string | FormData;
  retryOnConnectionError: boolean;
  description: string;
}): Promise<NoteHttpResponse> {
  const { httpClient, method, url, headers, body, retryOnConnectionError, description } = params;
  const request: NoteHttpRequest = { method, url, headers, body };
  try {
    return await httpClient(request);
  } catch (error) {
    if (!retryOnConnectionError || !isRetryableConnectionError(error)) {
      throw new Error(
        `NoteClient: ${description} failed (connection-layer failure): ${errorMessage(error)}`,
        { cause: error },
      );
    }
    try {
      return await httpClient(request);
    } catch (retryError) {
      throw new Error(
        `NoteClient: ${description} failed even after 1 retry (connection-layer failure): ` +
          `${errorMessage(retryError)}`,
        { cause: retryError },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// レスポンス解析。
// ---------------------------------------------------------------------------

function parseJsonBody(body: string, description: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(
      `NoteClient: could not parse the JSON response for ${description}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function asRecord(value: unknown, description: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    throw new Error(`NoteClient: unexpected response shape for ${description} (not a JSON object)`);
  }
  return value as Record<string, unknown>;
}

/** `POST /api/v1/text_notes`(draft 予約)の成功レスポンスから取り出す値。 */
export interface NoteDraft {
  /** 数値記事 ID(状態 JSON の `remoteId` として文字列化して保存する)。 */
  id: string;
  /** note key(`n...`。記事 URL `https://note.com/<user>/n/<key>` の末尾セグメント)。 */
  key: string;
}

function parseDraftResponse(body: string): NoteDraft {
  const record = asRecord(
    parseJsonBody(body, 'POST /api/v1/text_notes'),
    'POST /api/v1/text_notes',
  );
  const { id, key } = record;
  if (typeof id !== 'number' && typeof id !== 'string') {
    throw new Error('NoteClient: draft-reserve response is missing a numeric/string "id"');
  }
  if (typeof key !== 'string' || key === '') {
    throw new Error('NoteClient: draft-reserve response is missing a non-empty string "key"');
  }
  return { id: String(id), key };
}

/** `GET /api/v2/current_user` から取り出す値。 */
export interface NoteCurrentUser {
  /** 記事 URL の組み立てに使う urlname(`https://note.com/<urlname>/n/<key>`)。 */
  urlname: string;
}

/**
 * `GET /api/v2/current_user` のレスポンスを解析する。元記事は具体的な JSON 構造までは
 * 示していないため、よくある `{ data: { urlname } }` の入れ子と、フラットな `{ urlname }`
 * の両方を許容する(寛容な解析。実機確認課題ではあるが、どちらであってもこの1関数を
 * 差し替えるだけで対応できる)。
 */
function parseCurrentUserResponse(body: string): NoteCurrentUser {
  const record = asRecord(
    parseJsonBody(body, 'GET /api/v2/current_user'),
    'GET /api/v2/current_user',
  );
  const nested = record.data;
  const candidate =
    nested !== null && typeof nested === 'object' ? (nested as Record<string, unknown>) : record;
  const { urlname } = candidate;
  if (typeof urlname !== 'string' || urlname === '') {
    throw new Error(
      'NoteClient: GET /api/v2/current_user response is missing a non-empty string "urlname" ' +
        '(checked both a top-level and a "data"-nested field)',
    );
  }
  return { urlname };
}

/** presigned POST 発行(`POST /api/v3/images/upload/presigned_post`)のレスポンス。 */
interface NotePresignedPost {
  /** S3 側のアップロード先 URL(ここへ `post` の全フィールド + `file` をマルチポストする)。 */
  action: string;
  /** S3 の POST ポリシー用フィールド一式(`x-amz-security-token` を含む。順序保持のため Map)。 */
  post: Map<string, string>;
}

function parsePresignedPostResponse(body: string): NotePresignedPost {
  const record = asRecord(
    parseJsonBody(body, 'POST /api/v3/images/upload/presigned_post'),
    'POST /api/v3/images/upload/presigned_post',
  );
  const data = record.data;
  if (data === null || typeof data !== 'object') {
    throw new Error('NoteClient: presigned_post response is missing a "data" object');
  }
  const { action, post } = data as Record<string, unknown>;
  if (typeof action !== 'string' || action === '') {
    throw new Error(
      'NoteClient: presigned_post response is missing a non-empty string "data.action"',
    );
  }
  if (post === null || typeof post !== 'object') {
    throw new Error('NoteClient: presigned_post response is missing a "data.post" object');
  }
  const postFields = new Map<string, string>();
  for (const [key, value] of Object.entries(post as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new Error(
        `NoteClient: presigned_post response field "data.post.${key}" is not a string`,
      );
    }
    postFields.set(key, value);
  }
  return { action, post: postFields };
}

// ---------------------------------------------------------------------------
// 実機確認課題 (c): presigned レスポンスから <KEY> を導出する。
// ---------------------------------------------------------------------------

/**
 * presigned POST の `data.post.key`(S3 オブジェクトキー、例
 * `uploads/images/.../img/<KEY>.<ext>`)から、本文 HTML に埋め込む
 * `https://assets.st-note.com/img/<KEY>` の `<KEY>` を導出する(500 罠には数えないが、
 * 元記事はこの導出方法自体を明記していないため実機確認課題として1関数に閉じ込める)。
 *
 * 初期実装: 末尾の `img/` 以降を `<KEY>` とみなす(最後の出現を使う——ネストしたパスに
 * `img/` が複数回現れても、実際のファイル名に最も近い区切りを優先するため)。`img/` が
 * 含まれない場合はパスの basename(最後の `/` 以降)を `<KEY>` とみなす。実機確認で異なる
 * 導出規則が判明した場合、この関数だけを差し替えればよい。
 */
export function deriveImageKey(postKey: string): string {
  const marker = 'img/';
  const index = postKey.lastIndexOf(marker);
  if (index !== -1) {
    return postKey.slice(index + marker.length);
  }
  const segments = postKey.split('/');
  return segments[segments.length - 1] ?? postKey;
}

// ---------------------------------------------------------------------------
// 公開ペイロード(呼び出し側 `src/publishers/note.ts` が組み立てる wire 形状)。
// ---------------------------------------------------------------------------

/**
 * `PUT /api/v1/text_notes/{id}` のリクエストボディ(元記事の項目一覧どおり)。新規公開・
 * 既存記事の更新の**両方**でこの同じ形を送る(差分 API は無く、常にフルペイロード)。
 */
export interface NotePublishPayload {
  status: 'published';
  name: string;
  free_body: string;
  pay_body: string;
  separator: string;
  price: number;
  slug: string;
  body_length: number;
  hashtags: readonly { name: string }[];
  image_keys: readonly string[];
  magazine_ids: readonly string[];
  magazine_keys: readonly string[];
  disable_comment: boolean;
  limited: boolean;
  is_refund: boolean;
  index: boolean;
  exclude_from_creator_top: boolean;
  exclude_ai_learning_reward: boolean;
  send_notifications_flag: boolean;
  author_ids: readonly string[];
  circle_permissions: readonly unknown[];
  discount_campaigns: readonly unknown[];
  lead_form: { is_active: false; consent_url: string };
  line_add_friend: { is_active: false; keyword: string; add_friend_url: string };
  line_add_friend_access_token: string;
  pro_coupon_keys: readonly string[];
}

// ---------------------------------------------------------------------------
// ラッパー関数(いずれも呼び出しごとに cookie を受け取る。`src/publishers/note.ts` が
// `env[config.note.session_cookie_env]` を publish() のたびに読んで渡す)。
// ---------------------------------------------------------------------------

/**
 * `POST /api/v1/text_notes`(空ボディ)で下書きを予約する(元記事)。応答の `id`/`key` から
 * 記事 ID とスラグ用の note key が確定する。POST は自動リトライしない。
 */
export async function createDraft(httpClient: NoteHttpClient, cookie: string): Promise<NoteDraft> {
  const response = await sendNoteRequest({
    httpClient,
    method: 'POST',
    url: `${NOTE_API_BASE_URL}/api/v1/text_notes`,
    headers: buildNoteHeaders(cookie),
    body: undefined,
    retryOnConnectionError: false,
    description: 'POST /api/v1/text_notes (draft reserve)',
  });
  assertNoteApiOk(response, 'POST /api/v1/text_notes (draft reserve)');
  return parseDraftResponse(response.body);
}

/**
 * `PUT /api/v1/text_notes/{id}` にフルペイロードを送り、記事を公開(または既存記事を更新)
 * する(元記事「差分 API は無く常にフルペイロード」)。接続系エラーに限り1回だけ再試行する
 * (PUT は同一内容の再送が冪等なため、`src/publishers/devto.ts` と同じ方針)。
 */
export async function publishNote(
  httpClient: NoteHttpClient,
  cookie: string,
  id: string,
  payload: NotePublishPayload,
): Promise<void> {
  const description = `PUT /api/v1/text_notes/${id} (publish)`;
  const response = await sendNoteRequest({
    httpClient,
    method: 'PUT',
    url: `${NOTE_API_BASE_URL}/api/v1/text_notes/${encodeURIComponent(id)}`,
    headers: buildNoteHeaders(cookie, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
    retryOnConnectionError: true,
    description,
  });
  assertNoteApiOk(response, description);
}

/**
 * `GET /api/v2/current_user` でログイン状態を確認し、記事 URL 組み立てに使う `urlname` を
 * 取得する(元記事)。401/403 は `NoteAuthError` になるため、認証チェックとしても機能する。
 */
export async function getCurrentUser(
  httpClient: NoteHttpClient,
  cookie: string,
): Promise<NoteCurrentUser> {
  const description = 'GET /api/v2/current_user';
  const response = await sendNoteRequest({
    httpClient,
    method: 'GET',
    url: `${NOTE_API_BASE_URL}/api/v2/current_user`,
    headers: buildNoteHeaders(cookie),
    body: undefined,
    retryOnConnectionError: false,
    description,
  });
  assertNoteApiOk(response, description);
  return parseCurrentUserResponse(response.body);
}

/**
 * 画像(本文)を2段階でアップロードする(元記事): (1)
 * `POST /api/v3/images/upload/presigned_post` で S3 の presigned POST フィールドを取得、
 * (2) `data.post.*` の全フィールドを**受け取った順序のまま**マルチポートフォームへコピーし
 * (`x-amz-security-token` の欠落は 403 InvalidAccessKeyId になるため必須)、`file` パートを
 * **最後**に追加して `data.action`(S3 URL)へ POST する。成功は 204(または他の 2xx)。
 * いずれの POST も自動リトライしない(モジュール冒頭「送信」節参照)。
 */
export async function uploadImage(
  httpClient: NoteHttpClient,
  cookie: string,
  bytes: Uint8Array,
  filename: string,
  contentType: string,
): Promise<{ key: string }> {
  const presignedResponse = await sendNoteRequest({
    httpClient,
    method: 'POST',
    url: `${NOTE_API_BASE_URL}/api/v3/images/upload/presigned_post`,
    headers: buildNoteHeaders(cookie, { 'Content-Type': 'application/json' }),
    body: '{}',
    retryOnConnectionError: false,
    description: 'POST /api/v3/images/upload/presigned_post',
  });
  assertNoteApiOk(presignedResponse, 'POST /api/v3/images/upload/presigned_post');
  const presigned = parsePresignedPostResponse(presignedResponse.body);

  const form = new FormData();
  // `data.post` の全フィールドを受け取った順序のまま先にコピーし、`file` を最後に追加する
  // (元記事。S3 の POST ポリシーはフィールドの並び順に依存しうるため、Map の挿入順=
  // レスポンス JSON のキー順をそのまま使う)。
  for (const [key, value] of presigned.post) {
    form.append(key, value);
  }
  // `bytes` は `Uint8Array<ArrayBufferLike>`(呼び出し元の `Buffer` 含む)として渡ってきうる
  // ため、`BlobPart` が要求する `ArrayBuffer` 裏付けの型へ明示的にコピーする(TS の型不一致
  // 回避。`Buffer` の下層が `SharedArrayBuffer` になり得る lib.dom.d.ts の型定義に合わせる)。
  form.append('file', new Blob([new Uint8Array(bytes)], { type: contentType }), filename);

  const uploadDescription = `POST ${presigned.action} (S3 image upload)`;
  const uploadResponse = await sendNoteRequest({
    httpClient,
    method: 'POST',
    url: presigned.action,
    headers: {},
    body: form,
    retryOnConnectionError: false,
    description: uploadDescription,
  });
  if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
    const truncatedBody =
      uploadResponse.body.length > 500
        ? `${uploadResponse.body.slice(0, 500)}…`
        : uploadResponse.body;
    throw new Error(
      `NoteClient: ${uploadDescription} failed with HTTP ${String(uploadResponse.status)}: ${truncatedBody}`,
    );
  }

  const postKey = presigned.post.get('key');
  if (postKey === undefined) {
    throw new Error(
      'NoteClient: presigned_post response "data.post" is missing the "key" field needed to ' +
        'derive the uploaded image key (deriveImageKey)',
    );
  }
  return { key: deriveImageKey(postKey) };
}
