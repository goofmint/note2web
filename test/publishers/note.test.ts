import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { createNotePublisher } from '../../src/publishers/note.js';
import {
  NOTE_API_BASE_URL,
  NoteAuthError,
  type NoteHttpClient,
  type NoteHttpRequest,
  type NoteHttpResponse,
} from '../../src/publishers/note-client.js';
import { computeNoteBodyLength } from '../../src/publishers/note-html.js';
import type { RenderedArticle } from '../../src/publishers/types.js';
import { AssetUploadError } from '../../src/assets/uploader.js';
import type { NoteState } from '../../src/state/store.js';

// ---------------------------------------------------------------------------
// テスト用ヘルパー(makeMockHttpClient/jsonResponse。SUBAGENT TASK の指示どおり vi.fn を
// 使わず、記録可能・応答をスクリプト可能なフェイクを自前で組み立てる。
// `test/publishers/devto.test.ts`/`qiita.test.ts` と同じパターン)。
// ---------------------------------------------------------------------------

const NOTE_UUID = '5c1c2c3d-0000-4000-8000-000000000001';
const COOKIE_VALUE = 'super-secret-cookie-value-should-never-leak';
const COOKIE_ENV: NodeJS.ProcessEnv = { NOTE_SESSION_COOKIE: COOKIE_VALUE };
const S3_ACTION_URL = 'https://s3.example.com/upload-bucket';

function jsonResponse(status: number, body: unknown): NoteHttpResponse {
  return { status, body: JSON.stringify(body) };
}

function buildConfig(sessionCookieEnv = 'NOTE_SESSION_COOKIE'): Config {
  return {
    service: 'note',
    timezone: 'Asia/Tokyo',
    source: { folders: ['tech'] },
    assets: {
      provider: 's3',
      bucket: 'blog-assets-note',
      public_base_url: 'https://assets.example.com/notes/',
      access_key_id_env: 'NOTE_S3_ACCESS_KEY_ID',
      secret_access_key_env: 'NOTE_S3_SECRET_ACCESS_KEY',
    },
    note: { session_cookie_env: sessionCookieEnv },
  };
}

function buildArticle(overrides: Partial<RenderedArticle> = {}): RenderedArticle {
  return {
    noteUuid: NOTE_UUID,
    title: 'Hello World',
    artifact: '---\ntitle: "Hello World"\ntags: []\n---\n\nbody text\n',
    contentHash: 'sha256:deadbeef',
    bodyMarkdown: 'body text',
    tags: [],
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

/** 応答をスクリプト可能なフェイク `NoteHttpClient`(記録つき)。 */
function makeScriptedHttpClient(
  script: Array<(request: NoteHttpRequest) => NoteHttpResponse | Promise<NoteHttpResponse>>,
): { httpClient: NoteHttpClient; calls: NoteHttpRequest[] } {
  const calls: NoteHttpRequest[] = [];
  let index = 0;
  const httpClient: NoteHttpClient = async (request) => {
    calls.push(request);
    const handler = script[index];
    index += 1;
    if (handler === undefined) {
      throw new Error(
        `test setup: no scripted response for call #${String(index)} (${request.method} ${request.url})`,
      );
    }
    return handler(request);
  };
  return { httpClient, calls };
}

/**
 * URL/method で振り分けるフェイク `NoteHttpClient`(記録つき)。個別のシナリオを1行ずつ書く
 * `makeScriptedHttpClient` と違い、既定の一連の応答(current_user/draft/presigned/S3/publish)
 * を素直に返すだけの単純なテストで使う。`presignedKeys` は presigned_post 呼び出しごとに
 * 順番に返す `data.post.key` の一覧(複数画像テスト用)。
 */
function makeDefaultHttpClient(
  options: {
    presignedKeys?: string[];
    urlname?: string;
    draftId?: string;
    draftKey?: string;
  } = {},
): { httpClient: NoteHttpClient; calls: NoteHttpRequest[] } {
  const { presignedKeys = ['img/generated-key.png'], urlname = 'example-user' } = options;
  const draftId = options.draftId ?? '12345';
  const draftKey = options.draftKey ?? 'nabcde';
  let presignedCallIndex = 0;

  const calls: NoteHttpRequest[] = [];
  const httpClient: NoteHttpClient = async (request) => {
    calls.push(request);
    if (request.method === 'POST' && request.url === `${NOTE_API_BASE_URL}/api/v1/text_notes`) {
      return jsonResponse(200, { id: draftId, key: draftKey });
    }
    if (
      request.method === 'PUT' &&
      request.url.startsWith(`${NOTE_API_BASE_URL}/api/v1/text_notes/`)
    ) {
      return jsonResponse(200, { status: 'published' });
    }
    if (request.method === 'GET' && request.url === `${NOTE_API_BASE_URL}/api/v2/current_user`) {
      return jsonResponse(200, { data: { urlname } });
    }
    if (
      request.method === 'POST' &&
      request.url === `${NOTE_API_BASE_URL}/api/v3/images/upload/presigned_post`
    ) {
      const key = presignedKeys[presignedCallIndex] ?? presignedKeys[presignedKeys.length - 1];
      presignedCallIndex += 1;
      return jsonResponse(200, {
        data: {
          action: S3_ACTION_URL,
          post: {
            key,
            policy: 'policy-value',
            'x-amz-security-token': 'security-token-value',
            'x-amz-signature': 'signature-value',
          },
        },
      });
    }
    if (request.method === 'POST' && request.url === S3_ACTION_URL) {
      return { status: 204, body: '' };
    }
    throw new Error(`test setup: unexpected request ${request.method} ${request.url}`);
  };
  return { httpClient, calls };
}

// ---------------------------------------------------------------------------
// テスト用の添付ファイル配置(`<assetSourceDir>/files/<path>`、Exporter の出力規約と同じ)。
// ---------------------------------------------------------------------------

async function writeAttachmentFile(assetSourceDir: string, relPath: string): Promise<void> {
  const absolutePath = join(assetSourceDir, 'files', relPath);
  await mkdir(join(assetSourceDir, 'files'), { recursive: true });
  await writeFile(absolutePath, `fixture bytes for ${relPath}`);
}

// ---------------------------------------------------------------------------
// テスト本体。
// ---------------------------------------------------------------------------

describe('createNotePublisher', () => {
  let assetSourceDir: string;

  beforeEach(async () => {
    assetSourceDir = await mkdtemp(join(tmpdir(), 'note2web-note-test-'));
  });

  afterEach(async () => {
    await rm(assetSourceDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 作成フロー(prev.remoteId 無し)。
  // -------------------------------------------------------------------------
  describe('publish() create flow (no prev.remoteId)', () => {
    it('fetches current_user, reserves a draft, PUTs the full publish payload, and returns created + article URL', async () => {
      const { httpClient, calls } = makeDefaultHttpClient();
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      const result = await publisher.publish(buildArticle(), null);

      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
        `GET ${NOTE_API_BASE_URL}/api/v2/current_user`,
        `POST ${NOTE_API_BASE_URL}/api/v1/text_notes`,
        `PUT ${NOTE_API_BASE_URL}/api/v1/text_notes/12345`,
      ]);
      expect(result).toEqual({
        result: 'created',
        remoteId: '12345',
        url: 'https://note.com/example-user/n/nabcde',
      });
    });

    it('does not call the presigned/S3 endpoints for an article with no image placeholders', async () => {
      const { httpClient, calls } = makeDefaultHttpClient();
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      await publisher.publish(buildArticle({ bodyMarkdown: 'plain text, no images' }), null);

      expect(calls.some((call) => call.url.includes('presigned_post'))).toBe(false);
      expect(calls.some((call) => call.url === S3_ACTION_URL)).toBe(false);
    });

    it('sends the draft-reserve POST with no request body', async () => {
      const { httpClient, calls } = makeDefaultHttpClient();
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      await publisher.publish(buildArticle(), null);

      const draftCall = calls.find(
        (call) => call.method === 'POST' && call.url.endsWith('/text_notes'),
      );
      expect(draftCall?.body).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 更新フロー(prev.remoteId あり)。
  // -------------------------------------------------------------------------
  describe('publish() update flow (prev.remoteId present)', () => {
    it('PUTs directly to the existing id, without a draft-reserve POST, and re-derives the key from prev.url', async () => {
      const { httpClient, calls } = makeDefaultHttpClient();
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      const prev = buildPrevState({
        remoteId: '999',
        url: 'https://note.com/other-user/n/existing-key',
      });
      const result = await publisher.publish(buildArticle(), prev);

      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
        `GET ${NOTE_API_BASE_URL}/api/v2/current_user`,
        `PUT ${NOTE_API_BASE_URL}/api/v1/text_notes/999`,
      ]);
      expect(result).toEqual({
        result: 'updated',
        remoteId: '999',
        url: 'https://note.com/example-user/n/existing-key',
      });
    });

    it('uses the re-derived key ("existing-key") for the slug, not the current urlname', async () => {
      const { httpClient, calls } = makeDefaultHttpClient();
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      await publisher.publish(
        buildArticle(),
        buildPrevState({ remoteId: '999', url: 'https://note.com/other-user/n/existing-key' }),
      );

      const putCall = calls.find((call) => call.method === 'PUT');
      const payload = JSON.parse(putCall?.body as string) as { slug: string };
      expect(payload.slug).toBe('slug-existing-key');
    });

    it('throws a descriptive error when prev.remoteId is set but prev.url is missing', async () => {
      const { httpClient } = makeDefaultHttpClient();
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      await expect(
        publisher.publish(buildArticle(), buildPrevState({ remoteId: '999', url: undefined })),
      ).rejects.toThrow(/no stored "url"/);
    });

    it('throws a descriptive error when prev.url does not match the note.com article URL format', async () => {
      const { httpClient } = makeDefaultHttpClient();
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      await expect(
        publisher.publish(
          buildArticle(),
          buildPrevState({ remoteId: '999', url: 'https://example.com/not-a-note-url' }),
        ),
      ).rejects.toThrow(/does not match the expected/);
    });
  });

  // -------------------------------------------------------------------------
  // urlname のキャッシュ(Publisher インスタンスごとに1回、認証チェックも兼ねる)。
  // -------------------------------------------------------------------------
  describe('urlname caching (getCurrentUser)', () => {
    it('fetches current_user only once across multiple publish() calls', async () => {
      const { httpClient, calls } = makeDefaultHttpClient();
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      await publisher.publish(buildArticle({ noteUuid: 'uuid-1' }), null);
      await publisher.publish(buildArticle({ noteUuid: 'uuid-2' }), null);

      expect(calls.filter((call) => call.url.endsWith('/current_user'))).toHaveLength(1);
    });

    it('serializes concurrent publish() calls (publishChain) so current_user is fetched exactly once even under Promise.all', async () => {
      const { httpClient, calls } = makeDefaultHttpClient();
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      await Promise.all([
        publisher.publish(buildArticle({ noteUuid: 'uuid-a' }), null),
        publisher.publish(buildArticle({ noteUuid: 'uuid-b' }), null),
      ]);

      expect(calls.filter((call) => call.url.endsWith('/current_user'))).toHaveLength(1);
      expect(calls.filter((call) => call.url.endsWith('/text_notes'))).toHaveLength(2);
    });

    it('does not cache a failed current_user lookup (retries on the next publish())', async () => {
      // 単一の Publisher インスタンス・単一のスクリプト付き httpClient で確認する: 1回目の
      // publish() は current_user が 500 で失敗し、2回目の publish()(同じインスタンス)は
      // current_user が成功して draft 予約 → PUT まで進む。urlnamePromise が失敗をキャッシュ
      // していれば2回目も current_user を再度叩かないはずなので、calls の件数で検証する。
      const { httpClient, calls } = makeScriptedHttpClient([
        () => Promise.resolve({ status: 500, body: 'boom' }),
        () => Promise.resolve(jsonResponse(200, { data: { urlname: 'example-user' } })),
        () => Promise.resolve(jsonResponse(200, { id: '12345', key: 'nabcde' })),
        () => Promise.resolve(jsonResponse(200, { status: 'published' })),
      ]);
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      await expect(publisher.publish(buildArticle(), null)).rejects.toThrow();
      expect(calls.filter((call) => call.url.endsWith('/current_user'))).toHaveLength(1);

      const result = await publisher.publish(buildArticle(), null);
      expect(calls.filter((call) => call.url.endsWith('/current_user'))).toHaveLength(2);
      expect(result.result).toBe('created');
    });
  });

  // -------------------------------------------------------------------------
  // cookie / 認証。
  // -------------------------------------------------------------------------
  describe('cookie / authentication', () => {
    it('throws naming the env var when the session cookie env var is unset, without any HTTP calls', async () => {
      const { httpClient, calls } = makeDefaultHttpClient();
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: {} });

      await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(/NOTE_SESSION_COOKIE/);
      expect(calls).toHaveLength(0);
    });

    it('throws naming the env var when the session cookie is the empty string, without any HTTP calls', async () => {
      const { httpClient, calls } = makeDefaultHttpClient();
      const publisher = createNotePublisher({
        config: buildConfig(),
        httpClient,
        env: { NOTE_SESSION_COOKIE: '' },
      });

      await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(/NOTE_SESSION_COOKIE/);
      expect(calls).toHaveLength(0);
    });

    it.each([401, 403])(
      'throws NoteAuthError with browser re-acquisition steps (and no cookie value) on HTTP %d from current_user',
      async (status) => {
        const { httpClient: authFailClient } = makeScriptedHttpClient([
          () => Promise.resolve({ status, body: '' }),
        ]);
        const publisher = createNotePublisher({
          config: buildConfig(),
          httpClient: authFailClient,
          env: COOKIE_ENV,
        });

        const error = await publisher.publish(buildArticle(), null).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NoteAuthError);
        const message = (error as Error).message;
        expect(message).toMatch(/ブラウザで note\.com にログイン/);
        expect(message).toMatch(/_note_session_v5/);
        expect(message).not.toContain(COOKIE_VALUE);
      },
    );

    it('never includes the cookie value in any thrown error message, even on a generic HTTP failure', async () => {
      const { httpClient: failClient } = makeScriptedHttpClient([
        () => Promise.resolve({ status: 500, body: `error mentioning nothing secret` }),
      ]);
      const publisher = createNotePublisher({
        config: buildConfig(),
        httpClient: failClient,
        env: COOKIE_ENV,
      });

      const error = await publisher.publish(buildArticle(), null).catch((e: unknown) => e);
      expect((error as Error).message).not.toContain(COOKIE_VALUE);
    });

    it('sends the cookie only in the Cookie header (note.com API requests), never to the S3 presigned URL', async () => {
      await writeAttachmentFile(assetSourceDir, 'sketch.png');
      const { httpClient, calls } = makeDefaultHttpClient();
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      await publisher.publish(
        buildArticle({
          bodyMarkdown: '![alt](note2web-asset://img-1)',
          attachments: [{ identifier: 'img-1', path: 'sketch.png' }],
          assetSourceDir,
        }),
        null,
      );

      for (const call of calls) {
        if (call.url === S3_ACTION_URL) {
          expect(call.headers.Cookie).toBeUndefined();
        } else {
          expect(call.headers.Cookie).toBe(`_note_session_v5=${COOKIE_VALUE}`);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // 画像アップロード。
  // -------------------------------------------------------------------------
  describe('image upload', () => {
    it('uploads a single referenced image via presigned POST + S3 multipart, copying all post fields with file last', async () => {
      await writeAttachmentFile(assetSourceDir, 'sketch.png');
      const { httpClient, calls } = makeDefaultHttpClient({
        presignedKeys: ['img/uploaded-key.png'],
      });
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      await publisher.publish(
        buildArticle({
          bodyMarkdown: '![alt](note2web-asset://img-1)',
          attachments: [{ identifier: 'img-1', path: 'sketch.png' }],
          assetSourceDir,
        }),
        null,
      );

      const s3Call = calls.find((call) => call.url === S3_ACTION_URL);
      expect(s3Call).toBeDefined();
      const form = s3Call?.body as FormData;
      const fieldNames = [...form.entries()].map(([key]) => key);
      expect(fieldNames).toEqual([
        'key',
        'policy',
        'x-amz-security-token',
        'x-amz-signature',
        'file',
      ]);
      expect(fieldNames.at(-1)).toBe('file');
      // x-amz-security-token の欠落は403 InvalidAccessKeyId になるため必須(元記事)。
      expect(form.get('x-amz-security-token')).toBe('security-token-value');

      const putCall = calls.find((call) => call.method === 'PUT');
      const payload = JSON.parse(putCall?.body as string) as {
        image_keys: string[];
        free_body: string;
      };
      expect(payload.image_keys).toEqual(['uploaded-key.png']);
      expect(payload.free_body).toContain('https://assets.st-note.com/img/uploaded-key.png');
    });

    it('uploads multiple images in order of appearance in the markdown (not attachment array order)', async () => {
      await writeAttachmentFile(assetSourceDir, 'first.png');
      await writeAttachmentFile(assetSourceDir, 'second.png');
      const { httpClient, calls } = makeDefaultHttpClient({
        presignedKeys: ['img/key-for-second.png', 'img/key-for-first.png'],
      });
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      // 本文中では img-2(second.png)が img-1(first.png)より先に現れる。
      const markdown = '![second](note2web-asset://img-2)\n\n![first](note2web-asset://img-1)\n';
      await publisher.publish(
        buildArticle({
          bodyMarkdown: markdown,
          attachments: [
            { identifier: 'img-1', path: 'first.png' },
            { identifier: 'img-2', path: 'second.png' },
          ],
          assetSourceDir,
        }),
        null,
      );

      const putCall = calls.find((call) => call.method === 'PUT');
      const payload = JSON.parse(putCall?.body as string) as { image_keys: string[] };
      // 出現順(img-2 が先)どおりに image_keys が並ぶ。
      expect(payload.image_keys).toEqual(['key-for-second.png', 'key-for-first.png']);
    });

    it('never retries the presigned_post POST on a connection error', async () => {
      let presignedCalls = 0;
      const { httpClient } = makeScriptedHttpClient([
        () => jsonResponse(200, { data: { urlname: 'example-user' } }), // current_user
        () => jsonResponse(200, { id: '1', key: 'nkey' }), // draft
        () => {
          presignedCalls += 1;
          throw new TypeError('fetch failed');
        },
      ]);
      await writeAttachmentFile(assetSourceDir, 'sketch.png');
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      await expect(
        publisher.publish(
          buildArticle({
            bodyMarkdown: '![alt](note2web-asset://img-1)',
            attachments: [{ identifier: 'img-1', path: 'sketch.png' }],
            assetSourceDir,
          }),
          null,
        ),
      ).rejects.toThrow();
      expect(presignedCalls).toBe(1);
    });

    it('throws AssetUploadError for an unsupported image extension, without calling presigned_post', async () => {
      await writeAttachmentFile(assetSourceDir, 'photo.heic');
      const { httpClient, calls } = makeDefaultHttpClient();
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      const error = await publisher
        .publish(
          buildArticle({
            bodyMarkdown: '![alt](note2web-asset://img-heic)',
            attachments: [{ identifier: 'img-heic', path: 'photo.heic' }],
            assetSourceDir,
          }),
          null,
        )
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AssetUploadError);
      expect((error as AssetUploadError).identifier).toBe('img-heic');
      expect(calls.some((call) => call.url.includes('presigned_post'))).toBe(false);
    });

    it('throws when the markdown references an image placeholder but assetSourceDir is unset (wiring bug guard)', async () => {
      const { httpClient } = makeDefaultHttpClient();
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      await expect(
        publisher.publish(
          buildArticle({
            bodyMarkdown: '![alt](note2web-asset://img-1)',
            attachments: [{ identifier: 'img-1', path: 'sketch.png' }],
            assetSourceDir: undefined,
          }),
          null,
        ),
      ).rejects.toThrow(/assetSourceDir is unset/);
    });
  });

  // -------------------------------------------------------------------------
  // 4つの 500 罠。
  // -------------------------------------------------------------------------
  describe('the four 500-traps', () => {
    it('trap 1: image_keys lists every uploaded image key, in order of appearance', async () => {
      await writeAttachmentFile(assetSourceDir, 'a.png');
      const { httpClient, calls } = makeDefaultHttpClient({ presignedKeys: ['img/trap1-key.png'] });
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      await publisher.publish(
        buildArticle({
          bodyMarkdown: '![alt](note2web-asset://img-1)',
          attachments: [{ identifier: 'img-1', path: 'a.png' }],
          assetSourceDir,
        }),
        null,
      );

      const putCall = calls.find((call) => call.method === 'PUT');
      const payload = JSON.parse(putCall?.body as string) as { image_keys: string[] };
      expect(payload.image_keys).toEqual(['trap1-key.png']);
      expect(payload.image_keys.length).toBeGreaterThan(0);
    });

    it('trap 1: image_keys is an empty array (not omitted) for an article with no images', async () => {
      const { httpClient, calls } = makeDefaultHttpClient();
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      await publisher.publish(buildArticle({ bodyMarkdown: 'no images here' }), null);

      const putCall = calls.find((call) => call.method === 'PUT');
      const payload = JSON.parse(putCall?.body as string) as { image_keys: unknown };
      expect(payload.image_keys).toEqual([]);
    });

    it('trap 2: lead_form and line_add_friend are never null and match the exact required shape', async () => {
      const { httpClient, calls } = makeDefaultHttpClient();
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      await publisher.publish(buildArticle(), null);

      const putCall = calls.find((call) => call.method === 'PUT');
      const payload = JSON.parse(putCall?.body as string) as {
        lead_form: unknown;
        line_add_friend: unknown;
        line_add_friend_access_token: unknown;
      };
      expect(payload.lead_form).toEqual({ is_active: false, consent_url: '' });
      expect(payload.line_add_friend).toEqual({
        is_active: false,
        keyword: '',
        add_friend_url: '',
      });
      expect(payload.line_add_friend_access_token).toBe('');
    });

    it('trap 3: body_length is the visible-text Unicode code point count, not the HTML length', async () => {
      const { httpClient, calls } = makeDefaultHttpClient();
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      const markdown = '# 見出し\n\n本文テキストです。**強調**も含みます。\n';
      await publisher.publish(buildArticle({ bodyMarkdown: markdown }), null);

      const putCall = calls.find((call) => call.method === 'PUT');
      const payload = JSON.parse(putCall?.body as string) as {
        body_length: number;
        free_body: string;
      };
      expect(payload.body_length).toBe(computeNoteBodyLength(markdown));
      // 固定値でも回帰を検知する(「見出し」(3) + 「本文テキストです。」(9) + 「強調」(2) +
      // 「も含みます。」(6) = 20 コードポイント)。
      expect(payload.body_length).toBe(20);
      // HTML 文字列(タグ込み)の長さとは明確に異なる(HTML の方が長い)。
      expect(payload.body_length).toBeLessThan(payload.free_body.length);
    });

    it('trap 4: slug defaults to "slug-<note_key>" and is never empty (create flow)', async () => {
      const { httpClient, calls } = makeDefaultHttpClient({ draftKey: 'freshkey123' });
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      await publisher.publish(buildArticle(), null);

      const putCall = calls.find((call) => call.method === 'PUT');
      const payload = JSON.parse(putCall?.body as string) as { slug: string };
      expect(payload.slug).toBe('slug-freshkey123');
      expect(payload.slug.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // hashtags の wire 形式(実機確認課題 (a))。
  // -------------------------------------------------------------------------
  describe('hashtags builder', () => {
    it('wraps each tag as {name: "#tag"}, normalizing to exactly one leading "#"', async () => {
      const { httpClient, calls } = makeDefaultHttpClient();
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      await publisher.publish(buildArticle({ tags: ['#TypeScript', 'plain-tag'] }), null);

      const putCall = calls.find((call) => call.method === 'PUT');
      const payload = JSON.parse(putCall?.body as string) as { hashtags: { name: string }[] };
      expect(payload.hashtags).toEqual([{ name: '#TypeScript' }, { name: '#plain-tag' }]);
    });

    it('sends an empty array when the article has no tags', async () => {
      const { httpClient, calls } = makeDefaultHttpClient();
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      await publisher.publish(buildArticle({ tags: [] }), null);

      const putCall = calls.find((call) => call.method === 'PUT');
      const payload = JSON.parse(putCall?.body as string) as { hashtags: unknown };
      expect(payload.hashtags).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 公開ペイロードの固定フィールド(status/send_notifications_flag 等)。
  // -------------------------------------------------------------------------
  describe('publish payload fixed fields', () => {
    it('sends status "published" and send_notifications_flag false on every publish', async () => {
      const { httpClient, calls } = makeDefaultHttpClient();
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      await publisher.publish(buildArticle(), null);

      const putCall = calls.find((call) => call.method === 'PUT');
      const payload = JSON.parse(putCall?.body as string) as {
        status: string;
        send_notifications_flag: boolean;
        pay_body: string;
        price: number;
        magazine_ids: unknown;
        magazine_keys: unknown;
        author_ids: unknown;
        circle_permissions: unknown;
        discount_campaigns: unknown;
        pro_coupon_keys: unknown;
      };
      expect(payload.status).toBe('published');
      expect(payload.send_notifications_flag).toBe(false);
      expect(payload.pay_body).toBe('');
      expect(payload.price).toBe(0);
      expect(payload.magazine_ids).toEqual([]);
      expect(payload.magazine_keys).toEqual([]);
      expect(payload.author_ids).toEqual([]);
      expect(payload.circle_permissions).toEqual([]);
      expect(payload.discount_campaigns).toEqual([]);
      expect(payload.pro_coupon_keys).toEqual([]);
    });

    it('sends the Content-Type: application/json header for the publish PUT', async () => {
      const { httpClient, calls } = makeDefaultHttpClient();
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      await publisher.publish(buildArticle(), null);

      const putCall = calls.find((call) => call.method === 'PUT');
      expect(putCall?.headers['Content-Type']).toBe('application/json');
    });
  });

  // -------------------------------------------------------------------------
  // PUT の接続系エラー1回リトライ。
  // -------------------------------------------------------------------------
  describe('publish PUT retry-on-connection-error', () => {
    it('retries the publish PUT exactly once on a connection error, then succeeds', async () => {
      let putAttempts = 0;
      const { httpClient, calls } = makeScriptedHttpClient([
        () => jsonResponse(200, { data: { urlname: 'example-user' } }), // current_user
        () => jsonResponse(200, { id: '1', key: 'nkey' }), // draft
        () => {
          putAttempts += 1;
          throw new TypeError('fetch failed');
        },
        () => {
          putAttempts += 1;
          return jsonResponse(200, { status: 'published' });
        },
      ]);
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      const result = await publisher.publish(buildArticle(), null);

      expect(putAttempts).toBe(2);
      expect(calls).toHaveLength(4);
      expect(result.result).toBe('created');
    });

    it('does not retry the draft-reserve POST on a connection error', async () => {
      let draftAttempts = 0;
      const { httpClient } = makeScriptedHttpClient([
        () => jsonResponse(200, { data: { urlname: 'example-user' } }), // current_user
        () => {
          draftAttempts += 1;
          throw new TypeError('fetch failed');
        },
      ]);
      const publisher = createNotePublisher({ config: buildConfig(), httpClient, env: COOKIE_ENV });

      await expect(publisher.publish(buildArticle(), null)).rejects.toThrow();
      expect(draftAttempts).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Publisher 構築。
  // -------------------------------------------------------------------------
  describe('createNotePublisher() construction', () => {
    it('has no prepare/finalize (API mode)', () => {
      const publisher = createNotePublisher({ config: buildConfig() });
      expect(publisher.prepare).toBeUndefined();
      expect(publisher.finalize).toBeUndefined();
    });

    it('throws immediately when config.note is undefined', () => {
      const config = buildConfig();
      const brokenConfig = { ...config, note: undefined };
      expect(() => createNotePublisher({ config: brokenConfig })).toThrow(/config\.note/);
    });
  });
});
