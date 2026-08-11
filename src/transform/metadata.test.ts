import { describe, expect, it } from 'vitest';
import {
  MetadataExtractionError,
  completeNoteMetadata,
  dedupeTags,
  findHashtagOnlyLineIndexes,
  isHashtagOnlyLine,
  splitTitleAndEmoji,
} from './metadata.js';
import type { Note } from '../model/note.js';

/** `test/fixtures/parser-output/` (T-08) の個別 HTML の構造を模した自己完結 HTML 文字列。 */
function noteHtml(contentHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>dummy</title></head>
<body>
<div class="note-card">
<div><h1><a id="note_uuid">Note uuid</a></h1></div>
<div class="note-content">
${contentHtml}
</div>
</div>
</body>
</html>`;
}

/** テスト用の最小限の `Note`(骨格 + Exporter が埋める `tags`)。 */
function buildNote(overrides: Partial<Note> = {}): Note {
  return {
    uuid: 'uuid-1',
    folder: 'Tech',
    title: '',
    emoji: null,
    tags: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    bodyHtml: noteHtml('<h1>Plain Title<br>\n</h1>\n<br>Body text.'),
    attachments: [],
    ...overrides,
  };
}

describe('splitTitleAndEmoji', () => {
  it('returns emoji: null and title as-is when the first grapheme is not a pictograph', () => {
    expect(splitTitleAndEmoji('Plain Title')).toEqual({ title: 'Plain Title', emoji: null });
  });

  it('extracts a simple leading emoji and strips it plus following whitespace from the title', () => {
    expect(splitTitleAndEmoji('🚀 Launch Notes')).toEqual({
      title: 'Launch Notes',
      emoji: '🚀',
    });
  });

  it('treats a ZWJ-combined emoji sequence as a single grapheme cluster', () => {
    const family = '👨‍👩‍👧‍👦';
    expect(splitTitleAndEmoji(`${family} Family Notes`)).toEqual({
      title: 'Family Notes',
      emoji: family,
    });
  });

  it('treats a skin-tone-modified emoji as a single grapheme cluster', () => {
    const thumbsUp = '👍🏽';
    expect(splitTitleAndEmoji(`${thumbsUp} Thumbs Up`)).toEqual({
      title: 'Thumbs Up',
      emoji: thumbsUp,
    });
  });

  it('handles a title that is a hashtag mixed with an emoji-less leading word', () => {
    expect(splitTitleAndEmoji('#planning kickoff')).toEqual({
      title: '#planning kickoff',
      emoji: null,
    });
  });

  it('returns an empty title/no emoji for an empty line', () => {
    expect(splitTitleAndEmoji('')).toEqual({ title: '', emoji: null });
  });
});

describe('isHashtagOnlyLine', () => {
  it('is true for a single hashtag', () => {
    expect(isHashtagOnlyLine('#launch')).toBe(true);
  });

  it('is true for multiple whitespace-separated hashtags', () => {
    expect(isHashtagOnlyLine('#launch #productivity')).toBe(true);
  });

  it('is true for Japanese hashtags', () => {
    expect(isHashtagOnlyLine('#買い物 #タスク')).toBe(true);
  });

  it('is false when a hashtag is mixed with prose (inline hashtag)', () => {
    expect(isHashtagOnlyLine('We need better #planning this week.')).toBe(false);
  });

  it('is false for prose with no hashtags at all', () => {
    expect(isHashtagOnlyLine('Deployed version 1.2.3 to production.')).toBe(false);
  });

  it('is false for a blank/whitespace-only line', () => {
    expect(isHashtagOnlyLine('   ')).toBe(false);
    expect(isHashtagOnlyLine('')).toBe(false);
  });
});

describe('findHashtagOnlyLineIndexes', () => {
  it('flags only the trailing hashtag-only line, not the title or the mixed inline line', () => {
    const html = noteHtml(
      '<h1>🚀 Launch Notes<br>\n</h1>\n<br>We need better #planning this week.<br>\n<br>#launch #productivity',
    );
    expect(findHashtagOnlyLineIndexes(html)).toEqual(new Set([2]));
  });

  it('returns an empty set when there are no hashtags at all', () => {
    const html = noteHtml('<h1>Ops Log<br>\n</h1>\n<br>Deployed version 1.2.3 to production.');
    expect(findHashtagOnlyLineIndexes(html)).toEqual(new Set());
  });
});

describe('dedupeTags', () => {
  it('removes duplicates while preserving first-seen order', () => {
    expect(dedupeTags(['#a', '#b', '#a', '#c', '#b'])).toEqual(['#a', '#b', '#c']);
  });

  it('returns [] for []', () => {
    expect(dedupeTags([])).toEqual([]);
  });
});

describe('completeNoteMetadata', () => {
  it('fills title/emoji from the first line and normalizes tags (dedupe, order preserved)', () => {
    const note = buildNote({
      bodyHtml: noteHtml('<h1>🚀 Launch Notes<br>\n</h1>\n<br>#launch #productivity'),
      tags: ['#launch', '#productivity', '#launch'],
    });

    const result = completeNoteMetadata(note);

    expect(result.title).toBe('Launch Notes');
    expect(result.emoji).toBe('🚀');
    expect(result.tags).toEqual(['#launch', '#productivity']);
    // 元の Note オブジェクトは変更しない(純粋関数)。
    expect(note.title).toBe('');
    expect(note.emoji).toBeNull();
  });

  it('fills title with emoji: null when the first line has no leading pictograph', () => {
    const note = buildNote({ bodyHtml: noteHtml('<h1>Grocery Checklist<br>\n</h1>\n<br>eggs') });

    const result = completeNoteMetadata(note);

    expect(result.title).toBe('Grocery Checklist');
    expect(result.emoji).toBeNull();
  });

  it('preserves other Note fields untouched', () => {
    const note = buildNote({ uuid: 'note-42', folder: 'Archive' });
    const result = completeNoteMetadata(note);
    expect(result.uuid).toBe('note-42');
    expect(result.folder).toBe('Archive');
    expect(result.createdAt).toBe(note.createdAt);
    expect(result.updatedAt).toBe(note.updatedAt);
    expect(result.attachments).toBe(note.attachments);
  });

  it('throws MetadataExtractionError (with noteUuid) for empty bodyHtml', () => {
    const note = buildNote({ uuid: 'note-empty', bodyHtml: '' });

    expect(() => completeNoteMetadata(note)).toThrow(MetadataExtractionError);
    try {
      completeNoteMetadata(note);
      throw new Error('unreachable');
    } catch (error) {
      expect(error).toBeInstanceOf(MetadataExtractionError);
      expect((error as MetadataExtractionError).name).toBe('MetadataExtractionError');
      expect((error as MetadataExtractionError).noteUuid).toBe('note-empty');
    }
  });

  it('throws MetadataExtractionError for HTML with no derivable text (decoration only)', () => {
    const note = buildNote({
      uuid: 'note-textless',
      bodyHtml: noteHtml('<br><a href="x.png"><img src="x.png"></a>'),
    });

    expect(() => completeNoteMetadata(note)).toThrow(MetadataExtractionError);
  });
});
