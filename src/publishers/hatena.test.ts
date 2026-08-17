import { describe, expect, it } from 'vitest';
import { renderHatenaArticle } from './hatena.js';
import type { Note } from '../model/note.js';
import type { Config } from '../config.js';
import { computeContentHash } from '../transform/frontmatter.js';

function buildNote(overrides: Partial<Note> = {}): Note {
  const folder = overrides.folder ?? 'tech';
  return {
    uuid: '5c1c2c3d-0000-0000-0000-000000000001',
    folder,
    folderPath: [folder],
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

// はてなは API モード。`renderHatenaArticle` は `config.hatena.hatena_id`(<author><name>用)
// のみ参照するため、それ以外は最小限の値で足りる(`src/publishers/devto.test.ts` と同じ方針)。
const CONFIG = {
  timezone: 'Asia/Tokyo',
  service: 'hatena',
  hatena: {
    hatena_id: 'example',
    blog_id: 'example.hatenablog.com',
    api_key_env: 'HATENA_API_KEY',
  },
} as Config;

// ---------------------------------------------------------------------------
// golden test: AtomPub <entry> XML の確定的な直列化(design.md §5.7、issue #28)。
// ---------------------------------------------------------------------------

describe('golden: renderHatenaArticle AtomPub entry XML', () => {
  const note = buildNote({
    uuid: '5c1c2c3d-0000-4000-8000-000000000001',
    folder: 'tech',
    title: 'こんにちは、世界',
    tags: ['#TypeScript', '#devto記事'],
  });
  const markdown = '本文はここに書きます。\n\n見出しの前後にも改行があります。\n';

  const expectedArtifact =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<entry xmlns="http://www.w3.org/2005/Atom">\n' +
    '  <title>こんにちは、世界</title>\n' +
    '  <author>\n' +
    '    <name>example</name>\n' +
    '  </author>\n' +
    '  <content type="text/x-markdown">本文はここに書きます。\n' +
    '\n' +
    '見出しの前後にも改行があります。\n' +
    '</content>\n' +
    '  <category term="tech"/>\n' +
    '  <category term="TypeScript"/>\n' +
    '  <category term="devto記事"/>\n' +
    '</entry>\n';

  it('serializes the XML declaration/entry/title/author/content/category elements exactly', () => {
    const article = renderHatenaArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.artifact).toBe(expectedArtifact);
  });

  it('computes a content hash matching computeContentHash(expectedArtifact)', () => {
    const article = renderHatenaArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.contentHash).toBe(computeContentHash(expectedArtifact));
  });

  it('carries noteUuid and title through to the RenderedArticle', () => {
    const article = renderHatenaArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.noteUuid).toBe(note.uuid);
    expect(article.title).toBe('こんにちは、世界');
  });

  it('does not set artifactPath/bodyMarkdown/tags (API mode; artifact IS the wire body)', () => {
    const article = renderHatenaArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.artifactPath).toBeUndefined();
    expect(article.bodyMarkdown).toBeUndefined();
    expect(article.tags).toBeUndefined();
  });

  it('changes the content hash when only the title changes (change detection)', () => {
    const original = renderHatenaArticle({ note, markdown, config: CONFIG, prev: null });
    const retitled = renderHatenaArticle({
      note: buildNote({ ...note, title: 'A different title' }),
      markdown,
      config: CONFIG,
      prev: null,
    });
    expect(retitled.contentHash).not.toBe(original.contentHash);
  });

  it('changes the content hash when only the tags change (change detection)', () => {
    const original = renderHatenaArticle({ note, markdown, config: CONFIG, prev: null });
    const retagged = renderHatenaArticle({
      note: buildNote({ ...note, tags: ['#different'] }),
      markdown,
      config: CONFIG,
      prev: null,
    });
    expect(retagged.contentHash).not.toBe(original.contentHash);
  });

  it('changes the content hash when only the body markdown changes (change detection)', () => {
    const original = renderHatenaArticle({ note, markdown, config: CONFIG, prev: null });
    const rebodied = renderHatenaArticle({
      note,
      markdown: 'different body\n',
      config: CONFIG,
      prev: null,
    });
    expect(rebodied.contentHash).not.toBe(original.contentHash);
  });
});

// ---------------------------------------------------------------------------
// category(フォルダ + タグ)の組み立て: `#` 除去・重複排除(design.md §5.7 が明記していない
// 部分の実装判断、モジュール冒頭 JSDoc「category の `#` 除去・重複排除」参照)。
// ---------------------------------------------------------------------------

describe('renderHatenaArticle category (folder + tags) construction', () => {
  it('emits the folder as the first <category>, before any tags', () => {
    const note = buildNote({ folder: 'idea', tags: ['#a', '#b'] });
    const article = renderHatenaArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    const terms = [...article.artifact.matchAll(/<category term="([^"]*)"\/>/g)].map(
      (match) => match[1],
    );
    expect(terms).toEqual(['idea', 'a', 'b']);
  });

  it('strips exactly one leading "#" from each tag', () => {
    const note = buildNote({ folder: 'tech', tags: ['##double', '#single'] });
    const article = renderHatenaArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    const terms = [...article.artifact.matchAll(/<category term="([^"]*)"\/>/g)].map(
      (match) => match[1],
    );
    // "##double" loses only the first "#", becoming "#double".
    expect(terms).toEqual(['tech', '#double', 'single']);
  });

  it('drops a tag that becomes empty after stripping "#" (a tag that was just "#")', () => {
    const note = buildNote({ folder: 'tech', tags: ['#', '#real'] });
    const article = renderHatenaArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    const terms = [...article.artifact.matchAll(/<category term="([^"]*)"\/>/g)].map(
      (match) => match[1],
    );
    expect(terms).toEqual(['tech', 'real']);
  });

  it('deduplicates tags that collide after stripping "#", keeping first occurrence order', () => {
    const note = buildNote({ folder: 'tech', tags: ['#dup', '#other', '#dup'] });
    const article = renderHatenaArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    const terms = [...article.artifact.matchAll(/<category term="([^"]*)"\/>/g)].map(
      (match) => match[1],
    );
    expect(terms).toEqual(['tech', 'dup', 'other']);
  });

  it('deduplicates a tag that collides with the folder name, keeping only 1 <category> for it', () => {
    const note = buildNote({ folder: 'tech', tags: ['#tech', '#other'] });
    const article = renderHatenaArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    const terms = [...article.artifact.matchAll(/<category term="([^"]*)"\/>/g)].map(
      (match) => match[1],
    );
    expect(terms).toEqual(['tech', 'other']);
  });
});

// ---------------------------------------------------------------------------
// XML エスケープの境界値(design.md §5.7 が明記していない部分の実装判断: escaping (&, <, >, ")、
// モジュール冒頭 JSDoc 参照)。
// ---------------------------------------------------------------------------

describe('renderHatenaArticle XML escaping', () => {
  it('escapes &, <, > in the <title> text node', () => {
    const note = buildNote({ title: 'A & B <tag> "quoted"' });
    const article = renderHatenaArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('<title>A &amp; B &lt;tag&gt; "quoted"</title>');
  });

  it('escapes &, <, > in the <content> text node (markdown body)', () => {
    const note = buildNote();
    const markdown = 'Array<T> & `a < b` in code\n';
    const article = renderHatenaArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.artifact).toContain(
      '<content type="text/x-markdown">Array&lt;T&gt; &amp; `a &lt; b` in code\n</content>',
    );
  });

  it('escapes &, <, >, and " in a <category term="…"> attribute value', () => {
    const note = buildNote({ folder: 'tech', tags: ['#A&B<C>"D"'] });
    const article = renderHatenaArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('<category term="A&amp;B&lt;C&gt;&quot;D&quot;"/>');
  });

  it('escapes the <author><name> text node (built from config.hatena.hatena_id)', () => {
    const config = {
      timezone: 'Asia/Tokyo',
      service: 'hatena',
      hatena: {
        hatena_id: 'a&b',
        blog_id: 'example.hatenablog.com',
        api_key_env: 'HATENA_API_KEY',
      },
    } as Config;
    const article = renderHatenaArticle({
      note: buildNote(),
      markdown: 'body',
      config,
      prev: null,
    });
    expect(article.artifact).toContain('<name>a&amp;b</name>');
  });
});
