import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { makeAssetPlaceholder, transformBody } from './body.js';

/**
 * T-08(GitHub issue #13)のフィクスチャ(`test/fixtures/parser-output/html/`。issue #72
 * で `html/<uuid>.html` のフラット構成へ更新)をそのまま入力に使う(design.md §5.4・
 * issue #16 の要求どおり)。個別 HTML ファイルは `<div class="note-content">` の外側に
 * メタデータヘッダ(`Note <uuid>` / `Account:` / `Folder:` / `Title:` / `Created:` /
 * `Modified:`)を持つ、実際の note2web 独自スクリプトの出力構造。
 */
const FIXTURES_DIR = 'test/fixtures/parser-output/html';

function readFixture(relativePath: string): string {
  return readFileSync(`${FIXTURES_DIR}/${relativePath}`, 'utf8');
}

/**
 * `html.test.ts`/`metadata.test.ts` に倣った自己完結 HTML ビルダー(T-08 が確認していない
 * 合成的なエッジケース——未対応要素・非画像添付リンク——を作るための最小フィクスチャ)。
 */
function noteHtml(contentHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>dummy</title></head>
<body>
<div class="note-card">
<div><h1><a id="note_uuid">Note uuid</a></h1></div>
<div><b>Account:</b> <a href="../index.html">Sample Notes</a></div>
<div><b>Folder:</b> <span><a href="index.html">Tech</a></span></div>
<div><b>Title:</b> dummy</div>
<div><b>Created:</b> 2026-01-01 00:00:00 +0000</div>
<div><b>Modified:</b> 2026-01-02 00:00:00 +0000</div>
<div class="note-content">
${contentHtml}
</div>
</div>
</body>
</html>`;
}

describe('makeAssetPlaceholder', () => {
  it('returns the note2web-asset:// placeholder contract shared with T-13', () => {
    expect(makeAssetPlaceholder('88888888-8888-4888-8888-888888888888')).toBe(
      'note2web-asset://88888888-8888-4888-8888-888888888888',
    );
  });
});

describe('transformBody', () => {
  it('returns markdown: "" for empty bodyHtml', () => {
    expect(transformBody({ bodyHtml: '' })).toEqual({ markdown: '' });
  });

  it('returns markdown: "" when the body has only a title line', () => {
    const bodyHtml = noteHtml('<h1>Only Title<br>\n</h1>');
    expect(transformBody({ bodyHtml })).toEqual({ markdown: '' });
  });

  // (a) 表 → GFM の表(FR-11)。
  it('converts <table> to a GFM table, with the first (<td>-only) row promoted to the header', () => {
    const bodyHtml = readFixture('44444444-4444-4444-8444-444444444444.html');
    const { markdown } = transformBody({ bodyHtml });

    expect(markdown).toBe(
      '| Item    | Revenue |\n' +
        '| ------- | ------- |\n' +
        '| Widgets | 1,200   |\n' +
        '| Gadgets | 3,400   |\n',
    );
    // タイトル行・メタデータヘッダは本文に一切現れない。
    expect(markdown).not.toContain('Q3 Sales Table');
    expect(markdown).not.toContain('Account:');
    expect(markdown).not.toContain('Folder:');
    expect(markdown).not.toContain('Note 44444444');
  });

  // (b) チェックリスト(ネスト・checked/unchecked 混在)→ `- [x]` / `- [ ]`(FR-12)。
  it('converts a checklist (incl. nested, checked/unchecked) to GFM task list items', () => {
    const bodyHtml = readFixture('55555555-5555-4555-8555-555555555555.html');
    const { markdown } = transformBody({ bodyHtml });

    expect(markdown).toBe(
      '- [ ] Buy milk\n' +
        '\n' +
        '- [x] Buy eggs\n' +
        '\n' +
        '  - [x] Large eggs\n' +
        '  - [ ] Free-range\n' +
        '\n' +
        '- [ ] Buy bread\n',
    );
    expect(markdown).not.toContain('Grocery Checklist');
  });

  // (c) 添付・描画参照 → プレースホルダ(FR-13/FR-14)。
  it('converts a drawing reference (<a><img data-apple-notes-zidentifier>) to a bare image placeholder, not a linked image', () => {
    const bodyHtml = readFixture('66666666-6666-4666-8666-666666666666.html');
    const { markdown } = transformBody({ bodyHtml });

    expect(markdown).toBe('![](note2web-asset://88888888-8888-4888-8888-888888888888)\n');
  });

  it('converts a non-image attachment reference to a placeholder link (image: ![](), otherwise: link)', () => {
    const bodyHtml = noteHtml(
      '<h1>Attachment Demo<br>\n</h1>\n<br><a href="../files/report.pdf" data-apple-notes-zidentifier="attach-1111-4111-8111-111111111111">report.pdf</a>',
    );
    const { markdown } = transformBody({ bodyHtml });

    expect(markdown).toBe('[report.pdf](note2web-asset://attach-1111-4111-8111-111111111111)\n');
  });

  it('falls back to the identifier as the link label when a non-image attachment reference has no text', () => {
    const bodyHtml = noteHtml(
      '<h1>Attachment Demo<br>\n</h1>\n<br><a href="../files/report.pdf" data-apple-notes-zidentifier="attach-2222-4222-8222-222222222222"></a>',
    );
    const { markdown } = transformBody({ bodyHtml });

    expect(markdown).toBe(
      '[attach-2222-4222-8222-222222222222](note2web-asset://attach-2222-4222-8222-222222222222)\n',
    );
  });

  it('propagates the <img alt> attribute onto the asset placeholder image', () => {
    const bodyHtml = noteHtml(
      '<h1>Alt Demo<br>\n</h1>\n<br><img src="../files/sketch.png" alt="a hand-drawn sketch" data-apple-notes-zidentifier="99999999-9999-4999-8999-999999999999">',
    );
    const { markdown } = transformBody({ bodyHtml });

    expect(markdown).toBe(
      '![a hand-drawn sketch](note2web-asset://99999999-9999-4999-8999-999999999999)\n',
    );
  });

  // (d) タイトル行の除去(FR-04 との関係。タイトルは frontmatter へ)。
  it('removes the title line (first line) from the body', () => {
    const bodyHtml = readFixture('eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee.html');
    const { markdown } = transformBody({ bodyHtml });

    expect(markdown).toBe('Deployed version 1.2.3 to production.\n');
    expect(markdown).not.toContain('Ops Log');
  });

  // (e) ハッシュタグのみの行の除去。文中のインラインなハッシュタグは残す(design.md §5.3)。
  it('removes a trailing hashtag-only line while keeping an inline hashtag inside prose', () => {
    const bodyHtml = readFixture('77777777-7777-4777-8777-777777777777.html');
    const { markdown } = transformBody({ bodyHtml });

    expect(markdown).toBe('We need better #planning this week before the launch.\n');
    // インラインのハッシュタグはそのまま残る。
    expect(markdown).toContain('#planning');
    // タグ置き場の行(ハッシュタグのみ)は除去される。
    expect(markdown).not.toContain('#launch');
    expect(markdown).not.toContain('#productivity');
    // タイトル(絵文字含む)も本文に現れない。
    expect(markdown).not.toContain('Launch Notes');
    expect(markdown).not.toContain('🚀');
  });

  // (f) 未対応要素のテキスト化と、警告ログの内容(どのノートのどの要素か)。
  describe('unsupported elements', () => {
    it('textualizes an unsupported element (keeps its text content) instead of embedding raw HTML', () => {
      const bodyHtml = noteHtml(
        '<h1>Unsupported Demo<br>\n</h1>\n<br>Before <video src="clip.mov">clip text</video> after.',
      );
      const { markdown } = transformBody({ bodyHtml });

      expect(markdown).toBe('Before clip text after.\n');
      expect(markdown).not.toContain('<video');
      expect(markdown).not.toContain('clip.mov');
    });

    it('calls the injected logger.warn with the note identity and the unsupported element name', () => {
      const warn = vi.fn();
      const bodyHtml = noteHtml(
        '<h1>Unsupported Demo<br>\n</h1>\n<br>Before <video src="clip.mov">clip text</video> after.',
      );

      transformBody({
        bodyHtml,
        logger: { warn },
        noteUuid: '66666666-6666-4666-8666-666666666666',
        title: 'Unsupported Demo',
      });

      expect(warn).toHaveBeenCalledTimes(1);
      const [payload] = warn.mock.calls[0] as [
        { message: string; noteUuid?: string; title?: string },
      ];
      expect(payload.message).toContain('video');
      expect(payload.noteUuid).toBe('66666666-6666-4666-8666-666666666666');
      expect(payload.title).toBe('Unsupported Demo');
    });

    it('warns once per unsupported element occurrence, and does not warn when there is none', () => {
      const warn = vi.fn();
      const bodyHtml = noteHtml(
        '<h1>Two Unsupported<br>\n</h1>\n<br><video src="a.mov">a</video> and <strong>this one is supported</strong> and <audio src="b.mp3">b</audio>.',
      );

      transformBody({ bodyHtml, logger: { warn } });

      // <video> と <audio> の2つが未対応要素として警告される(<strong> は
      // SUPPORTED_TAG_NAMES に含む通常の強調要素のため警告対象外)。
      expect(warn).toHaveBeenCalledTimes(2);
      const messages = warn.mock.calls.map((call) => (call[0] as { message: string }).message);
      expect(messages.some((message) => message.includes('video'))).toBe(true);
      expect(messages.some((message) => message.includes('audio'))).toBe(true);
    });

    it('does not throw when transformBody is called without a logger (matches subprocess.ts pattern)', () => {
      const bodyHtml = noteHtml('<h1>No Logger<br>\n</h1>\n<br><video src="clip.mov">clip</video>');
      expect(() => transformBody({ bodyHtml })).not.toThrow();
    });

    it('removes <script>/<style> content entirely (does not textualize it) but still warns once each', () => {
      const warn = vi.fn();
      const bodyHtml = noteHtml(
        '<h1>Script And Style<br>\n</h1>\n<br>Before <script>alert("x")</script><style>.a{color:red}</style> after.',
      );

      const { markdown } = transformBody({ bodyHtml, logger: { warn } });

      expect(markdown).toBe('Before after.\n');
      expect(markdown).not.toContain('alert');
      expect(markdown).not.toContain('color:red');
      expect(warn).toHaveBeenCalledTimes(2);
      const messages = warn.mock.calls.map((call) => (call[0] as { message: string }).message);
      expect(messages.some((message) => message.includes('script'))).toBe(true);
      expect(messages.some((message) => message.includes('style'))).toBe(true);
    });

    it('wraps unsupported block-level elements (e.g. <section>) in separate paragraphs instead of merging their text', () => {
      const bodyHtml = noteHtml(
        '<h1>Sections<br>\n</h1>\n<br><section>A</section><section>B</section>',
      );

      const { markdown } = transformBody({ bodyHtml });

      expect(markdown).toBe('A\n\nB\n');
    });
  });

  // <br> 区切りのプレーンテキストの各連は、独立した段落として出力される
  // (単一段落内の強制改行にはしない)。
  it('turns each <br>-separated prose run into its own paragraph', () => {
    const bodyHtml = noteHtml(
      '<h1>Multi Paragraph<br>\n</h1>\n<br>First line.<br>\n<br>Second line.<br>\n<br>Third line.',
    );
    const { markdown } = transformBody({ bodyHtml });

    expect(markdown).toBe('First line.\n\nSecond line.\n\nThird line.\n');
  });
});
