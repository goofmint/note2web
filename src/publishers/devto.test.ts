import { describe, expect, it } from 'vitest';
import { renderDevtoArticle } from './devto.js';
import type { Note } from '../model/note.js';
import type { Config } from '../config.js';
import { computeContentHash } from '../transform/frontmatter.js';

function buildNote(overrides: Partial<Note> = {}): Note {
  // Note の不変条件「`folder` は `folderPath` の最終要素と一致する」(src/model/note.ts)を
  // fixture でも維持する: `folderPath` だけが指定されたら `folder` を末尾要素から導出し、
  // 両方指定されて食い違う場合はテストの書き誤りとして即座に失敗させる。
  const folder = overrides.folder ?? overrides.folderPath?.at(-1) ?? 'tech';
  const folderPath = overrides.folderPath ?? [folder];
  if (folderPath.at(-1) !== folder) {
    throw new Error(
      `buildNote: folder ${JSON.stringify(folder)} must equal the last element of ` +
        `folderPath ${JSON.stringify(folderPath)}`,
    );
  }
  return {
    uuid: '5c1c2c3d-0000-0000-0000-000000000001',
    folder,
    folderPath,
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

// dev.to は API モード。`config` は renderDevtoArticle が参照しないため最小限の値で足りる。
const CONFIG = {
  timezone: 'Asia/Tokyo',
  service: 'devto',
  devto: { api_key_env: 'DEVTO_API_KEY' },
} as Config;

// ---------------------------------------------------------------------------
// golden test: 冪等判定用ハッシュの確定的な直列化(design.md §5.6・§5.7、issue #27)。
// ---------------------------------------------------------------------------

describe('golden: renderDevtoArticle content hash', () => {
  const note = buildNote({
    uuid: '5c1c2c3d-0000-4000-8000-000000000001',
    title: 'こんにちは、世界',
    tags: ['#TypeScript', '#devto記事'],
  });
  const markdown = '本文はここに書きます。\n\n見出しの前後にも改行があります。\n';

  const expectedArtifact =
    '---\n' +
    'title: "こんにちは、世界"\n' +
    'tags: ["#TypeScript","#devto記事"]\n' +
    '---\n' +
    '\n' +
    markdown;

  it('serializes the title/tags entries + body exactly (same shape as renderGenericArticle)', () => {
    const article = renderDevtoArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.artifact).toBe(expectedArtifact);
  });

  it('computes a content hash matching computeContentHash(expectedArtifact)', () => {
    const article = renderDevtoArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.contentHash).toBe(computeContentHash(expectedArtifact));
  });

  it('carries noteUuid and title through to the RenderedArticle', () => {
    const article = renderDevtoArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.noteUuid).toBe(note.uuid);
    expect(article.title).toBe('こんにちは、世界');
  });

  it('changes the content hash when only the title changes (change detection)', () => {
    const original = renderDevtoArticle({ note, markdown, config: CONFIG, prev: null });
    const retitled = renderDevtoArticle({
      note: buildNote({ ...note, title: 'A different title' }),
      markdown,
      config: CONFIG,
      prev: null,
    });
    expect(retitled.contentHash).not.toBe(original.contentHash);
  });

  it('changes the content hash when only the tags change (change detection)', () => {
    const original = renderDevtoArticle({ note, markdown, config: CONFIG, prev: null });
    const retagged = renderDevtoArticle({
      note: buildNote({ ...note, tags: ['#different'] }),
      markdown,
      config: CONFIG,
      prev: null,
    });
    expect(retagged.contentHash).not.toBe(original.contentHash);
  });
});

// ---------------------------------------------------------------------------
// API モード専用フィールド(design.md §5.7、`src/publishers/types.ts` の JSDoc)。
// ---------------------------------------------------------------------------

describe('renderDevtoArticle API-mode fields', () => {
  it('sets bodyMarkdown to the pure transformed body (no frontmatter)', () => {
    const note = buildNote();
    const markdown = 'pure body\n\nwith multiple paragraphs\n';
    const article = renderDevtoArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.bodyMarkdown).toBe(markdown);
  });

  it('passes note.tags through to RenderedArticle.tags unmodified (no "#" stripping, no truncation)', () => {
    const note = buildNote({ tags: ['#a', '#b', '#c', '#d', '#e', '#f'] });
    const article = renderDevtoArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.tags).toEqual(['#a', '#b', '#c', '#d', '#e', '#f']);
  });

  it('does not set artifactPath (API mode, no file output)', () => {
    const note = buildNote();
    const article = renderDevtoArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifactPath).toBeUndefined();
  });
});
