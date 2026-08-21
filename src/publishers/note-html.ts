/**
 * note.com 非公式 API 向け本文 HTML 生成モジュール(issue #86 Phase 3。CodeRabbit 実装プラン
 * 承認済み)。
 *
 * 出典は「note非公式APIを徹底調査|2026年版エンドポイント一覧完全版」
 * (https://note.com/marie_222/n/n6a10366298b0、以下「元記事」)。同記事によれば note.com の
 * 本文(`free_body`)は ProseMirror 由来の HTML で、各ブロック要素が
 * `<p name="UUID" id="UUID">…</p>` のように `name`/`id` に同一の UUID を持つ形をとる。
 * 本モジュールは変換済み Markdown(mdast)からこの形の HTML を組み立てる。
 *
 * **要素マッピング**: 段落→`<p>`、見出し→`<h2>`/`<h3>`(note.com は見出しレベルを2段しか
 * 持たないため、mdast の depth 1・2 → `<h2>`、3以上 → `<h3>` に丸める)、リスト→`<ul>`/`<ol>`
 * + `<li>`、コードブロック→`<pre><code>`、インラインコード→`<code>`、リンク→`<a href>`、
 * 引用→`<blockquote>`、水平線→`<hr>`、強調/強い強調→`<em>`/`<strong>`、改行→`<br>`。
 * **リスト項目の内側**: mdast は tight/loose(空行区切りの有無)に関わらず、リスト項目の
 * 行内容を常に `paragraph` ノードとして表現する(この違いは `spread` メタデータのみに
 * 現れ、木構造自体は変わらない)ため、`<li>` の中身は素の文字列ではなく `<li><p>…</p></li>`
 * という形になる。GFM のタスクリスト(`- [x] …`)は `<li>` 直下・`<p>` の手前に
 * `[x] `/`[ ] ` というプレーンテキストの接頭辞を付ける形に劣化させる(下記「劣化」参照)。
 * `name`/`id` の UUID(既定 `crypto.randomUUID`。決定的なテストのため `idFactory` で差し替え
 * 可能)は**トップレベルのブロック要素にのみ**付与する——引用・リスト項目の内側にネストした
 * ブロックには付与しない(元記事はネスト時の規約に触れておらず、まず動く最小実装を優先した
 * 実装判断)。
 *
 * **画像**: `note2web-asset://<identifier>` プレースホルダ(`assets/uploader.ts` の契約。
 * note.com 向けは `processNoteBody` が意図的に未解決のまま残す、`src/publishers/note.ts`
 * 冒頭 JSDoc 参照)が段落の唯一の内容である場合、その段落は
 * `<figure name="UUID" id="UUID"><img src="https://assets.st-note.com/img/<KEY>" alt="…">
 * </figure>` に昇格する(`<KEY>` は呼び出し側が既にアップロード済みの `imageKeyByIdentifier`
 * から解決する)。テキストと混在するインライン画像は `<figure>` に昇格させず、その場で
 * `<img>` のみを埋め込む(HTML の入れ子制約上 `<p>` の中に `<figure>` を置けないため)。
 * `note2web-asset://` 以外の URL(外部 http(s) 等、`renderNoteArticle` を通らずに本文へ
 * 混入した参照)を指す画像ノードは `NoteExternalImageError` として拒否する——note.com は
 * 自身の presigned アップロード API を経由した画像のみを表示できるため。
 *
 * **劣化(度外視する要素)**: 表(GFM table)・脚注(footnote 参照/定義)・生 HTML ノード
 * (`html`)・参照形式のリンク/画像(`linkReference`/`imageReference`)・取り消し線
 * (`delete`)は note.com 側の対応要素が無い、またはこのタスクの範囲外のため、いずれも
 * `mdast-util-to-string` でテキスト化(ブロック位置にあれば `<p>` として、インライン位置に
 * あればそのままテキストとして)する劣化経路に落ちる。生 HTML ノードは**実行されず**、
 * エスケープ済みの文字列としてのみ表示される。GFM のタスクリスト(`- [x] …`)はチェック
 * ボックス要素ではなく `<li>` 先頭の `[x] `/`[ ] ` というプレーンテキストに劣化させる
 * (note.com がチェックボックスをネイティブサポートするか元記事に記載が無いため)。
 * 参照定義(`definition` ノード)は本来不可視のため出力しない(劣化ではない)。
 *
 * **body_length(500 罠 3)**: `free_body` の HTML 長ではなく、可視テキストの Unicode
 * コードポイント数でなければならない(元記事)。`computeNoteBodyLength` は mdast の
 * テキスト内容(`mdast-util-to-string`)からこれを計算する——HTML 文字列を組み立てた後に
 * タグを正規表現で剥がすのではなく、構文木から直接テキストのみを取り出す。
 */

import { randomUUID } from 'node:crypto';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { toString as mdastToString } from 'mdast-util-to-string';
import type {
  Blockquote,
  Code,
  Emphasis,
  Heading,
  Image,
  InlineCode,
  Link,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Strong,
  Text,
} from 'mdast';

// ---------------------------------------------------------------------------
// パーサ(`src/publishers/note.ts` 旧実装・`src/transform/body.ts` と同様、ステートレスな
// ので使い回す)。
// ---------------------------------------------------------------------------

const noteBodyMarkdownParser = unified().use(remarkParse).use(remarkGfm).freeze();

/** `note2web-asset://<identifier>` プレースホルダの接頭辞(`assets/uploader.ts` と共有の契約)。 */
const ASSET_PLACEHOLDER_PREFIX = 'note2web-asset://';

// ---------------------------------------------------------------------------
// エラー型。
// ---------------------------------------------------------------------------

/**
 * note.com が表示できない画像参照(`note2web-asset://` プレースホルダ以外の URL、典型的には
 * 添付を伴わない `<img src="外部URL">` 由来)を表す(モジュール冒頭 JSDoc「画像」参照)。
 * `src/sync.ts` の `processNote` がこの例外を捕捉し、当該ノートのみ `'failed'` として隔離する
 * (NFR-06。旧 `src/publishers/note.ts` の同名エラーと同じ役割を引き継ぐ)。
 */
export class NoteExternalImageError extends Error {
  /** 検証に失敗したノートの UUID。 */
  readonly noteUuid: string;
  /** 検出された非対応の URL(問題の画像を特定しやすくするため)。 */
  readonly imageUrl: string;

  constructor(noteUuid: string, imageUrl: string) {
    super(
      `note.com can only display images uploaded through its own presigned-upload API; note ` +
        `"${noteUuid}" contains an image reference that is not a resolved note2web attachment ` +
        `placeholder (${imageUrl}, likely an <img src="…"> pointing at an external URL without an ` +
        'Apple Notes attachment) — remove the image, or publish this note to a different service instead',
    );
    this.name = 'NoteExternalImageError';
    this.noteUuid = noteUuid;
    this.imageUrl = imageUrl;
  }
}

// ---------------------------------------------------------------------------
// エスケープ(`src/init.ts` の `escapeXml` と同じ形の最小限の HTML エスケープ)。
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ---------------------------------------------------------------------------
// body_length(モジュール冒頭 JSDoc「body_length」参照)。
// ---------------------------------------------------------------------------

/** 可視テキストの Unicode コードポイント数を数える(サロゲートペアを1文字として数える)。 */
function countVisibleCodePoints(tree: Root): number {
  return [...mdastToString(tree)].length;
}

/**
 * `markdown` の可視テキストの Unicode コードポイント数を計算する(500 罠3。元記事「body_length
 * は HTML 長ではなく可視テキスト長」)。`renderNoteBodyHtml` 内部でも同じロジックを(パース
 * 済みの木を再利用して)使うが、この関数は単体でも呼べるよう独立してエクスポートする。
 */
export function computeNoteBodyLength(markdown: string): number {
  const tree = noteBodyMarkdownParser.parse(markdown) as Root;
  return countVisibleCodePoints(tree);
}

// ---------------------------------------------------------------------------
// 本体。
// ---------------------------------------------------------------------------

/** `renderNoteBodyHtml` のオプション。 */
export interface NoteHtmlOptions {
  /** エラーメッセージ・例外に使うノート UUID。 */
  noteUuid: string;
  /** `note2web-asset://<identifier>` → アップロード済み画像の `<KEY>`(呼び出し側が事前に解決)。 */
  imageKeyByIdentifier: ReadonlyMap<string, string>;
  /** ブロック要素の `name`/`id` に使う UUID 生成の注入点(テスト用)。既定は `randomUUID`。 */
  idFactory?: () => string;
}

/** `renderNoteBodyHtml` の戻り値。 */
export interface NoteHtmlResult {
  /** note.com の `free_body` に送る HTML 文字列。 */
  html: string;
  /** 本文中に現れた画像の `<KEY>` を出現順・重複ありで列挙したもの(`image_keys` 用、500 罠1)。 */
  imageKeys: string[];
  /** 可視テキストの Unicode コードポイント数(`body_length` 用、500 罠3)。 */
  bodyLength: number;
}

/**
 * 変換済み Markdown を note.com の `free_body` HTML へ変換する(モジュール冒頭 JSDoc 参照)。
 * `imageKeyByIdentifier` に無い画像プレースホルダが本文に残っていた場合は内部不変条件違反
 * (呼び出し側が本文中の全プレースホルダを事前にアップロード済みである契約、
 * `src/publishers/note.ts` 参照)として例外を投げる。
 */
export function renderNoteBodyHtml(markdown: string, options: NoteHtmlOptions): NoteHtmlResult {
  const { noteUuid, imageKeyByIdentifier, idFactory = randomUUID } = options;
  const tree = noteBodyMarkdownParser.parse(markdown) as Root;
  const bodyLength = countVisibleCodePoints(tree);
  const imageKeys: string[] = [];

  /** 画像ノードの `url` を note.com の `assets.st-note.com` URL へ解決し、`imageKeys` へ記録する。 */
  function resolveImageSrc(url: string): string {
    if (!url.startsWith(ASSET_PLACEHOLDER_PREFIX)) {
      throw new NoteExternalImageError(noteUuid, url);
    }
    const identifier = url.slice(ASSET_PLACEHOLDER_PREFIX.length);
    const key = imageKeyByIdentifier.get(identifier);
    if (key === undefined) {
      throw new Error(
        `internal error: renderNoteBodyHtml: no uploaded image key for placeholder identifier ` +
          `"${identifier}" (note "${noteUuid}") — the caller must upload every referenced image ` +
          'before rendering the body HTML (src/publishers/note.ts)',
      );
    }
    imageKeys.push(key);
    return `https://assets.st-note.com/img/${key}`;
  }

  function renderImageTag(image: Image): string {
    const src = resolveImageSrc(image.url);
    const alt = image.alt !== null && image.alt !== undefined ? escapeHtml(image.alt) : '';
    return `<img src="${src}" alt="${alt}">`;
  }

  function renderInline(nodes: readonly PhrasingContent[]): string {
    return nodes.map((node) => renderInlineNode(node)).join('');
  }

  function renderInlineNode(node: PhrasingContent): string {
    switch (node.type) {
      case 'text':
        return escapeHtml((node as Text).value);
      case 'strong':
        return `<strong>${renderInline((node as Strong).children)}</strong>`;
      case 'emphasis':
        return `<em>${renderInline((node as Emphasis).children)}</em>`;
      case 'inlineCode':
        return `<code>${escapeHtml((node as InlineCode).value)}</code>`;
      case 'break':
        return '<br>';
      case 'link': {
        const link = node as Link;
        return `<a href="${escapeHtml(link.url)}">${renderInline(link.children)}</a>`;
      }
      case 'image':
        // テキストと混在するインライン画像は <figure> に昇格させず img のみ埋め込む
        // (`<p>` の中に `<figure>` は置けないため。単独段落の画像は下記 renderBlockNode
        // が <figure> へ昇格させる)。
        return renderImageTag(node as Image);
      default:
        // 未対応のインライン要素(取り消し線・参照形式リンク/画像・脚注参照・生インライン HTML
        // 等)はテキスト化して劣化させる(モジュール冒頭 JSDoc「劣化」参照)。
        return escapeHtml(mdastToString(node));
    }
  }

  /** 段落が(前後の空白テキストを除いて)画像1つだけで構成されているか。 */
  function soleImage(paragraph: Paragraph): Image | undefined {
    const meaningful = paragraph.children.filter(
      (child) => !(child.type === 'text' && (child as Text).value.trim() === ''),
    );
    const only = meaningful.length === 1 ? meaningful[0] : undefined;
    return only?.type === 'image' ? (only as Image) : undefined;
  }

  function renderListItem(item: ListItem): string {
    // GFM タスクリストはチェックボックス要素ではなくプレーンテキストの接頭辞に劣化させる
    // (モジュール冒頭 JSDoc「劣化」参照)。
    const prefix = item.checked === true ? '[x] ' : item.checked === false ? '[ ] ' : '';
    return `<li>${prefix}${renderBlockChildren(item.children as readonly RootContent[])}</li>`;
  }

  /** ブロック要素1つを HTML へ変換する。`topLevel` のときのみ `name`/`id` を付与する。 */
  function renderBlockNode(node: RootContent, topLevel: boolean): string {
    const id = topLevel ? idFactory() : undefined;
    const attrs = id !== undefined ? ` name="${id}" id="${id}"` : '';

    switch (node.type) {
      case 'paragraph': {
        const paragraph = node as Paragraph;
        const image = soleImage(paragraph);
        if (image !== undefined) {
          const src = resolveImageSrc(image.url);
          const alt = image.alt !== null && image.alt !== undefined ? escapeHtml(image.alt) : '';
          return `<figure${attrs}><img src="${src}" alt="${alt}"></figure>`;
        }
        return `<p${attrs}>${renderInline(paragraph.children)}</p>`;
      }
      case 'heading': {
        const heading = node as Heading;
        // note.com は見出しレベルを2段(h2/h3)しか持たないため丸める(モジュール冒頭 JSDoc)。
        const tag = heading.depth <= 2 ? 'h2' : 'h3';
        return `<${tag}${attrs}>${renderInline(heading.children)}</${tag}>`;
      }
      case 'list': {
        const list = node as List;
        const tag = list.ordered === true ? 'ol' : 'ul';
        const items = list.children.map((item) => renderListItem(item)).join('');
        return `<${tag}${attrs}>${items}</${tag}>`;
      }
      case 'code': {
        const code = node as Code;
        return `<pre${attrs}><code>${escapeHtml(code.value)}</code></pre>`;
      }
      case 'blockquote': {
        const blockquote = node as Blockquote;
        return `<blockquote${attrs}>${renderBlockChildren(blockquote.children as readonly RootContent[])}</blockquote>`;
      }
      case 'thematicBreak':
        return `<hr${attrs}>`;
      default: {
        // 未対応のブロック要素(表・脚注定義・生 HTML ブロック等)はテキスト化して <p> に
        // 劣化させる(モジュール冒頭 JSDoc「劣化」参照)。参照定義(definition)は本来
        // 不可視のためテキストが空になり、その場合は何も出力しない。
        const text = mdastToString(node).trim();
        return text === '' ? '' : `<p${attrs}>${escapeHtml(text)}</p>`;
      }
    }
  }

  function renderBlockChildren(nodes: readonly RootContent[]): string {
    return nodes.map((node) => renderBlockNode(node, false)).join('');
  }

  const html = tree.children.map((node) => renderBlockNode(node, true)).join('');

  return { html, imageKeys, bodyLength };
}
