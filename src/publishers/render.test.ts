import { describe, expect, it } from 'vitest';
import { renderGenericArticle } from './render.js';
import type { Note } from '../model/note.js';
import type { Config } from '../config.js';

function buildNote(overrides: Partial<Note> = {}): Note {
  // Note の不変条件「`folder` は `folderPath` の最終要素と一致する」(src/model/note.ts)を
  // fixture でも維持する: `folderPath` だけが指定されたら `folder` を末尾要素から導出し、
  // 両方指定されて食い違う場合はテストの書き誤りとして即座に失敗させる。
  const folder = overrides.folder ?? overrides.folderPath?.at(-1) ?? 'Tech';
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
    tags: ['#hello'],
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-02T00:00:00Z'),
    bodyHtml: '<p>Hello World</p>',
    attachments: [],
    ...overrides,
  };
}

// API/CLI モード(qiita)。artifactPath は design.md §8「Git モードでは null」に対応し、
// この Renderer では git モード以外なら `undefined` のままとする。
const API_CONFIG = { timezone: 'Asia/Tokyo', service: 'qiita' } as Config;

// Git モード(zenn)。`git.output_dir` から artifactPath を組み立てる(CodeRabbit review, PR #47)。
const GIT_CONFIG = {
  timezone: 'Asia/Tokyo',
  service: 'zenn',
  git: {
    repo_path: '/repos/zenn-content',
    base_branch: 'main',
    output_dir: 'articles',
    auto_merge: true,
  },
} as Config;

describe('renderGenericArticle', () => {
  it('produces a deterministic content hash for identical input', () => {
    const note = buildNote();
    const a = renderGenericArticle({ note, markdown: 'body text', config: API_CONFIG, prev: null });
    const b = renderGenericArticle({ note, markdown: 'body text', config: API_CONFIG, prev: null });
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes the content hash when the body changes', () => {
    const note = buildNote();
    const a = renderGenericArticle({ note, markdown: 'body text', config: API_CONFIG, prev: null });
    const b = renderGenericArticle({
      note,
      markdown: 'different body text',
      config: API_CONFIG,
      prev: null,
    });
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('includes title and tags in the frontmatter block', () => {
    const note = buildNote({ title: 'My Title', tags: ['#a', '#b'] });
    const { artifact } = renderGenericArticle({
      note,
      markdown: 'body',
      config: API_CONFIG,
      prev: null,
    });
    expect(artifact).toContain('title: "My Title"');
    expect(artifact).toContain('tags: ["#a","#b"]');
    expect(artifact).toContain('\nbody');
  });

  it('carries noteUuid and title through to the RenderedArticle', () => {
    const note = buildNote({ uuid: 'abc-123', title: 'Some Title' });
    const article = renderGenericArticle({
      note,
      markdown: 'body',
      config: API_CONFIG,
      prev: null,
    });
    expect(article.noteUuid).toBe('abc-123');
    expect(article.title).toBe('Some Title');
  });

  it('leaves artifactPath undefined for API/CLI-mode services (design.md §8: Git モードでは null)', () => {
    const note = buildNote();
    const article = renderGenericArticle({
      note,
      markdown: 'body',
      config: API_CONFIG,
      prev: null,
    });
    expect(article.artifactPath).toBeUndefined();
  });

  it('derives artifactPath as "<git.output_dir>/<uuid>.md" for git-mode services (design.md §8 example)', () => {
    const note = buildNote({ uuid: '5c1c2c3d-0000-0000-0000-000000000001' });
    const article = renderGenericArticle({
      note,
      markdown: 'body',
      config: GIT_CONFIG,
      prev: null,
    });
    expect(article.artifactPath).toBe('articles/5c1c2c3d-0000-0000-0000-000000000001.md');
  });
});
