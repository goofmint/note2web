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
// 画像(利用者決定 2026-08-21、モジュール冒頭 JSDoc「2. 画像」参照)。
// ---------------------------------------------------------------------------
//
// `renderNoteArticle` 自身は画像の検出・拒否を一切行わない——`assets/uploader.ts` の
// `processNoteBody` が事前にローカル相対パス(`./images/<identifier><ext>`)へ解決済みの
// 本文を渡してくる前提のため、ここでは単にその本文をそのまま frontmatter に埋め込んで
// 通過することだけを確認する。

describe('renderNoteArticle with an already-resolved local image reference', () => {
  it('publishes normally: a "./images/<identifier><ext>" reference passes through unchanged', () => {
    const note = buildNote();
    const markdown =
      'text before\n\n![alt text](./images/88888888-8888-4888-8888-888888888888.png)\n';
    const article = renderNoteArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.artifact).toContain(
      '![alt text](./images/88888888-8888-4888-8888-888888888888.png)',
    );
  });
});
