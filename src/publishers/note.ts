/**
 * NotePublisher(issue #86。CodeRabbit 実装プラン承認済み)。
 *
 * issue #85 までの実装は note.com への配信を外部 CLI `noet` のサブプロセス実行に委ねていた
 * ため、`noet` バイナリの入手・`NOET_PATH` の設定・note.com にログイン済みの実 Chrome
 * ブラウザ + noet 拡張機能が同一マシン上で常時稼働していることが前提となり、完全な無人
 * (cron/launchd)実行が構造的に不可能だった(旧 `src/publishers/note.ts` 冒頭 JSDoc、
 * design.md §5.7 旧 NotePublisher 節参照)。issue #86 はこの `noet` 依存を全面撤去し、
 * 代わりに note.com の非公式 API を本モジュールから直接叩く。認証は note.com のセッション
 * cookie(`_note_session_v5`)を利用者が env ファイルへ手動設定する方式(NFR-03 の例外は
 * 撤廃——cookie が有効な限り完全に無人実行できる。失効時の手動再取得のみが残る例外)。
 *
 * **出典**: 「note非公式APIを徹底調査|2026年版エンドポイント一覧完全版」
 * (https://note.com/marie_222/n/n6a10366298b0、以下「元記事」)。wire contract の詳細は
 * `src/publishers/note-client.ts` の JSDoc、本文 HTML への変換は `src/publishers/note-html.ts`
 * の JSDoc を参照。本モジュールは両者を結線し、design.md §5.7 の `Publisher` インターフェース
 * (`publish(article, prev)`)を実装する。
 *
 * **作成・更新フロー(元記事)**:
 *   1. `prev?.remoteId` が無ければ `createDraft()`(`POST /api/v1/text_notes`、空ボディ)で
 *      数値 ID と note key(`n...`)を予約する。draft_save(下書き保存のみで公開しない操作)
 *      は意図的に使わない——issue #30/#85 以来、本ツールは常に公開状態で配信する契約
 *      (frontmatter/設定に下書き制御フィールドが無い)を踏襲する(Design Choice 2)。
 *   2. `prev?.remoteId` があれば、それを数値 ID としてそのまま使う。**この場合の note key は
 *      状態 JSON に保存されていない**(`NoteState` は `remoteId`/`url` のみを持つ)ため、
 *      `prev.url`(`https://note.com/<urlname>/n/<key>` 形式)の末尾セグメントから
 *      `deriveNoteKeyFromUrl` で再導出する——`slug`(500罠4)の組み立てに note key が要る
 *      ため。`prev.url` が無い・想定外の形式の場合は明確なエラーで当該ノートを failed に
 *      する(状態 JSON が壊れているか、旧バージョン(#85 以前)由来の互換性が無いエントリ)。
 *   3. 本文中の `note2web-asset://<identifier>` 画像プレースホルダ(`assets/uploader.ts` が
 *      note.com 向けには意図的に未解決のまま残す。同モジュール冒頭 JSDoc「note.com 向けの
 *      例外」参照)を列挙し、対応する添付ファイルを `note-client.ts` の `uploadImage` で
 *      1枚ずつアップロードして `<KEY>` を得る(identifier → key の対応表を組み立てる)。
 *   4. `note-html.ts` の `renderNoteBodyHtml` で本文 HTML(`free_body`)・`image_keys`
 *      (500罠1)・`body_length`(500罠3)を得る。
 *   5. `PUT /api/v1/text_notes/{id}` にフルペイロード(500罠1〜4を満たした形、下記
 *      `buildNotePublishPayload`)を送って公開/更新する。
 *   6. `getCurrentUser()`(`GET /api/v2/current_user`)で得た `urlname` と、上記の note key
 *      から記事 URL(`https://note.com/<urlname>/n/<key>`)を組み立てて返す。この呼び出しは
 *      Publisher インスタンスごとに1回だけ行い(`ensureUrlname` でキャッシュ)、認証チェック
 *      も兼ねる——1本目の `publish()` の最初に実行される。
 *
 * **応答不明時の重複防止**: 元記事は note.com の「自分の記事一覧」API を明らかにしていない
 * ため、dev.to/はてなのようなタイトル一致による既存記事の照合は行わない——Qiita
 * (`src/publishers/qiita.ts`)と同じ単純な契約: `prev.remoteId` の有無だけで更新/新規作成を
 * 振り分ける。POST(draft 予約・画像アップロードの presigned/S3)は自動リトライしない。
 * PUT(公開/更新)は同一内容の再送が冪等なので、接続系エラーに限り1回だけ再試行してよい
 * (`note-client.ts` の `publishNote` 参照)。
 *
 * **contentHash と画像の関係(design 判断の明記)**: `renderNoteArticle` は本文 Markdown を
 * **画像プレースホルダ未解決のまま** frontmatter 相当のエントリと連結してハッシュ化する
 * (dev.to/Qiita と同じ「変換済み本文 + title/tags のみをハッシュ対象にする」方針)。この
 * ため、Apple Notes 側で同じ添付 identifier のまま画像バイト列だけを差し替えても
 * `contentHash` は変わらず、本文・タイトル・タグが不変な限り次回実行は `skip` になる
 * ——画像だけの差し替えは自動では再配信されない。これは CodeRabbit 実装プランが明示的に
 * 選んだ設計(「contentHash stays stable across uploads」)であり、note.com 側の画像
 * アップロードのたびに `PUT` を再送してしまう(冪等性はあるが無駄なアップロードを繰り返す)
 * ことを避けるためのトレードオフとして受け入れる。画像だけを更新したい場合は、本文
 * (タイトル・タグ・テキスト)側にも変更を加えるか、状態 JSON の `contentHash` を手動で
 * 変更して強制再配信すること。
 *
 * **API モードのため `prepare`/`finalize` は実装しない**(`src/publishers/types.ts` 冒頭
 * JSDoc「API/CLI 系 Publisher はこの2メソッドを実装しなくてよい」)。
 */

import { extname, basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import {
  AssetUploadError,
  extractPlaceholderIdentifiers,
  resolveAttachmentAbsolutePath,
  resolveContentType,
} from '../assets/uploader.js';
import type { Attachment } from '../model/note.js';
import type { NoteState } from '../state/store.js';
import type { RenderNoteInput, NoteRenderer } from './render.js';
import type { Publisher, PublishResult, RenderedArticle } from './types.js';
import {
  computeContentHash,
  renderArtifact,
  type FrontmatterEntry,
} from '../transform/frontmatter.js';
import {
  createDraft,
  defaultNoteHttpClient,
  getCurrentUser,
  publishNote,
  uploadImage,
  type NoteHttpClient,
  type NotePublishPayload,
} from './note-client.js';
import { renderNoteBodyHtml } from './note-html.js';

export { NoteExternalImageError } from './note-html.js';
export { NoteAuthError } from './note-client.js';

// ---------------------------------------------------------------------------
// Renderer 本体。
// ---------------------------------------------------------------------------

/**
 * タグ先頭の `#` を1つだけ除去する(`src/publishers/zenn.ts`/`devto.ts` の
 * `stripLeadingHash` と同じ規約をミラーする)。
 */
function stripLeadingHash(tag: string): string {
  return tag.startsWith('#') ? tag.slice(1) : tag;
}

/**
 * note.com 向け `NoteRenderer`(issue #86)。dev.to(`renderDevtoArticle`)と同じ形——
 * `title`/`tags`(未加工。`#` 除去・hashtags への変換は配信時点(`publishOnce`)の責務、
 * モジュール冒頭 JSDoc「contentHash と画像の関係」参照)を frontmatter 相当のエントリとして
 * 含め、変換済み本文(画像プレースホルダ未解決のまま)と連結してハッシュ化する。API モード
 * のため `artifactPath` は設定しない。`bodyMarkdown`(本文そのもの)・`tags`(未加工)・
 * `attachments`/`assetSourceDir`(画像アップロード用、`src/publishers/types.ts` 参照)を
 * `RenderedArticle` の専用フィールドへそのまま渡す。
 *
 * 外部 URL(`http(s)://`)の画像参照の検証は本モジュールでは行わない——本文 HTML への変換
 * (`note-html.ts` の `renderNoteBodyHtml`)は配信時点(`publishOnce`)まで遅延しており、
 * その変換の中で `note2web-asset://` 以外の画像参照を検出した時点で `NoteExternalImageError`
 * を投げる(モジュール冒頭 JSDoc 参照)。
 */
export const renderNoteArticle: NoteRenderer = ({
  note,
  markdown,
  exportDir,
}: RenderNoteInput): RenderedArticle => {
  const entries: FrontmatterEntry[] = [
    ['title', note.title],
    ['tags', note.tags],
  ];
  const artifact = renderArtifact(entries, markdown);
  const contentHash = computeContentHash(artifact);

  return {
    noteUuid: note.uuid,
    title: note.title,
    artifact,
    contentHash,
    bodyMarkdown: markdown,
    tags: note.tags,
    attachments: note.attachments,
    assetSourceDir: exportDir,
  };
};

// ---------------------------------------------------------------------------
// hashtags の wire 形式(実機確認課題 (a)、`src/publishers/note-client.ts` 冒頭 JSDoc 参照)。
// ---------------------------------------------------------------------------

/**
 * hashtags の wire 形式の初期実装(実機確認課題 (a))。元記事はフィールド名 `hashtags` の
 * 存在のみを述べ、値の具体的な形までは示していない。`[{ name: "#タグ" }]`(各タグオブジェクト
 * が `#` 付きの名前を持つ)という形を初期実装として採用する——note.com 上でのハッシュタグ
 * 表示が `#` 付きであることからの推測。実機確認で異なる形が判明した場合、この関数だけを
 * 差し替えればよい。
 */
function buildNoteHashtags(tags: readonly string[]): { name: string }[] {
  return tags.map((tag) => ({ name: `#${stripLeadingHash(tag)}` }));
}

// ---------------------------------------------------------------------------
// note key の再導出(モジュール冒頭 JSDoc「作成・更新フロー」手順2 参照)。
// ---------------------------------------------------------------------------

/** note.com の記事 URL(`https://note.com/<urlname>/n/<key>`)から末尾の `<key>` を取り出す。 */
const NOTE_URL_KEY_PATTERN = /\/n\/([^/?#]+)/;

function deriveNoteKeyFromUrl(url: string | undefined, noteUuid: string): string {
  if (url === undefined) {
    throw new Error(
      `NotePublisher.publish: note "${noteUuid}" has a remoteId but no stored "url" in the state ` +
        'JSON; cannot re-derive the note key needed for the slug (note.com article URLs are ' +
        'https://note.com/<urlname>/n/<key>). This state entry looks incompatible or corrupted — ' +
        'resolve manually (e.g. set the correct url in the state JSON, or clear remoteId/url to ' +
        'force this note to be created as a new article).',
    );
  }
  const match = NOTE_URL_KEY_PATTERN.exec(url);
  const key = match?.[1];
  if (key === undefined || key === '') {
    throw new Error(
      `NotePublisher.publish: note "${noteUuid}" has a stored url (${JSON.stringify(url)}) that ` +
        'does not match the expected note.com article URL format (https://note.com/<urlname>/n/<key>); ' +
        'cannot re-derive the note key needed for the slug.',
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// 画像アップロード(モジュール冒頭 JSDoc「作成・更新フロー」手順3 参照)。
// ---------------------------------------------------------------------------

/**
 * note.com の presigned アップロード API が受け付ける画像拡張子(初期実装の保守的なガード)。
 * 元記事は具体的な受理フォーマットの一覧を示していないため、旧 `noet` 経由の実装
 * (`read_image_as_base64`)が対応していた集合をそのまま踏襲する——直接アップロードでは
 * この制約が技術的に必須ではない可能性があるが、明確なエラーで早期に失敗させる方を選ぶ
 * (実機確認で note.com が他形式も受け付けると判明すれば、この集合を広げるだけでよい)。
 */
const NOTE_SUPPORTED_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
]);

interface UploadArticleImagesParams {
  markdown: string;
  attachments: readonly Attachment[];
  assetSourceDir: string | undefined;
  noteUuid: string;
  cookie: string;
  httpClient: NoteHttpClient;
}

/**
 * 本文中の画像プレースホルダを列挙し、対応する添付ファイルを note.com へ1枚ずつアップロード
 * して `identifier → <KEY>` の対応表を作る(逐次実行。`assets/uploader.ts` が R2/S3 アップ
 * ロードを並列化しないのと同じ理由——アップロード先が1つの外部サービスであるため、
 * 並列化の必要性が薄く、エラー発生時の切り分けを単純に保つ)。プレースホルダが無ければ
 * ネットワーク呼び出し・ファイル I/O を一切行わない。
 */
async function uploadArticleImages(
  params: UploadArticleImagesParams,
): Promise<Map<string, string>> {
  const { markdown, attachments, assetSourceDir, noteUuid, cookie, httpClient } = params;
  const identifiers = extractPlaceholderIdentifiers(markdown);
  const imageKeyByIdentifier = new Map<string, string>();
  if (identifiers.length === 0) {
    return imageKeyByIdentifier;
  }
  if (assetSourceDir === undefined) {
    throw new Error(
      `internal error: NotePublisher.publish: note "${noteUuid}" references image placeholder(s) ` +
        'but RenderedArticle.assetSourceDir is unset; this indicates a wiring bug in the caller ' +
        '(renderNoteArticle/src/sync.ts) rather than a user-facing configuration error',
    );
  }

  const attachmentByIdentifier = new Map<string, Attachment>(
    attachments.map((attachment) => [attachment.identifier, attachment] as const),
  );

  for (const identifier of identifiers) {
    const attachment = attachmentByIdentifier.get(identifier);
    if (attachment === undefined) {
      throw new AssetUploadError(`no attachment found for placeholder identifier "${identifier}"`, {
        noteUuid,
        identifier,
      });
    }

    const ext = extname(attachment.path).toLowerCase();
    if (!NOTE_SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
      const supported = [...NOTE_SUPPORTED_IMAGE_EXTENSIONS].sort().join(', ');
      throw new AssetUploadError(
        `image attachment for identifier "${identifier}" has extension "${ext}", which note.com's ` +
          `presigned image upload is not known to accept (supported: ${supported}); remove or ` +
          'convert this image, or publish this note to a different service instead',
        { noteUuid, identifier },
      );
    }

    const absolutePath = await resolveAttachmentAbsolutePath(assetSourceDir, attachment, {
      noteUuid,
      identifier,
    });
    let bytes: Buffer;
    try {
      bytes = await readFile(absolutePath);
    } catch (error) {
      throw new AssetUploadError(
        `failed to read attachment file for identifier "${identifier}": ${absolutePath}`,
        { noteUuid, identifier, cause: error },
      );
    }

    const contentType = resolveContentType(ext);
    const uploaded = await uploadImage(
      httpClient,
      cookie,
      bytes,
      basename(attachment.path),
      contentType,
    );
    imageKeyByIdentifier.set(identifier, uploaded.key);
  }

  return imageKeyByIdentifier;
}

// ---------------------------------------------------------------------------
// 公開ペイロードの組み立て(500罠1〜4、モジュール冒頭 JSDoc・`note-client.ts` 冒頭 JSDoc 参照)。
// ---------------------------------------------------------------------------

function buildNotePublishPayload(params: {
  title: string;
  html: string;
  imageKeys: readonly string[];
  bodyLength: number;
  slug: string;
  hashtags: readonly { name: string }[];
}): NotePublishPayload {
  const { title, html, imageKeys, bodyLength, slug, hashtags } = params;
  return {
    status: 'published',
    name: title,
    free_body: html,
    pay_body: '',
    separator: '',
    price: 0,
    // 500罠4: slug は空にできない。既定 `slug-<note_key>`(元記事)。
    slug,
    // 500罠3: HTML 長ではなく可視テキストの Unicode コードポイント数。
    body_length: bodyLength,
    hashtags,
    // 500罠1: 本文中に現れた画像の key を出現順にすべて列挙する(空配列を渡さない)。
    image_keys: imageKeys,
    magazine_ids: [],
    magazine_keys: [],
    disable_comment: false,
    limited: false,
    is_refund: false,
    index: false,
    exclude_from_creator_top: false,
    exclude_ai_learning_reward: false,
    send_notifications_flag: false,
    author_ids: [],
    circle_permissions: [],
    discount_campaigns: [],
    // 500罠2: lead_form/line_add_friend は null にできない。
    lead_form: { is_active: false, consent_url: '' },
    line_add_friend: { is_active: false, keyword: '', add_friend_url: '' },
    line_add_friend_access_token: '',
    pro_coupon_keys: [],
  };
}

// ---------------------------------------------------------------------------
// Publisher 本体。
// ---------------------------------------------------------------------------

/** `createNotePublisher` のオプション。 */
export interface CreateNotePublisherOptions {
  /** 検証済み設定。`config.note` が必須(`src/config.ts` の `noteSchema` 参照)。 */
  config: Config;
  /** note.com API 呼び出しの注入点(テスト用)。既定は本物の `fetch`(`defaultNoteHttpClient`)。 */
  httpClient?: NoteHttpClient;
  /** ログ出力先(任意。現時点では note.com 固有の警告は無いが、他 Publisher との型の一貫性のため受け取る)。 */
  logger?: Logger;
  /** 環境変数の参照元(`note.session_cookie_env` の解決元、テスト用)。既定は `process.env`。 */
  env?: NodeJS.ProcessEnv;
}

/** design.md §7 の `note` ブロック(`session_cookie_env`)。 */
type NoteConfig = NonNullable<Config['note']>;

/**
 * `config.note` の存在を検証して返す(`src/publishers/qiita.ts` の `requireQiitaConfig` と
 * 同じ防御パターン)。
 */
function requireNoteConfig(config: Config): NoteConfig {
  if (config.note === undefined) {
    throw new Error(
      `internal error: createNotePublisher requires config.note (service "${config.service}" has none)`,
    );
  }
  return config.note;
}

/**
 * NotePublisher を実装する `Publisher` を作る(issue #86)。API モードのため `prepare`/
 * `finalize` は実装しない(モジュール冒頭 JSDoc)。
 *
 * `config.note` が未定義の場合は即座に例外を投げる(`requireNoteConfig`)。セッション cookie
 * は `publish()` 呼び出し時(HTTP リクエストの直前)に `env[config.note.session_cookie_env]`
 * から読む——未設定なら HTTP 呼び出しを一切行わずに例外を投げる。値そのものはログ・エラー
 * メッセージに一切含めない(FR-30)。
 *
 * `urlname`(`getCurrentUser()`)は Publisher インスタンスごとに1回だけ取得しキャッシュする
 * (モジュール冒頭 JSDoc「作成・更新フロー」手順6)。取得に失敗した場合はキャッシュを破棄し、
 * 次の `publish()` 呼び出しで再試行できるようにする。
 */
export function createNotePublisher(options: CreateNotePublisherOptions): Publisher {
  const { config, httpClient = defaultNoteHttpClient, env = process.env } = options;
  const noteConfig = requireNoteConfig(config);

  // urlname の per-インスタンスキャッシュ(モジュール冒頭 JSDoc参照)。認証チェックも兼ねる。
  let urlnamePromise: Promise<string> | null = null;
  function ensureUrlname(cookie: string): Promise<string> {
    if (urlnamePromise === null) {
      urlnamePromise = getCurrentUser(httpClient, cookie)
        .then((user) => user.urlname)
        .catch((error: unknown) => {
          // 失敗はキャッシュしない——次回の publish() で再試行できるようにする。
          urlnamePromise = null;
          throw error;
        });
    }
    return urlnamePromise;
  }

  // publish() の直列化チェーン(`createDevtoPublisher`/`createHatenaPublisher` と同じ
  // パターン)。urlname キャッシュの初期化・画像アップロードの競合を避けるため、全 publish
  // を構造的に直列化する。
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
    const cookie = env[noteConfig.session_cookie_env];
    if (cookie === undefined || cookie === '') {
      throw new Error(
        `NotePublisher.publish: environment variable "${noteConfig.session_cookie_env}" ` +
          '(note.session_cookie_env) is not set; cannot authenticate with note.com (FR-30). ' +
          'Set it to the value of the "_note_session_v5" cookie from a browser logged into note.com.',
      );
    }
    if (article.bodyMarkdown === undefined) {
      throw new Error(
        `NotePublisher.publish: note "${article.noteUuid}" has no bodyMarkdown ` +
          '(renderNoteArticle must set one)',
      );
    }

    // 認証チェックを兼ねた urlname の取得(モジュール冒頭 JSDoc「作成・更新フロー」手順6)。
    // 他の書き込みより前に行うことで、cookie が無効な場合に draft 予約・画像アップロード等の
    // 副作用を起こす前に失敗させる。
    const urlname = await ensureUrlname(cookie);

    let id: string;
    let key: string;
    let isUpdate: boolean;
    if (prev !== null && prev.remoteId !== null) {
      isUpdate = true;
      id = prev.remoteId;
      key = deriveNoteKeyFromUrl(prev.url, article.noteUuid);
    } else {
      isUpdate = false;
      const draft = await createDraft(httpClient, cookie);
      id = draft.id;
      key = draft.key;
    }

    const imageKeyByIdentifier = await uploadArticleImages({
      markdown: article.bodyMarkdown,
      attachments: article.attachments ?? [],
      assetSourceDir: article.assetSourceDir,
      noteUuid: article.noteUuid,
      cookie,
      httpClient,
    });

    const { html, imageKeys, bodyLength } = renderNoteBodyHtml(article.bodyMarkdown, {
      noteUuid: article.noteUuid,
      imageKeyByIdentifier,
    });

    const payload = buildNotePublishPayload({
      title: article.title,
      html,
      imageKeys,
      bodyLength,
      slug: `slug-${key}`,
      hashtags: buildNoteHashtags(article.tags ?? []),
    });

    await publishNote(httpClient, cookie, id, payload);

    return {
      result: isUpdate ? 'updated' : 'created',
      remoteId: id,
      url: `https://note.com/${urlname}/n/${key}`,
    };
  }

  return { publish };
}
