import { describe, expect, it } from 'vitest';
import { renderGenericArticle } from './render.js';
import type { Note } from '../model/note.js';
import type { Config } from '../config.js';

function buildNote(overrides: Partial<Note> = {}): Note {
  return {
    uuid: '5c1c2c3d-0000-0000-0000-000000000001',
    folder: 'Tech',
    title: 'Hello World',
    emoji: null,
    tags: ['#hello'],
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-02T00:00:00Z'),
    bodyHtml: '<p>Hello World</p>',
    attachments: [],
    ...overrides,
  };
}

const CONFIG = { timezone: 'Asia/Tokyo' } as Config;

describe('renderGenericArticle', () => {
  it('produces a deterministic content hash for identical input', () => {
    const note = buildNote();
    const a = renderGenericArticle({ note, markdown: 'body text', config: CONFIG });
    const b = renderGenericArticle({ note, markdown: 'body text', config: CONFIG });
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes the content hash when the body changes', () => {
    const note = buildNote();
    const a = renderGenericArticle({ note, markdown: 'body text', config: CONFIG });
    const b = renderGenericArticle({ note, markdown: 'different body text', config: CONFIG });
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('includes title and tags in the frontmatter block', () => {
    const note = buildNote({ title: 'My Title', tags: ['#a', '#b'] });
    const { artifact } = renderGenericArticle({ note, markdown: 'body', config: CONFIG });
    expect(artifact).toContain('title: "My Title"');
    expect(artifact).toContain('tags: ["#a","#b"]');
    expect(artifact).toContain('\nbody');
  });

  it('carries noteUuid and title through to the RenderedArticle', () => {
    const note = buildNote({ uuid: 'abc-123', title: 'Some Title' });
    const article = renderGenericArticle({ note, markdown: 'body', config: CONFIG });
    expect(article.noteUuid).toBe('abc-123');
    expect(article.title).toBe('Some Title');
    expect(article.artifactPath).toBeUndefined();
  });
});
