import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import {
  createQiitaPublisher,
  QIITA_API_BASE_URL,
  type QiitaHttpClient,
  type QiitaHttpRequest,
  type QiitaHttpResponse,
} from '../../src/publishers/qiita.js';
import type { RenderedArticle } from '../../src/publishers/types.js';
import type { NoteState } from '../../src/state/store.js';

// ---------------------------------------------------------------------------
// テスト用ヘルパー(`test/publishers/devto.test.ts` と同じ「記録可能・応答をスクリプト
// 可能なモック」パターンを踏襲する。vi.fn は使わない)。
// ---------------------------------------------------------------------------

const NOTE_UUID = '5c1c2c3d-0000-4000-8000-000000000001';

function buildConfig(overrides: { tokenEnv?: string } = {}): Config {
  const { tokenEnv = 'QIITA_TOKEN' } = overrides;
  return {
    service: 'qiita',
    timezone: 'Asia/Tokyo',
    source: { folders: ['tech'] },
    assets: {
      provider: 's3',
      bucket: 'blog-assets-qiita',
      public_base_url: 'https://assets.example.com/notes/',
      access_key_id_env: 'QIITA_S3_ACCESS_KEY_ID',
      secret_access_key_env: 'QIITA_S3_SECRET_ACCESS_KEY',
    },
    qiita: { token_env: tokenEnv },
  };
}

function buildArticle(overrides: Partial<RenderedArticle> = {}): RenderedArticle {
  return {
    noteUuid: NOTE_UUID,
    title: 'Hello World',
    artifact: '---\ntitle: "Hello World"\ntags: ["typescript"]\n---\n\nbody text\n',
    contentHash: 'sha256:deadbeef',
    bodyMarkdown: 'body text\n',
    tags: ['typescript', 'qiita'],
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

interface RecordedCall {
  method: QiitaHttpRequest['method'];
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * 記録可能・応答をスクリプト可能なモック HTTP クライアント。`handler` が投げれば
 * `httpClient` 自体が reject する(接続系エラーの模擬)、返せばその応答を解決する。
 */
function makeMockHttpClient(
  handler: (call: RecordedCall) => QiitaHttpResponse | Promise<QiitaHttpResponse>,
): { client: QiitaHttpClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: QiitaHttpClient = async (request: QiitaHttpRequest) => {
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

function jsonResponse(status: number, value: unknown): QiitaHttpResponse {
  return { status, body: JSON.stringify(value) };
}

// ---------------------------------------------------------------------------
// テスト本体。
// ---------------------------------------------------------------------------

describe('createQiitaPublisher() construction', () => {
  it('has no prepare/finalize (API mode)', () => {
    const publisher = createQiitaPublisher({
      config: buildConfig(),
      httpClient: makeMockHttpClient(() => jsonResponse(200, {})).client,
      env: { QIITA_TOKEN: 'token' },
    });
    expect(publisher.prepare).toBeUndefined();
    expect(publisher.finalize).toBeUndefined();
  });

  it('throws immediately when config.qiita is undefined', () => {
    const config = { ...buildConfig(), qiita: undefined };
    expect(() => createQiitaPublisher({ config })).toThrow(/config\.qiita/);
  });
});

describe('publish() wire contract', () => {
  it('sends the exact request body/headers/URL for a new article (POST, no prev)', async () => {
    const { client, calls } = makeMockHttpClient(() =>
      jsonResponse(201, { id: 'abc123', url: 'https://qiita.com/me/items/abc123' }),
    );
    const publisher = createQiitaPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { QIITA_TOKEN: 'the-secret-token' },
    });
    const article = buildArticle({ tags: ['typescript', 'qiita'] });

    const result = await publisher.publish(article, null);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) {
      throw new Error('test setup: no call recorded');
    }
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${QIITA_API_BASE_URL}/api/v2/items`);
    // issue #82 プランの wire contract: exactly these 2 headers, exact values.
    expect(call.headers).toEqual({
      Authorization: 'Bearer the-secret-token',
      'Content-Type': 'application/json',
    });
    const parsedBody: unknown = JSON.parse(call.body ?? 'null');
    expect(parsedBody).toEqual({
      body: 'body text\n',
      title: 'Hello World',
      tags: [
        { name: 'typescript', versions: [] },
        { name: 'qiita', versions: [] },
      ],
      private: false,
    });
    expect(result).toEqual({
      result: 'created',
      remoteId: 'abc123',
      url: 'https://qiita.com/me/items/abc123',
    });
  });

  it('updates via PATCH to /api/v2/items/{remoteId} when prev.remoteId is present', async () => {
    const { client, calls } = makeMockHttpClient(() =>
      jsonResponse(200, { id: 'existing-id', url: 'https://qiita.com/me/items/existing-id' }),
    );
    const publisher = createQiitaPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { QIITA_TOKEN: 'token' },
    });

    const result = await publisher.publish(
      buildArticle(),
      buildPrevState({ remoteId: 'existing-id' }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: `${QIITA_API_BASE_URL}/api/v2/items/existing-id`,
    });
    expect(result).toEqual({
      result: 'updated',
      remoteId: 'existing-id',
      url: 'https://qiita.com/me/items/existing-id',
    });
  });

  it('creates via POST when prev is null', async () => {
    const { client } = makeMockHttpClient(() =>
      jsonResponse(201, { id: 'new-id', url: 'https://qiita.com/me/items/new-id' }),
    );
    const publisher = createQiitaPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { QIITA_TOKEN: 'token' },
    });

    const result = await publisher.publish(buildArticle(), null);
    expect(result.result).toBe('created');
  });

  it('creates via POST when prev.remoteId is null (previously failed/unpublished)', async () => {
    const { client, calls } = makeMockHttpClient(() =>
      jsonResponse(201, { id: 'new-id', url: 'https://qiita.com/me/items/new-id' }),
    );
    const publisher = createQiitaPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { QIITA_TOKEN: 'token' },
    });

    const result = await publisher.publish(buildArticle(), buildPrevState({ remoteId: null }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(result.result).toBe('created');
  });

  it('sends exactly 1 request with no title-match lookup, unlike dev.to/hatena (issue #82 simplification)', async () => {
    const { client, calls } = makeMockHttpClient(() =>
      jsonResponse(201, { id: 'x', url: 'https://qiita.com/me/items/x' }),
    );
    const publisher = createQiitaPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { QIITA_TOKEN: 'token' },
    });

    await publisher.publish(buildArticle(), null);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
  });
});

describe('publish() retry policy', () => {
  it('does not retry POST on a connection-layer failure: exactly 1 request, error propagates', async () => {
    const { client, calls } = makeMockHttpClient(() => {
      throw new TypeError('fetch failed');
    });
    const publisher = createQiitaPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { QIITA_TOKEN: 'token' },
    });

    await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(
      /connection-layer failure/,
    );
    expect(calls).toHaveLength(1);
  });

  it('retries PATCH exactly once on a connection-layer failure; propagates if the retry also fails', async () => {
    const { client, calls } = makeMockHttpClient(() => {
      throw new TypeError('fetch failed');
    });
    const publisher = createQiitaPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { QIITA_TOKEN: 'token' },
    });

    await expect(
      publisher.publish(buildArticle(), buildPrevState({ remoteId: '9' })),
    ).rejects.toThrow(/even after 1 retry \(connection-layer failure\)/);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.method === 'PATCH')).toBe(true);
  });

  it('classifies a non-connection error thrown by the retried PATCH as "request failure", not "connection-layer failure"', async () => {
    // 1回目が接続系エラーでも、再試行(2回目)の例外が接続系とは限らない
    // (注入クライアントの実装エラー等)。文言は retryError 自身の判定で決まる
    // (PR #83 CodeRabbit レビュー)。
    let attempts = 0;
    const { client, calls } = makeMockHttpClient(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError('fetch failed');
      }
      throw new Error('mock client bug');
    });
    const publisher = createQiitaPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { QIITA_TOKEN: 'token' },
    });

    await expect(
      publisher.publish(buildArticle(), buildPrevState({ remoteId: '9' })),
    ).rejects.toThrow(/even after 1 retry \(request failure\)/);
    expect(calls).toHaveLength(2);
  });

  it('recovers when the retried PATCH succeeds after 1 connection-layer failure', async () => {
    let attempts = 0;
    const { client, calls } = makeMockHttpClient(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError('fetch failed');
      }
      return jsonResponse(200, { id: '9', url: 'https://qiita.com/me/items/9' });
    });
    const publisher = createQiitaPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { QIITA_TOKEN: 'token' },
    });

    const result = await publisher.publish(buildArticle(), buildPrevState({ remoteId: '9' }));

    expect(calls).toHaveLength(2);
    expect(result).toEqual({
      result: 'updated',
      remoteId: '9',
      url: 'https://qiita.com/me/items/9',
    });
  });

  it('does not retry PATCH on an HTTP-status failure (500): exactly 1 request, throws', async () => {
    const { client, calls } = makeMockHttpClient(() => ({
      status: 500,
      body: '{"error":"boom"}',
    }));
    const publisher = createQiitaPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { QIITA_TOKEN: 'token' },
    });

    await expect(
      publisher.publish(buildArticle(), buildPrevState({ remoteId: '9' })),
    ).rejects.toThrow(/HTTP 500/);
    expect(calls).toHaveLength(1);
  });

  it('treats an errno-style connection error (e.g. ECONNRESET) on PATCH as retryable', async () => {
    const { client, calls } = makeMockHttpClient(() => {
      const error = new Error('socket hang up') as NodeJS.ErrnoException;
      error.code = 'ECONNRESET';
      throw error;
    });
    const publisher = createQiitaPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { QIITA_TOKEN: 'token' },
    });

    await expect(
      publisher.publish(buildArticle(), buildPrevState({ remoteId: '9' })),
    ).rejects.toThrow(/connection-layer failure/);
    expect(calls).toHaveLength(2);
  });
});

describe('publish() authentication (FR-30)', () => {
  it('throws when the configured token_env environment variable is not set, without any HTTP calls', async () => {
    const { client, calls } = makeMockHttpClient(() => {
      throw new Error('test setup: no HTTP call should have been made');
    });
    const publisher = createQiitaPublisher({
      config: buildConfig({ tokenEnv: 'QIITA_TOKEN' }),
      httpClient: client,
      env: {}, // QIITA_TOKEN not set
    });

    await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(/QIITA_TOKEN/);
    expect(calls).toHaveLength(0);
  });

  it('throws when the configured token_env environment variable is set to an empty string', async () => {
    const { client, calls } = makeMockHttpClient(() => {
      throw new Error('test setup: no HTTP call should have been made');
    });
    const publisher = createQiitaPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { QIITA_TOKEN: '' },
    });

    await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(/QIITA_TOKEN/);
    expect(calls).toHaveLength(0);
  });

  it('reads the token from the environment variable named by qiita.token_env (not a fixed name)', async () => {
    const { client, calls } = makeMockHttpClient(() =>
      jsonResponse(201, { id: '1', url: 'https://qiita.com/me/items/1' }),
    );
    const publisher = createQiitaPublisher({
      config: buildConfig({ tokenEnv: 'MY_CUSTOM_QIITA_TOKEN_VAR' }),
      httpClient: client,
      env: { MY_CUSTOM_QIITA_TOKEN_VAR: 'the-actual-token' },
    });

    await publisher.publish(buildArticle(), null);

    expect(calls[0]?.headers.Authorization).toBe('Bearer the-actual-token');
  });

  it('never puts the token in request URLs', async () => {
    const secretToken = 'super-secret-qiita-token-value';
    const { client, calls } = makeMockHttpClient(() =>
      jsonResponse(201, { id: '1', url: 'https://qiita.com/me/items/1' }),
    );
    const publisher = createQiitaPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { QIITA_TOKEN: secretToken },
    });

    await publisher.publish(buildArticle(), null);

    for (const call of calls) {
      expect(call.url).not.toContain(secretToken);
    }
  });

  it('never leaks the token in a connection-failure error message', async () => {
    const secretToken = 'super-secret-qiita-token-value';
    const { client } = makeMockHttpClient(() => {
      throw new TypeError('fetch failed');
    });
    const publisher = createQiitaPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { QIITA_TOKEN: secretToken },
    });

    try {
      await publisher.publish(buildArticle(), null);
      expect.unreachable('publish() should have thrown');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secretToken);
    }
  });

  it('never leaks the token in an HTTP-status failure error message', async () => {
    const secretToken = 'super-secret-qiita-token-value';
    const { client } = makeMockHttpClient(() => ({ status: 401, body: 'Unauthorized' }));
    const publisher = createQiitaPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { QIITA_TOKEN: secretToken },
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

describe('publish() input validation', () => {
  it('throws when article.bodyMarkdown is undefined, without any HTTP calls', async () => {
    const { client, calls } = makeMockHttpClient(() => {
      throw new Error('test setup: no HTTP call should have been made');
    });
    const publisher = createQiitaPublisher({
      config: buildConfig(),
      httpClient: client,
      env: { QIITA_TOKEN: 'token' },
    });

    const article = buildArticle({ bodyMarkdown: undefined });
    await expect(publisher.publish(article, null)).rejects.toThrow(/bodyMarkdown/);
    expect(calls).toHaveLength(0);
  });
});
