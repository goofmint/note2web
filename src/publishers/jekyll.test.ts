import { describe, expect, it } from 'vitest';
import { renderJekyllArticle } from './jekyll.js';
import type { Note } from '../model/note.js';
import type { Config } from '../config.js';
import type { NoteState } from '../state/store.js';
import { computeContentHash } from '../transform/frontmatter.js';

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
    tags: [],
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-02T00:00:00Z'),
    bodyHtml: '<p>Hello World</p>',
    attachments: [],
    ...overrides,
  };
}

/** design.md §8 の `NoteState`(前回配信結果)を最小限の値で組み立てる。 */
function buildPrev(overrides: Partial<NoteState> = {}): NoteState {
  return {
    contentHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000',
    remoteId: null,
    firstPublishedAt: '2026-07-01T00:00:00+09:00',
    lastPublishedAt: '2026-07-01T00:00:00+09:00',
    ...overrides,
  };
}

// Jekyll は Git モード。`renderJekyllArticle` は config.git を参照しない
// (jekyll.ts 冒頭 JSDoc「output_dir は使わない」)ため、git ブロックは他サービスとの
// スキーマ整合のためだけに最小限の値で足りる。
const CONFIG = {
  timezone: 'Asia/Tokyo',
  service: 'jekyll',
  git: {
    repo_path: '/repos/jekyll-content',
    base_branch: 'main',
    output_dir: 'ignored-by-jekyll',
    auto_merge: true,
  },
} as Config;

// ---------------------------------------------------------------------------
// golden test: frontmatter の確定的な直列化(design.md §5.7 Jekyll 行、issue #24 受け入れ条件)。
// ---------------------------------------------------------------------------

describe('golden: renderJekyllArticle frontmatter', () => {
  const note = buildNote({
    uuid: '5C1C2C3D-AAAA-4AAA-8AAA-AAAAAAAAAAAA', // 大文字混じり UUID → Jekyll は小文字化しない(Hugo と同じ)
    folder: 'Tech',
    title: 'こんにちは、Jekyll', // 日本語タイトル
    tags: ['#TypeScript', '#Jekyll記事'], // "#" を保持したまま(design.md §5.7 が変換を明記していない)
    createdAt: new Date('2026-08-01T00:00:00Z'), // Asia/Tokyo で 2026-08-01T09:00:00+09:00
    updatedAt: new Date('2026-08-02T03:30:00Z'),
  });
  const markdown = '本文はここに書きます。\n\n見出しの前後にも改行があります。\n';

  const expectedArtifact =
    '---\n' +
    'title: "こんにちは、Jekyll"\n' +
    'date: "2026-08-01T09:00:00+09:00"\n' +
    'categories: ["Tech"]\n' +
    'tags: ["#TypeScript","#Jekyll記事"]\n' +
    '---\n' +
    '\n' +
    markdown;

  // sha256 of expectedArtifact's UTF-8 bytes, pinned so any change to the Jekyll frontmatter
  // key order/quoting/date-formatting/categories-tags-mapping convention is caught (design.md §12).
  const expectedHash = 'sha256:21bff0761cdedb1ce358ec5f4a0e4dbbe40b2202f1df8ad711c2d4952052e0c1';

  it('serializes the fixed frontmatter block + body exactly (key order title/date/categories/tags)', () => {
    const article = renderJekyllArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.artifact).toBe(expectedArtifact);
  });

  it('computes the fixed sha256 content hash for the golden artifact', () => {
    const article = renderJekyllArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.contentHash).toBe(expectedHash);
    expect(article.contentHash).toBe(computeContentHash(expectedArtifact));
  });

  it('carries noteUuid and title through to the RenderedArticle', () => {
    const article = renderJekyllArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.noteUuid).toBe(note.uuid);
    expect(article.title).toBe('こんにちは、Jekyll');
  });
});

// ---------------------------------------------------------------------------
// artifactPath golden(design.md §4「_posts/YYYY-MM-DD-<uuid>.md」、日付は作成日)。
// ---------------------------------------------------------------------------

describe('renderJekyllArticle artifactPath (first publication)', () => {
  it('is "_posts/YYYY-MM-DD-<uuid>.md" with the date derived from note.createdAt in config.timezone', () => {
    const note = buildNote({
      uuid: '5C1C2C3D-0000-4000-8000-000000000001',
      createdAt: new Date('2026-01-15T15:00:00Z'), // UTC → Asia/Tokyo は翌日 2026-01-16
    });
    const article = renderJekyllArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifactPath).toBe('_posts/2026-01-16-5C1C2C3D-0000-4000-8000-000000000001.md');
  });

  it('does NOT lowercase an uppercase uuid (same convention as Hugo, unlike Zenn)', () => {
    const note = buildNote({ uuid: 'ABCDEF12-0000-4000-8000-000000000099' });
    const article = renderJekyllArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifactPath).toContain('ABCDEF12-0000-4000-8000-000000000099.md');
  });

  it('ignores config.git.output_dir entirely (fixed to "_posts/", design.md §4/§5.7)', () => {
    const note = buildNote({ uuid: '5c1c2c3d-0000-4000-8000-000000000002' });
    const customOutputDirConfig = {
      ...CONFIG,
      git: { ...CONFIG.git, output_dir: 'content/posts' },
    } as Config;
    const article = renderJekyllArticle({
      note,
      markdown: 'body',
      config: customOutputDirConfig,
      prev: null,
    });
    expect(article.artifactPath).toBe('_posts/2026-08-01-5c1c2c3d-0000-4000-8000-000000000002.md');
  });

  it('respects a non-default config.timezone when deriving the date prefix', () => {
    const note = buildNote({
      uuid: '5c1c2c3d-0000-4000-8000-000000000003',
      createdAt: new Date('2026-08-01T23:30:00Z'), // UTC → Asia/Tokyo は翌日、UTC のままなら同日
    });
    const tokyoArticle = renderJekyllArticle({
      note,
      markdown: 'body',
      config: CONFIG,
      prev: null,
    });
    expect(tokyoArticle.artifactPath).toBe(
      '_posts/2026-08-02-5c1c2c3d-0000-4000-8000-000000000003.md',
    );

    const utcConfig = { ...CONFIG, timezone: 'UTC' } as Config;
    const utcArticle = renderJekyllArticle({
      note,
      markdown: 'body',
      config: utcConfig,
      prev: null,
    });
    expect(utcArticle.artifactPath).toBe(
      '_posts/2026-08-01-5c1c2c3d-0000-4000-8000-000000000003.md',
    );
  });
});

// ---------------------------------------------------------------------------
// 受け入れ条件(issue #24 / design.md §4): 作成日が変わっても2回目以降のファイル名が
// 変わらない(URL の安定性を優先し、記録済みファイル名をそのまま再利用する)。
// ---------------------------------------------------------------------------

describe('renderJekyllArticle artifactPath (subsequent publications: filename pinning)', () => {
  it('reuses prev.artifactPath verbatim even when note.createdAt has changed', () => {
    const uuid = '5c1c2c3d-0000-4000-8000-000000000010';

    // 初回配信: prev が無いので、その時点の createdAt から新規にパスを算出する。
    const firstNote = buildNote({ uuid, createdAt: new Date('2026-08-01T00:00:00Z') });
    const firstArticle = renderJekyllArticle({
      note: firstNote,
      markdown: 'body',
      config: CONFIG,
      prev: null,
    });
    expect(firstArticle.artifactPath).toBe(`_posts/2026-08-01-${uuid}.md`);

    // 2回目配信: 作成日が変わった(Apple Notes 側の再同期等を想定)が、prev.artifactPath は
    // 初回のまま。結果の artifactPath は初回と完全に一致し続けなければならない。
    const changedNote = buildNote({ uuid, createdAt: new Date('2099-12-31T00:00:00Z') });
    const prev = buildPrev({ artifactPath: firstArticle.artifactPath });
    const secondArticle = renderJekyllArticle({
      note: changedNote,
      markdown: 'body (edited)',
      config: CONFIG,
      prev,
    });
    expect(secondArticle.artifactPath).toBe(firstArticle.artifactPath);
    expect(secondArticle.artifactPath).toBe(`_posts/2026-08-01-${uuid}.md`);
  });

  it('still uses the (unchanged) date-derived path when prev.artifactPath happens to match it', () => {
    const uuid = '5c1c2c3d-0000-4000-8000-000000000011';
    const note = buildNote({ uuid, createdAt: new Date('2026-08-01T00:00:00Z') });
    const prev = buildPrev({ artifactPath: `_posts/2026-08-01-${uuid}.md` });
    const article = renderJekyllArticle({ note, markdown: 'body', config: CONFIG, prev });
    expect(article.artifactPath).toBe(`_posts/2026-08-01-${uuid}.md`);
  });

  it('falls back to a freshly-derived path when prev exists but has no artifactPath recorded yet', () => {
    const note = buildNote({
      uuid: '5c1c2c3d-0000-4000-8000-000000000012',
      createdAt: new Date('2026-08-01T00:00:00Z'),
    });
    const prev = buildPrev(); // artifactPath 未設定(旧バージョンの状態 JSON 等を想定)
    const article = renderJekyllArticle({ note, markdown: 'body', config: CONFIG, prev });
    expect(article.artifactPath).toBe('_posts/2026-08-01-5c1c2c3d-0000-4000-8000-000000000012.md');
  });
});

// ---------------------------------------------------------------------------
// categories マッピング(design.md §5.7「categories」、Hugo と同じ無変換規約)。
// ---------------------------------------------------------------------------

describe('renderJekyllArticle categories', () => {
  it('wraps note.folder in a single-element array, unchanged (no slugification, no allowlist)', () => {
    const note = buildNote({ folder: 'Dev/Ops: Log' });
    const article = renderJekyllArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('categories: ["Dev/Ops: Log"]');
  });

  it('accepts any folder name (no tech/idea allowlist like Zenn — FR-24 does not apply to Jekyll)', () => {
    const note = buildNote({ folder: 'Archive' });
    expect(() =>
      renderJekyllArticle({ note, markdown: 'body', config: CONFIG, prev: null }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// tags マッピング(design.md §5.7 が変換を明記していないため無変換。"#" を保持する)。
// ---------------------------------------------------------------------------

describe('renderJekyllArticle tags', () => {
  it('keeps the leading "#" on each tag, unlike Zenn topics', () => {
    const note = buildNote({ tags: ['#typescript', '#jekyll記事'] });
    const article = renderJekyllArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('tags: ["#typescript","#jekyll記事"]');
  });

  it('produces an empty tags array for a note with no tags', () => {
    const note = buildNote({ tags: [] });
    const article = renderJekyllArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('tags: []');
  });
});

// ---------------------------------------------------------------------------
// date(design.md §5.7「date は作成日」。完全な ISO-8601、formatTimestamp 経由)。
// ---------------------------------------------------------------------------

describe('renderJekyllArticle date', () => {
  it('formats createdAt as the full ISO-8601 `date` in config.timezone, fixed offset, second precision', () => {
    const note = buildNote({
      createdAt: new Date('2026-01-15T15:00:00Z'), // UTC冬 → Asia/Tokyo +09:00 は年中固定(DST無し)
    });
    const article = renderJekyllArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('date: "2026-01-16T00:00:00+09:00"');
  });

  it('does not use updatedAt for `date` (Jekyll has no lastmod-equivalent key)', () => {
    const note = buildNote({
      createdAt: new Date('2026-08-01T00:00:00Z'),
      updatedAt: new Date('2099-01-01T00:00:00Z'),
    });
    const article = renderJekyllArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('date: "2026-08-01T09:00:00+09:00"');
    expect(article.artifact).not.toContain('2099');
  });

  it('is run-invariant: does not depend on the current wall-clock time', () => {
    const note = buildNote();
    const a = renderJekyllArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    const b = renderJekyllArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(a.contentHash).toBe(b.contentHash);
  });
});
