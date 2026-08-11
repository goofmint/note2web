import { describe, expect, it } from 'vitest';
import { InvalidZennSlugError, InvalidZennTypeError, renderZennArticle } from './zenn.js';
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

// Zenn は Git モード。`config` は renderZennArticle が参照しないため最小限の値で足りる。
const CONFIG = {
  timezone: 'Asia/Tokyo',
  service: 'zenn',
  git: {
    repo_path: '/repos/zenn-content',
    base_branch: 'main',
    output_dir: 'articles',
    auto_merge: true,
  },
} as Config;

// ---------------------------------------------------------------------------
// golden test: frontmatter の確定的な直列化(design.md §5.7 Zenn 行、issue #22 受け入れ条件)。
// ---------------------------------------------------------------------------

describe('golden: renderZennArticle frontmatter', () => {
  const note = buildNote({
    uuid: '5C1C2C3D-AAAA-4AAA-8AAA-AAAAAAAAAAAA', // 大文字 UUID → slug は小文字化(FR-23)
    folder: 'tech',
    title: 'こんにちは、世界', // 日本語タイトル
    emoji: null, // 絵文字未設定 → 既定値 📝 を使う
    tags: ['#TypeScript', '#Zenn記事'],
  });
  const markdown = '本文はここに書きます。\n\n見出しの前後にも改行があります。\n';

  const expectedArtifact =
    '---\n' +
    'title: "こんにちは、世界"\n' +
    'emoji: "📝"\n' +
    'type: "tech"\n' +
    'topics: ["TypeScript","Zenn記事"]\n' +
    'published: true\n' +
    '---\n' +
    '\n' +
    markdown;

  // sha256 of expectedArtifact's UTF-8 bytes, pinned so any change to the Zenn frontmatter
  // key order/quoting/topics-mapping/default-emoji convention is caught (design.md §12).
  const expectedHash = 'sha256:49848ee48dcdbe49c48bb3be80c6783a91a881ad84d7767415b0c25982199c52';

  it('serializes the fixed frontmatter block + body exactly (key order title/emoji/type/topics/published)', () => {
    const article = renderZennArticle({ note, markdown, config: CONFIG });
    expect(article.artifact).toBe(expectedArtifact);
  });

  it('computes the fixed sha256 content hash for the golden artifact', () => {
    const article = renderZennArticle({ note, markdown, config: CONFIG });
    expect(article.contentHash).toBe(expectedHash);
    expect(article.contentHash).toBe(computeContentHash(expectedArtifact));
  });

  it('carries noteUuid and title through to the RenderedArticle', () => {
    const article = renderZennArticle({ note, markdown, config: CONFIG });
    expect(article.noteUuid).toBe(note.uuid);
    expect(article.title).toBe('こんにちは、世界');
  });
});

// ---------------------------------------------------------------------------
// artifactPath golden(design.md §5.7「articles/<uuid小文字>.md」、FR-23)。
// ---------------------------------------------------------------------------

describe('renderZennArticle artifactPath', () => {
  it('is "articles/<uuid小文字>.md", lowercasing an uppercase uuid', () => {
    const note = buildNote({ uuid: '5C1C2C3D-0000-4000-8000-000000000001', folder: 'idea' });
    const article = renderZennArticle({ note, markdown: 'body', config: CONFIG });
    expect(article.artifactPath).toBe('articles/5c1c2c3d-0000-4000-8000-000000000001.md');
  });

  it('ignores config.git.output_dir — Zenn always writes under "articles/" (design.md §7)', () => {
    const note = buildNote({ uuid: '5c1c2c3d-0000-4000-8000-000000000001' });
    const customOutputDirConfig = {
      ...CONFIG,
      git: { ...CONFIG.git, output_dir: 'custom-dir' },
    } as Config;
    const article = renderZennArticle({ note, markdown: 'body', config: customOutputDirConfig });
    expect(article.artifactPath).toBe('articles/5c1c2c3d-0000-4000-8000-000000000001.md');
  });
});

// ---------------------------------------------------------------------------
// emoji 既定値(design.md §5.7「絵文字が無いノートは既定値 📝」)。
// ---------------------------------------------------------------------------

describe('renderZennArticle emoji', () => {
  it('uses note.emoji when present', () => {
    const note = buildNote({ emoji: '🚀' });
    const article = renderZennArticle({ note, markdown: 'body', config: CONFIG });
    expect(article.artifact).toContain('emoji: "🚀"');
  });

  it('defaults to 📝 when note.emoji is null', () => {
    const note = buildNote({ emoji: null });
    const article = renderZennArticle({ note, markdown: 'body', config: CONFIG });
    expect(article.artifact).toContain('emoji: "📝"');
  });
});

// ---------------------------------------------------------------------------
// topics マッピング(先頭の "#" を1つだけ除去。モジュール冒頭 JSDoc 参照)。
// ---------------------------------------------------------------------------

describe('renderZennArticle topics', () => {
  it('strips exactly one leading "#" from each tag', () => {
    const note = buildNote({ tags: ['#typescript', '#zenn'] });
    const article = renderZennArticle({ note, markdown: 'body', config: CONFIG });
    expect(article.artifact).toContain('topics: ["typescript","zenn"]');
  });

  it('produces an empty topics array for a note with no tags', () => {
    const note = buildNote({ tags: [] });
    const article = renderZennArticle({ note, markdown: 'body', config: CONFIG });
    expect(article.artifact).toContain('topics: []');
  });

  it('leaves a tag without a leading "#" unchanged (defensive)', () => {
    const note = buildNote({ tags: ['already-plain'] });
    const article = renderZennArticle({ note, markdown: 'body', config: CONFIG });
    expect(article.artifact).toContain('topics: ["already-plain"]');
  });
});

// ---------------------------------------------------------------------------
// type 検証(design.md §5.7「tech/idea 以外のフォルダ名なら…そのノートを失敗扱い」、FR-24)。
// ---------------------------------------------------------------------------

describe('renderZennArticle type validation (FR-24)', () => {
  it('accepts folder "tech"', () => {
    const note = buildNote({ folder: 'tech' });
    expect(() => renderZennArticle({ note, markdown: 'body', config: CONFIG })).not.toThrow();
  });

  it('accepts folder "idea"', () => {
    const note = buildNote({ folder: 'idea' });
    expect(() => renderZennArticle({ note, markdown: 'body', config: CONFIG })).not.toThrow();
  });

  it.each(['Archive', 'Tech', 'Dev/Ops: Log', ''])(
    'throws InvalidZennTypeError for folder %j (not exactly tech/idea)',
    (folder) => {
      const note = buildNote({ folder });
      expect(() => renderZennArticle({ note, markdown: 'body', config: CONFIG })).toThrow(
        InvalidZennTypeError,
      );
    },
  );

  it('includes the offending folder and noteUuid in the thrown error', () => {
    const note = buildNote({ uuid: 'note-uuid-under-test', folder: 'Archive' });
    try {
      renderZennArticle({ note, markdown: 'body', config: CONFIG });
      expect.unreachable('renderZennArticle should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidZennTypeError);
      const typedError = error as InvalidZennTypeError;
      expect(typedError.folder).toBe('Archive');
      expect(typedError.noteUuid).toBe('note-uuid-under-test');
      expect(typedError.message).toContain('Archive');
      expect(typedError.message).toContain('note-uuid-under-test');
    }
  });
});

// ---------------------------------------------------------------------------
// slug 検証(design.md §5.7・FR-23。防御的: 通常の36文字 UUID は常に満たす)。
// ---------------------------------------------------------------------------

describe('renderZennArticle slug validation (FR-23, defensive)', () => {
  it('throws InvalidZennSlugError when the lowercased uuid is too short (<12 chars)', () => {
    const note = buildNote({ uuid: 'short-id' });
    expect(() => renderZennArticle({ note, markdown: 'body', config: CONFIG })).toThrow(
      InvalidZennSlugError,
    );
  });

  it('throws InvalidZennSlugError when the uuid contains characters outside a-z0-9_-', () => {
    const note = buildNote({ uuid: '5c1c2c3d.0000.4000.8000.000000000001' });
    expect(() => renderZennArticle({ note, markdown: 'body', config: CONFIG })).toThrow(
      InvalidZennSlugError,
    );
  });

  it('accepts a normal 36-character Apple Notes uuid (hyphens included)', () => {
    const note = buildNote({ uuid: '5c1c2c3d-0000-4000-8000-000000000001' });
    expect(() => renderZennArticle({ note, markdown: 'body', config: CONFIG })).not.toThrow();
  });
});
