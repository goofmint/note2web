import { describe, expect, it } from 'vitest';
import {
  computeNoteBodyLength,
  NoteExternalImageError,
  renderNoteBodyHtml,
} from '../../src/publishers/note-html.js';

const NOTE_UUID = '5c1c2c3d-0000-4000-8000-000000000001';

/** 決定的なテストのため、呼び出し順に "id-0", "id-1", … を返す `idFactory`。 */
function makeSequentialIdFactory(): () => string {
  let counter = 0;
  return () => {
    const id = `id-${String(counter)}`;
    counter += 1;
    return id;
  };
}

function render(
  markdown: string,
  imageKeyByIdentifier: ReadonlyMap<string, string> = new Map(),
): ReturnType<typeof renderNoteBodyHtml> {
  return renderNoteBodyHtml(markdown, {
    noteUuid: NOTE_UUID,
    imageKeyByIdentifier,
    idFactory: makeSequentialIdFactory(),
  });
}

// ---------------------------------------------------------------------------
// ブロック UUID 付与(idFactory の注入)。
// ---------------------------------------------------------------------------

describe('renderNoteBodyHtml: top-level block name/id assignment', () => {
  it('assigns a sequential id to each top-level block via the injected idFactory', () => {
    const { html } = render('para one\n\npara two\n');
    expect(html).toBe('<p name="id-0" id="id-0">para one</p><p name="id-1" id="id-1">para two</p>');
  });

  it('uses the same UUID for both name and id on a single block', () => {
    const { html } = render('hello');
    expect(html).toMatch(/<p name="([^"]+)" id="\1">/);
  });

  it('defaults to crypto.randomUUID()-shaped ids when idFactory is not provided', () => {
    const { html } = renderNoteBodyHtml('hello', {
      noteUuid: NOTE_UUID,
      imageKeyByIdentifier: new Map(),
    });
    expect(html).toMatch(
      /<p name="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" id="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}">/,
    );
  });

  it('does not assign name/id to nested blocks inside a blockquote', () => {
    const { html } = render('> quoted paragraph\n');
    expect(html).toBe('<blockquote name="id-0" id="id-0"><p>quoted paragraph</p></blockquote>');
  });
});

// ---------------------------------------------------------------------------
// 要素マッピング。
// ---------------------------------------------------------------------------

describe('renderNoteBodyHtml: element mappings', () => {
  it('maps a paragraph to <p>', () => {
    const { html } = render('plain paragraph');
    expect(html).toBe('<p name="id-0" id="id-0">plain paragraph</p>');
  });

  it.each([
    [1, 'h2'],
    [2, 'h2'],
    [3, 'h3'],
    [4, 'h3'],
    [5, 'h3'],
    [6, 'h3'],
  ])('maps a depth-%d heading to <%s> (note.com has only 2 heading levels)', (depth, tag) => {
    const { html } = render(`${'#'.repeat(depth)} Heading`);
    expect(html).toBe(`<${tag} name="id-0" id="id-0">Heading</${tag}>`);
  });

  // mdast は tight/loose にかかわらず、リスト項目の行内容を常に paragraph ノードとして
  // 表現する(空行区切りかどうかは `spread` メタデータのみに反映され、木構造自体は変わらない)。
  // そのため `renderBlockNode`(非トップレベル呼び出し)がそのまま `<p>…</p>` を生成し、
  // `<li>` の中身は `<li><p>…</p></li>` という形になる。

  it('maps an unordered list to <ul><li><p>…</p></li></ul>', () => {
    const { html } = render('- one\n- two\n');
    expect(html).toBe('<ul name="id-0" id="id-0"><li><p>one</p></li><li><p>two</p></li></ul>');
  });

  it('maps an ordered list to <ol><li><p>…</p></li></ol>', () => {
    const { html } = render('1. one\n2. two\n');
    expect(html).toBe('<ol name="id-0" id="id-0"><li><p>one</p></li><li><p>two</p></li></ol>');
  });

  it('degrades a GFM task list item to a "[x] "/"[ ] " text prefix inside <li>', () => {
    const { html } = render('- [x] done\n- [ ] todo\n');
    expect(html).toBe(
      '<ul name="id-0" id="id-0"><li>[x] <p>done</p></li><li>[ ] <p>todo</p></li></ul>',
    );
  });

  it('maps a fenced code block to <pre><code>, verbatim (no escaping surprises for plain text)', () => {
    const { html } = render('```\nconst x = 1;\n```\n');
    expect(html).toBe('<pre name="id-0" id="id-0"><code>const x = 1;</code></pre>');
  });

  it('escapes HTML-significant characters inside a code block', () => {
    const { html } = render('```\n<script>alert(1)</script>\n```\n');
    expect(html).toBe(
      '<pre name="id-0" id="id-0"><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>',
    );
  });

  it('maps inline code to <code>', () => {
    const { html } = render('use `code` here');
    expect(html).toBe('<p name="id-0" id="id-0">use <code>code</code> here</p>');
  });

  it('maps a link to <a href>', () => {
    const { html } = render('[text](https://example.com/)');
    expect(html).toBe('<p name="id-0" id="id-0"><a href="https://example.com/">text</a></p>');
  });

  it('maps a blockquote to <blockquote>', () => {
    const { html } = render('> quoted\n');
    expect(html).toBe('<blockquote name="id-0" id="id-0"><p>quoted</p></blockquote>');
  });

  it('maps a thematic break to <hr>', () => {
    const { html } = render('---\n');
    expect(html).toBe('<hr name="id-0" id="id-0">');
  });

  it('maps emphasis and strong to <em>/<strong>', () => {
    const { html } = render('*em* and **strong**');
    expect(html).toBe('<p name="id-0" id="id-0"><em>em</em> and <strong>strong</strong></p>');
  });

  it('maps a hard line break to <br>', () => {
    const { html } = render('line one  \nline two\n');
    expect(html).toBe('<p name="id-0" id="id-0">line one<br>line two</p>');
  });

  it('escapes HTML-significant characters in plain text', () => {
    const { html } = render('a < b && "quoted" & \'single\'');
    expect(html).toBe(
      '<p name="id-0" id="id-0">a &lt; b &amp;&amp; &quot;quoted&quot; &amp; &#39;single&#39;</p>',
    );
  });
});

// ---------------------------------------------------------------------------
// 劣化(表・生 HTML 等)。
// ---------------------------------------------------------------------------

describe('renderNoteBodyHtml: degradations', () => {
  it('degrades a GFM table to a flattened text <p>', () => {
    const { html } = render('| a | b |\n| - | - |\n| 1 | 2 |\n');
    expect(html).toContain('<p name="id-0" id="id-0">');
    expect(html).toContain('a');
    expect(html).toContain('b');
    expect(html).not.toContain('<table');
  });

  it('degrades a raw HTML block to escaped literal text (not executed)', () => {
    const { html } = render('<div class="raw">hello</div>\n');
    expect(html).toContain('&lt;div');
    expect(html).not.toContain('<div');
  });
});

// ---------------------------------------------------------------------------
// リンクのスキーム制限(javascript:/data: 等はプレーンテキスト化)。
// ---------------------------------------------------------------------------

describe('renderNoteBodyHtml: link scheme allowlist', () => {
  it('renders an http(s) link as <a href>', () => {
    const { html } = render('[text](https://example.com/)');
    expect(html).toBe('<p name="id-0" id="id-0"><a href="https://example.com/">text</a></p>');
  });

  it('renders a mailto link as <a href>', () => {
    const { html } = render('[mail me](mailto:me@example.com)');
    expect(html).toBe('<p name="id-0" id="id-0"><a href="mailto:me@example.com">mail me</a></p>');
  });

  it('renders a javascript: link as plain text, not an anchor', () => {
    const { html } = render('[click me](javascript:alert(1))');
    expect(html).toBe('<p name="id-0" id="id-0">click me</p>');
    expect(html).not.toContain('<a ');
  });

  it('renders a data: link as plain text, not an anchor', () => {
    const { html } = render('[payload](data:text/html,%3Cscript%3E)');
    expect(html).toBe('<p name="id-0" id="id-0">payload</p>');
    expect(html).not.toContain('<a ');
  });
});

// ---------------------------------------------------------------------------
// figure/img 埋め込み + image_keys の出現順。
// ---------------------------------------------------------------------------

describe('renderNoteBodyHtml: image embedding', () => {
  it('promotes a sole-image paragraph to a top-level <figure><img></figure> with the resolved key', () => {
    const { html, imageKeys } = render(
      '![my alt text](note2web-asset://img-1)',
      new Map([['img-1', 'resolved-key-1.png']]),
    );
    expect(html).toBe(
      '<figure name="id-0" id="id-0"><img src="https://assets.st-note.com/img/resolved-key-1.png" alt="my alt text"></figure>',
    );
    expect(imageKeys).toEqual(['resolved-key-1.png']);
  });

  it('lists image_keys in order of appearance across multiple images', () => {
    const { imageKeys } = render(
      '![first](note2web-asset://img-1)\n\ntext between\n\n![second](note2web-asset://img-2)\n',
      new Map([
        ['img-1', 'key-1'],
        ['img-2', 'key-2'],
      ]),
    );
    expect(imageKeys).toEqual(['key-1', 'key-2']);
  });

  it('embeds an inline image (mixed with text) as a plain <img>, not a <figure>', () => {
    const { html, imageKeys } = render(
      'before ![alt](note2web-asset://img-1) after',
      new Map([['img-1', 'inline-key.png']]),
    );
    expect(html).toBe(
      '<p name="id-0" id="id-0">before <img src="https://assets.st-note.com/img/inline-key.png" alt="alt"> after</p>',
    );
    expect(imageKeys).toEqual(['inline-key.png']);
  });

  it('throws NoteExternalImageError for an image URL that is not a note2web-asset:// placeholder', () => {
    expect(() => render('![alt](https://example.com/a.png)')).toThrow(NoteExternalImageError);
  });

  it('includes the offending noteUuid and URL on NoteExternalImageError', () => {
    try {
      render('![alt](https://example.com/broken.png)');
      expect.unreachable('renderNoteBodyHtml should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NoteExternalImageError);
      const externalImageError = error as NoteExternalImageError;
      expect(externalImageError.noteUuid).toBe(NOTE_UUID);
      expect(externalImageError.imageUrl).toBe('https://example.com/broken.png');
    }
  });

  it('throws an internal error when a placeholder has no entry in imageKeyByIdentifier', () => {
    expect(() => render('![alt](note2web-asset://missing-id)', new Map())).toThrow(
      /no uploaded image key/,
    );
  });
});

// ---------------------------------------------------------------------------
// body_length(可視テキストの Unicode コードポイント数)。
// ---------------------------------------------------------------------------

describe('computeNoteBodyLength / body_length', () => {
  it('counts visible text length, not HTML length', () => {
    const markdown = 'hello **world**';
    const length = computeNoteBodyLength(markdown);
    // "hello world"(強調記法の `**` そのものは可視テキストに含まれないが、テキストノード
    // 間の空白はそのまま残る)= 11 文字。
    expect(length).toBe('hello world'.length);
  });

  it('counts multi-byte (Japanese) text by Unicode code points', () => {
    expect(computeNoteBodyLength('こんにちは')).toBe(5);
  });

  it('counts a surrogate-pair emoji as a single code point', () => {
    // 絵文字(サロゲートペア)は1コードポイントとして数える(UTF-16 コード単位数=2とは異なる)。
    expect(computeNoteBodyLength('😀')).toBe(1);
    expect('😀'.length).toBe(2);
  });

  it('matches the bodyLength returned by renderNoteBodyHtml for the same markdown', () => {
    const markdown = '# 見出し\n\n本文です。\n';
    const { bodyLength } = render(markdown);
    expect(bodyLength).toBe(computeNoteBodyLength(markdown));
  });

  it('is strictly less than the generated HTML string length once tags/attributes are added', () => {
    const markdown = '# Heading\n\nSome paragraph text.\n';
    const { html, bodyLength } = render(markdown);
    expect(bodyLength).toBeLessThan(html.length);
  });

  it('excludes an image alt text from the visible-text count (includeImageAlt: false)', () => {
    const markdown = '![this is alt text](note2web-asset://img-1)\n\nvisible body text.\n';
    const { bodyLength } = render(markdown, new Map([['img-1', 'key-1']]));
    // "visible body text." のみが可視テキストとしてカウントされ、alt("this is alt text")は
    // 含まれない。固定値で回帰を検知する(alt を含めれば 34 になってしまうところ)。
    expect(bodyLength).toBe('visible body text.'.length);
    expect(bodyLength).toBe(18);
    expect(bodyLength).toBe(computeNoteBodyLength(markdown));
  });
});
