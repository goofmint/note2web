import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import type { Logger, WarnPayload } from '../../src/logger.js';
import {
  createHatenaPublisher,
  HatenaAmbiguousTitleMatchError,
  type HatenaHttpClient,
  type HatenaHttpRequest,
  type HatenaHttpResponse,
} from '../../src/publishers/hatena.js';
import type { RenderedArticle } from '../../src/publishers/types.js';
import type { NoteState } from '../../src/state/store.js';

// ---------------------------------------------------------------------------
// テスト用ヘルパー(`test/publishers/devto.test.ts` と同じ「記録可能・応答をスクリプト
// 可能なモック」パターンを踏襲する。vi.fn は使わない)。
// ---------------------------------------------------------------------------

const NOTE_UUID = '5c1c2c3d-0000-4000-8000-000000000001';
const HATENA_ID = 'example';
const BLOG_ID = 'example.hatenablog.com';
const COLLECTION_URI = `https://blog.hatena.ne.jp/${HATENA_ID}/${BLOG_ID}/atom/entry`;

function buildConfig(overrides: { apiKeyEnv?: string } = {}): Config {
  const { apiKeyEnv = 'HATENA_API_KEY' } = overrides;
  return {
    service: 'hatena',
    timezone: 'Asia/Tokyo',
    source: { folders: ['tech'] },
    assets: {
      provider: 's3',
      bucket: 'blog-assets-hatena',
      public_base_url: 'https://assets.example.com/notes/',
      access_key_id_env: 'HATENA_S3_ACCESS_KEY_ID',
      secret_access_key_env: 'HATENA_S3_SECRET_ACCESS_KEY',
    },
    hatena: { hatena_id: HATENA_ID, blog_id: BLOG_ID, api_key_env: apiKeyEnv },
  };
}

function buildArticle(overrides: Partial<RenderedArticle> = {}): RenderedArticle {
  return {
    noteUuid: NOTE_UUID,
    title: 'Hello World',
    artifact:
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<entry xmlns="http://www.w3.org/2005/Atom">\n' +
      '  <title>Hello World</title>\n' +
      '  <author>\n' +
      `    <name>${HATENA_ID}</name>\n` +
      '  </author>\n' +
      '  <content type="text/x-markdown">body text\n</content>\n' +
      '  <category term="tech"/>\n' +
      '</entry>\n',
    contentHash: 'sha256:deadbeef',
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
  method: HatenaHttpRequest['method'];
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * 記録可能・応答をスクリプト可能なモック HTTP クライアント(`test/publishers/devto.test.ts`
 * の `makeMockHttpClient` と同じ形)。`handler` が投げれば `client` 自体が reject する
 * (接続系エラーの模擬)、返せばその応答を解決する。
 */
function makeMockHttpClient(
  handler: (call: RecordedCall) => HatenaHttpResponse | Promise<HatenaHttpResponse>,
): { client: HatenaHttpClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: HatenaHttpClient = async (request: HatenaHttpRequest) => {
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

function xmlResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): HatenaHttpResponse {
  return { status, headers, body };
}

/** `GET .../atom/entry`(コレクション)応答用の `<feed>` XML を組み立てる。 */
function feedXml(entries: { id: string; title: string }[], nextHref?: string): string {
  const nextLink = nextHref !== undefined ? `<link rel="next" href="${nextHref}"/>` : '';
  const entryXml = entries
    .map(
      (entry) =>
        `<entry><title>${entry.title}</title>` +
        `<link rel="edit" href="${COLLECTION_URI}/${entry.id}"/></entry>`,
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<feed xmlns="http://www.w3.org/2005/Atom">' +
    `${nextLink}${entryXml}</feed>`
  );
}

/** `POST`/`PUT` 応答(単一 `<entry>`)用の XML を組み立てる。 */
function entryResponseXml(params: { id?: string; alternateUrl?: string } = {}): string {
  const linkEdit =
    params.id !== undefined ? `<link rel="edit" href="${COLLECTION_URI}/${params.id}"/>` : '';
  const linkAlt =
    params.alternateUrl !== undefined
      ? `<link rel="alternate" type="text/html" href="${params.alternateUrl}"/>`
      : '';
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<entry xmlns="http://www.w3.org/2005/Atom">${linkEdit}${linkAlt}<title>Hello World</title></entry>`
  );
}

function basicAuthHeader(hatenaId: string, apiKey: string): string {
  return `Basic ${Buffer.from(`${hatenaId}:${apiKey}`).toString('base64')}`;
}

// ---------------------------------------------------------------------------
// テスト本体。
// ---------------------------------------------------------------------------

describe('createHatenaPublisher() construction', () => {
  it('has no prepare/finalize (API mode)', () => {
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client: makeMockHttpClient(() => xmlResponse(200, feedXml([]))).client,
      env: { HATENA_API_KEY: 'token' },
    });
    expect(publisher.prepare).toBeUndefined();
    expect(publisher.finalize).toBeUndefined();
  });

  it('throws immediately when config.hatena is undefined', () => {
    const config = { ...buildConfig(), hatena: undefined };
    expect(() => createHatenaPublisher({ config })).toThrow(/config\.hatena/);
  });
});

describe('publish() wire contract', () => {
  it('sends the exact collection URL, Basic auth header, and Content-Type for a new entry (POST, 0 title matches)', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return xmlResponse(200, feedXml([]));
      return xmlResponse(201, entryResponseXml({ id: '555' }), {
        location: `${COLLECTION_URI}/555`,
      });
    });
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: 'the-secret-token' },
    });

    const result = await publisher.publish(buildArticle(), null);

    const postCall = calls.find((call) => call.method === 'POST');
    if (postCall === undefined) {
      throw new Error('test setup: no POST call recorded');
    }
    expect(postCall.url).toBe(COLLECTION_URI);
    expect(postCall.headers.Authorization).toBe(basicAuthHeader(HATENA_ID, 'the-secret-token'));
    expect(postCall.headers['Content-Type']).toBe('application/atom+xml;type=entry');
    expect(postCall.body).toBe(buildArticle().artifact);
    expect(result).toEqual({
      result: 'created',
      remoteId: '555',
      url: `https://${BLOG_ID}/entry/555`,
    });
  });

  it('updates via PUT to .../atom/entry/{remoteId} when prev.remoteId is present, without any title-match GET', async () => {
    const { client, calls } = makeMockHttpClient(() =>
      xmlResponse(
        200,
        entryResponseXml({ id: '42', alternateUrl: 'https://example.hatenablog.com/entry/42' }),
      ),
    );
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: 'token' },
    });

    const result = await publisher.publish(buildArticle(), buildPrevState({ remoteId: '42' }));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'PUT', url: `${COLLECTION_URI}/42` });
    expect(result).toEqual({
      result: 'updated',
      remoteId: '42',
      url: 'https://example.hatenablog.com/entry/42',
    });
  });

  it('constructs the URL from blog_id/entry_id when no <link rel="alternate"> is present in the response', async () => {
    const { client } = makeMockHttpClient(() => xmlResponse(200, entryResponseXml({ id: '42' })));
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: 'token' },
    });

    const result = await publisher.publish(buildArticle(), buildPrevState({ remoteId: '42' }));

    expect(result.url).toBe(`https://${BLOG_ID}/entry/42`);
  });
});

describe('publish() entry_id extraction (POST only)', () => {
  it('extracts entry_id from the Location header', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return xmlResponse(200, feedXml([]));
      return xmlResponse(201, entryResponseXml(), { location: `${COLLECTION_URI}/9001` });
    });
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: 'token' },
    });

    const result = await publisher.publish(buildArticle(), null);

    expect(result.remoteId).toBe('9001');
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
  });

  it('falls back to <link rel="edit"> in the response body when there is no Location header', async () => {
    const { client } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return xmlResponse(200, feedXml([]));
      return xmlResponse(201, entryResponseXml({ id: '9002' }));
    });
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: 'token' },
    });

    const result = await publisher.publish(buildArticle(), null);

    expect(result.remoteId).toBe('9002');
  });

  it('throws when entry_id cannot be extracted from either the Location header or the body', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return xmlResponse(200, feedXml([]));
      return xmlResponse(201, entryResponseXml());
    });
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: 'token' },
    });

    await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(/entry_id/);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
});

describe('publish() title-match recovery (design.md §5.7 "応答不明時の重複防止")', () => {
  it('adopts the id from exactly 1 title match and PUTs it (no POST)', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET')
        return xmlResponse(200, feedXml([{ id: '7', title: 'Hello World' }]));
      return xmlResponse(200, entryResponseXml({ id: '7' }));
    });
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: 'token' },
    });

    const result = await publisher.publish(buildArticle({ title: 'Hello World' }), null);

    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    const putCall = calls.find((call) => call.method === 'PUT');
    expect(putCall?.url).toBe(`${COLLECTION_URI}/7`);
    expect(result).toMatchObject({ result: 'updated', remoteId: '7' });
  });

  it('creates via POST when 0 title matches', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return xmlResponse(200, feedXml([]));
      return xmlResponse(201, entryResponseXml({ id: '1' }));
    });
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: 'token' },
    });

    const result = await publisher.publish(buildArticle(), null);

    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    expect(result.result).toBe('created');
  });

  it('throws HatenaAmbiguousTitleMatchError on 2+ title matches, warns, and sends no write request', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') {
        return xmlResponse(
          200,
          feedXml([
            { id: '1', title: 'Dup' },
            { id: '2', title: 'Dup' },
          ]),
        );
      }
      throw new Error('test setup: no write request should have been sent');
    });
    const { logger, warnings } = createFakeLogger();
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      logger,
      env: { HATENA_API_KEY: 'token' },
    });

    await expect(
      publisher.publish(buildArticle({ noteUuid: 'dup-note', title: 'Dup' }), null),
    ).rejects.toThrow(HatenaAmbiguousTitleMatchError);

    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ service: 'hatena', noteUuid: 'dup-note', title: 'Dup' });
  });

  it('ignores titles that only partially match (exact match required)', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') {
        return xmlResponse(200, feedXml([{ id: '1', title: 'Hello World Extended' }]));
      }
      return xmlResponse(201, entryResponseXml({ id: '2' }));
    });
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: 'token' },
    });

    const result = await publisher.publish(buildArticle({ title: 'Hello World' }), null);

    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    expect(result.result).toBe('created');
  });

  it('follows <link rel="next"> pagination across pages until exhausted', async () => {
    const page2Uri = `${COLLECTION_URI}?page=1234567890`;
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') {
        if (call.url === COLLECTION_URI) {
          return xmlResponse(200, feedXml([{ id: '1', title: 'Other Entry' }], page2Uri));
        }
        if (call.url === page2Uri) {
          return xmlResponse(200, feedXml([{ id: '9999', title: 'Target Title' }]));
        }
        throw new Error(`test setup: unexpected GET url "${call.url}"`);
      }
      return xmlResponse(200, entryResponseXml({ id: '9999' }));
    });
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: 'token' },
    });

    const result = await publisher.publish(buildArticle({ title: 'Target Title' }), null);

    const getCalls = calls.filter((call) => call.method === 'GET');
    expect(getCalls).toHaveLength(2);
    expect(getCalls[1]?.url).toBe(page2Uri);
    expect(result).toMatchObject({ result: 'updated', remoteId: '9999' });
  });

  it('fetches the collection only once per run and reuses the cache for later notes', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return xmlResponse(200, feedXml([]));
      if (call.method === 'POST') return xmlResponse(201, entryResponseXml({ id: '100' }));
      return xmlResponse(200, entryResponseXml({ id: '100' }));
    });
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: 'token' },
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
    expect(second).toMatchObject({ result: 'updated', remoteId: '100' });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('serializes concurrent publishes: two same-title notes via Promise.all cause exactly 1 POST', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return xmlResponse(200, feedXml([]));
      if (call.method === 'POST') return xmlResponse(201, entryResponseXml({ id: '200' }));
      return xmlResponse(200, entryResponseXml({ id: '200' }));
    });
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: 'token' },
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

describe('publish() two-run persistence (remoteId feedback across runs)', () => {
  it('the 1st run POSTs and returns remoteId; feeding it back as prev makes the 2nd run PUT to that id', async () => {
    const { client: firstClient, calls: firstCalls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return xmlResponse(200, feedXml([]));
      return xmlResponse(201, entryResponseXml({ id: '777' }));
    });
    const firstPublisher = createHatenaPublisher({
      config: buildConfig(),
      client: firstClient,
      env: { HATENA_API_KEY: 'token' },
    });
    const firstResult = await firstPublisher.publish(buildArticle(), null);
    expect(firstResult).toMatchObject({ result: 'created', remoteId: '777' });
    expect(firstCalls.filter((call) => call.method === 'POST')).toHaveLength(1);

    const { client: secondClient, calls: secondCalls } = makeMockHttpClient(() =>
      xmlResponse(200, entryResponseXml({ id: '777' })),
    );
    const secondPublisher = createHatenaPublisher({
      config: buildConfig(),
      client: secondClient,
      env: { HATENA_API_KEY: 'token' },
    });
    const secondResult = await secondPublisher.publish(
      buildArticle(),
      buildPrevState({ remoteId: firstResult.remoteId }),
    );

    expect(secondCalls).toHaveLength(1);
    expect(secondCalls[0]).toMatchObject({ method: 'PUT', url: `${COLLECTION_URI}/777` });
    expect(secondResult).toMatchObject({ result: 'updated', remoteId: '777' });
  });
});

describe('publish() retry policy (design.md §5.7 "応答不明時の重複防止")', () => {
  it('does not retry POST on a connection-layer failure: exactly 1 request, error propagates', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return xmlResponse(200, feedXml([]));
      throw new TypeError('fetch failed');
    });
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: 'token' },
    });

    await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(
      /connection-layer failure/,
    );
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('does not retry POST on a timeout (AbortError): exactly 1 request, error propagates', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return xmlResponse(200, feedXml([]));
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    });
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: 'token' },
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
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: 'token' },
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
      return xmlResponse(200, entryResponseXml({ id: '9' }));
    });
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: 'token' },
    });

    const result = await publisher.publish(buildArticle(), buildPrevState({ remoteId: '9' }));

    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(2);
    expect(result).toMatchObject({ result: 'updated', remoteId: '9' });
  });

  it('does not retry PUT on an HTTP-status failure (500): exactly 1 request, throws', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'PUT') return { status: 500, headers: {}, body: '{"error":"boom"}' };
      throw new Error('test setup: unexpected non-PUT call');
    });
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: 'token' },
    });

    await expect(
      publisher.publish(buildArticle(), buildPrevState({ remoteId: '9' })),
    ).rejects.toThrow(/HTTP 500/);
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
  });

  it('does not retry POST on an HTTP-status failure (400): exactly 1 request, throws', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return xmlResponse(200, feedXml([]));
      if (call.method === 'POST') return { status: 400, headers: {}, body: '<error>bad</error>' };
      throw new Error('test setup: unexpected call');
    });
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: 'token' },
    });

    await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(/HTTP 400/);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('aborts title-match recovery with an error when rel="next" pagination is circular', async () => {
    // rel="next" が自分自身を指し続ける異常応答で無限ループせず、照合漏れによる
    // 重複 POST を避けるためエラーで安全側に倒すこと。
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') {
        return xmlResponse(200, feedXml([{ id: '1', title: 'Other Entry' }], call.url));
      }
      throw new Error('test setup: no write request should have been sent');
    });
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: 'token' },
    });

    await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(/circular/);
    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
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
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: 'token' },
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
    const publisher = createHatenaPublisher({
      config: buildConfig({ apiKeyEnv: 'HATENA_API_KEY' }),
      client,
      env: {}, // HATENA_API_KEY not set
    });

    await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(/HATENA_API_KEY/);
    expect(calls).toHaveLength(0);
  });

  it('throws when the configured api_key_env environment variable is set to an empty string', async () => {
    const { client, calls } = makeMockHttpClient(() => {
      throw new Error('test setup: no HTTP call should have been made');
    });
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: '' },
    });

    await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(/HATENA_API_KEY/);
    expect(calls).toHaveLength(0);
  });

  it('reads the key from the environment variable named by hatena.api_key_env (not a fixed name)', async () => {
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return xmlResponse(200, feedXml([]));
      return xmlResponse(201, entryResponseXml({ id: '1' }));
    });
    const publisher = createHatenaPublisher({
      config: buildConfig({ apiKeyEnv: 'MY_CUSTOM_HATENA_KEY_VAR' }),
      client,
      env: { MY_CUSTOM_HATENA_KEY_VAR: 'the-actual-key' },
    });

    await publisher.publish(buildArticle(), null);

    const writeCall = calls.find((call) => call.method === 'POST');
    expect(writeCall?.headers.Authorization).toBe(basicAuthHeader(HATENA_ID, 'the-actual-key'));
  });

  it('never puts the api key in request URLs', async () => {
    const secretKey = 'super-secret-hatena-key-value';
    const { client, calls } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return xmlResponse(200, feedXml([]));
      return xmlResponse(201, entryResponseXml({ id: '1' }));
    });
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: secretKey },
    });

    await publisher.publish(buildArticle(), null);

    for (const call of calls) {
      expect(call.url).not.toContain(secretKey);
    }
  });

  it('never leaks the api key in a connection-failure error message', async () => {
    const secretKey = 'super-secret-hatena-key-value';
    const { client } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return xmlResponse(200, feedXml([]));
      throw new TypeError('fetch failed');
    });
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: secretKey },
    });

    try {
      await publisher.publish(buildArticle(), null);
      expect.unreachable('publish() should have thrown');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secretKey);
    }
  });

  it('never leaks the api key in an HTTP-status failure error message', async () => {
    const secretKey = 'super-secret-hatena-key-value';
    const { client } = makeMockHttpClient((call) => {
      if (call.method === 'GET') return xmlResponse(200, feedXml([]));
      return { status: 401, headers: {}, body: 'Unauthorized' };
    });
    const publisher = createHatenaPublisher({
      config: buildConfig(),
      client,
      env: { HATENA_API_KEY: secretKey },
    });

    try {
      await publisher.publish(buildArticle(), null);
      expect.unreachable('publish() should have thrown');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secretKey);
    }
  });
});
