import { describe, expect, it } from 'vitest';
import { NoteImagesUnsupportedError, renderNoteArticle } from './note.js';
import type { Note } from '../model/note.js';
import type { Config } from '../config.js';
import { computeContentHash } from '../transform/frontmatter.js';

function buildNote(overrides: Partial<Note> = {}): Note {
  return {
    uuid: '5c1c2c3d-0000-0000-0000-000000000001',
    folder: 'tech',
    title: 'Hello World',
    emoji: null,
    tags: [],
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-02T00:00:00Z'),
    bodyHtml: '<p>Hello World</p>',
    attachments: [],
    ...overrides,
  };
}

// note.com は API/CLI モード。renderNoteArticle は config を参照しないため最小限の値で足りる。
const CONFIG = {
  timezone: 'Asia/Tokyo',
  service: 'note',
  note: { workspace: '~/src/note-content' },
} as Config;

// ---------------------------------------------------------------------------
// golden test: frontmatter の確定的な直列化(design.md §5.7 NotePublisher 節、§13-4)。
// ---------------------------------------------------------------------------

describe('golden: renderNoteArticle frontmatter', () => {
  const note = buildNote({
    uuid: '5C1C2C3D-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    title: 'こんにちは、note',
    tags: ['#TypeScript', '#note記事'],
  });
  const markdown = '本文はここに書きます。\n\n見出しの前後にも改行があります。\n';

  const expectedArtifact =
    '---\n' +
    'title: "こんにちは、note"\n' +
    'tags: ["TypeScript","note記事"]\n' +
    '---\n' +
    '\n' +
    markdown;

  // design.md §12: 同一入力ノートに対する期待直列化文字列とハッシュ値を golden として固定する。
  const expectedHash = computeContentHash(expectedArtifact);

  it('serializes the minimal frontmatter block + body exactly (key order title/tags only, per §13-4)', () => {
    const article = renderNoteArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.artifact).toBe(expectedArtifact);
  });

  it('computes the fixed sha256 content hash for the golden artifact', () => {
    const article = renderNoteArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.contentHash).toBe(expectedHash);
    expect(article.contentHash).toBe(computeContentHash(expectedArtifact));
  });

  it('carries noteUuid and title through to the RenderedArticle', () => {
    const article = renderNoteArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.noteUuid).toBe(note.uuid);
    expect(article.title).toBe('こんにちは、note');
  });
});

// ---------------------------------------------------------------------------
// artifactPath(design.md §5.7 NotePublisher「`<uuid>.md`」、workspace 相対)。
// ---------------------------------------------------------------------------

describe('renderNoteArticle artifactPath', () => {
  it('is "<uuid>.md" (relative; NotePublisher resolves against config.note.workspace)', () => {
    const note = buildNote({ uuid: '5c1c2c3d-0000-4000-8000-000000000001' });
    const article = renderNoteArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifactPath).toBe('5c1c2c3d-0000-4000-8000-000000000001.md');
  });

  it('does not lowercase the uuid (unlike Zenn slugs)', () => {
    const note = buildNote({ uuid: '5C1C2C3D-0000-4000-8000-000000000001' });
    const article = renderNoteArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifactPath).toBe('5C1C2C3D-0000-4000-8000-000000000001.md');
  });
});

// ---------------------------------------------------------------------------
// tags(モジュール冒頭 JSDoc「frontmatter」: 先頭の "#" を1つ除去する実装判断)。
// ---------------------------------------------------------------------------

describe('renderNoteArticle tags', () => {
  it('strips exactly one leading "#" from each tag', () => {
    const note = buildNote({ tags: ['#typescript', '#note'] });
    const article = renderNoteArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('tags: ["typescript","note"]');
  });

  it('produces an empty tags array for a note with no tags', () => {
    const note = buildNote({ tags: [] });
    const article = renderNoteArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('tags: []');
  });

  it('leaves a tag without a leading "#" unchanged (defensive)', () => {
    const note = buildNote({ tags: ['already-plain'] });
    const article = renderNoteArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('tags: ["already-plain"]');
  });
});

// ---------------------------------------------------------------------------
// 画像非対応(design.md §13-6「option (b)」、モジュール冒頭 JSDoc「2. 画像」)。
// ---------------------------------------------------------------------------

describe('renderNoteArticle image detection (design.md §13-6, option (b))', () => {
  it('throws NoteImagesUnsupportedError for an inline image reference', () => {
    const note = buildNote();
    const markdown = 'text before\n\n![alt text](https://assets.example.com/notes/ab/ab12.png)\n';
    expect(() => renderNoteArticle({ note, markdown, config: CONFIG, prev: null })).toThrow(
      NoteImagesUnsupportedError,
    );
  });

  it('throws NoteImagesUnsupportedError for a reference-style image', () => {
    const note = buildNote();
    const markdown = '![alt text][img1]\n\n[img1]: https://assets.example.com/notes/ab/ab12.png\n';
    expect(() => renderNoteArticle({ note, markdown, config: CONFIG, prev: null })).toThrow(
      NoteImagesUnsupportedError,
    );
  });

  it('throws NoteImagesUnsupportedError for a shortcut reference-style image', () => {
    const note = buildNote();
    const markdown = '![alt text]\n\n[alt text]: https://assets.example.com/notes/ab/ab12.png\n';
    expect(() => renderNoteArticle({ note, markdown, config: CONFIG, prev: null })).toThrow(
      NoteImagesUnsupportedError,
    );
  });

  it('does not throw for a note with no image references', () => {
    const note = buildNote();
    const markdown = 'plain text, a [regular link](https://example.com/) is fine.\n';
    expect(() => renderNoteArticle({ note, markdown, config: CONFIG, prev: null })).not.toThrow();
  });

  it('NoteImagesUnsupportedError carries the offending noteUuid', () => {
    const note = buildNote({ uuid: 'note-uuid-under-test' });
    const markdown = '![img](https://assets.example.com/x.png)\n';
    try {
      renderNoteArticle({ note, markdown, config: CONFIG, prev: null });
      expect.unreachable('renderNoteArticle should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NoteImagesUnsupportedError);
      const typedError = error as NoteImagesUnsupportedError;
      expect(typedError.noteUuid).toBe('note-uuid-under-test');
      expect(typedError.message).toContain('note-uuid-under-test');
    }
  });

  it('throws before rendering, so no RenderedArticle is ever produced for an image note', () => {
    const note = buildNote();
    const markdown = '![img](https://assets.example.com/x.png)\n';
    let rendered: unknown;
    try {
      rendered = renderNoteArticle({ note, markdown, config: CONFIG, prev: null });
    } catch {
      // 例外経路: 成果物は生成されない。
    }
    expect(rendered).toBeUndefined();
  });
});
