import { describe, expect, it } from 'vitest';
import { extractLines, firstLine } from './html.js';

/**
 * `test/fixtures/parser-output/` (T-08) の個別 HTML の構造
 * (`<div class="note-content">` の下に `<h1>` / `<ul>` / `<table>` と、
 * `<br>` 区切りの地の文が並ぶ)を模した自己完結 HTML 文字列でテストする。
 */
function noteHtml(contentHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>dummy</title></head>
<body>
<div class="note-card">
<div><h1><a id="note_uuid">Note uuid</a></h1></div>
<div><b>Title:</b> dummy</div>
<div class="note-content">
${contentHtml}
</div>
</div>
</body>
</html>`;
}

describe('extractLines / firstLine', () => {
  it('returns [] / "" for empty input', () => {
    expect(extractLines('')).toEqual([]);
    expect(firstLine('')).toBe('');
  });

  it('treats the note-content <h1> title line as the first line, ignoring the outer metadata <h1>', () => {
    const html = noteHtml('<h1>My Title<br>\n</h1>\n<br>Body text.');
    expect(firstLine(html)).toBe('My Title');
    expect(extractLines(html)).toEqual(['My Title', 'Body text.']);
  });

  it('splits <br>-separated plain-text runs into separate lines and drops blank runs', () => {
    const html = noteHtml(
      '<h1>Launch Notes<br>\n</h1>\n<br>We need better #planning this week.<br>\n<br>#launch #productivity',
    );
    expect(extractLines(html)).toEqual([
      'Launch Notes',
      'We need better #planning this week.',
      '#launch #productivity',
    ]);
  });

  it('treats <table> as a single block-level line', () => {
    const html = noteHtml(
      '<h1>Q3 Sales<br>\n</h1>\n<br><table><tr><td>Item</td><td>Revenue</td></tr></table>',
    );
    const lines = extractLines(html);
    expect(lines[0]).toBe('Q3 Sales');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('Item');
    expect(lines[1]).toContain('Revenue');
  });

  it('treats a checklist <ul> as a single block-level line', () => {
    const html = noteHtml(
      '<h1>Groceries<br>\n</h1>\n<br><ul class="checklist"><li class="unchecked">Buy milk</li><li class="checked">Buy eggs</li></ul>',
    );
    const lines = extractLines(html);
    expect(lines[0]).toBe('Groceries');
    expect(lines[1]).toContain('Buy milk');
    expect(lines[1]).toContain('Buy eggs');
  });

  it('drops an inline run with no text (e.g. an <img> attachment reference with no alt text)', () => {
    const html = noteHtml('<h1>Whiteboard<br>\n</h1>\n<br><a href="x.png"><img src="x.png"></a>');
    expect(extractLines(html)).toEqual(['Whiteboard']);
  });

  it('falls back to scanning the whole document when no note-content div is present', () => {
    const html = '<html><body><h1>Fallback Title</h1><p>Second line</p></body></html>';
    expect(firstLine(html)).toBe('Fallback Title');
    expect(extractLines(html)).toEqual(['Fallback Title', 'Second line']);
  });
});
