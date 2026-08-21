import { describe, expect, it } from 'vitest';
import { renderNoteArticle } from './note.js';
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

// note.com は API モード。renderNoteArticle は config を参照しないため最小限の値で足りる。
const CONFIG = {
  timezone: 'Asia/Tokyo',
  service: 'note',
  note: { session_cookie_env: 'NOTE_SESSION_COOKIE' },
} as Config;

// ---------------------------------------------------------------------------
// golden test: frontmatter 相当の確定的な直列化(issue #86。dev.to/Qiita と同じ
// 「title/tags のみをハッシュ対象にする」方式)。
// ---------------------------------------------------------------------------

describe('golden: renderNoteArticle artifact/contentHash', () => {
  const note = buildNote({
    uuid: '5C1C2C3D-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    title: 'こんにちは、note',
    tags: ['#TypeScript', '#note記事'],
  });
  const markdown = '本文はここに書きます。\n\n見出しの前後にも改行があります。\n';

  const expectedArtifact =
    '---\n' +
    'title: "こんにちは、note"\n' +
    'tags: ["#TypeScript","#note記事"]\n' +
    '---\n' +
    '\n' +
    markdown;

  const expectedHash = computeContentHash(expectedArtifact);

  it('serializes title/tags (unmodified, "#" not stripped here — Publisher.publish() shapes hashtags at wire time)', () => {
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
// API モード専用フィールド(bodyMarkdown/tags/attachments/assetSourceDir、
// `src/publishers/types.ts` 参照)。
// ---------------------------------------------------------------------------

describe('renderNoteArticle API-mode fields', () => {
  it('sets bodyMarkdown to the raw converted markdown (unresolved image placeholders included)', () => {
    const note = buildNote();
    const markdown = 'text\n\n![alt](note2web-asset://img-1)\n';
    const article = renderNoteArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.bodyMarkdown).toBe(markdown);
  });

  it('sets tags to Note#tags unmodified ("#" not stripped)', () => {
    const note = buildNote({ tags: ['#typescript', 'no-hash'] });
    const article = renderNoteArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.tags).toEqual(['#typescript', 'no-hash']);
  });

  it('does not set artifactPath (API mode, no file output)', () => {
    const note = buildNote();
    const article = renderNoteArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifactPath).toBeUndefined();
  });

  it('passes note.attachments through to RenderedArticle.attachments unmodified', () => {
    const attachments = [{ identifier: 'img-1', path: 'sketch.png' }];
    const note = buildNote({ attachments });
    const article = renderNoteArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.attachments).toBe(attachments);
  });

  it('sets assetSourceDir from RenderNoteInput.exportDir', () => {
    const note = buildNote();
    const article = renderNoteArticle({
      note,
      markdown: 'body',
      config: CONFIG,
      prev: null,
      exportDir: '/tmp/export-dir-123',
    });
    expect(article.assetSourceDir).toBe('/tmp/export-dir-123');
  });

  it('leaves assetSourceDir undefined when exportDir is not provided', () => {
    const note = buildNote();
    const article = renderNoteArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.assetSourceDir).toBeUndefined();
  });
});
