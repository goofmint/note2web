import { describe, expect, it } from 'vitest';
import { renderHugoArticle } from './hugo.js';
import type { Note } from '../model/note.js';
import type { Config } from '../config.js';
import { computeContentHash } from '../transform/frontmatter.js';

function buildNote(overrides: Partial<Note> = {}): Note {
  const folder = overrides.folder ?? 'Tech';
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

// Hugo は Git モード。design.md §7 の hugo.yaml fixture(test/fixtures/configs/hugo.yaml)と
// 同じ output_dir 例("content/posts")を使う。
const CONFIG = {
  timezone: 'Asia/Tokyo',
  service: 'hugo',
  git: {
    repo_path: '~/src/hugo-content',
    base_branch: 'main',
    output_dir: 'content/posts',
    auto_merge: true,
  },
} as Config;

// ---------------------------------------------------------------------------
// golden test: frontmatter の確定的な直列化(design.md §5.7 Hugo 行、issue #23 受け入れ条件)。
// ---------------------------------------------------------------------------

describe('golden: renderHugoArticle frontmatter', () => {
  const note = buildNote({
    uuid: '5C1C2C3D-AAAA-4AAA-8AAA-AAAAAAAAAAAA', // 大文字混じり UUID → Hugo は小文字化しない
    folder: 'Tech', // Zenn と異なり folder は任意の文字列を許容(型検証なし)
    title: 'こんにちは、Hugo', // 日本語タイトル
    tags: ['#TypeScript', '#Hugo'], // "#" を保持したまま(design.md §5.7 が変換を明記していない)
    createdAt: new Date('2026-08-01T00:00:00Z'), // Asia/Tokyo で 2026-08-01T09:00:00+09:00
    updatedAt: new Date('2026-08-02T03:30:00Z'), // Asia/Tokyo で 2026-08-02T12:30:00+09:00
  });
  const markdown = '本文はここに書きます。\n\n見出しの前後にも改行があります。\n';

  const expectedArtifact =
    '---\n' +
    'title: "こんにちは、Hugo"\n' +
    'date: "2026-08-01T09:00:00+09:00"\n' +
    'lastmod: "2026-08-02T12:30:00+09:00"\n' +
    'categories: ["Tech"]\n' +
    'tags: ["#TypeScript","#Hugo"]\n' +
    '---\n' +
    '\n' +
    markdown;

  // sha256 of expectedArtifact's UTF-8 bytes, pinned so any change to the Hugo frontmatter
  // key order/quoting/date-formatting/tags-mapping convention is caught (design.md §12).
  const expectedHash = 'sha256:e4f0fe09236829dc61e1e9703265e799f3ae4fb921386c40188bb946759008c7';

  it('serializes the fixed frontmatter block + body exactly (key order title/date/lastmod/categories/tags)', () => {
    const article = renderHugoArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.artifact).toBe(expectedArtifact);
  });

  it('computes the fixed sha256 content hash for the golden artifact', () => {
    const article = renderHugoArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.contentHash).toBe(expectedHash);
    expect(article.contentHash).toBe(computeContentHash(expectedArtifact));
  });

  it('carries noteUuid and title through to the RenderedArticle', () => {
    const article = renderHugoArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.noteUuid).toBe(note.uuid);
    expect(article.title).toBe('こんにちは、Hugo');
  });
});

// ---------------------------------------------------------------------------
// artifactPath golden(design.md §5.7「<output_dir>/<uuid>.md」)。
// ---------------------------------------------------------------------------

describe('renderHugoArticle artifactPath', () => {
  it('is "<output_dir>/<uuid>.md", NOT lowercasing an uppercase uuid (unlike Zenn)', () => {
    const note = buildNote({ uuid: '5C1C2C3D-0000-4000-8000-000000000001' });
    const article = renderHugoArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifactPath).toBe('content/posts/5C1C2C3D-0000-4000-8000-000000000001.md');
  });

  it('uses config.git.output_dir (unlike Zenn, which ignores it — design.md §5.7)', () => {
    const note = buildNote({ uuid: '5c1c2c3d-0000-4000-8000-000000000001' });
    const customOutputDirConfig = {
      ...CONFIG,
      git: { ...CONFIG.git, output_dir: 'posts' },
    } as Config;
    const article = renderHugoArticle({
      note,
      markdown: 'body',
      config: customOutputDirConfig,
      prev: null,
    });
    expect(article.artifactPath).toBe('posts/5c1c2c3d-0000-4000-8000-000000000001.md');
  });

  it('throws when config.git is undefined (defensive; configSchema guarantees it for service "hugo")', () => {
    const note = buildNote();
    const noGitConfig = { timezone: 'Asia/Tokyo', service: 'hugo' } as Config;
    expect(() =>
      renderHugoArticle({ note, markdown: 'body', config: noGitConfig, prev: null }),
    ).toThrow(/requires config\.git/);
  });
});

// ---------------------------------------------------------------------------
// categories マッピング(design.md §5.7「categories: [フォルダ名]」)。
// ---------------------------------------------------------------------------

describe('renderHugoArticle categories', () => {
  it('wraps note.folder in a single-element array, unchanged (no slugification, no allowlist)', () => {
    const note = buildNote({ folder: 'Dev/Ops: Log' });
    const article = renderHugoArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('categories: ["Dev/Ops: Log"]');
  });

  it('accepts any folder name (no tech/idea allowlist like Zenn — FR-24 does not apply to Hugo)', () => {
    const note = buildNote({ folder: 'Archive' });
    expect(() =>
      renderHugoArticle({ note, markdown: 'body', config: CONFIG, prev: null }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// tags マッピング(design.md §5.7 が変換を明記していないため無変換。"#" を保持する)。
// ---------------------------------------------------------------------------

describe('renderHugoArticle tags', () => {
  it('keeps the leading "#" on each tag, unlike Zenn topics', () => {
    const note = buildNote({ tags: ['#typescript', '#hugo記事'] });
    const article = renderHugoArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('tags: ["#typescript","#hugo記事"]');
  });

  it('produces an empty tags array for a note with no tags', () => {
    const note = buildNote({ tags: [] });
    const article = renderHugoArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('tags: []');
  });
});

// ---------------------------------------------------------------------------
// date / lastmod(design.md §5.7「date(作成日時)/ lastmod(更新日時)」、formatTimestamp 経由)。
// ---------------------------------------------------------------------------

describe('renderHugoArticle date/lastmod', () => {
  it('formats createdAt as `date` and updatedAt as `lastmod` in config.timezone, fixed offset, second precision', () => {
    const note = buildNote({
      createdAt: new Date('2026-01-15T15:00:00Z'), // UTC冬 → Asia/Tokyo +09:00 は年中固定(DST無し)
      updatedAt: new Date('2026-01-16T23:59:59Z'),
    });
    const article = renderHugoArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('date: "2026-01-16T00:00:00+09:00"');
    expect(article.artifact).toContain('lastmod: "2026-01-17T08:59:59+09:00"');
  });

  it('respects a non-default config.timezone', () => {
    const note = buildNote({
      createdAt: new Date('2026-08-01T00:00:00Z'),
      updatedAt: new Date('2026-08-02T00:00:00Z'),
    });
    const utcConfig = { ...CONFIG, timezone: 'UTC' } as Config;
    const article = renderHugoArticle({ note, markdown: 'body', config: utcConfig, prev: null });
    expect(article.artifact).toContain('date: "2026-08-01T00:00:00+00:00"');
    expect(article.artifact).toContain('lastmod: "2026-08-02T00:00:00+00:00"');
  });

  it('is run-invariant: does not depend on the current wall-clock time', () => {
    const note = buildNote();
    const a = renderHugoArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    const b = renderHugoArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(a.contentHash).toBe(b.contentHash);
  });
});
