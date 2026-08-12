import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import type { Logger, WarnPayload } from '../../src/logger.js';
import {
  createDevtoPublisher,
  DevtoAmbiguousTitleMatchError,
  DEVTO_API_BASE_URL,
  DEVTO_LIST_PAGE_SIZE,
  type DevtoHttpClient,
  type DevtoHttpRequest,
  type DevtoHttpResponse,
} from '../../src/publishers/devto.js';
import type { RenderedArticle } from '../../src/publishers/types.js';
import type { NoteState } from '../../src/state/store.js';

// ---------------------------------------------------------------------------
// テスト用ヘルパー(`test/publishers/git-repo.test.ts`/`test/publishers/qiita.test.ts` と
// 同じ「記録可能・応答をスクリプト可能なモック」パターンを踏襲する。vi.fn は使わない)。
// ---------------------------------------------------------------------------

const NOTE_UUID = '5c1c2c3d-0000-4000-8000-000000000001';

function buildConfig(overrides: { apiKeyEnv?: string; canonicalBaseUrl?: string } = {}): Config {
  const { apiKeyEnv = 'DEVTO_API_KEY', canonicalBaseUrl } = overrides;
  return {
    service: 'devto',
    timezone: 'Asia/Tokyo',
    source: { folders: ['tech'] },
    assets: {
      provider: 's3',
      bucket: 'blog-assets-devto',
      public_base_url: 'https://assets.example.com/notes/',
      access_key_id_env: 'DEVTO_S3_ACCESS_KEY_ID',
      secret_access_key_env: 'DEVTO_S3_SECRET_ACCESS_KEY',
    },
    devto: { api_key_env: apiKeyEnv, canonical_base_url: canonicalBaseUrl },
  };
}

function buildArticle(overrides: Partial<RenderedArticle> = {}): RenderedArticle {
  return {
    noteUuid: NOTE_UUID,
    title: 'Hello World',
    artifact: '---\ntitle: "Hello World"\ntags: []\n---\n\nbody text\n',
    contentHash: 'sha256:deadbeef',
    bodyMarkdown: 'body text\n',
    tags: ['typescript', 'webdev'],
    ...overrides,
  };
}

function buildPrevState(overrides: Partial<NoteState> = {}): NoteState {
  return {
    contentHash: 'sha256:previous',
    remoteId: null,
    firstPublishedAt: '2026-08-01T00:00:00+09:00',
    lastPublishedAt: '2026-08-01T00:00:00+09:00',
    ...overrides,
  };
}

function createFakeLogger(): { logger: Logger; warnings: WarnPayload[] } {
  const warnings: WarnPayload[] = [];
  const logger: Logger = {
    runStart: () => {},
    runEnd: () => {},
    exportDone: () => {},
    notePublished: () => {},
    noteSkipped: () => {},
    noteFailed: () => {},
    assetUploaded: () => {},
    warn: (payload) => {
      warnings.push(payload);
    },
  };
  return { logger, warnings };
}

interface RecordedCall {
  method: DevtoHttpRequest['method'];
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * 記録可能・応答をスクリプト可能なモック HTTP クライアント。`handler` が投げれば
 * `httpClient` 自体が reject する(接続系エラーの模擬)、返せばその応答を解決する。
 */
function makeMockHttpClient(
  handler: (call: RecordedCall) => DevtoHttpResponse | Promise<DevtoHttpResponse>,
): { client: DevtoHttpClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: DevtoHttpClient = async (request: DevtoHttpRequest) => {
    const call: RecordedCall = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
    };
    calls.push(call);
    return await handler(call);
  };
  return { client, calls };
}

function jsonResponse(status: number, value: unknown): DevtoHttpResponse {
  return { status, body: JSON.stringify(value) };
}

// ---------------------------------------------------------------------------
// テスト本体。
// ---------------------------------------------------------------------------

describe('createDevtoPublisher() construction', () => {
  it('has no prepare/finalize (API mode)', () => {
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: makeMockHttpClient(() => jsonResponse(200, {})).client,
      env: { DEVTO_API_KEY: 'token' },
    });
    expect(publisher.prepare).toBeUndefined();
    expect(publisher.finalize).toBeUndefined();
  });

  it('throws immediately when config.devto is undefined', () => {
    const config = { ...buildConfig(), devto: undefined };
    expect(() => createDevtoPublisher({ config })).toThrow(/config\.devto/);
  });
});

describe('publish() wire contract', () => {
  it('sends the exact request body/headers/URL for a new article (POST, 0 title matches)', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') {
        return jsonResponse(200, []);
      }
      return jsonResponse(201, { id: 555, url: 'https://dev.to/me/hello-world-abc' });
    });
    const publisher = createDevtoPublisher({
      config: buildConfig({ canonicalBaseUrl: 'https://example.com/articles' }),
      httpClient: client,
      env: { DEVTO_API_KEY: 'the-secret-token' },
    });
    const article = buildArticle({
      tags: ['#TypeScript', '#devto', '#webdev', '#note2web', '#extra'],
    });

    const result = await publisher.publish(article, null);

    const postCall = calls.find((call) => call.method === 'POST');
    if (postCall === undefined) {
      throw new Error('test setup: no POST call recorded');
    }
    expect(postCall.url).toBe(`${DEVTO_API_BASE_URL}/api/articles`);
    // design.md §5.7 wire contract: exactly these 3 headers, exact values.
    expect(postCall.headers).toEqual({
      'api-key': 'the-secret-token',
      'Content-Type': 'application/json',
      Accept: 'application/vnd.forem.api-v1+json',
    });
    const parsedBody: unknown = JSON.parse(postCall.body ?? 'null');
    expect(parsedBody).toEqual({
      article: {
        title: 'Hello World',
        body_markdown: 'body text\n',
        published: true,
        // "#" stripped, truncated to the first 4 (design.md §5.7).
        tags: 'TypeScript,devto,webdev,note2web',
        // canonical_base_url without a trailing "/" gets exactly one added, then the uuid.
        canonical_url: `https://example.com/articles/${NOTE_UUID}`,
      },
    });
    expect(result).toEqual({
      result: 'created',
      remoteId: '555',
      url: 'https://dev.to/me/hello-world-abc',
    });
  });

  it('omits canonical_url entirely when canonical_base_url is not configured', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return jsonResponse(200, []);
      return jsonResponse(201, { id: 1, url: 'https://dev.to/me/x' });
    });
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { DEVTO_API_KEY: 'token' },
    });

    await publisher.publish(buildArticle(), null);

    const postCall = calls.find((call) => call.method === 'POST');
    const parsedBody = JSON.parse(postCall?.body ?? 'null') as { article: Record<string, unknown> };
    expect(parsedBody.article).not.toHaveProperty('canonical_url');
  });

  it('warns with service/noteUuid/title when truncating more than 4 tags', async () => {
    const { client } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return jsonResponse(200, []);
      return jsonResponse(201, { id: 1, url: 'https://dev.to/me/x' });
    });
    const { logger, warnings } = createFakeLogger();
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: client,
      logger,
      env: { DEVTO_API_KEY: 'token' },
    });
    const article = buildArticle({
      noteUuid: 'note-under-test',
      title: 'Truncate Test',
      tags: ['#a', '#b', '#c', '#d', '#e'],
    });

    await publisher.publish(article, null);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      service: 'devto',
      noteUuid: 'note-under-test',
      title: 'Truncate Test',
    });
    expect(warnings[0]?.message).toMatch(/truncated/i);
  });

  it('does not warn when 4 or fewer tags are provided', async () => {
    const { client } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return jsonResponse(200, []);
      return jsonResponse(201, { id: 1, url: 'https://dev.to/me/x' });
    });
    const { logger, warnings } = createFakeLogger();
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: client,
      logger,
      env: { DEVTO_API_KEY: 'token' },
    });

    await publisher.publish(buildArticle({ tags: ['#a', '#b'] }), null);

    expect(warnings).toHaveLength(0);
  });

  it('updates via PUT to /api/articles/{remoteId} when prev.remoteId is present, without any title-match GET', async () => {
    const { client, calls } = makeMockHttpClient(() =>
      jsonResponse(200, { id: 42, url: 'https://dev.to/me/hello-42' }),
    );
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { DEVTO_API_KEY: 'token' },
    });

    const result = await publisher.publish(buildArticle(), buildPrevState({ remoteId: '42' }));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      url: `${DEVTO_API_BASE_URL}/api/articles/42`,
    });
    expect(result).toEqual({
      result: 'updated',
      remoteId: '42',
      url: 'https://dev.to/me/hello-42',
    });
  });
});

describe('publish() title-match recovery (design.md §5.7 "応答不明時の重複防止")', () => {
  it('adopts the id from exactly 1 title match and PUTs it (no POST)', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') {
        const page = new URL(call.url).searchParams.get('page');
        return jsonResponse(200, page === '1' ? [{ id: 7, title: 'Hello World' }] : []);
      }
      return jsonResponse(200, { id: 7, url: 'https://dev.to/me/hello-world' });
    });
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { DEVTO_API_KEY: 'token' },
    });

    const result = await publisher.publish(buildArticle({ title: 'Hello World' }), null);

    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    const putCall = calls.find((call) => call.method === 'PUT');
    expect(putCall?.url).toBe(`${DEVTO_API_BASE_URL}/api/articles/7`);
    expect(result).toEqual({
      result: 'updated',
      remoteId: '7',
      url: 'https://dev.to/me/hello-world',
    });
  });

  it('creates via POST when 0 title matches', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return jsonResponse(200, []);
      return jsonResponse(201, { id: 1, url: 'https://dev.to/me/x' });
    });
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { DEVTO_API_KEY: 'token' },
    });

    const result = await publisher.publish(buildArticle(), null);

    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    expect(result.result).toBe('created');
  });

  it('throws DevtoAmbiguousTitleMatchError on 2+ title matches, warns, and sends no write request', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') {
        const page = new URL(call.url).searchParams.get('page');
        return jsonResponse(
          200,
          page === '1'
            ? [
                { id: 1, title: 'Dup' },
                { id: 2, title: 'Dup' },
              ]
            : [],
        );
      }
      throw new Error('test setup: no write request should have been sent');
    });
    const { logger, warnings } = createFakeLogger();
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: client,
      logger,
      env: { DEVTO_API_KEY: 'token' },
    });

    await expect(
      publisher.publish(buildArticle({ noteUuid: 'dup-note', title: 'Dup' }), null),
    ).rejects.toThrow(DevtoAmbiguousTitleMatchError);

    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ service: 'devto', noteUuid: 'dup-note', title: 'Dup' });
  });

  it('ignores titles that only partially match (exact match required)', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') {
        const page = new URL(call.url).searchParams.get('page');
        return jsonResponse(200, page === '1' ? [{ id: 1, title: 'Hello World Extended' }] : []);
      }
      return jsonResponse(201, { id: 2, url: 'https://dev.to/me/x' });
    });
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { DEVTO_API_KEY: 'token' },
    });

    const result = await publisher.publish(buildArticle({ title: 'Hello World' }), null);

    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    expect(result.result).toBe('created');
  });

  it('paginates GET /api/articles/me with page/per_page until exhausted, finding a match beyond the first page', async () => {
    const page1Items = Array.from({ length: DEVTO_LIST_PAGE_SIZE }, (_, index) => ({
      id: index + 1,
      title: `Other Article ${String(index)}`,
    }));
    const page2Items = [{ id: 9999, title: 'Target Title' }];
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') {
        const url = new URL(call.url);
        expect(url.searchParams.get('per_page')).toBe(String(DEVTO_LIST_PAGE_SIZE));
        const page = url.searchParams.get('page');
        if (page === '1') return jsonResponse(200, page1Items);
        if (page === '2') return jsonResponse(200, page2Items);
        if (page === '3') return jsonResponse(200, []);
        throw new Error(`test setup: unexpected page "${String(page)}"`);
      }
      return jsonResponse(200, { id: 9999, url: 'https://dev.to/me/target-title' });
    });
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { DEVTO_API_KEY: 'token' },
    });

    const result = await publisher.publish(buildArticle({ title: 'Target Title' }), null);

    const getCalls = calls.filter((call) => call.method === 'GET');
    // 空ページ(3ページ目)を確認して初めて打ち切るため、GET は3回になる。
    expect(getCalls).toHaveLength(3);
    expect(result).toMatchObject({ result: 'updated', remoteId: '9999' });
  });

  it('keeps paginating when the server clamps per_page (first page smaller than requested)', async () => {
    // サーバが per_page をクランプし、1ページ目が DEVTO_LIST_PAGE_SIZE 未満でも
    // 「空ページが返るまで」走査を続け、2ページ目の一致を見つけられること。
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') {
        const page = new URL(call.url).searchParams.get('page');
        if (page === '1') return jsonResponse(200, [{ id: 1, title: 'Other Article' }]);
        if (page === '2') return jsonResponse(200, [{ id: 42, title: 'Target Title' }]);
        return jsonResponse(200, []);
      }
      return jsonResponse(200, { id: 42, url: 'https://dev.to/me/target-title' });
    });
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { DEVTO_API_KEY: 'token' },
    });

    const result = await publisher.publish(buildArticle({ title: 'Target Title' }), null);

    expect(calls.filter((call) => call.method === 'GET').length).toBeGreaterThanOrEqual(3);
    expect(result).toMatchObject({ result: 'updated', remoteId: '42' });
  });

  it('fetches the article list only once per run and reuses the cache for later notes', async () => {
    // 同一実行内(同一 Publisher インスタンス)では記事一覧の取得は1回だけで、
    // POST 成功後はキャッシュ追記により後続ノートの照合が「1件一致 → PUT」になる。
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return jsonResponse(200, []);
      if (call.method === 'POST') return jsonResponse(201, { id: 100, url: 'https://dev.to/me/a' });
      return jsonResponse(200, { id: 100, url: 'https://dev.to/me/a' });
    });
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { DEVTO_API_KEY: 'token' },
    });

    const first = await publisher.publish(
      buildArticle({ noteUuid: 'u1', title: 'Same Title' }),
      null,
    );
    const second = await publisher.publish(
      buildArticle({ noteUuid: 'u2', title: 'Same Title' }),
      null,
    );

    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(1);
    expect(first.result).toBe('created');
    // 1件目の作成がキャッシュへ反映され、同名の2件目は重複 POST ではなく更新になる。
    expect(second).toMatchObject({ result: 'updated', remoteId: '100' });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('serializes concurrent publishes: two same-title notes via Promise.all cause exactly 1 POST', async () => {
    // 並行呼び出しでも publish は内部で直列化されるため、両者が未初期化キャッシュを
    // 同時に観測して二重 POST する競合は起きない(2件目はキャッシュ一致で PUT になる)。
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return jsonResponse(200, []);
      if (call.method === 'POST') return jsonResponse(201, { id: 200, url: 'https://dev.to/me/b' });
      return jsonResponse(200, { id: 200, url: 'https://dev.to/me/b' });
    });
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { DEVTO_API_KEY: 'token' },
    });

    const [first, second] = await Promise.all([
      publisher.publish(buildArticle({ noteUuid: 'c1', title: 'Concurrent Title' }), null),
      publisher.publish(buildArticle({ noteUuid: 'c2', title: 'Concurrent Title' }), null),
    ]);

    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(first.result).toBe('created');
    expect(second).toMatchObject({ result: 'updated', remoteId: '200' });
  });
});

describe('publish() retry policy (design.md §5.7 "応答不明時の重複防止")', () => {
  it('does not retry POST on a connection-layer failure: exactly 1 request, error propagates', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return jsonResponse(200, []);
      throw new TypeError('fetch failed');
    });
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { DEVTO_API_KEY: 'token' },
    });

    await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(
      /connection-layer failure/,
    );
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('retries PUT exactly once on a connection-layer failure; propagates if the retry also fails', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'PUT') throw new TypeError('fetch failed');
      throw new Error('test setup: unexpected non-PUT call');
    });
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { DEVTO_API_KEY: 'token' },
    });

    await expect(
      publisher.publish(buildArticle(), buildPrevState({ remoteId: '9' })),
    ).rejects.toThrow(/connection-layer failure/);
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(2);
  });

  it('recovers when the retried PUT succeeds after 1 connection-layer failure', async () => {
    let attempts = 0;
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method !== 'PUT') {
        throw new Error('test setup: unexpected non-PUT call');
      }
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError('fetch failed');
      }
      return jsonResponse(200, { id: 9, url: 'https://dev.to/me/x' });
    });
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { DEVTO_API_KEY: 'token' },
    });

    const result = await publisher.publish(buildArticle(), buildPrevState({ remoteId: '9' }));

    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(2);
    expect(result).toEqual({ result: 'updated', remoteId: '9', url: 'https://dev.to/me/x' });
  });

  it('does not retry PUT on an HTTP-status failure (500): exactly 1 request, throws', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'PUT') return { status: 500, body: '{"error":"boom"}' };
      throw new Error('test setup: unexpected non-PUT call');
    });
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { DEVTO_API_KEY: 'token' },
    });

    await expect(
      publisher.publish(buildArticle(), buildPrevState({ remoteId: '9' })),
    ).rejects.toThrow(/HTTP 500/);
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
  });

  it('treats an errno-style connection error (e.g. ECONNRESET) on PUT as retryable', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method !== 'PUT') {
        throw new Error('test setup: unexpected non-PUT call');
      }
      const error = new Error('socket hang up') as NodeJS.ErrnoException;
      error.code = 'ECONNRESET';
      throw error;
    });
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { DEVTO_API_KEY: 'token' },
    });

    await expect(
      publisher.publish(buildArticle(), buildPrevState({ remoteId: '9' })),
    ).rejects.toThrow(/connection-layer failure/);
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(2);
  });
});

describe('publish() authentication (design.md §5.7, FR-30)', () => {
  it('throws when the configured api_key_env environment variable is not set, without any HTTP calls', async () => {
    const { client, calls } = makeMockHttpClient(() => {
      throw new Error('test setup: no HTTP call should have been made');
    });
    const publisher = createDevtoPublisher({
      config: buildConfig({ apiKeyEnv: 'DEVTO_API_KEY' }),
      httpClient: client,
      env: {}, // DEVTO_API_KEY not set
    });

    await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(/DEVTO_API_KEY/);
    expect(calls).toHaveLength(0);
  });

  it('throws when the configured api_key_env environment variable is set to an empty string', async () => {
    const { client, calls } = makeMockHttpClient(() => {
      throw new Error('test setup: no HTTP call should have been made');
    });
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { DEVTO_API_KEY: '' },
    });

    await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(/DEVTO_API_KEY/);
    expect(calls).toHaveLength(0);
  });

  it('reads the token from the environment variable named by devto.api_key_env (not a fixed name)', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return jsonResponse(200, []);
      return jsonResponse(201, { id: 1, url: 'https://dev.to/me/x' });
    });
    const publisher = createDevtoPublisher({
      config: buildConfig({ apiKeyEnv: 'MY_CUSTOM_DEVTO_TOKEN_VAR' }),
      httpClient: client,
      env: { MY_CUSTOM_DEVTO_TOKEN_VAR: 'the-actual-token' },
    });

    await publisher.publish(buildArticle(), null);

    const writeCall = calls.find((call) => call.method === 'POST');
    expect(writeCall?.headers['api-key']).toBe('the-actual-token');
  });

  it('never puts the api key in request URLs', async () => {
    const secretToken = 'super-secret-devto-token-value';
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return jsonResponse(200, []);
      return jsonResponse(201, { id: 1, url: 'https://dev.to/me/x' });
    });
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { DEVTO_API_KEY: secretToken },
    });

    await publisher.publish(buildArticle(), null);

    for (const call of calls) {
      expect(call.url).not.toContain(secretToken);
    }
  });

  it('never leaks the api key in a connection-failure error message', async () => {
    const secretToken = 'super-secret-devto-token-value';
    const { client } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return jsonResponse(200, []);
      throw new TypeError('fetch failed');
    });
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { DEVTO_API_KEY: secretToken },
    });

    try {
      await publisher.publish(buildArticle(), null);
      expect.unreachable('publish() should have thrown');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secretToken);
    }
  });

  it('never leaks the api key in an HTTP-status failure error message', async () => {
    const secretToken = 'super-secret-devto-token-value';
    const { client } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return jsonResponse(200, []);
      return { status: 401, body: 'Unauthorized' };
    });
    const publisher = createDevtoPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { DEVTO_API_KEY: secretToken },
    });

    try {
      await publisher.publish(buildArticle(), null);
      expect.unreachable('publish() should have thrown');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secretToken);
    }
  });
});
