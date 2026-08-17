import { describe, expect, it } from 'vitest';
import { InvalidZennSlugError, InvalidZennTypeError, renderZennArticle } from './zenn.js';
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

// `src/publishers/qiita.test.ts` の同名ヘルパーと同形(§5.7 タグ検証テストの参照実装)。
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
    const article = renderZennArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.artifact).toBe(expectedArtifact);
  });

  it('computes the fixed sha256 content hash for the golden artifact', () => {
    const article = renderZennArticle({ note, markdown, config: CONFIG, prev: null });
    expect(article.contentHash).toBe(expectedHash);
    expect(article.contentHash).toBe(computeContentHash(expectedArtifact));
  });

  it('carries noteUuid and title through to the RenderedArticle', () => {
    const article = renderZennArticle({ note, markdown, config: CONFIG, prev: null });
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
    const article = renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifactPath).toBe('articles/5c1c2c3d-0000-4000-8000-000000000001.md');
  });

  it('ignores config.git.output_dir — Zenn always writes under "articles/" (design.md §7)', () => {
    const note = buildNote({ uuid: '5c1c2c3d-0000-4000-8000-000000000001' });
    const customOutputDirConfig = {
      ...CONFIG,
      git: { ...CONFIG.git, output_dir: 'custom-dir' },
    } as Config;
    const article = renderZennArticle({
      note,
      markdown: 'body',
      config: customOutputDirConfig,
      prev: null,
    });
    expect(article.artifactPath).toBe('articles/5c1c2c3d-0000-4000-8000-000000000001.md');
  });
});

// ---------------------------------------------------------------------------
// emoji 既定値(design.md §5.7「絵文字が無いノートは既定値 📝」)。
// ---------------------------------------------------------------------------

describe('renderZennArticle emoji', () => {
  it('uses note.emoji when present', () => {
    const note = buildNote({ emoji: '🚀' });
    const article = renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('emoji: "🚀"');
  });

  it('defaults to 📝 when note.emoji is null', () => {
    const note = buildNote({ emoji: null });
    const article = renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('emoji: "📝"');
  });

  // 防御的フォールバック(issue #76 CodeRabbit issue plan Phase 2 Task 1): `note.emoji` は
  // `splitTitleAndEmoji` により実運用では常に単一 grapheme cluster だが、万一そうでない値が
  // 来ても例外を投げず既定値へフォールバックすることを確認する。
  it('falls back to 📝 when note.emoji is multiple grapheme clusters (defensive)', () => {
    const note = buildNote({ emoji: '😸😸' });
    const article = renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('emoji: "📝"');
  });

  it('falls back to 📝 when note.emoji is plain non-emoji text (defensive)', () => {
    const note = buildNote({ emoji: 'ab' });
    const article = renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('emoji: "📝"');
  });

  it('falls back to 📝 when note.emoji is a single non-emoji character like "a" (defensive)', () => {
    // セグメント数は1だが絵文字ではない: \p{Extended_Pictographic} 判定で弾かれる
    // (issue #76 CodeRabbit レビュー)。
    const note = buildNote({ emoji: 'a' });
    const article = renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('emoji: "📝"');
  });

  it('keeps a ZWJ-joined emoji sequence unchanged (single grapheme cluster despite multiple code points)', () => {
    const note = buildNote({ emoji: '👨‍👩‍👧‍👦' });
    const article = renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('emoji: "👨‍👩‍👧‍👦"');
  });
});

// ---------------------------------------------------------------------------
// topics マッピング(先頭の "#" を1つだけ除去。モジュール冒頭 JSDoc 参照)。
// ---------------------------------------------------------------------------

describe('renderZennArticle topics', () => {
  it('strips exactly one leading "#" from each tag', () => {
    const note = buildNote({ tags: ['#typescript', '#zenn'] });
    const article = renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('topics: ["typescript","zenn"]');
  });

  it('produces an empty topics array for a note with no tags', () => {
    const note = buildNote({ tags: [] });
    const article = renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('topics: []');
  });

  it('leaves a tag without a leading "#" unchanged (defensive)', () => {
    const note = buildNote({ tags: ['already-plain'] });
    const article = renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('topics: ["already-plain"]');
  });
});

// ---------------------------------------------------------------------------
// topics サニタイズ(design.md §5.7 Zenn 行、issue #76。`resolveQiitaTags` のテストを
// 参照実装とする)。
// ---------------------------------------------------------------------------

describe('renderZennArticle topics sanitization (issue #76)', () => {
  it('drops tags that become empty after stripping the leading "#" and logs a warning', () => {
    const note = buildNote({
      uuid: 'note-under-test',
      title: 'Empty Topic Test',
      tags: ['#', '#typescript'],
    });
    const { logger, warnings } = createFakeLogger();
    const article = renderZennArticle({
      note,
      markdown: 'body',
      config: CONFIG,
      prev: null,
      logger,
    });

    expect(article.artifact).toContain('topics: ["typescript"]');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      service: 'zenn',
      noteUuid: 'note-under-test',
      title: 'Empty Topic Test',
    });
    expect(warnings[0]?.message).toContain('empty');
  });

  it('drops tags containing a half-width space and logs a warning with service/noteUuid/title', () => {
    const note = buildNote({
      uuid: 'note-under-test',
      title: 'Space Test',
      tags: ['#good-tag', '#has space', '#another good'],
    });
    const { logger, warnings } = createFakeLogger();
    const article = renderZennArticle({
      note,
      markdown: 'body',
      config: CONFIG,
      prev: null,
      logger,
    });

    expect(article.artifact).toContain('topics: ["good-tag"]');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      service: 'zenn',
      noteUuid: 'note-under-test',
      title: 'Space Test',
    });
    expect(warnings[0]?.message).toContain('has space');
    expect(warnings[0]?.message).toContain('another good');
  });

  it('truncates to the first 5 topics when more than 5 remain, and logs a warning', () => {
    const note = buildNote({
      uuid: 'note-under-test',
      title: 'Truncate Test',
      tags: ['#a', '#b', '#c', '#d', '#e', '#f', '#g'],
    });
    const { logger, warnings } = createFakeLogger();
    const article = renderZennArticle({
      note,
      markdown: 'body',
      config: CONFIG,
      prev: null,
      logger,
    });

    expect(article.artifact).toContain('topics: ["a","b","c","d","e"]');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      service: 'zenn',
      noteUuid: 'note-under-test',
      title: 'Truncate Test',
    });
    expect(warnings[0]?.message).toMatch(/truncated/i);
  });

  it('applies the space-drop before the 5-topic truncation (design.md §5.7 order)', () => {
    // 7 topics total; 2 contain spaces. After dropping spaces: 5 remain (exactly the limit,
    // so no truncation warning should fire).
    const note = buildNote({
      tags: ['#a', '#b c', '#c', '#d', '#e', '#f g', '#g'],
    });
    const { logger, warnings } = createFakeLogger();
    const article = renderZennArticle({
      note,
      markdown: 'body',
      config: CONFIG,
      prev: null,
      logger,
    });

    expect(article.artifact).toContain('topics: ["a","c","d","e","g"]');
    expect(warnings).toHaveLength(1); // only the space-drop warning, no truncation warning
    expect(warnings[0]?.message).toMatch(/space/i);
  });

  it('produces an empty topics array (no throw) when 0 topics remain after sanitization', () => {
    const note = buildNote({ uuid: 'no-topics-note', tags: ['#has space', '#also has space'] });
    const { logger, warnings } = createFakeLogger();
    const article = renderZennArticle({
      note,
      markdown: 'body',
      config: CONFIG,
      prev: null,
      logger,
    });

    expect(article.artifact).toContain('topics: []');
    // Both spaced tags dropped in one warning; no "no topics remaining" error is thrown
    // (Zenn allows empty topics, unlike Qiita's QiitaNoTagsRemainingError).
    expect(warnings).toHaveLength(1);
  });

  it('does not throw when logger is not provided but a warning would otherwise fire', () => {
    const note = buildNote({ tags: ['#ok', '#has space'] });
    expect(() =>
      renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// type 検証(design.md §5.7「フォルダパスを葉から根へ遡り、最初に一致した tech/idea を
// type に採用。一致が無ければそのノートを失敗扱い」、FR-24)。
// ---------------------------------------------------------------------------

describe('renderZennArticle type validation (FR-24)', () => {
  it('accepts folder "tech"', () => {
    const note = buildNote({ folder: 'tech' });
    expect(() =>
      renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null }),
    ).not.toThrow();
  });

  it('accepts folder "idea"', () => {
    const note = buildNote({ folder: 'idea' });
    expect(() =>
      renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null }),
    ).not.toThrow();
  });

  it('resolves type "tech" from a nested folderPath (e.g. Zenn/tech)', () => {
    const note = buildNote({ folder: 'tech', folderPath: ['Zenn', 'tech'] });
    const article = renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('type: "tech"');
  });

  it('resolves type "idea" from a nested folderPath (e.g. Zenn/idea)', () => {
    const note = buildNote({ folder: 'idea', folderPath: ['Zenn', 'idea'] });
    const article = renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('type: "idea"');
  });

  it('picks the nearest ancestor "tech" when the leaf is a non-matching subfolder (Zenn/tech/drafts)', () => {
    const note = buildNote({ folder: 'drafts', folderPath: ['Zenn', 'tech', 'drafts'] });
    const article = renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('type: "tech"');
  });

  it('prefers the leaf-nearest match when multiple ancestors match (Zenn/idea/tech → tech)', () => {
    const note = buildNote({ folder: 'tech', folderPath: ['Zenn', 'idea', 'tech'] });
    const article = renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null });
    expect(article.artifact).toContain('type: "tech"');
  });

  it.each(['Archive', 'Tech', 'Dev/Ops: Log', ''])(
    'throws InvalidZennTypeError for folder %j (not exactly tech/idea)',
    (folder) => {
      const note = buildNote({ folder });
      expect(() =>
        renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null }),
      ).toThrow(InvalidZennTypeError);
    },
  );

  it('throws InvalidZennTypeError when no folder in the path matches (Zenn only, no tech/idea subfolder)', () => {
    const note = buildNote({ folder: 'Zenn', folderPath: ['Zenn'] });
    try {
      renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null });
      expect.unreachable('renderZennArticle should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidZennTypeError);
      const typedError = error as InvalidZennTypeError;
      expect(typedError.message).toContain('Zenn');
      expect(typedError.message).toContain('create a "tech" or "idea" subfolder');
    }
  });

  it('is case-sensitive: "Tech" in the path does not match (exact match only)', () => {
    const note = buildNote({ folder: 'Tech', folderPath: ['Tech'] });
    expect(() => renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null })).toThrow(
      InvalidZennTypeError,
    );
  });

  it('includes the offending folder path and noteUuid in the thrown error', () => {
    const note = buildNote({ uuid: 'note-uuid-under-test', folder: 'Archive' });
    try {
      renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null });
      expect.unreachable('renderZennArticle should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidZennTypeError);
      const typedError = error as InvalidZennTypeError;
      expect(typedError.folderPath).toEqual(['Archive']);
      expect(typedError.noteUuid).toBe('note-uuid-under-test');
      expect(typedError.message).toContain('Archive');
      expect(typedError.message).toContain('note-uuid-under-test');
      expect(typedError.message).toContain('create a "tech" or "idea" subfolder');
    }
  });
});

// ---------------------------------------------------------------------------
// slug 検証(design.md §5.7・FR-23。防御的: 通常の36文字 UUID は常に満たす)。
// ---------------------------------------------------------------------------

describe('renderZennArticle slug validation (FR-23, defensive)', () => {
  it('throws InvalidZennSlugError when the lowercased uuid is too short (<12 chars)', () => {
    const note = buildNote({ uuid: 'short-id' });
    expect(() => renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null })).toThrow(
      InvalidZennSlugError,
    );
  });

  it('throws InvalidZennSlugError when the uuid contains characters outside a-z0-9_-', () => {
    const note = buildNote({ uuid: '5c1c2c3d.0000.4000.8000.000000000001' });
    expect(() => renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null })).toThrow(
      InvalidZennSlugError,
    );
  });

  it('accepts a normal 36-character Apple Notes uuid (hyphens included)', () => {
    const note = buildNote({ uuid: '5c1c2c3d-0000-4000-8000-000000000001' });
    expect(() =>
      renderZennArticle({ note, markdown: 'body', config: CONFIG, prev: null }),
    ).not.toThrow();
  });
});
