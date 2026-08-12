/**
 * HatenaPublisher(design.md §5.7「HatenaPublisher」・「応答不明時の重複防止」、§13-5、
 * FR-28/FR-30、T-23 / issue #28)。
 *
 * design.md §5.7 HatenaPublisher 節は AtomPub(FR-28)を定める:
 *
 *   - 新規: `POST <blog>/atom/entry`。更新: `PUT <blog>/atom/entry/<entry_id>`
 *     (`entry_id` は状態 JSON の `remoteId`)
 *   - `content type="text/x-markdown"` で Markdown 本文をそのまま入稿
 *   - `<category term="フォルダ名"/>`、タグもカテゴリとして `category` 要素で送る
 *   - 認証: Basic(はてな ID + API キー)。API キーは環境変数(既定 `HATENA_API_KEY`。
 *     実際の変数名は設定 `hatena.api_key_env`)
 *
 * §13-5 の実機確認注記どおり、`text/x-markdown` 入稿の一次資料はネットワーク制約で
 * 参照できなかった(§4 の調査結果表)。本実装は §5.7 の wire contract をそのまま実装し、
 * HTTP モック(`test/publishers/hatena.test.ts`)で検証する——実際のはてなブログへの
 * 入稿確認は §12/§13 に残る未実施項目のままである(design.md §13-5 参照)。
 *
 * 「応答不明時の重複防止」(design.md §5.7 共通節)は dev.to(`src/publishers/devto.ts`)と
 * 同じ規約に従う:
 *
 *   - HTTP タイムアウト30秒。**新規作成(POST)は自動リトライしない**。更新(PUT)は
 *     接続系エラーに限り1回だけ再試行してよい
 *   - `remoteId` の無いノートを新規作成する前に、コレクション URI の entry 一覧から
 *     タイトル一致で検索する
 *   - **ちょうど1件一致**のみその entry_id を採用し PUT(更新)。**0件**は POST(新規作成)。
 *     **複数一致**は誤った記事への紐付け・重複作成を避けるため failed とし状態を更新しない
 *
 * **AtomPub エントリ XML の具体的な形(design.md に明記の無い実装判断)**: design.md §5.7 は
 * `title`/`author`/`content type="text/x-markdown"`/`category` の4要素を送ることのみを
 * 定め、XML の具体的な直列化(要素順・インデント・名前空間の書き方)までは規定していない。
 * `src/transform/frontmatter.ts` が YAML について行っているのと同じ理由(ライブラリの
 * 既定シリアライズはバージョン・値の内容で結果が変わりうり、FR-15 の冪等判定=コンテンツ
 * ハッシュの安定性を壊す)により、本実装は依存無しの自前 XML シリアライザを持つ。
 * 生成規約は次のとおり固定する(`buildHatenaEntryXml`):
 *
 *   - `<?xml version="1.0" encoding="utf-8"?>` 宣言 → ルート `<entry
 *     xmlns="http://www.w3.org/2005/Atom">` → `title` → `author>name` → `content` →
 *     `category`(1個以上、`buildHatenaCategories` の順)の固定順
 *   - 2スペースインデント、各要素を1行に1つ。テキスト内容は `&` `<` `>` を、属性値は
 *     さらに `"` をエスケープする(CDATA は使わない——課題指示の「escaping (&, <, >, ")」
 *     どおり)
 *   - 連結後に `normalizeText`(`src/transform/normalize.ts`。LF 統一・NFC 正規化)を適用し、
 *     `renderArtifact`(`src/transform/frontmatter.ts`)と同じ正規化規約を踏襲する
 *
 * **`RenderedArticle.artifact` がそのまま POST/PUT のリクエストボディになる**:
 * Git モード/Qiita の `artifact` はファイルに書き出す内容だが、はてなは API モードで
 * ファイル出力を持たず、`artifact`(AtomPub `<entry>` XML そのもの)がそのまま HTTP
 * リクエストボディとして使える(`title`/`category`/`content` が既に XML に埋め込まれて
 * いるため)。dev.to の `bodyMarkdown`/`tags`(`RenderedArticle` の API モード専用
 * フィールド)は、はてなでは不要——`artifactPath` 同様 `undefined` のまま。
 *
 * **category の `#` 除去・重複排除(design.md §5.7 が明記していない部分の決定)**: `Note#tags`
 * は先頭 `#` を含めたまま保持される(design.md §5.3「差分」節、FR-07「そのまま」)。
 * design.md §5.7 のはてな行は `#` の扱いに触れていないが、`src/publishers/zenn.ts`・
 * `src/publishers/qiita.ts`・`src/publishers/devto.ts` の `stripLeadingHash` と同じ理由
 * ——ハッシュタグ記法ではなくプレーンな語であるべき——により、ここでも `#` を1つ除去する
 * (課題指示どおり)。除去後に空文字列になったタグ(`#` のみ等)は `category term=""`
 * という無意味な要素を送らないよう除外する。フォルダ名(常に1件目)とタグは
 * `dedupeTags`(`src/transform/metadata.ts`。ハッシュタグ抽出の重複排除と同じユーティリティ)
 * で、フォルダ・タグを通した1つの列として重複排除する——「フォルダ名と同名のタグ」や
 * 「重複するタグ」がはてな側に同じ `category term` を2回送ることにならないようにするため
 * (順序は保持: フォルダが常に先頭)。
 *
 * **entry_id の抽出(design.md §5.7「応答不明時の重複防止」、課題指示「per qiita.ts precedent」)**:
 * POST 成功時、`Location` レスポンスヘッダ → 無ければレスポンスボディの
 * `<link rel="edit" href="…/atom/entry/<id>">` の順で entry_id を取り出す。Atom の
 * `<id>` 要素(`tag:blog.hatena.ne.jp,2013:blog-…-entry-…` の Tag URI 形式)は URL の
 * 末尾セグメントとして entry_id を持たないため使わない。どちらからも取り出せない場合は
 * (`src/publishers/qiita.ts` の `extractQiitaId` が `id` 未書き戻しを failed 扱いにする
 * のと同じ理由で)例外を投げる——ここで `created` として状態を確定してしまうと、
 * `remoteId` が保存されないまま次回実行が同じ記事を再度 POST しかねないため。
 * PUT(更新)では entry_id は呼び出し前から判明している(`prev.remoteId` または
 * タイトル一致で採用した id)ため、レスポンスからの抽出は行わない。
 *
 * **`PublishResult.url` の組み立て(design.md §5.7 が明記していない部分の決定)**:
 * レスポンスボディに `<link rel="alternate" href="…">` があればそれをそのまま使う
 * (はてなの AtomPub レスポンスは通常この形で記事の公開 URL を返す)。無い場合は
 * `https://<blog_id>/entry/<entry_id>`(はてなブログの既定の記事 URL パス規約)を
 * 組み立てる。`src/publishers/qiita.ts` が `https://qiita.com/items/${remoteId}` を
 * 機械的に導出しているのと同じ、design.md に明記の無い実装判断。
 *
 * **接続系エラーの判定・リトライ実装は `src/publishers/devto.ts` をそのままミラーする**
 * (課題指示「reuse the RETRYABLE_ERRNO_CODES/TypeError/AbortError approach」「otherwise
 * mirror locally with a comment」)。共有モジュールへ切り出すと dev.to 側の既存の型
 * (`DevtoHttpClient` 等)まで巻き込んだ広い変更になるため、本タスクの範囲としては
 * ローカルに複製する側を選んだ(挙動は完全に同一)。
 *
 * **HTTP クライアントの注入・タイムアウト・per-run キャッシュ・publish() の直列化**は
 * `src/publishers/devto.ts` と同じパターン(同ファイル冒頭 JSDoc 参照)。
 *
 * **API/CLI モードのため `prepare`/`finalize` は実装しない**(`src/publishers/types.ts`
 * 冒頭 JSDoc、`src/publishers/qiita.ts`/`devto.ts` と同じ方針)。
 */

import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { NoteState } from '../state/store.js';
import { computeContentHash } from '../transform/frontmatter.js';
import { normalizeText } from '../transform/normalize.js';
import { dedupeTags } from '../transform/metadata.js';
import type { RenderNoteInput, NoteRenderer } from './render.js';
import type { Publisher, PublishResult, RenderedArticle } from './types.js';

// ---------------------------------------------------------------------------
// XML エスケープ・アンエスケープ(モジュール冒頭 JSDoc「AtomPub エントリ XML の
// 具体的な形」参照)。
// ---------------------------------------------------------------------------

/** テキストノード用のエスケープ(`&` `<` `>` のみ。課題指示どおり `"` は含めない)。 */
function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 属性値用のエスケープ(テキスト用に加えて `"` もエスケープ)。 */
function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;');
}

/**
 * XML の名前付きエンティティを元の文字へ戻す(はてな側のレスポンス XML を読むためだけの
 * 最小限の実装。数値文字参照(`&#…;`)は本実装が生成する側では使わないため対応しない)。
 * `&amp;` は最後に戻す(先に戻すと `&amp;lt;` のような二重エスケープされた値を誤って
 * `<` に変換してしまう)。
 */
function unescapeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// category(フォルダ + タグ)の組み立て(モジュール冒頭 JSDoc「category の `#` 除去・
// 重複排除」参照)。
// ---------------------------------------------------------------------------

/**
 * タグ先頭の `#` を1つだけ除去する(`src/publishers/zenn.ts`/`qiita.ts`/`devto.ts` の
 * `stripLeadingHash` と同じ規約をミラーする)。
 */
function stripLeadingHash(tag: string): string {
  return tag.startsWith('#') ? tag.slice(1) : tag;
}

/**
 * `<category term="…">` に列挙する値を組み立てる: フォルダ名(常に先頭・1件)+
 * `#` を除去したタグ(除去後に空文字列になったものは除外)。フォルダとタグを通した
 * 1つの列として `dedupeTags`(`src/transform/metadata.ts`)で重複排除する(順序保持)。
 */
function buildHatenaCategories(folder: string, tags: readonly string[]): string[] {
  const strippedTags = tags.map(stripLeadingHash).filter((tag) => tag.length > 0);
  return dedupeTags([folder, ...strippedTags]);
}

// ---------------------------------------------------------------------------
// AtomPub エントリ XML の組み立て。
// ---------------------------------------------------------------------------

/** `buildHatenaEntryXml` の入力。 */
interface HatenaEntryXmlInput {
  title: string;
  authorName: string;
  markdown: string;
  categories: readonly string[];
}

/**
 * AtomPub `<entry>` XML を組み立てる(design.md §5.7 wire contract、モジュール冒頭 JSDoc
 * 「AtomPub エントリ XML の具体的な形」の固定規約どおり)。`categories` は1件以上を前提とする
 * (`renderHatenaArticle` は常にフォルダ名を含む列を渡すため空にはならない)。
 */
function buildHatenaEntryXml(input: HatenaEntryXmlInput): string {
  const { title, authorName, markdown, categories } = input;
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<entry xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${escapeXmlText(title)}</title>`,
    '  <author>',
    `    <name>${escapeXmlText(authorName)}</name>`,
    '  </author>',
    `  <content type="text/x-markdown">${escapeXmlText(markdown)}</content>`,
    ...categories.map((term) => `  <category term="${escapeXmlAttr(term)}"/>`),
    '</entry>',
    '',
  ];
  return normalizeText(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Renderer 本体。
// ---------------------------------------------------------------------------

/** design.md §7 の `hatena` ブロック(`hatena_id`/`blog_id`/`api_key_env`)。 */
type HatenaConfig = NonNullable<Config['hatena']>;

/**
 * `config.hatena` の存在を検証して返す(`src/publishers/qiita.ts` の `requireQiitaConfig` と
 * 同じ防御パターン。Renderer・Publisher の両方から呼ばれる)。
 */
function requireHatenaConfig(config: Config): HatenaConfig {
  if (config.hatena === undefined) {
    throw new Error(
      `internal error: HatenaPublisher requires config.hatena (service "${config.service}" has none)`,
    );
  }
  return config.hatena;
}

/**
 * はてなブログ向け `NoteRenderer`(design.md §5.7 HatenaPublisher 行、FR-28、T-23)。
 * `RenderedArticle.artifact` は「frontmatter + 本文」ではなく AtomPub `<entry>` XML
 * そのもの(モジュール冒頭 JSDoc「`RenderedArticle.artifact` がそのまま POST/PUT の
 * リクエストボディになる」参照)。`<author><name>` には `config.hatena.hatena_id` を使う
 * ため(`renderHugoArticle` が `config.git` を参照するのと同じ理由で)`config` を参照する。
 */
export const renderHatenaArticle: NoteRenderer = ({
  note,
  markdown,
  config,
}: RenderNoteInput): RenderedArticle => {
  const hatenaConfig = requireHatenaConfig(config);
  const categories = buildHatenaCategories(note.folder, note.tags);
  const artifact = buildHatenaEntryXml({
    title: note.title,
    authorName: hatenaConfig.hatena_id,
    markdown,
    categories,
  });
  const contentHash = computeContentHash(artifact);

  return { noteUuid: note.uuid, title: note.title, artifact, contentHash };
};

// ---------------------------------------------------------------------------
// HTTP クライアントの注入点(`src/publishers/devto.ts` の `DevtoHttpClient` と同じ
// 注入パターン。モジュール冒頭 JSDoc 参照)。
// ---------------------------------------------------------------------------

/** はてな AtomPub へのリクエスト1件。 */
export interface HatenaHttpRequest {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * はてな AtomPub のレスポンス。`headers` はキー小文字化済み(`fetch` の
 * `Headers#entries()` と同じ規約)で、少なくとも POST 応答の `location` を含みうる
 * (entry_id 抽出に必要。モジュール冒頭 JSDoc「entry_id の抽出」参照)。
 */
export interface HatenaHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** はてな AtomPub 呼び出しの注入点(テスト用)。既定は本物の `fetch`(`defaultHatenaHttpClient`)。 */
export type HatenaHttpClient = (request: HatenaHttpRequest) => Promise<HatenaHttpResponse>;

/** HTTP タイムアウト(design.md §5.7「応答不明時の重複防止」: HTTP はタイムアウト30秒)。 */
export const HATENA_HTTP_TIMEOUT_MS = 30_000;

/** AtomPub エントリのリクエスト Content-Type(design.md §5.7 の wire contract)。 */
const HATENA_ENTRY_CONTENT_TYPE = 'application/atom+xml;type=entry';

/**
 * 既定の `HatenaHttpClient`。グローバル `fetch`(Node 20+ 標準搭載)を
 * `AbortSignal.timeout(HATENA_HTTP_TIMEOUT_MS)` 付きで呼ぶ。`fetch` 自体が接続失敗で
 * 投げる例外はそのまま呼び出し元へ伝播させる(`isRetryableConnectionError` が判定に使う)。
 */
const defaultHatenaHttpClient: HatenaHttpClient = async ({
  method,
  url,
  headers,
  body,
}: HatenaHttpRequest): Promise<HatenaHttpResponse> => {
  const response = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(HATENA_HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  return { status: response.status, headers: responseHeaders, body: text };
};

// ---------------------------------------------------------------------------
// 接続系エラーの判定(`src/publishers/devto.ts` のミラー。モジュール冒頭 JSDoc参照)。
// ---------------------------------------------------------------------------

/** Node の `NodeJS.ErrnoException`(`code` を持つ)かどうかの型ガード(`src/lock.ts` と同じ)。 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * errno 系エラーのうち、接続レイヤの一時的失敗としてリトライしてよいコードの許可リスト
 * (`src/publishers/devto.ts` の `RETRYABLE_ERRNO_CODES` と同一)。
 */
const RETRYABLE_ERRNO_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
]);

/**
 * 接続系エラー(タイムアウト・DNS 失敗・接続拒否等)かどうかを判定する。HTTP ステータスに
 * よる失敗はここに含めない(`assertOk` が別途、リトライしないエラーとして投げる)。
 */
function isRetryableConnectionError(error: unknown): boolean {
  if (error instanceof TypeError) {
    return true;
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return true;
  }
  return (
    isErrnoException(error) && error.code !== undefined && RETRYABLE_ERRNO_CODES.has(error.code)
  );
}

/** エラーからログ/例外メッセージ用の文字列を取り出す(`src/sync.ts` の `errorMessage` と同じ形)。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// レスポンス XML の軽量パース(collection の title 一致検索・`rel="next"` ページング・
// entry_id/URL 抽出に使う。モジュール冒頭 JSDoc 参照)。
// ---------------------------------------------------------------------------

/** `<link ...>` タグ1個分の属性を、出現順に関わらず `name="value"` のペアとして取り出す。 */
function parseTagAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([a-zA-Z:_-]+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(attrString)) !== null) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) {
      attrs[name] = value;
    }
  }
  return attrs;
}

/**
 * `xml` に含まれる `<link>` 要素のうち `rel` が一致するものの `href` を出現順に列挙する
 * (Atom の `link` は空要素——`rel="edit"`/`rel="alternate"`/`rel="next"` の抽出に使う)。
 */
function parseLinkHrefs(xml: string, rel: string): string[] {
  const hrefs: string[] = [];
  const linkTagPattern = /<link\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = linkTagPattern.exec(xml)) !== null) {
    const attrs = parseTagAttributes(match[1] ?? '');
    if (attrs.rel === rel && attrs.href !== undefined) {
      hrefs.push(unescapeXmlText(attrs.href));
    }
  }
  return hrefs;
}

/**
 * URL の末尾パスセグメントを entry_id として取り出す(はてなの entry_id は
 * `…/atom/entry/<entry_id>` の末尾)。絶対 URL として解析できない場合は素朴な `/` 分割に
 * フォールバックする(テスト用のダミー URL 等、`new URL` が失敗しうる入力への防御)。
 */
function entryIdFromUrl(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  return segments[segments.length - 1];
}

/** ヘッダ名を大文字小文字を区別せずに引く(`HatenaHttpResponse.headers` はテスト由来では大文字小文字が揃うとは限らない)。 */
function getHeaderCaseInsensitive(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }
  return undefined;
}

/** コレクション一覧(`GET .../atom/entry`)の1エントリ分(タイトル一致検索用の最小限の形)。 */
interface HatenaListedEntry {
  id: string;
  title: string;
}

/**
 * `<feed>` レスポンスボディから `<entry>` を1件ずつ切り出し、`title`/entry_id(`<link
 * rel="edit">` の href 末尾)を取り出す(design.md §5.7「コレクション URI の entry 一覧から
 * タイトル一致で検索」の下ごしらえ)。
 */
function extractEntries(feedXml: string, description: string): HatenaListedEntry[] {
  const blocks = feedXml.match(/<entry\b[^>]*>[\s\S]*?<\/entry>/g) ?? [];
  return blocks.map((block) => {
    const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/.exec(block);
    if (titleMatch?.[1] === undefined) {
      throw new Error(`HatenaPublisher: ${description}: an <entry> is missing a <title>`);
    }
    const title = unescapeXmlText(titleMatch[1]);
    const editHref = parseLinkHrefs(block, 'edit')[0];
    if (editHref === undefined) {
      throw new Error(
        `HatenaPublisher: ${description}: an <entry> titled ${JSON.stringify(title)} is missing ` +
          'a <link rel="edit"> (needed to derive its entry_id)',
      );
    }
    const id = entryIdFromUrl(editHref);
    if (id === undefined) {
      throw new Error(
        `HatenaPublisher: ${description}: could not derive an entry_id from the <link rel="edit"> ` +
          `href (${JSON.stringify(editHref)}) of the entry titled ${JSON.stringify(title)}`,
      );
    }
    return { id, title };
  });
}

/**
 * レスポンスボディの `<link rel="alternate">` から公開 URL を取り出す。無ければ
 * `https://<blog_id>/entry/<entry_id>` を組み立てる(モジュール冒頭 JSDoc「`PublishResult.url`
 * の組み立て」参照)。
 */
function extractResultUrl(body: string, blogId: string, entryId: string): string {
  const alternate = parseLinkHrefs(body, 'alternate')[0];
  if (alternate !== undefined && alternate !== '') {
    return alternate;
  }
  return `https://${blogId}/entry/${entryId}`;
}

/**
 * POST 応答から entry_id を取り出す(`Location` ヘッダ優先 → `<link rel="edit">`
 * フォールバック。モジュール冒頭 JSDoc「entry_id の抽出」参照)。どちらからも取り出せない
 * 場合は例外を投げる(design.md §5.7「応答不明時の重複防止」を守るため——`remoteId` の
 * 無い `created` を返してしまうと次回実行が重複 POST しかねない)。
 */
function extractCreatedEntryId(response: HatenaHttpResponse, noteUuid: string): string {
  const location = getHeaderCaseInsensitive(response.headers, 'location');
  if (location !== undefined && location !== '') {
    const id = entryIdFromUrl(location);
    if (id !== undefined) {
      return id;
    }
  }
  const editHref = parseLinkHrefs(response.body, 'edit')[0];
  if (editHref !== undefined) {
    const id = entryIdFromUrl(editHref);
    if (id !== undefined) {
      return id;
    }
  }
  throw new Error(
    `HatenaPublisher.publish: could not extract an entry_id for note "${noteUuid}" from the POST ` +
      'response (checked the "Location" header and <link rel="edit"> in the body; design.md §5.7 ' +
      '"応答不明時の重複防止" — refusing to record this as created without an id, to avoid a ' +
      'duplicate POST next run)',
  );
}

/**
 * 2xx 以外のレスポンスを、トークンを含めない説明的なエラーとして投げる
 * (`src/publishers/devto.ts` の `assertOk` と同じ形)。ボディはログ肥大化・機微情報の
 * 意図しない露出を避けるため500文字で打ち切る。
 */
function assertOk(response: HatenaHttpResponse, description: string): void {
  if (response.status >= 200 && response.status < 300) {
    return;
  }
  const truncatedBody =
    response.body.length > 500 ? `${response.body.slice(0, 500)}…` : response.body;
  throw new Error(
    `HatenaPublisher: ${description} failed with HTTP ${String(response.status)}: ${truncatedBody}`,
  );
}

/**
 * `rel="next"`(design.md §4「Hatena AtomPub のページングは `<link rel="next">` を辿る」
 * 相当。§13-5 の調査結果表)を辿ってコレクション全体の entry 一覧を取得する
 * (design.md §5.7「コレクション URI の entry 一覧からタイトル一致で検索」)。終了条件は
 * `rel="next"` リンクが無くなった時点(dev.to の「空ページが返るまで」に相当する、
 * はてな AtomPub 版の終了判定)。
 */
/**
 * `fetchAllEntries` のページ数上限。はてなの1ページは約10件のため、上限 1000 ページ ≒
 * 10,000 記事まで走査できる。サーバ応答の異常(`rel="next"` の循環・自己参照)による
 * 無限ループを防ぐための安全弁で、通常運用で到達することはない。
 */
const HATENA_MAX_LIST_PAGES = 1000;

async function fetchAllEntries(
  client: HatenaHttpClient,
  headers: Record<string, string>,
  collectionUri: string,
): Promise<HatenaListedEntry[]> {
  const items: HatenaListedEntry[] = [];
  const visited = new Set<string>();
  let url: string | undefined = collectionUri;
  while (url !== undefined) {
    // サーバ応答の異常(rel="next" の循環)や過大なコレクションで無限ループしないよう、
    // 訪問済み URL とページ数上限で打ち切る。打ち切りは照合漏れ(重複 POST の危険)に
    // つながるため、静かに続行せずエラーにして安全側へ倒す。
    if (visited.has(url)) {
      throw new Error(
        `HatenaPublisher: circular rel="next" pagination detected at ${url} (title-match recovery aborted)`,
      );
    }
    if (visited.size >= HATENA_MAX_LIST_PAGES) {
      throw new Error(
        `HatenaPublisher: collection listing exceeded ${String(HATENA_MAX_LIST_PAGES)} pages (title-match recovery aborted)`,
      );
    }
    visited.add(url);
    const response = await client({ method: 'GET', url, headers });
    assertOk(response, 'GET .../atom/entry (title-match recovery)');
    items.push(...extractEntries(response.body, 'GET .../atom/entry (title-match recovery)'));
    url = parseLinkHrefs(response.body, 'next')[0];
  }
  return items;
}

// ---------------------------------------------------------------------------
// POST/PUT の送信(リトライ規約。モジュール冒頭 JSDoc参照)。
// ---------------------------------------------------------------------------

/** `POST .../atom/entry` を送る。design.md §5.7「新規作成(POST)は自動リトライしない」。 */
async function sendCreate(params: {
  client: HatenaHttpClient;
  url: string;
  headers: Record<string, string>;
  body: string;
  noteUuid: string;
}): Promise<HatenaHttpResponse> {
  const { client, url, headers, body, noteUuid } = params;
  try {
    return await client({ method: 'POST', url, headers, body });
  } catch (error) {
    throw new Error(
      `HatenaPublisher: POST request to the AtomPub collection failed for note "${noteUuid}" ` +
        `(connection-layer failure, design.md §5.7): ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

/**
 * `PUT .../atom/entry/{entry_id}` を送る。接続系エラー(`isRetryableConnectionError`)に
 * 限り1回だけ再送する(design.md §5.7「応答不明時の重複防止」)。HTTP ステータスによる
 * 失敗(`httpClient` が正常に応答を返した場合)はここでは扱わない——呼び出し元の
 * `assertOk` がリトライせずエラーを投げる。
 */
async function sendUpdate(params: {
  client: HatenaHttpClient;
  url: string;
  headers: Record<string, string>;
  body: string;
  noteUuid: string;
}): Promise<HatenaHttpResponse> {
  const { client, url, headers, body, noteUuid } = params;
  const request: HatenaHttpRequest = { method: 'PUT', url, headers, body };
  try {
    return await client(request);
  } catch (error) {
    if (!isRetryableConnectionError(error)) {
      throw new Error(
        `HatenaPublisher: PUT request to the AtomPub member resource failed for note "${noteUuid}" ` +
          `(connection-layer failure, design.md §5.7): ${errorMessage(error)}`,
        { cause: error },
      );
    }
    try {
      return await client(request);
    } catch (retryError) {
      throw new Error(
        `HatenaPublisher: PUT request to the AtomPub member resource failed for note "${noteUuid}" ` +
          `even after 1 retry (connection-layer failure, design.md §5.7): ${errorMessage(retryError)}`,
        { cause: retryError },
      );
    }
  }
}

/** `sendUpdate` を実行し、レスポンスを検証して `PublishResult`(`result: 'updated'`)に変換する。 */
async function putEntry(params: {
  client: HatenaHttpClient;
  headers: Record<string, string>;
  collectionUri: string;
  entryId: string;
  body: string;
  noteUuid: string;
  blogId: string;
}): Promise<PublishResult> {
  const { client, headers, collectionUri, entryId, body, noteUuid, blogId } = params;
  const response = await sendUpdate({
    client,
    url: `${collectionUri}/${entryId}`,
    headers,
    body,
    noteUuid,
  });
  assertOk(response, 'PUT .../atom/entry/{entry_id}');
  return {
    result: 'updated',
    remoteId: entryId,
    url: extractResultUrl(response.body, blogId, entryId),
  };
}

// ---------------------------------------------------------------------------
// Publisher 本体。
// ---------------------------------------------------------------------------

/** `createHatenaPublisher` のオプション。 */
export interface CreateHatenaPublisherOptions {
  /** 検証済み設定。`config.hatena` が必須(`src/config.ts` の `hatenaSchema` 参照)。 */
  config: Config;
  /** はてな AtomPub 呼び出しの注入点(テスト用)。既定は本物の `fetch`(`defaultHatenaHttpClient`)。 */
  client?: HatenaHttpClient;
  /** ログ出力先(任意)。複数一致時の警告に使う。 */
  logger?: Logger;
  /** 環境変数の参照元(`hatena.api_key_env` の解決元、テスト用)。既定は `process.env`。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * 複数一致(応答不明時の重複防止の照合で2件以上ヒット)を表す(design.md §5.7「複数一致の場合は
 * …そのノートを failed とし状態を更新しない」)。`src/sync.ts` の `processNote` がこの例外を
 * 捕捉し、当該ノートのみを `'failed'` として隔離する(`DevtoAmbiguousTitleMatchError` と
 * 同じパターン)。
 */
export class HatenaAmbiguousTitleMatchError extends Error {
  /** 検証に失敗したノートの UUID。 */
  readonly noteUuid: string;
  /** 一致したはてな記事の件数(常に2以上)。 */
  readonly matchCount: number;

  constructor(noteUuid: string, title: string, matchCount: number) {
    super(
      `HatenaPublisher.publish: found ${String(matchCount)} existing entries with a title exactly ` +
        `matching note "${noteUuid}" (${JSON.stringify(title)}); refusing to guess which one ` +
        'corresponds to this note (design.md §5.7 "応答不明時の重複防止": 複数一致は failed とし ' +
        '状態を更新しない — manual resolution required)',
    );
    this.name = 'HatenaAmbiguousTitleMatchError';
    this.noteUuid = noteUuid;
    this.matchCount = matchCount;
  }
}

/**
 * design.md §5.7 HatenaPublisher を実装する `Publisher` を作る(T-23 / issue #28)。
 * API モードのため `prepare`/`finalize` は実装しない(モジュール冒頭 JSDoc)。
 *
 * `config.hatena` が未定義の場合は即座に例外を投げる(`requireHatenaConfig`)。API キーは
 * `publish()` 呼び出し時(HTTP リクエストの直前)に `env[config.hatena.api_key_env]` から
 * 読む——未設定なら HTTP 呼び出しを一切行わずに例外を投げる。値そのものはログ・エラー
 * メッセージに一切含めない(FR-30)。
 */
export function createHatenaPublisher(options: CreateHatenaPublisherOptions): Publisher {
  const { config, client = defaultHatenaHttpClient, logger, env = process.env } = options;
  const hatenaConfig = requireHatenaConfig(config);
  const collectionUri = `https://blog.hatena.ne.jp/${hatenaConfig.hatena_id}/${hatenaConfig.blog_id}/atom/entry`;

  // 同一実行内での entry 一覧のキャッシュ(`src/publishers/devto.ts` の `articleListCache`
  // と同じ理由・同じ形)。新規作成(POST)成功時はキャッシュへ追記する。
  let collectionCache: HatenaListedEntry[] | null = null;

  // publish() の直列化チェーン(`src/publishers/devto.ts` の `publishChain` と同じ理由:
  // 並行呼び出しでキャッシュ未初期化を同時観測して同名記事を二重 POST する競合を防ぐ)。
  let publishChain: Promise<unknown> = Promise.resolve();

  function publish(article: RenderedArticle, prev: NoteState | null): Promise<PublishResult> {
    const run = publishChain.then(() => publishOnce(article, prev));
    publishChain = run.catch(() => undefined);
    return run;
  }

  async function publishOnce(
    article: RenderedArticle,
    prev: NoteState | null,
  ): Promise<PublishResult> {
    const apiKey = env[hatenaConfig.api_key_env];
    if (apiKey === undefined || apiKey === '') {
      throw new Error(
        `HatenaPublisher.publish: environment variable "${hatenaConfig.api_key_env}" ` +
          '(hatena.api_key_env) is not set; cannot authenticate with the AtomPub endpoint ' +
          '(design.md §5.7, FR-30)',
      );
    }

    // design.md §5.7「認証: Basic(はてな ID + API キー)」。
    const authHeader = `Basic ${Buffer.from(`${hatenaConfig.hatena_id}:${apiKey}`).toString('base64')}`;
    const headers: Record<string, string> = {
      Authorization: authHeader,
      'Content-Type': HATENA_ENTRY_CONTENT_TYPE,
    };

    // design.md §5.7「remoteId の無いノートを新規作成する前に、既存記事の照合を行う」——
    // 逆に言えば remoteId があれば照合不要でそのまま更新してよい。
    if (prev !== null && prev.remoteId !== null) {
      return await putEntry({
        client,
        headers,
        collectionUri,
        entryId: prev.remoteId,
        body: article.artifact,
        noteUuid: article.noteUuid,
        blogId: hatenaConfig.blog_id,
      });
    }

    // design.md §5.7「ちょうど1件一致した場合のみその ID を remoteId に採用し、更新として
    // 配信する。0件なら記事は未作成と判断して新規作成する。複数一致の場合は…failed」。
    collectionCache ??= await fetchAllEntries(client, headers, collectionUri);
    const matches = collectionCache.filter((item) => item.title === article.title);

    if (matches.length === 1) {
      const match = matches[0];
      if (match === undefined) {
        throw new Error('internal error: matches.length === 1 but matches[0] is undefined');
      }
      return await putEntry({
        client,
        headers,
        collectionUri,
        entryId: match.id,
        body: article.artifact,
        noteUuid: article.noteUuid,
        blogId: hatenaConfig.blog_id,
      });
    }

    if (matches.length >= 2) {
      logger?.warn({
        service: 'hatena',
        noteUuid: article.noteUuid,
        title: article.title,
        message:
          `found ${String(matches.length)} existing entries with a title exactly matching this ` +
          'note (GET .../atom/entry); refusing to guess which one corresponds to this note — ' +
          'resolve manually (design.md §5.7 "応答不明時の重複防止")',
      });
      throw new HatenaAmbiguousTitleMatchError(article.noteUuid, article.title, matches.length);
    }

    // 0件: 新規作成。POST は自動リトライしない(design.md §5.7「新規作成(POST)は自動
    // リトライしない」——重複記事を作らないため)。
    const response = await sendCreate({
      client,
      url: collectionUri,
      headers,
      body: article.artifact,
      noteUuid: article.noteUuid,
    });
    assertOk(response, 'POST .../atom/entry');
    const entryId = extractCreatedEntryId(response, article.noteUuid);
    // 作成成功をキャッシュに反映し、同一実行内の後続ノートの照合で「既に作成済み」と
    // 判定できるようにする(重複作成防止。`src/publishers/devto.ts` と同じ)。
    collectionCache.push({ id: entryId, title: article.title });
    return {
      result: 'created',
      remoteId: entryId,
      url: extractResultUrl(response.body, hatenaConfig.blog_id, entryId),
    };
  }

  return { publish };
}
