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
 *
 * **note.com 向けの例外(design.md §5.7「画像」節、利用者決定 2026-08-21。旧 §13-6
 * option (b) から option (a) へ変更)**: `service === 'note'` かつプレースホルダが画像
 * (`isImageExtension`)を指す場合は、上記の R2/S3 アップロード経路を通らず、代わりに
 * ファイルを `<noteWorkspace>/images/<identifier><ext>` へコピーし、本文の参照を
 * `./images/<identifier><ext>` という相対パスに差し替える。`noet create`/`update` が
 * (kako-jun/noet commit `e3a8562`、`apps/cli/src/commands/extension.rs::image_handler.rs`)
 * markdown 中の `![alt](相対パス)` を自動検出し、`markdown_path.parent()` 基準で解決した
 * ファイルを note.com へ自前でアップロードしたうえで本文中の参照を `st-note.com` の URL に
 * 差し替えてくれるため、note.com 向けにはこちらの経路の方が正しく画像として表示される
 * (note.com の ProseMirror エディタは `http(s)://` 参照を画像として解釈しないため、
 * R2/S3 の公開 URL のまま送っても意味が無い——noet の `extract_image_references` も
 * `http://`/`https://` で始まる参照はアップロード対象から除外(スキップ)する)。
 * ローカルコピーは `StateStore` のアセット状態には一切記録しない(R2/S3 アセットでは
 * なく、実行のたびに再コピーする使い捨てファイルのため)。noet がサポートする画像形式は
 * jpg/jpeg/png/gif/webp のみ(`read_image_as_base64`)であり、`isImageExtension`
 * (本モジュール)が許容する拡張子の方が広いため、この経路では別途
 * `NOET_SUPPORTED_IMAGE_EXTENSIONS` でさらに絞り込み、対象外の拡張子は
 * `noet create`/`update` が60秒のコマンドタイムアウトの末に不可解に失敗する前に、
 * このアセット解決段階で明確な `AssetUploadError` として早期に落とす。
 * `<noteWorkspace>/images/` 配下の、もはやどのノートからも参照されなくなった古いファイル
 * (画像の削除・差し替え後に残るもの)は掃除しない——noet は毎回そのノートが実際に参照する
 * 画像だけを再アップロードするため無害であり、note.com 側で参照されなくなった過去の
 * アップロード自体は note.com のクリーンアップに委ねる(design.md §5.7 参照)。
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
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
 *   - `attachment.path` が `<exportDir>/files/` の外側を指している(トラバーサル・
 *     絶対パス・シンボリックリンクのいずれか。`resolveAttachmentAbsolutePath` 参照)
 *   - 添付ファイル実体が読み取れない(不存在・権限不足等)
 *   - `UploaderClient.putObject` が失敗した
 *   - アップロード成功後の `StateStore.saveAsset` が失敗した(状態未記録)
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

/**
 * `ext`(`node:path` の `extname` が返す、`.png` のようにドットを含む形。大文字小文字は
 * 無視する)が画像の拡張子かどうか。
 *
 * BodyTransformer(`transform/body.ts` の `assetAwareAHandler`)が、`data-apple-notes-
 * zidentifier` を直接持つ `<a>`(img を伴わない添付参照)を画像として `![]()` にするか
 * リンク `[]()` のままにするか(design.md §5.4 FR-14「添付は画像なら `![]()`、それ以外は
 * リンク」)を判定するのに使う。`CONTENT_TYPE_BY_EXTENSION` と二重管理にならないよう、
 * その値が `image/` で始まるかどうかで判定を共有する。
 */
export function isImageExtension(ext: string): boolean {
  const contentType = CONTENT_TYPE_BY_EXTENSION[ext.toLowerCase()];
  return contentType !== undefined && contentType.startsWith('image/');
}

/**
 * noet(kako-jun/noet, commit `e3a8562`)の `read_image_as_base64` が実際に読める画像拡張子
 * (小文字、ドット付き)。note.com 向けのローカル画像コピー経路(モジュール冒頭 JSDoc
 * 「note.com 向けの例外」参照)専用の、`isImageExtension` より厳しいゲート。この集合に無い
 * 拡張子を渡すと `noet create`/`update` がコマンド全体を失敗させる(該当ノートも巻き込む)ため、
 * ここで先に検出して明確なエラーにする。
 */
export const NOET_SUPPORTED_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
]);

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
// 添付ファイルパスの解決(`<exportDir>/files/` 配下への封じ込め検証つき)。
// ---------------------------------------------------------------------------

/**
 * `candidate` が `root` 自身、または `root` 配下(`root + path.sep` で始まる)かどうか。
 * 文字列比較の前に両者とも正規化済みの絶対パスであることを呼び出し側が保証する。
 */
function isPathWithinRoot(root: string, candidate: string): boolean {
  if (candidate === root) {
    return true;
  }
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(rootWithSep);
}

/**
 * `attachment.path` を `<exportDir>/files/` 配下の絶対パスへ解決し、`files/` root の
 * 外側を指していないことを検証する(セキュリティ対応。PR #46 CodeRabbit review)。
 *
 * `attachment.path` は parser が出力する JSON(`embedded_objects[].filepath` /
 * `backup_location`)由来の外部入力であり、信頼できないものとして扱う。
 * トラバーサル(`../..`)・絶対パスによる root の差し替え・`files/` 配下に置かれた
 * シンボリックリンクによる root 外への脱出、いずれも許さない:
 *
 *   1. `path.resolve(filesRoot, attachment.path)` で候補絶対パスを組み立てる
 *      (`resolve` は第2引数が絶対パスの場合、第1引数を無視してその絶対パスを
 *      そのまま返す。これ単体では絶対パス攻撃を防げないため、次の文字列包含
 *      チェックで弾く)。
 *   2. 文字列としての包含チェック(`isPathWithinRoot`)で、ファイルシステムに
 *      触れる前にトラバーサル・絶対パスの両方を拒否する。
 *   3. `fs.realpath` で `filesRoot` と候補パスそれぞれの実体パス(シンボリック
 *      リンクを解決した結果)を求め、再度包含チェックする。`files/` 配下に置かれた
 *      シンボリックリンクが root 外を指している場合はここで拒否する。候補パスが
 *      存在しない場合(`ENOENT` 等)は「読み取れない」エラーとして扱う。
 *
 * いずれの拒否も `AssetUploadError`(`noteUuid`/`identifier` の文脈つき)を送出する。
 */
async function resolveAttachmentAbsolutePath(
  exportDir: string,
  attachment: Attachment,
  context: { noteUuid: string; identifier: string },
): Promise<string> {
  const { noteUuid, identifier } = context;
  const filesRoot = resolve(exportDir, 'files');
  const candidatePath = resolve(filesRoot, attachment.path);

  if (!isPathWithinRoot(filesRoot, candidatePath)) {
    throw new AssetUploadError(
      `attachment path escapes the files root (traversal or absolute path rejected) for identifier "${identifier}": "${attachment.path}"`,
      { noteUuid, identifier },
    );
  }

  let realFilesRoot: string;
  try {
    realFilesRoot = await realpath(filesRoot);
  } catch (error) {
    throw new AssetUploadError(`files root does not exist under exportDir: ${filesRoot}`, {
      noteUuid,
      identifier,
      cause: error,
    });
  }

  let realCandidatePath: string;
  try {
    realCandidatePath = await realpath(candidatePath);
  } catch (error) {
    throw new AssetUploadError(
      `failed to read attachment file for identifier "${identifier}": ${candidatePath}`,
      { noteUuid, identifier, cause: error },
    );
  }

  if (!isPathWithinRoot(realFilesRoot, realCandidatePath)) {
    throw new AssetUploadError(
      `attachment path resolves outside the files root via a symlink for identifier "${identifier}": "${attachment.path}"`,
      { noteUuid, identifier },
    );
  }

  return realCandidatePath;
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
  /**
   * note.com 向けワークスペースの絶対パス(呼び出し側で `expandHome` 展開済み。
   * `src/sync.ts` が `config.note` から渡す)。`service === 'note'` かつ画像プレース
   * ホルダが1つでもある場合のみ必須(モジュール冒頭 JSDoc「note.com 向けの例外」参照)。
   * それ以外のサービスでは無視される。
   */
  noteWorkspace?: string;
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
    noteWorkspace,
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

    const absolutePath = await resolveAttachmentAbsolutePath(exportDir, attachment, {
      noteUuid,
      identifier,
    });
    const ext = extname(attachment.path);

    // note.com 向けの画像はローカルコピー経路(モジュール冒頭 JSDoc「note.com 向けの例外」
    // 参照)。R2/S3 へはアップロードせず、`StateStore` にも記録しない。
    if (service === 'note' && isImageExtension(ext)) {
      if (noteWorkspace === undefined) {
        throw new AssetUploadError(
          `internal error: processNoteBody was called with service "note" and an image ` +
            `attachment (identifier "${identifier}") but no "noteWorkspace" option was provided; ` +
            'the config schema guarantees "note.workspace" for the note service, so this indicates ' +
            'a wiring bug in the caller (src/sync.ts) rather than a user-facing configuration error',
          { noteUuid, identifier },
        );
      }

      const lowerExt = ext.toLowerCase();
      if (!NOET_SUPPORTED_IMAGE_EXTENSIONS.has(lowerExt)) {
        const supported = [...NOET_SUPPORTED_IMAGE_EXTENSIONS].sort().join(', ');
        throw new AssetUploadError(
          `image attachment for identifier "${identifier}" has extension "${ext}", which noet ` +
            `does not support for note.com uploads (noet's read_image_as_base64 accepts only: ` +
            `${supported}); remove or convert this image, or publish this note to a different ` +
            'service instead',
          { noteUuid, identifier },
        );
      }

      const imagesDir = join(noteWorkspace, 'images');
      const destFileName = `${identifier}${lowerExt}`;
      const destPath = join(imagesDir, destFileName);
      try {
        await mkdir(imagesDir, { recursive: true });
        await copyFile(absolutePath, destPath);
      } catch (error) {
        throw new AssetUploadError(
          `failed to copy image attachment for identifier "${identifier}" into the note.com ` +
            `workspace ("${destPath}")`,
          { noteUuid, identifier, cause: error },
        );
      }

      resolvedUrlByIdentifier.set(identifier, `./images/${destFileName}`);
      continue;
    }

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
    // アップロード自体は既に成功しているため(実体は R2/S3 に存在する)、この
    // 保存失敗はノート単位の失敗として文脈(noteUuid/identifier)を保った上で
    // 呼び出し側に伝える(状態未記録のまま処理を続けると、次回実行時に
    // 同一アセットを不要に再アップロードしてしまうため)。
    try {
      await state.saveAsset(contentHash, { key, url, uploadedAt });
    } catch (error) {
      throw new AssetUploadError(
        `failed to persist state after successful upload for identifier "${identifier}" (uploaded to key "${key}" but not recorded)`,
        { noteUuid, identifier, cause: error },
      );
    }
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
