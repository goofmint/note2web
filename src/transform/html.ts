/**
 * HTML → 行(line)分解の純粋ヘルパー(design.md §5.3「1行目」§5.4 unified/rehype 採用)。
 *
 * parser が出力する個別ノート HTML(design.md §5.2)は、本文を `<div class="note-content">`
 * の中に置き、その直下に見出し(`<h1>`)・リスト(`<ul>` チェックリスト含む)・表(`<table>`)
 * などのブロック要素と、地の文(プレーンテキスト)を `<br>` で区切って並べる、という構造を
 * とる(`test/fixtures/parser-output/` の個別 HTML を参照)。したがって「行」は
 * 「ブロック要素そのもの」と「`<br>` で区切られたインラインテキストのひとまとまり」の
 * 両方から成る、という前提でパースする。
 *
 * ここで言う「行」はメタデータ抽出(`src/transform/metadata.ts`、T-10)専用の中間表現であり、
 * 本文除去(T-11)は行わない(bodyHtml 自体はこのモジュールでは一切書き換えない)。
 *
 * `resolveContainerChildren` / `groupContainerChildrenIntoLines` は BodyTransformer
 * (`src/transform/body.ts`、T-11)からも再利用される。BodyTransformer はタイトル行
 * (1行目)・ハッシュタグのみの行を実際に本文から取り除く必要があり、その際
 * 「どの行がどの hast ノードに対応するか」を本モジュールと同じ規則で判定できないと
 * 除去対象がずれてしまう。そのため行分割アルゴリズムはここに一元化し、
 * `LineGroup#nodes`(行を構成した元ノード列)まで公開する。
 */

import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import { toText } from 'hast-util-to-text';
import type { Element, Node, Root, RootContent } from 'hast';

/** 本文の「行」として扱うブロックレベル要素タグ名(design.md §5.4 の変換対象に登場するものを中心に、常識的な範囲で列挙)。 */
const BLOCK_TAG_NAMES: ReadonlySet<string> = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'div',
  'ul',
  'ol',
  'table',
  'blockquote',
  'pre',
]);

/** hast の要素ノードかどうかを判定する(`body.ts` からも利用)。 */
export function isElement(node: Node): node is Element {
  return node.type === 'element';
}

/**
 * `class` 属性(`hast` では `properties.className`。`rehype-parse` は常に
 * `Array<string>` へ正規化するため、その形のみを扱う)が指定のクラス名を
 * 含むかどうかを判定する(`body.ts` からも利用。チェックリストの
 * `li.checked`/`li.unchecked` 判定などに使う)。
 */
export function hasClassName(element: Element, className: string): boolean {
  return (element.properties.className ?? []).includes(className);
}

/** 木を深さ優先で辿り、`predicate` を満たす最初の要素を返す。見つからなければ `null`。 */
function findFirstElement(node: Node, predicate: (element: Element) => boolean): Element | null {
  if (isElement(node) && predicate(node)) {
    return node;
  }
  const children = (node as { children?: RootContent[] }).children;
  if (children === undefined) {
    return null;
  }
  for (const child of children) {
    const found = findFirstElement(child, predicate);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/**
 * 「行」への分解対象とする子ノード列を選ぶ。
 * 1. `<div class="note-content">` があれば、その直下の子(design.md §5.2/§5.3 が
 *    前提とする parser の実際の出力構造)。
 * 2. 無ければ `<body>` の直下の子(`note-content` を持たない簡略化された HTML の
 *    フォールバック。トップレベルの `<html>` 要素をそのまま「行」候補にすると
 *    ブロック要素の区別が失われるため、`<body>` まで潜る必要がある)。
 * 3. `<body>` も無ければ木そのものの直下の子。
 *
 * `body.ts`(BodyTransformer)もこの関数で「本文」の範囲を決める。個別 HTML の
 * メタデータヘッダ(Note UUID・Account・Folder・Title・Created・Modified)は
 * `<div class="note-content">` の外側にあるため、この関数が返す子ノード列にしか
 * 現れない——BodyTransformer が変換対象をこの戻り値に限定する限り、メタデータ
 * ヘッダは変換結果の Markdown に一切現れない。
 */
export function resolveContainerChildren(tree: Root): RootContent[] {
  const contentDiv = findFirstElement(tree, (element) => hasClassName(element, 'note-content'));
  if (contentDiv !== null) {
    return contentDiv.children;
  }
  const body = findFirstElement(tree, (element) => element.tagName === 'body');
  if (body !== null) {
    return body.children;
  }
  return tree.children;
}

/** ノードの配下テキストを取得し、前後の空白を trim して返す(空要素・空白のみは `''`)。 */
function extractText(nodes: readonly RootContent[]): string {
  return toText({ type: 'root', children: [...nodes] } as Root, { whitespace: 'normal' }).trim();
}

/**
 * `groupContainerChildrenIntoLines` が返す1行分。`text` は行のテキスト内容
 * (`extractLines` が返すのと同じ値)、`nodes` はその行を構成した元の hast ノード列
 * (`resolveContainerChildren` が返す配列内での参照。同一配列内の要素そのもの)。
 * `kind` は `'block'`(ブロック要素1つがそのまま1行になった)か
 * `'inline'`(`<br>` 区切りで蓄積されたインラインノード列が1行になった)か。
 *
 * `body.ts`(BodyTransformer)は `nodes` を使ってタイトル行・ハッシュタグのみの行を
 * 実際に取り除き、`kind` を使って残った行を(ブロックはそのまま、インラインは
 * 合成 `<p>` として)Markdown 変換対象の木に組み直す。
 */
export interface LineGroup {
  text: string;
  nodes: RootContent[];
  kind: 'block' | 'inline';
}

/**
 * コンテナ(`resolveContainerChildren` が返す子ノード列)を、design.md §5.3 の言う
 * 「行」の並びへ分解する。`extractLines`・`body.ts` の双方から使われる、行分割の
 * 唯一の実装(規則がずれると、メタデータ抽出が数えた行インデックスと
 * BodyTransformer が実際に取り除くノードとが食い違ってしまうため)。
 *
 * 分解規則:
 * - ブロック要素(`BLOCK_TAG_NAMES`)は、それ単体で1行になる(内部の `<br>` はその行の中で
 *   無視され、テキストとして結合される)。テキストを持たないブロック要素(空の `<div>` 等)は
 *   行として出力しない。
 * - ブロック要素以外(テキストノード・`<a>` `<b>` `<img>` 等のインライン要素)は、直前の行の
 *   続きとして蓄積され、`<br>` 要素・ブロック要素の出現・コンテナの終端のいずれかで
 *   1行として確定する。空白のみのテキストが並んだだけの蓄積(要素を1つも含まない)は
 *   行として出力しない(`<br><br>` の間の空行を除外するため)。**ただし要素ノードを
 *   1つでも含む蓄積は、テキストが空(`text: ''`)であっても行として出力する**——
 *   `<a href="…"><img … data-apple-notes-zidentifier="…"></a>`(alt 無しの添付・描画
 *   参照。design.md §13-2)のように、視覚テキストは無いが `body.ts`(BodyTransformer)
 *   にとっては変換すべき実体を持つ行があるため。`extractLines`(メタデータ抽出専用)は
 *   このテキスト空の行を末尾で除外し、従来どおり「テキストを持つ行だけ」を返す。
 */
export function groupContainerChildrenIntoLines(children: readonly RootContent[]): LineGroup[] {
  const groups: LineGroup[] = [];
  let pendingInline: RootContent[] = [];

  const flushInline = (): void => {
    if (pendingInline.length === 0) {
      return;
    }
    const nodes = pendingInline;
    pendingInline = [];
    const text = extractText(nodes);
    const hasElement = nodes.some(isElement);
    if (text !== '' || hasElement) {
      groups.push({ text, nodes, kind: 'inline' });
    }
  };

  for (const child of children) {
    if (isElement(child) && child.tagName === 'br') {
      flushInline();
      continue;
    }
    if (isElement(child) && BLOCK_TAG_NAMES.has(child.tagName)) {
      flushInline();
      const text = extractText([child]);
      if (text !== '') {
        groups.push({ text, nodes: [child], kind: 'block' });
      }
      continue;
    }
    pendingInline.push(child);
  }
  flushInline();

  return groups;
}

/**
 * bodyHtml を解析し、`resolveContainerChildren` が選んだコンテナ(`<div class="note-content">`。
 * 無ければ `<body>`、それも無ければ木そのもの)直下の子を `groupContainerChildrenIntoLines` で
 * 行に分解し、テキストを持つ行(`text !== ''`)だけをそのテキストで返す
 * (`groupContainerChildrenIntoLines` はテキストの無い要素だけの行——alt 無しの `<img>`
 * 参照など——も `body.ts` のために返すが、メタデータ抽出用のこの関数はそれを除外する)。
 *
 * 空の bodyHtml(パース結果にテキストを持つノードが一切無い)の場合は空配列を返す。
 */
export function extractLines(bodyHtml: string): string[] {
  const tree = unified().use(rehypeParse).parse(bodyHtml);
  const containerChildren = resolveContainerChildren(tree);
  return groupContainerChildrenIntoLines(containerChildren)
    .map((group) => group.text)
    .filter((text) => text !== '');
}

/** `extractLines` の先頭要素(無ければ `''`)。design.md §5.3「1行目」の取得に使う。 */
export function firstLine(bodyHtml: string): string {
  return extractLines(bodyHtml)[0] ?? '';
}
