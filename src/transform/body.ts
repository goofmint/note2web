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
 *   確認済みなのは前者の描画パターンのみ。後者は実機(Qiita 公開)で確認された、
 *   img を伴わない添付参照の実際の HTML 形)→ `makeAssetPlaceholder` が返す
 *   プレースホルダ URL を使った `![](…)`(画像)または `[…](…)`(リンク)(FR-13/FR-14)。
 *   FR-14「添付は画像なら `![]()`、それ以外はリンク」の判定基準は **HTML の形
 *   (img を伴うか)ではなく、参照先の添付の種別(拡張子が画像かどうか)**
 *   である(実機で `<a data-apple-notes-zidentifier>` 直接参照の画像添付が
 *   リンクとして誤変換される不具合を修正。`options.attachments` を
 *   `Attachment.identifier` で引き、`isImageExtension`(`assets/uploader.ts`。
 *   Content-Type 推定テーブルと共有)で拡張子判定する。識別子に対応する
 *   `Attachment` が無ければ(未知の参照)、従来どおりリンクのままにする)
 * - リンクテキストが URL そのものと一致するリンク(Apple Notes で URL を貼り付けた
 *   `<a href="URL">URL</a>`)は、オートリンク `<URL>` ではなく**素の URL テキスト**として
 *   出力する(`unwrapAutolinks`。Zenn のリンクカードは行全体が素の URL のときにのみ
 *   発動するため。リンクテキストが URL と異なる通常のリンクは `[テキスト](URL)` のまま)
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
 * - ノート本文中に地の文として書かれた ```` ``` ````(コードフェンス)の行に囲まれた区間を、
 *   逐語(エスケープ無し)の Markdown コードブロック(`code` ノード)として認識する
 *   (`recognizeCodeFences`。実機で ```` ```ruby ```` のようなフェンスが `\`\`\`ruby` と
 *   エスケープされてしまう不具合の修正)。hast→mdast 変換後・`remark-stringify` 直列化前に
 *   mdast ツリーへ後処理として適用する。**仕様(design.md §5.4 にも記載)**:
 *   - mdast ルートの**トップレベルの子のみ**を対象にする(リスト・引用の内部は対象外。
 *     ネストした構造の中まで探索すると「行」の境界が曖昧になるため、意図的に対象外とする)
 *   - 「フェンス行」は段落(`paragraph`)1つの内容全体(`mdast-util-to-string` でテキスト化し
 *     `trim` したもの)が `/^```([A-Za-z0-9_+#.-]*)$/`(開始。言語トークン任意)または
 *     完全一致の ` ``` `(終端)と一致するものだけを指す。**フェンス行が他の行と同じ段落を
 *     共有している場合は認識しない**(`html.ts`/本モジュールの行分割規則により、
 *     `<br>` 区切りの各行は既定で独立した段落になるため、通常のノートではこの制約は
 *     問題にならない)
 *   - 開始フェンス行の次から、直後に見つかった終端フェンス行の手前までの各トップレベル
 *     ノードのプレーンテキストを(`\n` で連結して)コードブロックの内容にする
 *   - 開始フェンス行に対応する終端フェンス行が最後まで見つからない場合は、**何もしない**
 *     (それ以前の通常のテキスト化・エスケープのまま。閉じフェンスの位置を推測しない)
 *   - コードブロックの内容は完全に逐語(`remark-stringify` がバッククォートのエスケープを
 *     一切行わない `code` ノードとして直列化するため。内容が ` ``` ` を含む場合は
 *     `remark-stringify`(`mdast-util-to-markdown`)が自動的に外側のフェンスを
 *     4連続以上のバッククォートに伸長する——本モジュールが意識する必要はない)
 *   - フェンス区間内にアセット参照(添付・描画の `![]()`/`[]()`)が入っていた場合、
 *     その mdast ノードもプレーンテキスト化(=リンクテキスト/alt のみ)されるため、
 *     アセット自体への参照は失われる(**コードフェンス内の添付参照は非対応**。
 *     `note2web-asset://` プレースホルダが本文に残らないため、AssetUploader
 *     (T-13)の「未解決プレースホルダが残っていないこと」検証にも抵触しない)
 * - ノート本文中に地の文として書かれたインラインコード(`` `code` `` のバッククォート対)
 *   を、逐語の `inlineCode` ノードとして認識する(`recognizeInlineCode`。実機で
 *   `` `code` `` が `` \`code\` `` とエスケープされてしまう不具合の修正。
 *   コードフェンス認識のインライン版)。対はバッククォート・改行を含まない1文字以上の
 *   内容に限り、対になっていないバッククォートは従来どおりエスケープされたまま残す
 */

import { extname } from 'node:path';
import { unified } from 'unified';
import rehypeRemark from 'rehype-remark';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { defaultHandlers } from 'hast-util-to-mdast';
import type { Handle } from 'hast-util-to-mdast';
import { toText } from 'hast-util-to-text';
import rehypeParse from 'rehype-parse';
import type { Element, ElementContent, Root, RootContent } from 'hast';
import type {
  Code as MdastCode,
  Image,
  InlineCode,
  Link,
  Root as MdastRoot,
  RootContent as MdastRootContent,
  Text as MdastText,
} from 'mdast';
import { toString as mdastToString } from 'mdast-util-to-string';
import { isImageExtension } from '../assets/uploader.js';
import type { Attachment } from '../model/note.js';
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
  return `${ASSET_PLACEHOLDER_PREFIX}${identifier}`;
}

/**
 * アセットプレースホルダ URL のプレフィックス(`makeAssetPlaceholder` の JSDoc の契約)。
 * `unwrapAutolinks` がアセット参照リンクを展開対象から除外する判定にも使う。
 */
const ASSET_PLACEHOLDER_PREFIX = 'note2web-asset://';

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
  /**
   * 当該ノートの添付・描画一覧(`Note#attachments`。design.md §5.3)。
   *
   * `data-apple-notes-zidentifier` を直接持つ `<a>`(img を伴わない添付参照)が画像か
   * どうか(FR-14「添付は画像なら `![]()`、それ以外はリンク」)を判定するために使う。
   * 未指定(省略)の場合は常に「対応する添付が見つからない」として扱い、従来どおり
   * リンクにする(呼び出し側が `attachments` を持たない場合の後方互換)。
   */
  attachments?: readonly Attachment[];
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

// ---------------------------------------------------------------------------
// FR-14 の画像判定に使う `identifier → Attachment` 対応表(呼び出しごとに変わる)。
// ---------------------------------------------------------------------------

/**
 * 現在処理中のノートの `identifier → Attachment` 対応表(モジュールスコープの可変状態)。
 *
 * `markdownProcessor`(直下で1回だけ構築し `.freeze()` する。ハンドラ自体はステートレスに
 * 保つ設計)と、ノートごとに異なる `attachments`(`assetAwareAHandler` が FR-14 の画像判定に
 * 要る)とを両立させるための橋渡し。`transformBody` は非同期処理を含まない同期関数であり
 * (`markdownProcessor.runSync` 呼び出し中に他の JS コードが割り込むことは無い)、呼び出し
 * 直前にセットし、直後(例外発生時含め)に空へ戻すことで、複数ノートを跨いだ状態の混入を
 * 防ぐ(`transformBody` 本体の `try…finally` 参照)。
 *
 * 対応表の照合はキー(`identifier`)の完全一致(大文字小文字を区別する)。これは
 * `AssetUploader`(`assets/uploader.ts` の `processNoteBody` が `Attachment.identifier` から
 * 組み立てる `Map` )が行う照合と同じ規約であり、本モジュールもそれに合わせる
 * (プレースホルダの `identifier` は両モジュールで同一の文字列がそのまま流れるため)。
 */
let currentAttachmentByIdentifier: ReadonlyMap<string, Attachment> = new Map();

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
 * `data-apple-notes-zidentifier` を `<a>` 自身が直接持つ場合(img を伴わない添付参照。
 * 実機(Qiita 公開)で確認された実際の HTML 形)は、`currentAttachmentByIdentifier` で
 * 参照先の `Attachment` を引き、その拡張子(`attachment.path`)が画像かどうか
 * (`isImageExtension`)で分岐する(FR-14「添付は画像なら `![]()`、それ以外はリンク」。
 * **HTML の形(img を伴うか)ではなく添付の種別で決める**):
 *   - 画像 → アセットプレースホルダ画像(`![](…)`)。alt はリンクテキスト(前後空白は
 *     トリム。無ければ空文字。`assetAwareImgHandler` の `readAlt` の既定値と同じ)
 *   - 画像以外、または `identifier` に対応する `Attachment` が見つからない(未知の参照。
 *     `attachments` 未指定時を含む)→ 従来どおりアセットプレースホルダへのリンク
 *     (`[<リンクテキスト>](…)`。リンクテキストが空なら識別子自体をラベルにする)
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
      const attachment = currentAttachmentByIdentifier.get(directIdentifier);
      if (attachment !== undefined && isImageExtension(extname(attachment.path))) {
        const image: Image = {
          type: 'image',
          url: makeAssetPlaceholder(directIdentifier),
          title: null,
          alt: linkText,
        };
        return image;
      }
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
// コードフェンス認識(design.md §5.4、モジュール先頭 JSDoc「地の文として書かれた ```
// (コードフェンス)」を参照。hast→mdast 変換後・`remark-stringify` 直列化前の後処理)。
// ---------------------------------------------------------------------------

/** フェンス行(開始・言語トークン任意)のパターン。モジュール先頭 JSDoc の仕様を参照。 */
const FENCE_LINE_PATTERN = /^```([A-Za-z0-9_+#.-]*)$/;

/**
 * mdast ノードのプレーンテキストを、`break`(`<br>` 由来)を `\n` として保持したまま
 * 取り出す。`mdast-util-to-string` は `break` を(`value` も `children` も持たないため)
 * 空文字列にしてしまう(`node_modules/mdast-util-to-string/lib/index.js` で確認済み)ため、
 * フェンス内コンテンツが複数行の段落(`<br>` を含む)を含む場合に備えて本関数で代替する。
 * `mdast-util-to-string` 自身と同じダックタイピングで、`value` を持つノード(`text`/`code`/
 * `html` 等)はその値を、`children` を持つノードは子を連結した結果を返す。
 */
function textPreservingBreaks(node: unknown): string {
  if (typeof node !== 'object' || node === null || !('type' in node)) {
    return '';
  }
  const typed = node as { type: unknown; value?: unknown; children?: unknown };
  if (typed.type === 'break') {
    return '\n';
  }
  if (typeof typed.value === 'string') {
    return typed.value;
  }
  if (Array.isArray(typed.children)) {
    return typed.children.map((child) => textPreservingBreaks(child)).join('');
  }
  return '';
}

/**
 * `node` が「開始フェンス行」(段落1つの内容全体が `FENCE_LINE_PATTERN` に一致)かどうかを
 * 判定し、言語トークン(無ければ `''`)を返す。フェンス行でなければ `undefined`。
 */
function matchOpeningFenceLanguage(node: MdastRootContent): string | undefined {
  if (node.type !== 'paragraph') {
    return undefined;
  }
  const text = mdastToString(node).trim();
  const match = FENCE_LINE_PATTERN.exec(text);
  return match === null ? undefined : match[1];
}

/** `node` が「終端フェンス行」(段落1つの内容全体が言語トークン無しの ``` と完全一致)かどうか。 */
function isClosingFenceLine(node: MdastRootContent): boolean {
  return node.type === 'paragraph' && mdastToString(node).trim() === '```';
}

/**
 * mdast ルートのトップレベルの子を走査し、開始フェンス行〜終端フェンス行の区間を
 * 1つの `code` ノード(逐語。エスケープ無し)へ差し替える(design.md §5.4、モジュール
 * 先頭 JSDoc の仕様を参照。破壊的に `root.children` を書き換える)。
 *
 * - 対象はトップレベルの子のみ(リスト・引用の内部までは探索しない)。
 * - 開始フェンス行が見つかったら、その直後から探索し**最初に見つかった**終端フェンス行と
 *   対応させる。区間内の各ノードのプレーンテキスト(`textPreservingBreaks`)を `\n` で
 *   連結して `code` ノードの `value` にする(区間が空 = 開始の直後が終端 の場合は `''`)。
 * - 終端フェンス行が最後まで見つからない場合は、その開始フェンス行を含め何も変更しない
 *   (閉じ位置を推測しない。以降の走査は開始フェンス行の次のノードから続ける)。
 */
function recognizeCodeFences(root: MdastRoot): void {
  const children = root.children;
  const result: MdastRootContent[] = [];
  let index = 0;
  while (index < children.length) {
    const node = children[index];
    const lang = matchOpeningFenceLanguage(node);
    if (lang === undefined) {
      result.push(node);
      index += 1;
      continue;
    }

    let closingIndex = -1;
    for (let cursor = index + 1; cursor < children.length; cursor += 1) {
      if (isClosingFenceLine(children[cursor])) {
        closingIndex = cursor;
        break;
      }
    }

    if (closingIndex === -1) {
      result.push(node);
      index += 1;
      continue;
    }

    const value = children
      .slice(index + 1, closingIndex)
      .map((contentNode) => textPreservingBreaks(contentNode))
      .join('\n');
    const code: MdastCode = { type: 'code', lang: lang === '' ? null : lang, value };
    result.push(code);
    index = closingIndex + 1;
  }
  root.children = result;
}

// ---------------------------------------------------------------------------
// オートリンクの素の URL への展開(design.md §5.4。hast→mdast 変換後・
// `remark-stringify` 直列化前の後処理)。
// ---------------------------------------------------------------------------

/**
 * リンクテキストが URL そのものと完全一致する `link` ノード(Apple Notes で URL を
 * 貼り付けたときの `<a href="URL">URL</a>` が該当)を、素の URL テキストへ展開する。
 *
 * `remark-stringify`(`mdast-util-to-markdown`)は「単一の text 子が `url` と一致し
 * `title` を持たない `link`」をオートリンク `<URL>` として直列化するが、Zenn は
 * `<URL>` 形式をリンクカードとして扱わず、行全体が素の URL である場合にのみカード化する
 * (Qiita 等でも素の URL のオートリンク化で十分)。そのためこの形のリンクは
 * Markdown 上で素の URL テキストとして出力する(利用者リクエスト 2026-08-17)。
 *
 * 差し替え先は `text` ノードではなく `html` ノードにする: `text` だと
 * `remark-stringify` が URL 中の `_` 等を `\_` にエスケープし得るのに対し、`html`
 * ノードの `value` は逐語で出力されるため、URL がそのままの字面で本文に残る。
 * リンクテキストが URL と異なる通常のリンク(`[テキスト](URL)`)や `title` 付きリンクは
 * 対象外のまま変更しない。アセットプレースホルダ(`ASSET_PLACEHOLDER_PREFIX`)への参照も
 * **URL 前置一致で明示的に除外**する——通常はラベル ≠ URL(リンクテキストまたは識別子)
 * なので条件に掛からないが、万一ラベルがプレースホルダ URL と一致しても、
 * `makeAssetPlaceholder` の契約「プレースホルダは Markdown のリンク/画像 URL の位置に
 * のみ現れる」を守るためリンクのまま維持する(PR #80 CodeRabbit レビュー)。
 * mdast ツリー全体(段落・リスト・表・引用の内部を含む)を再帰的に走査する。
 */
function unwrapAutolinks(node: unknown): void {
  if (typeof node !== 'object' || node === null || !('children' in node)) {
    return;
  }
  const children = (node as { children: unknown }).children;
  if (!Array.isArray(children)) {
    return;
  }
  for (let index = 0; index < children.length; index += 1) {
    const child: unknown = children[index];
    if (typeof child !== 'object' || child === null) {
      continue;
    }
    const typed = child as Link;
    if (
      typed.type === 'link' &&
      (typed.title === null || typed.title === undefined) &&
      !typed.url.startsWith(ASSET_PLACEHOLDER_PREFIX) &&
      typed.children.length === 1 &&
      typed.children[0]?.type === 'text' &&
      typed.children[0].value === typed.url
    ) {
      children[index] = { type: 'html', value: typed.url };
      continue;
    }
    unwrapAutolinks(child);
  }
}

// ---------------------------------------------------------------------------
// インラインコード認識(design.md §5.4。hast→mdast 変換後・`remark-stringify`
// 直列化前の後処理。`recognizeCodeFences`(ブロック)のインライン版)。
// ---------------------------------------------------------------------------

/**
 * 「インラインコード区間」のパターン: バッククォート対に挟まれた、バッククォート・改行を
 * 含まない1文字以上の内容。改行を跨ぐ対は認識しない(`<br>` 区切りの各行は独立した段落に
 * なるため、通常のノートでは元々跨げない。同一 text ノード内の改行も跨がないことを
 * ここで明示する)。
 */
const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;

/**
 * ノート本文に地の文として書かれたインラインコード(`` `code` `` のバッククォート対)を、
 * 逐語の `inlineCode` ノードとして認識する(実機 Zenn/Qiita 公開で、`` `code` `` が
 * `` \`code\` `` とエスケープされてしまう不具合の修正。`recognizeCodeFences`(ブロックの
 * ```` ``` ```` フェンス)のインライン版)。
 *
 * mdast ツリー全体の `text` ノードを再帰的に走査し、`INLINE_CODE_PATTERN` に一致する
 * 区間を `inlineCode` ノードへ、その前後を `text` ノードへ分割して差し替える。
 *
 * - 対になっていないバッククォート(奇数個の余り)は `text` のまま残す(従来どおり
 *   `remark-stringify` が `` \` `` にエスケープする。対の位置を推測しない——
 *   `recognizeCodeFences` の「閉じフェンスを推測しない」方針と同じ)
 * - `inlineCode` の内容は完全に逐語(`remark-stringify` は `inlineCode` の内容を
 *   エスケープしない。内容にバッククォートは含まれ得ない——`INLINE_CODE_PATTERN` が
 *   除外している)
 * - `code`(コードフェンス認識後のブロック)・`inlineCode` は `children` を持たないため
 *   走査対象にならず、フェンス内容が二重に変換されることはない
 */
function recognizeInlineCode(node: unknown): void {
  if (typeof node !== 'object' || node === null || !('children' in node)) {
    return;
  }
  const children = (node as { children: unknown }).children;
  if (!Array.isArray(children)) {
    return;
  }
  for (let index = 0; index < children.length; index += 1) {
    const child: unknown = children[index];
    if (typeof child !== 'object' || child === null) {
      continue;
    }
    const typed = child as { type?: unknown; value?: unknown };
    if (typed.type !== 'text' || typeof typed.value !== 'string') {
      recognizeInlineCode(child);
      continue;
    }

    const value = typed.value;
    if (!value.includes('`')) {
      continue;
    }
    const replacements: Array<MdastText | InlineCode> = [];
    let lastIndex = 0;
    INLINE_CODE_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INLINE_CODE_PATTERN.exec(value)) !== null) {
      if (match.index > lastIndex) {
        replacements.push({ type: 'text', value: value.slice(lastIndex, match.index) });
      }
      replacements.push({ type: 'inlineCode', value: match[1] ?? '' });
      lastIndex = match.index + match[0].length;
    }
    if (replacements.length === 0) {
      // バッククォートはあるが対が無い(`INLINE_CODE_PATTERN` に一致しない)。
      continue;
    }
    if (lastIndex < value.length) {
      replacements.push({ type: 'text', value: value.slice(lastIndex) });
    }
    children.splice(index, 1, ...replacements);
    index += replacements.length - 1;
  }
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
 * 4. `rehype-remark`(チェックリスト・アセットプレースホルダのカスタムハンドラ付き)で
 *    mdast に変換する。この間、`attachments` を `assetAwareAHandler` から参照できるよう
 *    `currentAttachmentByIdentifier` に一時的にセットする(FR-14 の画像判定。手順末尾で
 *    必ず戻す)。
 * 5. 変換後の mdast に `recognizeCodeFences` を適用し、地の文として書かれたコードフェンス
 *    (```` ``` ````)の区間を逐語の `code` ノードへ差し替える(モジュール先頭 JSDoc 参照)。
 *    続けて `recognizeInlineCode` を適用し、地の文として書かれたインラインコード
 *    (`` `code` `` のバッククォート対)を逐語の `inlineCode` ノードへ差し替える。
 *    さらに `unwrapAutolinks` を適用し、リンクテキストが URL そのものであるリンク
 *    (オートリンク `<URL>` として直列化される形)を素の URL テキストへ展開する。
 * 6. `remark-gfm` + `remark-stringify` で Markdown 文字列に直列化する。
 *
 * 空の `bodyHtml`、または本文コンテナにタイトル行以外の内容が無い場合は
 * `{ markdown: '' }` を返す(エラーにしない。タイトル・メタデータの抽出可否は
 * `metadata.ts` の責務)。
 */
export function transformBody(options: TransformBodyOptions): TransformBodyResult {
  const { bodyHtml, attachments = [], logger, noteUuid, title } = options;

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

  // FR-14 の画像判定(`assetAwareAHandler`)向けに、この呼び出し分の対応表を一時的に
  // セットする(`currentAttachmentByIdentifier` の JSDoc 参照)。`AssetUploader`
  // (`assets/uploader.ts` の `processNoteBody`)と同じ、`identifier` の完全一致で照合する。
  currentAttachmentByIdentifier = new Map(
    attachments.map((attachment) => [attachment.identifier, attachment] as const),
  );
  let mdast: MdastRoot;
  try {
    mdast = markdownProcessor.runSync(scopedRoot) as MdastRoot;
  } finally {
    currentAttachmentByIdentifier = new Map();
  }

  recognizeCodeFences(mdast);
  recognizeInlineCode(mdast);
  unwrapAutolinks(mdast);

  const raw = String(markdownProcessor.stringify(mdast));
  const trimmed = raw.trim();
  const markdown = trimmed === '' ? '' : `${trimmed}\n`;

  return { markdown };
}
