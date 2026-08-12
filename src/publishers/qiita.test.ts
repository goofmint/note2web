import { describe, expect, it } from 'vitest';
import { QiitaNoTagsRemainingError, renderQiitaArticle } from './qiita.js';
import type { Note } from '../model/note.js';
import type { Config } from '../config.js';
import type { Logger, WarnPayload } from '../logger.js';
import type { NoteState } from '../state/store.js';
import { computeContentHash } from '../transform/frontmatter.js';

function buildNote(overrides: Partial<Note> = {}): Note {
  return {
    uuid: '5c1c2c3d-0000-0000-0000-000000000001',
    folder: 'tech',
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

// Qiita は API/CLI モード。`config` は renderQiitaArticle が参照しないため最小限の値で足りる。
const CONFIG = {
  timezone: 'Asia/Tokyo',
  service: 'qiita',
  qiita: { workspace: '~/src/qiita-content', token_env: 'QIITA_TOKEN' },
} as Config;

function buildNoteState(overrides: Partial<NoteState> = {}): NoteState {
  return {
    contentHash: 'sha256:previous',
    remoteId: null,
    firstPublishedAt: '2026-08-01T00:00:00+09:00',
    lastPublishedAt: '2026-08-01T00:00:00+09:00',
    ...overrides,
  };
}

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
// golden test: frontmatter の確定的な直列化(design.md §5.7 Qiita 行)。
// ---------------------------------------------------------------------------

describe('golden: renderQiitaArticle frontmatter', () => {
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
    'private: false\n' +
    'slide: false\n' +
    'id: null\n' +
    '---\n' +
    '\n' +
    markdown;

  it('serializes the fixed frontmatter block + body exactly (key order title/tags/private/slide/id)', () => {
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
});

// ---------------------------------------------------------------------------
// artifactPath(design.md §5.7「<itemsRootDir>/public/<basename>.md」)。
// ---------------------------------------------------------------------------

describe('renderQiitaArticle artifactPath', () => {
  it('is "public/<uuid>.md" (no case transform, unlike Zenn slugs)', () => {
    const note = buildNote({ uuid: '5C1C2C3D-0000-4000-8000-000000000001' });
    const article = renderQiitaArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifactPath).toBe('public/5C1C2C3D-0000-4000-8000-000000000001.md');
  });
});

// ---------------------------------------------------------------------------
// id: prev の remoteId をそのまま引き継ぐ / 初回は null(design.md §5.7)。
// ---------------------------------------------------------------------------

describe('renderQiitaArticle id', () => {
  it('writes id: null when prev is null (first publish)', () => {
    const note = buildNote();
    const article = renderQiitaArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('id: null');
  });

  it('writes id: null when prev.remoteId is null (previously failed/unpublished)', () => {
    const note = buildNote();
    const prev = buildNoteState({ remoteId: null });
    const article = renderQiitaArticle({ note, markdown: 'body', config: CONFIG, prev });
    expect(article.artifact).toContain('id: null');
  });

  it('writes the previous remoteId back when re-publishing an already-published note', () => {
    const note = buildNote();
    const prev = buildNoteState({ remoteId: 'abc123def456' });
    const article = renderQiitaArticle({ note, markdown: 'body', config: CONFIG, prev });
    expect(article.artifact).toContain('id: "abc123def456"');
  });
});

// ---------------------------------------------------------------------------
// タグ制約(design.md §5.7「1〜5個必須、スペース不可」)。
// ---------------------------------------------------------------------------

describe('renderQiitaArticle tags', () => {
  it('strips exactly one leading "#" from each tag', () => {
    const note = buildNote({ tags: ['#typescript', '#qiita'] });
    const article = renderQiitaArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('tags: ["typescript","qiita"]');
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
