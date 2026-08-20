import { describe, expect, it } from 'vitest';
import { QiitaNoTagsRemainingError, renderQiitaArticle } from './qiita.js';
import type { Note } from '../model/note.js';
import type { Config } from '../config.js';
import type { Logger, WarnPayload } from '../logger.js';
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
    tags: ['#typescript'],
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-02T00:00:00Z'),
    bodyHtml: '<p>Hello World</p>',
    attachments: [],
    ...overrides,
  };
}

// Qiita は API モード(issue #82)。`config` は renderQiitaArticle が参照しないため
// 最小限の値で足りる。
const CONFIG = {
  timezone: 'Asia/Tokyo',
  service: 'qiita',
  qiita: { token_env: 'QIITA_TOKEN' },
} as Config;

function createFakeLogger(): { logger: Logger; warnings: WarnPayload[] } {
  const warnings: WarnPayload[] = [];
  const logger: Logger = {
    runStart: () => {},
    runEnd: () => {},
    exportDone: () => {},
    notePublished: () => {},
    noteSkipped: () => {},
    noteFailed: () => {},
    assetUploaded: () => {},
    warn: (payload) => {
      warnings.push(payload);
    },
  };
  return { logger, warnings };
}

// ---------------------------------------------------------------------------
// golden test: 冪等判定用ハッシュの確定的な直列化(design.md §5.6、issue #82 の
// contentHash 再定義: title + resolved tags + body Markdown のみ、dev.to と同じ形)。
// ---------------------------------------------------------------------------

describe('golden: renderQiitaArticle content hash', () => {
  const note = buildNote({
    uuid: '5c1c2c3d-0000-4000-8000-000000000001',
    title: 'こんにちは、世界',
    tags: ['#TypeScript', '#Qiita記事'],
  });
  const markdown = '本文はここに書きます。\n\n見出しの前後にも改行があります。\n';

  const expectedArtifact =
    '---\n' +
    'title: "こんにちは、世界"\n' +
    'tags: ["TypeScript","Qiita記事"]\n' +
    '---\n' +
    '\n' +
    markdown;

  it('serializes the title/(stripped)tags entries + body exactly (same shape as renderGenericArticle)', () => {
    const article = renderQiitaArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.artifact).toBe(expectedArtifact);
  });

  it('computes a content hash matching computeContentHash(expectedArtifact)', () => {
    const article = renderQiitaArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.contentHash).toBe(computeContentHash(expectedArtifact));
  });

  it('carries noteUuid and title through to the RenderedArticle', () => {
    const article = renderQiitaArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.noteUuid).toBe(note.uuid);
    expect(article.title).toBe('こんにちは、世界');
  });

  it('changes the content hash when only the title changes (change detection)', () => {
    const original = renderQiitaArticle({ note, markdown, config: CONFIG, prev: null });
    const retitled = renderQiitaArticle({
      note: buildNote({ ...note, title: 'A different title' }),
      markdown,
      config: CONFIG,
      prev: null,
    });
    expect(retitled.contentHash).not.toBe(original.contentHash);
  });

  it('changes the content hash when only the tags change (change detection)', () => {
    const original = renderQiitaArticle({ note, markdown, config: CONFIG, prev: null });
    const retagged = renderQiitaArticle({
      note: buildNote({ ...note, tags: ['#different'] }),
      markdown,
      config: CONFIG,
      prev: null,
    });
    expect(retagged.contentHash).not.toBe(original.contentHash);
  });

  it('does not change the content hash based on prev (remoteId is not part of the hash, unlike the old qiita-cli frontmatter)', () => {
    const withoutPrev = renderQiitaArticle({ note, markdown, config: CONFIG, prev: null });
    const withPrev = renderQiitaArticle({
      note,
      markdown,
      config: CONFIG,
      prev: {
        contentHash: 'sha256:previous',
        remoteId: 'abc123def456',
        firstPublishedAt: '2026-08-01T00:00:00+09:00',
        lastPublishedAt: '2026-08-01T00:00:00+09:00',
      },
    });
    expect(withPrev.contentHash).toBe(withoutPrev.contentHash);
  });
});

// ---------------------------------------------------------------------------
// API モード専用フィールド(design.md §5.7、`src/publishers/types.ts` の JSDoc、issue #82)。
// ---------------------------------------------------------------------------

describe('renderQiitaArticle API-mode fields', () => {
  it('sets bodyMarkdown to the pure transformed body (no frontmatter)', () => {
    const note = buildNote();
    const markdown = 'pure body\n\nwith multiple paragraphs\n';
    const article = renderQiitaArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.bodyMarkdown).toBe(markdown);
  });

  it('sets tags to the resolved (# stripped, constraint-applied) list, unlike dev.to which passes raw tags', () => {
    const note = buildNote({ tags: ['#a', '#b'] });
    const article = renderQiitaArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.tags).toEqual(['a', 'b']);
  });

  it('does not set artifactPath (API mode, no file output)', () => {
    const note = buildNote();
    const article = renderQiitaArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifactPath).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// タグ制約(design.md §5.7「1〜5個必須、スペース不可」、issue #82 でも変更なし)。
// ---------------------------------------------------------------------------

describe('renderQiitaArticle tags', () => {
  it('strips exactly one leading "#" from each tag', () => {
    const note = buildNote({ tags: ['#typescript', '#qiita'] });
    const article = renderQiitaArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('tags: ["typescript","qiita"]');
    expect(article.tags).toEqual(['typescript', 'qiita']);
  });

  it('drops tags that become empty after stripping the leading "#" and logs a warning', () => {
    const note = buildNote({
      uuid: 'note-under-test',
      title: 'Empty Tag Test',
      tags: ['#', '#typescript'],
    });
    const { logger, warnings } = createFakeLogger();
    const article = renderQiitaArticle({
      note,
      markdown: 'body',
      config: CONFIG,
      prev: null,
      logger,
    });

    expect(article.artifact).toContain('tags: ["typescript"]');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('empty');
  });

  it('throws QiitaNoTagsRemainingError when all tags become empty after stripping "#"', () => {
    const note = buildNote({ tags: ['#'] });
    const { logger } = createFakeLogger();
    expect(() =>
      renderQiitaArticle({ note, markdown: 'body', config: CONFIG, prev: null, logger }),
    ).toThrow(QiitaNoTagsRemainingError);
  });

  it('drops tags containing a half-width space and logs a warning with service/noteUuid/title', () => {
    const note = buildNote({
      uuid: 'note-under-test',
      title: 'Space Test',
      tags: ['#good-tag', '#has space', '#another good'],
    });
    const { logger, warnings } = createFakeLogger();
    const article = renderQiitaArticle({
      note,
      markdown: 'body',
      config: CONFIG,
      prev: null,
      logger,
    });

    expect(article.artifact).toContain('tags: ["good-tag"]');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      service: 'qiita',
      noteUuid: 'note-under-test',
      title: 'Space Test',
    });
    expect(warnings[0]?.message).toContain('has space');
    expect(warnings[0]?.message).toContain('another good');
  });

  it('truncates to the first 5 tags when more than 5 remain, and logs a warning', () => {
    const note = buildNote({
      uuid: 'note-under-test',
      title: 'Truncate Test',
      tags: ['#a', '#b', '#c', '#d', '#e', '#f', '#g'],
    });
    const { logger, warnings } = createFakeLogger();
    const article = renderQiitaArticle({
      note,
      markdown: 'body',
      config: CONFIG,
      prev: null,
      logger,
    });

    expect(article.artifact).toContain('tags: ["a","b","c","d","e"]');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      service: 'qiita',
      noteUuid: 'note-under-test',
      title: 'Truncate Test',
    });
    expect(warnings[0]?.message).toMatch(/truncated/i);
  });

  it('applies the space-drop before the 5-tag truncation (design.md §5.7 order)', () => {
    // 7 tags total; 2 contain spaces. After dropping spaces: 5 remain (exactly the limit,
    // so no truncation warning should fire).
    const note = buildNote({
      tags: ['#a', '#b c', '#c', '#d', '#e', '#f g', '#g'],
    });
    const { logger, warnings } = createFakeLogger();
    const article = renderQiitaArticle({
      note,
      markdown: 'body',
      config: CONFIG,
      prev: null,
      logger,
    });

    expect(article.artifact).toContain('tags: ["a","c","d","e","g"]');
    expect(warnings).toHaveLength(1); // only the space-drop warning, no truncation warning
    expect(warnings[0]?.message).toMatch(/space/i);
  });

  it('throws QiitaNoTagsRemainingError when 0 tags remain after dropping spaced tags', () => {
    const note = buildNote({ uuid: 'no-tags-note', tags: ['#has space', '#also has space'] });
    expect(() =>
      renderQiitaArticle({ note, markdown: 'body', config: CONFIG, prev: null }),
    ).toThrow(QiitaNoTagsRemainingError);
  });

  it('throws QiitaNoTagsRemainingError when the note has no tags at all', () => {
    const note = buildNote({ uuid: 'no-tags-note', tags: [] });
    try {
      renderQiitaArticle({ note, markdown: 'body', config: CONFIG, prev: null });
      expect.unreachable('renderQiitaArticle should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(QiitaNoTagsRemainingError);
      expect((error as QiitaNoTagsRemainingError).noteUuid).toBe('no-tags-note');
    }
  });

  it('does not throw when logger is not provided but a warning would otherwise fire', () => {
    const note = buildNote({ tags: ['#ok', '#has space'] });
    expect(() =>
      renderQiitaArticle({ note, markdown: 'body', config: CONFIG, prev: null }),
    ).not.toThrow();
  });
});
