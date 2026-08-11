/**
 * BodyTransformer(design.md §5.4)。
 *
 * parser が出力した個別ノート HTML(`<div class="note-content">` に本文を持つ。
 * `html.ts` の JSDoc・`test/fixtures/parser-output/html/` を参照)を、サービス配信用の
 * Markdown 本文へ変換する。unified(`rehype-parse` 相当で既にパース済みの hast を
 * 受け取り、`rehype-remark` → `remark-gfm` + `remark-stringify` で Markdown 化する)を使う。
 *
 * 変換対象は常に `html.ts` の `resolveContainerChildren` が選ぶコンテナ(`<div
 * class="note-content">`。無ければ `<body>`。それも無ければ木そのもの)の直下の子に
 * 限定する。個別 HTML のメタデータヘッダ(`Note <uuid>` / `Account:` / `Folder:` /
 * `Title:` / `Created:` / `Modified:`)はこのコンテナの外側にあるため、この限定だけで
 * 変換結果の Markdown に一切現れない(`html.ts` 側の JSDoc も参照)。
 *
 * 本モジュールが行う変換規則(design.md §5.4 の表に対応):
 * - `<table>` → GFM の表(FR-11。既定の `rehype-remark` ハンドラで変換される)
 * - チェックリスト(`<ul class="checklist"><li class="checked|unchecked">`。ネストは
 *   `li` 内の入れ子 `ul.checklist`。design.md §13-1 で確認済み)→ `- [x]` / `- [ ]`。
 *   ネストは mdast の `listItem.children` に入れ子の `list` を置くだけで、
 *   `remark-stringify` がインデントを自動で付ける(FR-12)
 * - 描画・添付への参照(`<a href="…"><img … data-apple-notes-zidentifier="UUID"></a>`
 *   または `data-apple-notes-zidentifier` を直接持つ `<a>`。design.md §13-2 で
 *   確認済みなのは前者の描画パターンのみ。後者は本モジュールが FR-14
 *   「添付は画像なら `![]()`、それ以外はリンク」を満たすために踏襲した拡張で、
 *   T-08 実機データでの確認は取れていない)→ `makeAssetPlaceholder` が返す
 *   プレースホルダ URL を使った `![](…)`(画像)または `[…](…)`(リンク)(FR-13/FR-14)
 * - 1行目(タイトル行。`html.ts` の「行」と同じ規則)は本文から除去する(タイトルは
 *   frontmatter へ。§5.6 Renderer の責務)
 * - ハッシュタグのみで構成される行(`metadata.ts` の `isHashtagOnlyLine`。文中の
 *   インラインなハッシュタグは残す)は本文から除去する(design.md §5.3)
 * - 上記いずれにも当たらない要素で、かつ Markdown で表現できない要素(`SUPPORTED_TAG_NAMES`
 *   に無いタグ)は、生 HTML を埋め込まずテキスト化し、注入されたロガーに `warn` する。
 *   ただし `<script>`/`<style>`(`DROPPED_TAG_NAMES`)はテキスト化せず要素ごと削除し
 *   (中身はコード/CSS であり本文に混入させてはいけないため)、`<section>` 等の
 *   HTML5 セクショニング要素(`UNSUPPORTED_BLOCK_TAG_NAMES`)はテキスト化した内容を
 *   合成 `<p>` で包んで段落境界を保つ
 * - `<br>` で区切られたプレーンテキストの各連(`html.ts` の「行」の `kind: 'inline'`)は、
 *   それぞれ独立した段落として出力する(単一段落内の強制改行にはしない)
 */

import { unified } from 'unified';
import rehypeRemark from 'rehype-remark';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { defaultHandlers } from 'hast-util-to-mdast';
import type { Handle } from 'hast-util-to-mdast';
import { toText } from 'hast-util-to-text';
import rehypeParse from 'rehype-parse';
import type { Element, ElementContent, Root, RootContent } from 'hast';
import type { Image, Link } from 'mdast';
import {
  groupContainerChildrenIntoLines,
  hasClassName,
  isElement,
  resolveContainerChildren,
} from './html.js';
import { isHashtagOnlyLine } from './metadata.js';

// ---------------------------------------------------------------------------
// アセット(添付・描画)プレースホルダの契約(T-13 と共有)。
// ---------------------------------------------------------------------------

/**
 * 添付・描画参照(FR-13/FR-14)のプレースホルダ URL を生成する(design.md §5.4)。
 *
 * design.md はプレースホルダの具体的なトークン形式までは規定していないため、本タスクで
 * 定義し、T-13(AssetUploader)と共有する契約とする。
 *
 * **契約**:
 * - 形式は `note2web-asset://<identifier>`(独自 URI スキーム)。`<identifier>` は
 *   parser が個別 HTML に埋め込む `data-apple-notes-zidentifier` 属性の値
 *   (埋め込みオブジェクトの UUID。design.md §5.3 の `Attachment#identifier` と同じ
 *   情報源)をそのまま使う。
 * - この文字列は Markdown の画像/リンク URL の位置(`![](…)` / `[…](…)`)にのみ現れる。
 *   有効な Markdown 構文を保ったまま、実アセット URL への差し替えを後段に委ねるための
 *   プレースホルダであり、本文中の任意の位置に埋め込む汎用センチネルではない。
 * - BodyTransformer(本モジュール)はこの URL を解決しない。AssetUploader(§5.5、T-13)が
 *   本文中からこの形式の URL を(`note2web-asset://` プレフィックスで)grep 可能な形で
 *   見つけ、`identifier` から対応する `Attachment` を解決したうえで、実際の R2/S3 URL
 *   (`public_base_url` + キー)に差し替える(FR-14)。
 */
export function makeAssetPlaceholder(identifier: string): string {
  return `note2web-asset://${identifier}`;
}

// ---------------------------------------------------------------------------
// ロガー(design.md §9 の `Logger['warn']` と構造的に互換。`subprocess.ts` の
// `SubprocessLogger` と同じ最小インターフェース注入パターン)。
// ---------------------------------------------------------------------------

/**
 * BodyTransformer が警告を出すのに必要な最小限のロガーインターフェース。
 * `src/logger.ts` の `Logger` はこれを満たすため、そのまま渡せる。
 */
export interface BodyTransformerLogger {
  warn(payload: { message: string; noteUuid?: string; title?: string }): void;
}

// ---------------------------------------------------------------------------
// 入力・出力契約。
// ---------------------------------------------------------------------------

/** `transformBody` の入力。design.md §5.4 の入力(個別 HTML)+ 警告ログ用の任意コンテキスト。 */
export interface TransformBodyOptions {
  /** parser が出力した当該ノートの個別 HTML(design.md §5.2。`Note#bodyHtml` と同じもの)。 */
  bodyHtml: string;
  /** 未対応要素のテキスト化を警告する先(任意注入)。未指定なら警告を出さない。 */
  logger?: BodyTransformerLogger;
  /** 警告ログでどのノートかを識別するための UUID(FR-09。`WarnPayload#noteUuid`)。 */
  noteUuid?: string;
  /** 警告ログでどのノートかを識別するためのタイトル(`WarnPayload#title`)。 */
  title?: string;
}

/** `transformBody` の出力。 */
export interface TransformBodyResult {
  /** frontmatter を含まない、変換済みの Markdown 本文(§5.6 Renderer が frontmatter と連結する)。 */
  markdown: string;
}

// ---------------------------------------------------------------------------
// 未対応要素のテキスト化(design.md §5.4「変換で表現できない要素」)。
// ---------------------------------------------------------------------------

/**
 * BodyTransformer が Markdown へ変換できると判断しているタグ名の一覧。
 *
 * ここに無いタグは(既定の `rehype-remark` ハンドラがどう扱うかに関わらず)本モジュールが
 * 「変換で表現できない要素」として扱い、テキスト化 + 警告ログの対象にする
 * (design.md §5.4)。見出し・地の文・強調・リンク・画像・リスト(チェックリスト含む)・
 * 表・改行・区切り線という、Apple Notes の個別 HTML(`test/fixtures/parser-output/`)と
 * 一般的な HTML 装飾で使われる範囲に絞って許可する。
 */
const SUPPORTED_TAG_NAMES: ReadonlySet<string> = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'div',
  'span',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'a',
  'img',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'strike',
  'del',
  'mark',
  'sup',
  'sub',
  'br',
  'hr',
  'blockquote',
  'pre',
  'code',
  'kbd',
]);

/**
 * 中身がコード/CSS であり、テキストとして本文に混入させてはいけないタグ。
 * `SUPPORTED_TAG_NAMES` には無い(=「変換で表現できない要素」の一種)が、他の未対応要素と
 * 違って `toText` によるテキスト化は行わず、要素ごと本文から取り除く(design.md §5.4の
 * 「テキスト化」は本来「その要素が持つ意味のあるテキストを残す」ことが目的であり、
 * `<script>`/`<style>` の中身はユーザー可読なテキストではなく実行コード/スタイル定義
 * そのものであるため、これを Markdown 本文に漏らすのは「テキスト化」の趣旨に反する)。
 * 警告ログ自体は他の未対応要素と同様に1回出す(要素が丸ごと失われたことをオペレータが
 * 追跡できるように)。
 */
const DROPPED_TAG_NAMES: ReadonlySet<string> = new Set(['script', 'style']);

/**
 * `SUPPORTED_TAG_NAMES` に無い(=未対応)タグのうち、HTML5 のセクショニング/
 * グルーピング要素のように既定でブロックレベル表示となるものの一覧。
 *
 * これらをテキスト化する際は、単なるテキストノードに置き換えるのではなく合成 `<p>` で
 * 包む(`html.ts` の `BLOCK_TAG_NAMES` に `'p'` が含まれるため、行分割で独立した1行=
 * 独立した段落として扱われる)。そうしないと、例えば `<section>A</section>
 * <section>B</section>` のような隣接するブロック要素が、テキスト化後は単なる隣接テキスト
 * ノード("A" と "B")になり、`<br>` も挟まないため行分割で1つの行("AB")に混ざって
 * 段落境界が失われてしまう。`<video>`/`<audio>` 等(インライン的に扱ってよい未対応要素)は
 * この一覧に含めず、従来どおり地の文に溶け込ませる。
 */
const UNSUPPORTED_BLOCK_TAG_NAMES: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'details',
  'dialog',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'header',
  'hgroup',
  'main',
  'nav',
  'section',
  'summary',
]);

/**
 * `nodes` を深さ優先で走査し、`SUPPORTED_TAG_NAMES` に無いタグの要素を置き換える(生 HTML を
 * 埋め込まない。design.md §5.4)。置き換えた要素ごとに `onUnsupported` を1回呼ぶ
 * (`html.ts`/`metadata.ts` に倣い、`nodes` そのものを破壊的に書き換える)。
 *
 * - `DROPPED_TAG_NAMES`(`script`/`style`)は要素ごと取り除く(コード/CSS をテキストとして
 *   残さない)。
 * - `UNSUPPORTED_BLOCK_TAG_NAMES` はテキスト化のうえ合成 `<p>` で包み、段落境界を保つ。
 * - それ以外の未対応タグは、その場でテキストノード(`hast-util-to-text` による配下
 *   テキストの抽出結果)に置き換える(地の文に溶け込ませる)。
 *
 * サポート対象タグの子要素へは再帰して未対応要素を探す。未対応タグはテキスト化(または
 * 削除)した時点でその配下ごと1つのノードにまとまるため、配下をさらに再帰しない
 * (配下にも未対応要素があれば、そのテキストは結果に含まれるが、個別の警告は
 * 外側の未対応要素1件のみ出す。ただし `DROPPED_TAG_NAMES` の場合は配下ごと消えるため、
 * 配下のテキストも結果に一切残らない)。
 */
function textualizeUnsupportedElements(
  nodes: Array<RootContent | ElementContent>,
  onUnsupported: (tagName: string) => void,
): void {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!isElement(node)) {
      continue;
    }
    if (SUPPORTED_TAG_NAMES.has(node.tagName)) {
      textualizeUnsupportedElements(node.children, onUnsupported);
      continue;
    }

    onUnsupported(node.tagName);

    if (DROPPED_TAG_NAMES.has(node.tagName)) {
      nodes.splice(index, 1);
      index -= 1;
      continue;
    }

    const text = toText(node, { whitespace: 'normal' });
    if (UNSUPPORTED_BLOCK_TAG_NAMES.has(node.tagName)) {
      nodes[index] = {
        type: 'element',
        tagName: 'p',
        properties: {},
        children: text === '' ? [] : [{ type: 'text', value: text }],
      };
    } else {
      nodes[index] = { type: 'text', value: text };
    }
  }
}

// ---------------------------------------------------------------------------
// 見出し行の無い `<table>` の補正(design.md §5.4「`<table>` → GFM の表」、FR-11)。
// ---------------------------------------------------------------------------

/**
 * `apple_cloud_notes_parser` が出力する `<table>`(`test/fixtures/parser-output/`
 * `Q3 Sales Table` フィクスチャ。README.md「実行検証」)は見出し行を `<th>` ではなく
 * 他の行と同じ `<td>` でしか表現しない。`hast-util-to-mdast` の既定 `table` ハンドラは
 * `<th>`/`<thead>` が1つも無いテーブルを「見出し無し」と判定し、GFM の表が構文上
 * 見出し行を必須とするために**空の見出し行を先頭に追加**してしまう——そのままでは
 * 表の実データ1行目(例: `Item | Revenue`)が見出しとして扱われず、FR-11 の意図
 * (表 → GFM の表であり、1行目が見出しになること)からずれる。
 *
 * そのため、`<thead>`/`<th>` を持たない `<table>` を見つけたら、その最初の `<tr>` の
 * `<td>` を `<th>` に昇格させ、意図どおり見出し行として扱わせる(セル内容・colspan/rowspan
 * 等はそのまま。タグ名のみの書き換え)。既に `<th>`/`<thead>` を持つテーブル
 * (design.md が明示的には出力しないと確認しているが、将来の変化に備える)には触れない。
 */
function promoteHeaderlessTableFirstRow(nodes: Array<RootContent | ElementContent>): void {
  for (const node of nodes) {
    if (!isElement(node)) {
      continue;
    }
    if (node.tagName === 'table' && !hasHeaderMarker(node)) {
      const firstRow = findFirstTableRow(node.children);
      if (firstRow !== undefined) {
        for (const cell of firstRow.children) {
          if (isElement(cell) && cell.tagName === 'td') {
            cell.tagName = 'th';
          }
        }
      }
    }
    promoteHeaderlessTableFirstRow(node.children);
  }
}

/** `table` の配下(ネストした `<table>` は除く)に `<th>` または `<thead>` があるかどうか。 */
function hasHeaderMarker(table: Element): boolean {
  const stack: ElementContent[] = [...table.children];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined || !isElement(node)) {
      continue;
    }
    if (node.tagName === 'th' || node.tagName === 'thead') {
      return true;
    }
    if (node.tagName === 'table') {
      continue;
    }
    stack.push(...node.children);
  }
  return false;
}

/** `table` の配下(ネストした `<table>` は除く)で文書順で最初に現れる `<tr>`。無ければ `undefined`。 */
function findFirstTableRow(nodes: readonly ElementContent[]): Element | undefined {
  for (const node of nodes) {
    if (!isElement(node)) {
      continue;
    }
    if (node.tagName === 'tr') {
      return node;
    }
    if (node.tagName === 'table') {
      continue;
    }
    const found = findFirstTableRow(node.children);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// チェックリスト・添付/描画のカスタムハンドラ(rehype-remark の `handlers`)。
// ---------------------------------------------------------------------------

/** `hast-util-to-mdast` の既定ハンドラを、存在確認込みで取り出す(常に存在する既知キーのみに使う)。 */
function requireDefaultHandler(tagName: 'li' | 'a' | 'img'): Handle {
  const handler = defaultHandlers[tagName];
  if (handler === null || handler === undefined) {
    throw new Error(
      `hast-util-to-mdast has no default handler for <${tagName}> (unexpected library change)`,
    );
  }
  return handler;
}

/** `data-apple-notes-zidentifier` 属性の値(添付・描画の識別子)。無ければ `undefined`。 */
function readZIdentifier(element: Element): string | undefined {
  const value = element.properties.dataAppleNotesZidentifier;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** `<img alt="…">` の値。無ければ `''`。 */
function readAlt(element: Element): string {
  const value = element.properties.alt;
  return typeof value === 'string' ? value : '';
}

/**
 * `<li class="checked">` / `<li class="unchecked">`(design.md §13-1)を GFM チェックリスト
 * 項目(`checked: true/false`)に変換する。それ以外(通常の `<li>`)は既定の挙動のまま
 * (FR-12)。ネストしたチェックリスト(`li` 内の入れ子 `ul.checklist`)は既定の `li`
 * ハンドラが `state.all` で再帰するため、この関数自身が再帰する必要は無い。
 */
function checklistAwareLiHandler(): Handle {
  const defaultLi = requireDefaultHandler('li');
  return (state, element, parent) => {
    // `unchecked` を先に判定する(防御的措置): `'unchecked'` は文字列として `'checked'` を
    // 部分文字列に含むため、万一 `hasClassName` の実装が将来 substring 判定に変わっても
    // (現状は `className` 配列の完全一致判定だが)判定順序をこの向きにしておけば
    // 誤判定しない。
    const checked = hasClassName(element, 'unchecked')
      ? false
      : hasClassName(element, 'checked')
        ? true
        : undefined;
    const result = defaultLi(state, element, parent);
    if (
      checked !== undefined &&
      result !== undefined &&
      !Array.isArray(result) &&
      result.type === 'listItem'
    ) {
      result.checked = checked;
    }
    return result;
  };
}

/**
 * `data-apple-notes-zidentifier` を持つ `<img>` をアセットプレースホルダ画像
 * (`![](note2web-asset://<identifier>)`)に変換する(FR-13 描画、FR-14 画像添付)。
 * 属性が無い通常の `<img>` は既定の挙動のまま。
 */
function assetAwareImgHandler(): Handle {
  const defaultImg = requireDefaultHandler('img');
  return (state, element, parent) => {
    const identifier = readZIdentifier(element);
    if (identifier === undefined) {
      return defaultImg(state, element, parent);
    }
    const image: Image = {
      type: 'image',
      url: makeAssetPlaceholder(identifier),
      title: null,
      alt: readAlt(element),
    };
    return image;
  };
}

/**
 * `<a href="…"><img … data-apple-notes-zidentifier="…"></a>`(design.md §13-2 で確認済みの
 * 描画参照の形。前後の空白テキストは無視する)を、リンクで包まずアセットプレースホルダ
 * 画像そのものに展開する(`![](…)`。design.md §5.4「画像参照」)。
 *
 * `data-apple-notes-zidentifier` を `<a>` 自身が直接持つ場合(画像を伴わない添付への
 * 参照。parser の実出力での確認は取れていない拡張。モジュール先頭の JSDoc 参照)は、
 * アセットプレースホルダへのリンク(`[<リンクテキスト>](…)`)にする(FR-14「それ以外は
 * リンク」)。
 *
 * どちらでもない通常の `<a>` は既定の挙動のまま。
 */
function assetAwareAHandler(): Handle {
  const defaultA = requireDefaultHandler('a');
  const img = assetAwareImgHandler();
  return (state, element, parent) => {
    const meaningfulChildren = element.children.filter(
      (child) => !(child.type === 'text' && child.value.trim() === ''),
    );
    if (meaningfulChildren.length === 1) {
      const only = meaningfulChildren[0];
      if (
        only.type === 'element' &&
        only.tagName === 'img' &&
        readZIdentifier(only) !== undefined
      ) {
        return img(state, only, element);
      }
    }

    const directIdentifier = readZIdentifier(element);
    if (directIdentifier !== undefined) {
      const linkText = toText(element, { whitespace: 'normal' }).trim();
      // リンクテキストが空(アイコンのみ等でテキストを持たない添付)だと `[](…)` になり、
      // 参照が目視できなくなる。その場合は識別子自体をラベルとして使い、
      // どのアセットへの参照かが Markdown 上でも読み取れるようにする。
      const label = linkText === '' ? directIdentifier : linkText;
      const link: Link = {
        type: 'link',
        url: makeAssetPlaceholder(directIdentifier),
        title: null,
        children: [{ type: 'text', value: label }],
      };
      return link;
    }

    return defaultA(state, element, parent);
  };
}

// ---------------------------------------------------------------------------
// unified プロセッサ(状態を持たないため、呼び出しごとに再構築せずモジュールスコープの
// 定数として使い回す。`.freeze()` してプラグイン構成を確定させる)。
// ---------------------------------------------------------------------------

/** `bodyHtml` を hast にパースするだけのプロセッサ。`html.ts` の各関数と同じ用途。 */
const parseProcessor = unified().use(rehypeParse).freeze();

/**
 * 組み直した hast(`scopedRoot`)を Markdown 文字列に変換するプロセッサ
 * (`rehype-remark`(チェックリスト・アセットプレースホルダのカスタムハンドラ付き)→
 * `remark-gfm` → `remark-stringify`)。ハンドラ自体はステートレスなので、
 * `transformBody` の呼び出しごとに作り直す必要が無い。
 */
const markdownProcessor = unified()
  .use(rehypeRemark, {
    handlers: {
      li: checklistAwareLiHandler(),
      img: assetAwareImgHandler(),
      a: assetAwareAHandler(),
    },
  })
  .use(remarkGfm)
  // `bullet: '-'`: design.md §5.4 / FR-12 の要求する `- [x]` / `- [ ]` 表記に合わせる
  // (remark-stringify の既定は `*`)。それ以外は既定のまま。
  .use(remarkStringify, { bullet: '-' })
  .freeze();

// ---------------------------------------------------------------------------
// エントリ関数。
// ---------------------------------------------------------------------------

/**
 * `bodyHtml`(parser が出力した個別ノート HTML)を、サービス配信用の Markdown 本文へ
 * 変換する(design.md §5.4)。frontmatter は含まない(§5.6 Renderer の責務)。
 *
 * 手順:
 * 1. `resolveContainerChildren`(`html.ts`)で本文コンテナ(`<div class="note-content">`
 *    等)の直下の子を取り出す。メタデータヘッダはこの外側にあるため出力に現れない。
 * 2. `textualizeUnsupportedElements` で、`SUPPORTED_TAG_NAMES` に無いタグを再帰的に
 *    テキスト化し、都度 `logger.warn` する。
 * 3. `groupContainerChildrenIntoLines`(`html.ts`)で「行」に分解し、1行目(タイトル行)と
 *    ハッシュタグのみの行を取り除く。残った行のうち、ブロック要素1つがそのまま1行に
 *    なったもの(`kind: 'block'`)はその要素をそのまま、`<br>` 区切りのインライン蓄積
 *    (`kind: 'inline'`)は合成 `<p>` として、それぞれ独立した Markdown 段落 / ブロックに
 *    なるように木を組み直す。
 * 4. `rehype-remark`(チェックリスト・アセットプレースホルダのカスタムハンドラ付き)→
 *    `remark-gfm` → `remark-stringify` で Markdown 文字列に直列化する。
 *
 * 空の `bodyHtml`、または本文コンテナにタイトル行以外の内容が無い場合は
 * `{ markdown: '' }` を返す(エラーにしない。タイトル・メタデータの抽出可否は
 * `metadata.ts` の責務)。
 */
export function transformBody(options: TransformBodyOptions): TransformBodyResult {
  const { bodyHtml, logger, noteUuid, title } = options;

  const tree = parseProcessor.parse(bodyHtml) as Root;
  const containerChildren = resolveContainerChildren(tree);

  textualizeUnsupportedElements(containerChildren, (tagName) => {
    logger?.warn({
      message: `unsupported element <${tagName}> could not be converted to Markdown; replaced with its text content`,
      noteUuid,
      title,
    });
  });
  promoteHeaderlessTableFirstRow(containerChildren);

  const groups = groupContainerChildrenIntoLines(containerChildren);
  // タイトル行(1行目)は `html.ts` の `firstLine`/`extractLines` と同じ定義
  // (テキストを持つ最初の行)を使う。`groupContainerChildrenIntoLines` は
  // BodyTransformer 向けにテキストの無い行(alt 無しの添付参照など)も返すため、
  // 単純に `groups[0]` を「タイトル行」とみなすと、本文の先頭が alt 無し画像だった
  // 場合に誤ってその画像を取り除いてしまう。そのため、テキストを持つ最初の行の
  // インデックスを明示的に探す(`metadata.ts` の `completeNoteMetadata` が
  // `firstLine(bodyHtml)` から導くタイトルと必ず一致させるため)。
  const titleGroupIndex = groups.findIndex((group) => group.text !== '');
  const survivingGroups = groups.filter((group, index) => {
    if (index === titleGroupIndex) {
      // 1行目(タイトル行)は本文から除去する(design.md §5.4。タイトルは frontmatter へ)。
      return false;
    }
    if (isHashtagOnlyLine(group.text)) {
      // ハッシュタグのみで構成される行は除去する(design.md §5.3。文中のインラインな
      // ハッシュタグはこの行分割では別グループになるため残る)。
      return false;
    }
    return true;
  });

  const blocks: RootContent[] = survivingGroups.map((group): RootContent => {
    if (group.kind === 'block') {
      return group.nodes[0];
    }
    // `<br>` 区切りのインラインテキストの各連は、独立した段落として出力する
    // (単一段落内の強制改行にはしない。モジュール先頭 JSDoc 参照)。
    return {
      type: 'element',
      tagName: 'p',
      properties: {},
      children: group.nodes as ElementContent[],
    };
  });

  const scopedRoot: Root = { type: 'root', children: blocks };

  const mdast = markdownProcessor.runSync(scopedRoot);
  const raw = String(markdownProcessor.stringify(mdast));
  const trimmed = raw.trim();
  const markdown = trimmed === '' ? '' : `${trimmed}\n`;

  return { markdown };
}
