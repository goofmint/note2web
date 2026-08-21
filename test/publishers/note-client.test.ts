import { describe, expect, it } from 'vitest';
import {
  createDraft,
  deriveImageKey,
  getCurrentUser,
  NoteAuthError,
  type NoteHttpClient,
  type NoteHttpRequest,
} from '../../src/publishers/note-client.js';

// ---------------------------------------------------------------------------
// deriveImageKey(実機確認課題 (c))。
// ---------------------------------------------------------------------------

describe('deriveImageKey', () => {
  it('strips everything up to and including the last "img/" occurrence', () => {
    expect(deriveImageKey('uploads/2026/08/img/abc123.png')).toBe('abc123.png');
  });

  it('uses the last "img/" occurrence when the path contains it multiple times', () => {
    expect(deriveImageKey('img/nested/img/final-key.png')).toBe('final-key.png');
  });

  it('falls back to the basename when "img/" is not present', () => {
    expect(deriveImageKey('uploads/2026/08/plain-key.png')).toBe('plain-key.png');
  });

  it('returns the input unchanged when it has no "/" and no "img/" prefix', () => {
    expect(deriveImageKey('bare-key.png')).toBe('bare-key.png');
  });

  it('handles a key that is exactly "img/<name>"', () => {
    expect(deriveImageKey('img/only-key.png')).toBe('only-key.png');
  });
});

// ---------------------------------------------------------------------------
// NoteAuthError(cookie の値を絶対に含めない、再取得手順を含む)。
// ---------------------------------------------------------------------------

describe('NoteAuthError', () => {
  it('includes browser re-acquisition steps mentioning the cookie name', () => {
    const error = new NoteAuthError('GET /api/v2/current_user', 401);
    expect(error.message).toMatch(/ブラウザで note\.com にログイン/);
    expect(error.message).toMatch(/DevTools/);
    expect(error.message).toMatch(/_note_session_v5/);
    expect(error.name).toBe('NoteAuthError');
  });

  it('includes the failing HTTP status and description', () => {
    const error = new NoteAuthError('PUT /api/v1/text_notes/123 (publish)', 403);
    expect(error.message).toContain('403');
    expect(error.message).toContain('PUT /api/v1/text_notes/123 (publish)');
  });

  it('never includes a representative cookie value or a "_note_session_v5=<value>" pair', () => {
    const cookieValue = 'super-secret-cookie-value-should-never-leak';
    const error = new NoteAuthError('GET /api/v2/current_user', 401);
    expect(error.message).not.toContain(cookieValue);
    expect(error.message).not.toMatch(/_note_session_v5=\S/);
  });
});

// ---------------------------------------------------------------------------
// buildNoteHeaders 経由の cookie 値バリデーション(nitpick: コピペミス対策)。
// getCurrentUser/createDraft はいずれも buildNoteHeaders を通るため、これらを通じて間接的に
// 検証する(buildNoteHeaders 自体は export されていない)。
// ---------------------------------------------------------------------------

function makeCapturingHttpClient(response: { status: number; body: string }): {
  httpClient: NoteHttpClient;
  requests: NoteHttpRequest[];
} {
  const requests: NoteHttpRequest[] = [];
  const httpClient: NoteHttpClient = async (request) => {
    requests.push(request);
    return response;
  };
  return { httpClient, requests };
}

describe('note session cookie validation (buildNoteHeaders, via getCurrentUser/createDraft)', () => {
  it('strips a copy-pasted "_note_session_v5=" name/"=" prefix from the cookie value', async () => {
    const { httpClient, requests } = makeCapturingHttpClient({
      status: 200,
      body: JSON.stringify({ data: { urlname: 'example-user' } }),
    });

    await getCurrentUser(httpClient, '_note_session_v5=actual-value');

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.Cookie).toBe('_note_session_v5=actual-value');
  });

  it('throws a clear configuration error (not a connection-failure classification) for a cookie value containing control characters, without making any HTTP call', async () => {
    const { httpClient, requests } = makeCapturingHttpClient({ status: 200, body: '{}' });

    let thrown: unknown;
    try {
      await createDraft(httpClient, 'actual-value\n');
      expect.unreachable('createDraft should have thrown');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/control characters/);
    expect((thrown as Error).message).not.toMatch(/connection-layer failure/);
    expect(requests).toHaveLength(0);
  });

  it('never includes the cookie value in the control-character error message', async () => {
    const { httpClient } = makeCapturingHttpClient({ status: 200, body: '{}' });
    const cookieValue = 'super-secret-cookie-value-should-never-leak';

    let thrown: unknown;
    try {
      await createDraft(httpClient, `${cookieValue}\n`);
      expect.unreachable('createDraft should have thrown');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(cookieValue);
  });
});

// ---------------------------------------------------------------------------
// parseDraftResponse(createDraft 経由。両方の JSON 構造を許容する。
// parseCurrentUserResponse と同じ寛容な解析方針)。
// ---------------------------------------------------------------------------

describe('createDraft response parsing', () => {
  it('accepts a flat { id, key } response shape', async () => {
    const { httpClient } = makeCapturingHttpClient({
      status: 200,
      body: JSON.stringify({ id: 111, key: 'nflat' }),
    });
    const draft = await createDraft(httpClient, 'cookie-value');
    expect(draft).toEqual({ id: '111', key: 'nflat' });
  });

  it('accepts a nested { data: { id, key } } response shape (mirrors parseCurrentUserResponse)', async () => {
    const { httpClient } = makeCapturingHttpClient({
      status: 200,
      body: JSON.stringify({ data: { id: 555, key: 'nxyz' } }),
    });
    const draft = await createDraft(httpClient, 'cookie-value');
    expect(draft).toEqual({ id: '555', key: 'nxyz' });
  });
});
