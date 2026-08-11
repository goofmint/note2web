/**
 * AssetUploader(design.md §5.5)。
 *
 * 添付・描画画像を R2 / S3 にアップロードし、BodyTransformer(T-11、`transform/body.ts`)
 * が本文中に埋め込んだプレースホルダ(`note2web-asset://<identifier>`。
 * `makeAssetPlaceholder` が定義する契約)を公開 URL に差し替える。
 *
 * 手順(design.md §5.5 / §5.6 書き込みポイント`#1` / issue #18):
 * 1. 本文中の `note2web-asset://<identifier>` を走査し、`identifier` を
 *    `Attachment.identifier` に照合してファイル実体を解決する
 *    (`<exportDir>/files/<Attachment.path>`)。解決できない・読み取れない場合は
 *    `AssetUploadError` を送出し、そのノートを呼び出し側(T-14)が failed 扱いにできる
 *    ようにする(design.md §10「アセットアップロード失敗 → そのノートを failed 扱い」)。
 * 2. ファイル実体の SHA-256(`sha256:<hex>`。`frontmatter.ts` の `computeContentHash`
 *    と同じ表記規約)を計算し、`StateStore.hasAsset`/`getAsset` で重複排除する(FR-17)。
 * 3. 未知のハッシュのみ `UploaderClient.putObject` でアップロードし、成功ごとに
 *    直ちに `StateStore.saveAsset` する(design.md §5.6 書き込みポイント`#1`。後段で
 *    そのノートの配信が失敗しても保存は維持される)。
 * 4. アップロード成功ごとに `logger.assetUploaded` を呼ぶ(skip 時は呼ばない)。
 * 5. 全プレースホルダを解決済み URL に差し替え、置換後にプレースホルダが1つも
 *    残っていないことを確認する。
 *
 * 同一実行内の重複参照(同一ノート内の複数プレースホルダ、および複数ノートが同じ
 * アセットを参照する場合の両方)は、`StateStore` の read-your-writes ビュー
 * (`state/store.ts` 冒頭 JSDoc 参照)により2回目以降が自動的にスキップになる。
 * これを成立させるため、呼び出し側は全ノートを通じて同一の `StateStore` インスタンスを
 * 共有し、本モジュールはアップロードを並列化せず逐次実行する(取りこぼしのない
 * 重複排除のため)。
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Attachment } from '../model/note.js';
import type { AssetUploadedPayload } from '../logger.js';
import type { StateStore } from '../state/store.js';
import { formatTimestamp } from '../transform/normalize.js';
import type { AssetsConfig, UploaderClient } from './client.js';

export type { AssetsConfig, PutObjectParams, UploaderClient } from './client.js';
export { createS3UploaderClient } from './client.js';

// ---------------------------------------------------------------------------
// エラー型(design.md §10)。
// ---------------------------------------------------------------------------

/**
 * アセットの解決・アップロードに失敗したことを表すエラー(design.md §10
 * 「アセットアップロード失敗 → そのノートを failed 扱い(URL 未確定の本文を配信しない)」)。
 *
 * 次のいずれかで送出される:
 *   - プレースホルダの `identifier` に対応する `Attachment` が無い(解決不可)
 *   - 添付ファイル実体が読み取れない(不存在・権限不足等)
 *   - `UploaderClient.putObject` が失敗した
 *   - 置換後の本文にプレースホルダが残っている(内部不変条件違反)
 *
 * `process.exit` は呼ばない。ノートを failed とし処理を続行するかどうかは
 * 呼び出し側(パイプライン、T-14)の責務。`noteUuid` を常に持たせ、`note_failed`
 * ログ(design.md §9)にどのノートの失敗かを伝えられるようにする。
 */
export class AssetUploadError extends Error {
  readonly noteUuid: string;
  readonly identifier?: string;

  constructor(
    message: string,
    options: { noteUuid: string; identifier?: string; cause?: unknown },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AssetUploadError';
    this.noteUuid = options.noteUuid;
    this.identifier = options.identifier;
  }
}

// ---------------------------------------------------------------------------
// logger インターフェース(`src/subprocess.ts` の任意 logger 慣習と同じ最小注入)。
// ---------------------------------------------------------------------------

/** AssetUploader が発行するイベントに必要な最小限の logger インターフェース。 */
export interface AssetUploaderLogger {
  /** アップロード成功ごとに1回呼ぶ(design.md §9 `asset_uploaded`)。skip 時は呼ばない。 */
  assetUploaded(payload: AssetUploadedPayload): void;
}

// ---------------------------------------------------------------------------
// オブジェクトキー・URL の組み立て(design.md §5.5 / §8)。
// ---------------------------------------------------------------------------

/**
 * オブジェクトキーを組み立てる(design.md §5.5:
 * `<prefix><content-hashの先頭2文字>/<content-hash>.<拡張子>`)。
 * `prefix` が未設定の場合は空文字として扱う(design.md §5.5、CodeRabbit plan)。
 * `hash` は `sha256:` を含まない生の16進文字列、`ext` は `.png` のようにドットを含む形。
 */
export function buildAssetKey(prefix: string | undefined, hash: string, ext: string): string {
  return `${prefix ?? ''}${hash.slice(0, 2)}/${hash}${ext}`;
}

/**
 * `public_base_url` とオブジェクトキーを決定的に連結する(design.md §5.5「本文中の
 * 参照は `public_base_url` + キー に差し替える」)。
 *
 * design.md はスラッシュの有無までは規定していないため、本モジュールが次の規約を
 * 定める: `public_base_url` の末尾に `/` が有っても無くても、また `key` が(通常
 * 無いはずだが)先頭に `/` を持っていても、結果は常に単一の `/` 区切りになる。
 */
export function joinPublicUrl(baseUrl: string, key: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const relKey = key.startsWith('/') ? key.slice(1) : key;
  return `${base}/${relKey}`;
}

// ---------------------------------------------------------------------------
// 拡張子 → Content-Type の推定。
// ---------------------------------------------------------------------------

/**
 * `attachment.path` の拡張子から推定する Content-Type のテーブル。
 * Apple Notes の添付・描画で現実的に出現しうる画像・書類・音声・動画の範囲を
 * カバーする。未知の拡張子は `DEFAULT_CONTENT_TYPE` にフォールバックする
 * (アップロード自体は拒否しない。design.md はアップロード可否を拡張子で制限しない)。
 */
const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

function resolveContentType(ext: string): string {
  return CONTENT_TYPE_BY_EXTENSION[ext.toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

// ---------------------------------------------------------------------------
// プレースホルダの走査(`transform/body.ts` の `makeAssetPlaceholder` 契約と共有)。
// ---------------------------------------------------------------------------

const PLACEHOLDER_PREFIX = 'note2web-asset://';

/**
 * `makeAssetPlaceholder` が生成する `note2web-asset://<identifier>` を検出する。
 * `identifier` は Markdown の画像/リンク URL の位置に現れる(`transform/body.ts` の
 * 契約)ため、空白・`)` `]` 引用符 `>` のいずれかで区切られると仮定して良い
 * (`identifier` 自体は parser が埋め込む UUID であり、これらの文字を含まない)。
 */
const PLACEHOLDER_PATTERN = /note2web-asset:\/\/([^\s)\]"'>]+)/g;

/** `markdown` 中に現れる一意な `identifier` を、初出順を保って抽出する。 */
function extractPlaceholderIdentifiers(markdown: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const match of markdown.matchAll(PLACEHOLDER_PATTERN)) {
    const identifier = match[1];
    if (identifier !== undefined && !seen.has(identifier)) {
      seen.add(identifier);
      ordered.push(identifier);
    }
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// 入力・出力契約。
// ---------------------------------------------------------------------------

/** `processNoteBody` の入力。`transform/body.ts` の `TransformBodyOptions` と同じ DI 慣習。 */
export interface ProcessNoteBodyOptions {
  /** BodyTransformer(T-11)の出力。`note2web-asset://<identifier>` プレースホルダを含みうる。 */
  markdown: string;
  /** 当該ノートの添付・描画一覧(`identifier` → 実体ファイルパスの対応表の元)。 */
  attachments: readonly Attachment[];
  /** Exporter が返した一時出力ディレクトリ(`<exportDir>/files/` 配下に実体がある)。 */
  exportDir: string;
  /** 警告・エラーでどのノートかを識別する UUID(FR-09)。 */
  noteUuid: string;
  /** `logger.assetUploaded` に渡すサービス名(design.md §9)。 */
  service: string;
  /** 検証済み設定の `assets` ブロック(design.md §7)。 */
  assets: AssetsConfig;
  /** 実行全体で共有する単一の `StateStore` インスタンス(read-your-writes による重複排除の前提)。 */
  state: StateStore;
  /** アップロード先クライアント(本番は `createS3UploaderClient`、テストは偽実装)。 */
  client: UploaderClient;
  /** 指定時のみ `assetUploaded` イベントを発行する(任意注入)。 */
  logger?: AssetUploaderLogger;
  /** `uploadedAt` の整形に使うタイムゾーン。既定は `formatTimestamp` の既定(`Asia/Tokyo`)。 */
  timezone?: string;
  /** `uploadedAt` 用の時刻注入点(テスト用)。既定は `() => new Date()`。 */
  now?: () => Date;
}

/** `processNoteBody` の出力。 */
export interface ProcessNoteBodyResult {
  /** プレースホルダを全て公開 URL に差し替えた後の Markdown 本文。 */
  markdown: string;
}

// ---------------------------------------------------------------------------
// エントリ関数。
// ---------------------------------------------------------------------------

/**
 * `markdown` 中のアセットプレースホルダを解決・アップロードし、公開 URL に
 * 差し替える(design.md §5.5)。
 *
 * プレースホルダが1つも無い場合は、ファイル I/O・アップロードを一切行わず
 * `markdown` をそのまま返す。
 */
export async function processNoteBody(
  options: ProcessNoteBodyOptions,
): Promise<ProcessNoteBodyResult> {
  const {
    markdown,
    attachments,
    exportDir,
    noteUuid,
    service,
    assets,
    state,
    client,
    logger,
    timezone,
    now = () => new Date(),
  } = options;

  const identifiers = extractPlaceholderIdentifiers(markdown);
  if (identifiers.length === 0) {
    return { markdown };
  }

  const attachmentByIdentifier = new Map<string, Attachment>(
    attachments.map((attachment) => [attachment.identifier, attachment] as const),
  );
  const resolvedUrlByIdentifier = new Map<string, string>();

  // 重複排除・クラッシュ安全性(design.md §5.6 書き込みポイント`#1`)の両方のため、
  // 並列化せず逐次アップロードする(モジュール先頭 JSDoc 参照)。
  for (const identifier of identifiers) {
    const attachment = attachmentByIdentifier.get(identifier);
    if (attachment === undefined) {
      throw new AssetUploadError(`no attachment found for placeholder identifier "${identifier}"`, {
        noteUuid,
        identifier,
      });
    }

    const absolutePath = join(exportDir, 'files', attachment.path);
    let bytes: Buffer;
    try {
      bytes = await readFile(absolutePath);
    } catch (error) {
      throw new AssetUploadError(
        `failed to read attachment file for identifier "${identifier}": ${absolutePath}`,
        { noteUuid, identifier, cause: error },
      );
    }

    const hexHash = createHash('sha256').update(bytes).digest('hex');
    // `state/store.ts` の `AssetState` マップキー表記(`frontmatter.ts` の
    // `computeContentHash` と同じ `sha256:` プレフィックス規約)。
    const contentHash = `sha256:${hexHash}`;
    const ext = extname(attachment.path);

    if (state.hasAsset(contentHash)) {
      const existing = state.getAsset(contentHash);
      if (existing === undefined) {
        // hasAsset/getAsset は同一メモリビューを参照するため到達しないはずだが、
        // StateStore の契約が将来変わった場合に静かに壊れないための防御。
        throw new AssetUploadError(
          `internal error: StateStore.hasAsset returned true but getAsset returned undefined for "${contentHash}"`,
          { noteUuid, identifier },
        );
      }
      resolvedUrlByIdentifier.set(identifier, existing.url);
      continue;
    }

    const key = buildAssetKey(assets.prefix, hexHash, ext);
    const contentType = resolveContentType(ext);

    try {
      await client.putObject({ bucket: assets.bucket, key, body: bytes, contentType });
    } catch (error) {
      throw new AssetUploadError(
        `failed to upload asset for identifier "${identifier}" to key "${key}"`,
        { noteUuid, identifier, cause: error },
      );
    }

    const url = joinPublicUrl(assets.public_base_url, key);
    const uploadedAt = formatTimestamp(now(), timezone);
    // design.md §5.6 書き込みポイント`#1`: アップロード成功ごとに直ちに保存する。
    await state.saveAsset(contentHash, { key, url, uploadedAt });
    logger?.assetUploaded({ service, assetHash: contentHash, key, url });

    resolvedUrlByIdentifier.set(identifier, url);
  }

  const replaced = markdown.replace(PLACEHOLDER_PATTERN, (_match, identifier: string) => {
    const url = resolvedUrlByIdentifier.get(identifier);
    if (url === undefined) {
      // `identifiers` は同じ `PLACEHOLDER_PATTERN` で抽出したものなので、
      // ここには到達しないはず(防御的チェック)。
      throw new AssetUploadError(
        `internal error: no resolved URL for placeholder identifier "${identifier}"`,
        { noteUuid, identifier },
      );
    }
    return url;
  });

  if (replaced.includes(PLACEHOLDER_PREFIX)) {
    // 受け入れ条件: 差し替え後の本文にプレースホルダが1つも残らないこと。
    throw new AssetUploadError(
      'unresolved note2web-asset:// placeholder remained in the body after replacement',
      { noteUuid },
    );
  }

  return { markdown: replaced };
}
