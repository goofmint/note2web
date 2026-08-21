import { describe, expect, it } from 'vitest';
import { deriveImageKey, NoteAuthError } from '../../src/publishers/note-client.js';

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
});
