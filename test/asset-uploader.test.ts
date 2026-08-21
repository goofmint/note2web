import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssetUploadError,
  buildAssetKey,
  joinPublicUrl,
  processNoteBody,
  type AssetUploaderLogger,
} from '../src/assets/uploader.js';
import type { AssetsConfig, PutObjectParams, UploaderClient } from '../src/assets/client.js';
import { makeAssetPlaceholder } from '../src/transform/body.js';
import type { Attachment } from '../src/model/note.js';
import { StateStore } from '../src/state/store.js';
import type { AssetUploadedPayload } from '../src/logger.js';

const SERVICE = 'zenn';
const TARGET = '/repos/example';
const NOTE_UUID_A = '5c1c2c3d-0000-0000-0000-000000000001';
const NOTE_UUID_B = '5c1c2c3d-0000-0000-0000-000000000002';

// `prefix` と `public_base_url` は design.md §7/§8 の例のように意味を重複させない
// (`public_base_url` は bucket 公開ルート、`prefix` は S3 オブジェクトキーの
// 名前空間)。design.md §5.5 は「本文中の参照は `public_base_url` + キー に
// 差し替える」と定めており、`key` は既に `prefix` を含むため、`public_base_url`
// 側に同じ文字列を重複して含めると URL に `prefix` が二重に現れる
// (design.md §7/§8 の例は両方に `notes/` を含んでおり、字面どおりに読むと
// この重複が起きる。§5.5 の規範文言を優先し、本テストでは重複しない値を使う)。
const ASSETS_CONFIG: AssetsConfig = {
  provider: 'r2',
  bucket: 'blog-assets',
  endpoint: 'https://example-account.r2.cloudflarestorage.com',
  region: 'auto',
  prefix: 'notes/',
  public_base_url: 'https://assets.example.com',
  access_key_id_env: 'R2_ACCESS_KEY_ID',
  secret_access_key_env: 'R2_SECRET_ACCESS_KEY',
};

/** 実ファイルへのアップロードを模す、呼び出しを記録するだけの偽クライアント。 */
function makeFakeClient(): UploaderClient & { putObject: ReturnType<typeof vi.fn> } {
  return {
    putObject: vi.fn(async (): Promise<void> => {
      // ネットワークは一切叩かない(実 S3Client を経由しない)。
      return undefined;
    }),
  };
}

function makeLogger(): AssetUploaderLogger & {
  assetUploaded: ReturnType<typeof vi.fn<(payload: AssetUploadedPayload) => void>>;
} {
  return { assetUploaded: vi.fn<(payload: AssetUploadedPayload) => void>() };
}

describe('AssetUploader', () => {
  let dir: string;
  let exportDir: string;
  let filesDir: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'note2web-asset-uploader-test-'));
    exportDir = join(dir, 'export');
    filesDir = join(exportDir, 'files');
    mkdirSync(filesDir, { recursive: true });
    statePath = join(dir, 'zenn.state.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** `filesDir` 配下に `relativePath` でファイルを作り、生バイト列を返す。 */
  function writeAttachmentFile(relativePath: string, content: string): Buffer {
    const absolute = join(filesDir, relativePath);
    mkdirSync(join(absolute, '..'), { recursive: true });
    const bytes = Buffer.from(content, 'utf8');
    writeFileSync(absolute, bytes);
    return bytes;
  }

  function sha256Hex(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  async function freshStore(): Promise<StateStore> {
    return StateStore.load({ statePath, service: SERVICE, target: TARGET });
  }

  describe('first upload', () => {
    it('uploads once and captures bucket/key/body via PutObjectCommand-shaped params', async () => {
      const bytes = writeAttachmentFile('image.png', 'first-upload-bytes');
      const attachments: Attachment[] = [{ identifier: 'id-1', path: 'image.png' }];
      const markdown = `![](${makeAssetPlaceholder('id-1')})`;

      const store = await freshStore();
      const client = makeFakeClient();
      const logger = makeLogger();

      const result = await processNoteBody({
        markdown,
        attachments,
        exportDir,
        noteUuid: NOTE_UUID_A,
        service: SERVICE,
        assets: ASSETS_CONFIG,
        state: store,
        client,
        logger,
        now: () => new Date('2026-08-11T00:00:00Z'),
      });

      expect(client.putObject).toHaveBeenCalledTimes(1);
      const call = client.putObject.mock.calls[0]?.[0] as PutObjectParams;
      const hex = sha256Hex(bytes);
      expect(call.bucket).toBe('blog-assets');
      expect(call.key).toBe(`notes/${hex.slice(0, 2)}/${hex}.png`);
      expect(call.body).toEqual(bytes);
      expect(call.contentType).toBe('image/png');

      expect(result.markdown).not.toContain('note2web-asset://');
      expect(result.markdown).toContain(
        `https://assets.example.com/notes/${hex.slice(0, 2)}/${hex}.png`,
      );

      expect(logger.assetUploaded).toHaveBeenCalledTimes(1);
      expect(logger.assetUploaded).toHaveBeenCalledWith({
        service: SERVICE,
        assetHash: `sha256:${hex}`,
        key: `notes/${hex.slice(0, 2)}/${hex}.png`,
        url: `https://assets.example.com/notes/${hex.slice(0, 2)}/${hex}.png`,
      });
    });

    it('persists the asset to StateStore immediately (write point #1)', async () => {
      const bytes = writeAttachmentFile('image.png', 'persist-check');
      const attachments: Attachment[] = [{ identifier: 'id-1', path: 'image.png' }];
      const markdown = `![](${makeAssetPlaceholder('id-1')})`;
      const hex = sha256Hex(bytes);

      const store = await freshStore();
      const client = makeFakeClient();

      expect(existsSync(statePath)).toBe(false);

      await processNoteBody({
        markdown,
        attachments,
        exportDir,
        noteUuid: NOTE_UUID_A,
        service: SERVICE,
        assets: ASSETS_CONFIG,
        state: store,
        client,
        now: () => new Date('2026-08-11T00:00:00Z'),
      });

      // ディスク上に個別に保存されている(saveAsset は都度アトミック保存する)。
      expect(existsSync(statePath)).toBe(true);
      const onDisk = JSON.parse(readFileSync(statePath, 'utf8')) as {
        assets: Record<string, { key: string; url: string; uploadedAt: string }>;
      };
      expect(onDisk.assets[`sha256:${hex}`]).toEqual({
        key: `notes/${hex.slice(0, 2)}/${hex}.png`,
        url: `https://assets.example.com/notes/${hex.slice(0, 2)}/${hex}.png`,
        uploadedAt: '2026-08-11T09:00:00+09:00',
      });

      // メモリ上のビュー(getAsset)からも即座に見える。
      expect(store.getAsset(`sha256:${hex}`)?.key).toBe(`notes/${hex.slice(0, 2)}/${hex}.png`);
    });

    it('does not throw when no logger is supplied (smoke test)', async () => {
      writeAttachmentFile('image.png', 'no-logger-smoke');
      const attachments: Attachment[] = [{ identifier: 'id-1', path: 'image.png' }];
      const markdown = `![](${makeAssetPlaceholder('id-1')})`;

      const store = await freshStore();
      const client = makeFakeClient();

      await expect(
        processNoteBody({
          markdown,
          attachments,
          exportDir,
          noteUuid: NOTE_UUID_A,
          service: SERVICE,
          assets: ASSETS_CONFIG,
          state: store,
          client,
        }),
      ).resolves.not.toThrow();
    });

    it('returns the markdown unchanged and skips all I/O when there are no placeholders', async () => {
      const store = await freshStore();
      const client = makeFakeClient();
      const markdown = '# Title\n\nNo assets here.\n';

      const result = await processNoteBody({
        markdown,
        attachments: [],
        exportDir,
        noteUuid: NOTE_UUID_A,
        service: SERVICE,
        assets: ASSETS_CONFIG,
        state: store,
        client,
      });

      expect(result.markdown).toBe(markdown);
      expect(client.putObject).not.toHaveBeenCalled();
    });
  });

  describe('same-run duplicate references', () => {
    it('collapses two placeholders referencing the same identifier within one note into a single upload', async () => {
      writeAttachmentFile('image.png', 'dup-within-note');
      const attachments: Attachment[] = [{ identifier: 'id-1', path: 'image.png' }];
      const markdown = `![](${makeAssetPlaceholder('id-1')}) and again ![](${makeAssetPlaceholder('id-1')})`;

      const store = await freshStore();
      const client = makeFakeClient();

      const result = await processNoteBody({
        markdown,
        attachments,
        exportDir,
        noteUuid: NOTE_UUID_A,
        service: SERVICE,
        assets: ASSETS_CONFIG,
        state: store,
        client,
      });

      expect(client.putObject).toHaveBeenCalledTimes(1);
      expect(result.markdown).not.toContain('note2web-asset://');
    });

    it('collapses references across two notes sharing one file hash into a single upload (shared StateStore)', async () => {
      const bytesA = writeAttachmentFile('a/image.png', 'same-content-bytes');
      writeAttachmentFile('b/image-copy.png', 'same-content-bytes');
      const hex = sha256Hex(bytesA);

      const store = await freshStore();
      const client = makeFakeClient();
      const logger = makeLogger();

      const resultA = await processNoteBody({
        markdown: `![](${makeAssetPlaceholder('id-note-a')})`,
        attachments: [{ identifier: 'id-note-a', path: 'a/image.png' }],
        exportDir,
        noteUuid: NOTE_UUID_A,
        service: SERVICE,
        assets: ASSETS_CONFIG,
        state: store,
        client,
        logger,
      });

      const resultB = await processNoteBody({
        markdown: `![](${makeAssetPlaceholder('id-note-b')})`,
        attachments: [{ identifier: 'id-note-b', path: 'b/image-copy.png' }],
        exportDir,
        noteUuid: NOTE_UUID_B,
        service: SERVICE,
        assets: ASSETS_CONFIG,
        state: store,
        client,
        logger,
      });

      expect(client.putObject).toHaveBeenCalledTimes(1);
      expect(logger.assetUploaded).toHaveBeenCalledTimes(1);

      const expectedUrl = `https://assets.example.com/notes/${hex.slice(0, 2)}/${hex}.png`;
      expect(resultA.markdown).toContain(expectedUrl);
      expect(resultB.markdown).toContain(expectedUrl);
    });
  });

  describe('re-run across processes (fresh StateStore loaded from disk)', () => {
    it('performs zero uploads and reuses the persisted URL', async () => {
      const bytes = writeAttachmentFile('image.png', 'rerun-bytes');
      const attachments: Attachment[] = [{ identifier: 'id-1', path: 'image.png' }];
      const markdown = `![](${makeAssetPlaceholder('id-1')})`;
      const hex = sha256Hex(bytes);

      const firstStore = await freshStore();
      const firstClient = makeFakeClient();
      await processNoteBody({
        markdown,
        attachments,
        exportDir,
        noteUuid: NOTE_UUID_A,
        service: SERVICE,
        assets: ASSETS_CONFIG,
        state: firstStore,
        client: firstClient,
      });
      expect(firstClient.putObject).toHaveBeenCalledTimes(1);

      // 新しいプロセスを模す: StateStore.load をディスクから読み直す。
      const secondStore = await StateStore.load({ statePath, service: SERVICE, target: TARGET });
      const secondClient = makeFakeClient();
      const secondLogger = makeLogger();

      const result = await processNoteBody({
        markdown,
        attachments,
        exportDir,
        noteUuid: NOTE_UUID_A,
        service: SERVICE,
        assets: ASSETS_CONFIG,
        state: secondStore,
        client: secondClient,
        logger: secondLogger,
      });

      expect(secondClient.putObject).not.toHaveBeenCalled();
      expect(secondLogger.assetUploaded).not.toHaveBeenCalled();
      expect(result.markdown).toContain(
        `https://assets.example.com/notes/${hex.slice(0, 2)}/${hex}.png`,
      );
    });
  });

  describe('error semantics', () => {
    it('throws AssetUploadError carrying noteUuid when the identifier has no matching attachment', async () => {
      const store = await freshStore();
      const client = makeFakeClient();
      const markdown = `![](${makeAssetPlaceholder('missing-id')})`;

      const error = await processNoteBody({
        markdown,
        attachments: [],
        exportDir,
        noteUuid: NOTE_UUID_A,
        service: SERVICE,
        assets: ASSETS_CONFIG,
        state: store,
        client,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AssetUploadError);
      expect((error as AssetUploadError).noteUuid).toBe(NOTE_UUID_A);
      expect(client.putObject).not.toHaveBeenCalled();
    });

    it('throws AssetUploadError carrying noteUuid when the attachment file is missing on disk', async () => {
      const attachments: Attachment[] = [{ identifier: 'id-1', path: 'does-not-exist.png' }];
      const markdown = `![](${makeAssetPlaceholder('id-1')})`;

      const store = await freshStore();
      const client = makeFakeClient();

      const error = await processNoteBody({
        markdown,
        attachments,
        exportDir,
        noteUuid: NOTE_UUID_B,
        service: SERVICE,
        assets: ASSETS_CONFIG,
        state: store,
        client,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AssetUploadError);
      expect((error as AssetUploadError).noteUuid).toBe(NOTE_UUID_B);
      expect(client.putObject).not.toHaveBeenCalled();
    });

    it('propagates upload failures as AssetUploadError without persisting state', async () => {
      writeAttachmentFile('image.png', 'upload-failure-bytes');
      const attachments: Attachment[] = [{ identifier: 'id-1', path: 'image.png' }];
      const markdown = `![](${makeAssetPlaceholder('id-1')})`;

      const store = await freshStore();
      const client: UploaderClient = {
        putObject: vi.fn(async () => {
          throw new Error('simulated network failure');
        }),
      };

      const error = await processNoteBody({
        markdown,
        attachments,
        exportDir,
        noteUuid: NOTE_UUID_A,
        service: SERVICE,
        assets: ASSETS_CONFIG,
        state: store,
        client,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AssetUploadError);
      expect((error as AssetUploadError).noteUuid).toBe(NOTE_UUID_A);
      expect(existsSync(statePath)).toBe(false);
    });

    it('wraps a StateStore.saveAsset failure as AssetUploadError carrying noteUuid/identifier/cause', async () => {
      writeAttachmentFile('image.png', 'save-asset-failure-bytes');
      const attachments: Attachment[] = [{ identifier: 'id-1', path: 'image.png' }];
      const markdown = `![](${makeAssetPlaceholder('id-1')})`;

      const store = await freshStore();
      const persistenceFailure = new Error('simulated disk error');
      // アップロード自体は成功させ、直後の状態保存だけを失敗させる
      // (`StateStore.saveAsset` はクラスの通常メソッドなので prototype 越しに
      // 差し替えられる)。
      vi.spyOn(store, 'saveAsset').mockRejectedValueOnce(persistenceFailure);
      const client = makeFakeClient();

      const error = await processNoteBody({
        markdown,
        attachments,
        exportDir,
        noteUuid: NOTE_UUID_A,
        service: SERVICE,
        assets: ASSETS_CONFIG,
        state: store,
        client,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AssetUploadError);
      expect((error as AssetUploadError).noteUuid).toBe(NOTE_UUID_A);
      expect((error as AssetUploadError).identifier).toBe('id-1');
      expect((error as AssetUploadError).cause).toBe(persistenceFailure);
      // アップロード自体は既に発生している(状態記録だけが失敗した)。
      expect(client.putObject).toHaveBeenCalledTimes(1);
    });
  });

  describe('attachment path containment (files root escape prevention)', () => {
    it('resolves a legitimate nested attachment path', async () => {
      const bytes = writeAttachmentFile('nested/deeper/legit.png', 'legit-nested-bytes');
      const attachments: Attachment[] = [{ identifier: 'id-1', path: 'nested/deeper/legit.png' }];
      const markdown = `![](${makeAssetPlaceholder('id-1')})`;

      const store = await freshStore();
      const client = makeFakeClient();

      const result = await processNoteBody({
        markdown,
        attachments,
        exportDir,
        noteUuid: NOTE_UUID_A,
        service: SERVICE,
        assets: ASSETS_CONFIG,
        state: store,
        client,
      });

      expect(client.putObject).toHaveBeenCalledTimes(1);
      const call = client.putObject.mock.calls[0]?.[0] as PutObjectParams;
      expect(call.body).toEqual(bytes);
      expect(result.markdown).not.toContain('note2web-asset://');
    });

    it('rejects a traversal path ("../..") that escapes the files root', async () => {
      // filesDir の外(exportDir 直下)に秘密ファイルを置く。
      writeFileSync(join(exportDir, 'secret.txt'), 'top secret');
      const attachments: Attachment[] = [{ identifier: 'id-1', path: '../secret.txt' }];
      const markdown = `![](${makeAssetPlaceholder('id-1')})`;

      const store = await freshStore();
      const client = makeFakeClient();

      const error = await processNoteBody({
        markdown,
        attachments,
        exportDir,
        noteUuid: NOTE_UUID_A,
        service: SERVICE,
        assets: ASSETS_CONFIG,
        state: store,
        client,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AssetUploadError);
      expect((error as AssetUploadError).noteUuid).toBe(NOTE_UUID_A);
      expect((error as AssetUploadError).identifier).toBe('id-1');
      expect(client.putObject).not.toHaveBeenCalled();
    });

    it('rejects an absolute attachment path that escapes the files root', async () => {
      // filesDir の外に秘密ファイルを置き、そのファイルへの絶対パスを attachment.path に使う。
      const outsidePath = join(dir, 'outside-absolute.txt');
      writeFileSync(outsidePath, 'top secret via absolute path');
      const attachments: Attachment[] = [{ identifier: 'id-1', path: outsidePath }];
      const markdown = `![](${makeAssetPlaceholder('id-1')})`;

      const store = await freshStore();
      const client = makeFakeClient();

      const error = await processNoteBody({
        markdown,
        attachments,
        exportDir,
        noteUuid: NOTE_UUID_A,
        service: SERVICE,
        assets: ASSETS_CONFIG,
        state: store,
        client,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AssetUploadError);
      expect((error as AssetUploadError).noteUuid).toBe(NOTE_UUID_A);
      expect((error as AssetUploadError).identifier).toBe('id-1');
      expect(client.putObject).not.toHaveBeenCalled();
    });

    it('rejects a symlink inside the files root that points outside it', async () => {
      const outsidePath = join(dir, 'outside-symlink-target.txt');
      writeFileSync(outsidePath, 'top secret via symlink');
      const linkPath = join(filesDir, 'link-to-outside.txt');
      symlinkSync(outsidePath, linkPath);

      const attachments: Attachment[] = [{ identifier: 'id-1', path: 'link-to-outside.txt' }];
      const markdown = `![](${makeAssetPlaceholder('id-1')})`;

      const store = await freshStore();
      const client = makeFakeClient();

      const error = await processNoteBody({
        markdown,
        attachments,
        exportDir,
        noteUuid: NOTE_UUID_A,
        service: SERVICE,
        assets: ASSETS_CONFIG,
        state: store,
        client,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AssetUploadError);
      expect((error as AssetUploadError).noteUuid).toBe(NOTE_UUID_A);
      expect((error as AssetUploadError).identifier).toBe('id-1');
      expect(client.putObject).not.toHaveBeenCalled();
    });

    it('still uploads a symlink that points to a legitimate file inside the files root', async () => {
      const targetBytes = writeAttachmentFile('real/inside-target.png', 'symlink-inside-bytes');
      const linkPath = join(filesDir, 'link-to-inside.png');
      symlinkSync(join(filesDir, 'real', 'inside-target.png'), linkPath);

      const attachments: Attachment[] = [{ identifier: 'id-1', path: 'link-to-inside.png' }];
      const markdown = `![](${makeAssetPlaceholder('id-1')})`;

      const store = await freshStore();
      const client = makeFakeClient();

      await processNoteBody({
        markdown,
        attachments,
        exportDir,
        noteUuid: NOTE_UUID_A,
        service: SERVICE,
        assets: ASSETS_CONFIG,
        state: store,
        client,
      });

      expect(client.putObject).toHaveBeenCalledTimes(1);
      const call = client.putObject.mock.calls[0]?.[0] as PutObjectParams;
      expect(call.body).toEqual(targetBytes);
    });
  });

  describe('note.com service: image placeholders left unresolved, non-image attachments unchanged (issue #86)', () => {
    it('(a) leaves an image placeholder unresolved (note2web-asset:// intact), without touching R2 or StateStore', async () => {
      writeAttachmentFile('sketch.png', 'note-image-bytes');
      const attachments: Attachment[] = [{ identifier: 'img-1', path: 'sketch.png' }];
      const markdown = `![alt](${makeAssetPlaceholder('img-1')})`;

      const store = await freshStore();
      const client = makeFakeClient();

      const result = await processNoteBody({
        markdown,
        attachments,
        exportDir,
        noteUuid: NOTE_UUID_A,
        service: 'note',
        assets: ASSETS_CONFIG,
        state: store,
        client,
      });

      // プレースホルダは意図的に未解決のまま残る(`src/publishers/note.ts` が画像の
      // アップロード・本文 HTML への変換を配信時点で行う。issue #86 Phase 4)。
      expect(result.markdown).toBe(markdown);
      expect(result.markdown).toContain('note2web-asset://');

      // R2 へは一切アップロードされず、StateStore のアセット状態にも記録されない。
      expect(client.putObject).not.toHaveBeenCalled();
      expect(existsSync(statePath)).toBe(false);
    });

    it('(b) still uploads a non-image attachment to R2 and replaces it with the public URL (unchanged behavior)', async () => {
      const bytes = writeAttachmentFile('report.pdf', 'note-non-image-bytes');
      const attachments: Attachment[] = [{ identifier: 'doc-1', path: 'report.pdf' }];
      const markdown = `[report](${makeAssetPlaceholder('doc-1')})`;
      const hex = sha256Hex(bytes);

      const store = await freshStore();
      const client = makeFakeClient();

      const result = await processNoteBody({
        markdown,
        attachments,
        exportDir,
        noteUuid: NOTE_UUID_A,
        service: 'note',
        assets: ASSETS_CONFIG,
        state: store,
        client,
      });

      expect(client.putObject).toHaveBeenCalledTimes(1);
      const expectedUrl = `https://assets.example.com/notes/${hex.slice(0, 2)}/${hex}.pdf`;
      expect(result.markdown).toBe(`[report](${expectedUrl})`);
    });

    it('(c) resolves a non-image attachment normally while leaving a sibling image placeholder unresolved in the same note', async () => {
      writeAttachmentFile('sketch.png', 'note-mixed-image-bytes');
      const bytes = writeAttachmentFile('report.pdf', 'note-mixed-doc-bytes');
      const attachments: Attachment[] = [
        { identifier: 'img-1', path: 'sketch.png' },
        { identifier: 'doc-1', path: 'report.pdf' },
      ];
      const markdown = `![alt](${makeAssetPlaceholder('img-1')})\n\n[report](${makeAssetPlaceholder('doc-1')})`;
      const hex = sha256Hex(bytes);

      const store = await freshStore();
      const client = makeFakeClient();

      const result = await processNoteBody({
        markdown,
        attachments,
        exportDir,
        noteUuid: NOTE_UUID_A,
        service: 'note',
        assets: ASSETS_CONFIG,
        state: store,
        client,
      });

      const expectedUrl = `https://assets.example.com/notes/${hex.slice(0, 2)}/${hex}.pdf`;
      expect(result.markdown).toContain(`note2web-asset://img-1`);
      expect(result.markdown).toContain(`[report](${expectedUrl})`);
      expect(client.putObject).toHaveBeenCalledTimes(1);
    });
  });

  describe('key layout and URL joining (golden)', () => {
    it('builds keys as <prefix><hash[0:2]>/<hash><ext>, treating an unset prefix as empty', () => {
      expect(buildAssetKey('notes/', 'ab12cd', '.png')).toBe('notes/ab/ab12cd.png');
      expect(buildAssetKey(undefined, 'ab12cd', '.png')).toBe('ab/ab12cd.png');
      expect(buildAssetKey('', 'ab12cd', '.png')).toBe('ab/ab12cd.png');
    });

    it('joins public_base_url and key deterministically regardless of a trailing slash', () => {
      expect(joinPublicUrl('https://assets.example.com/notes', 'ab/ab12cd.png')).toBe(
        'https://assets.example.com/notes/ab/ab12cd.png',
      );
      expect(joinPublicUrl('https://assets.example.com/notes/', 'ab/ab12cd.png')).toBe(
        'https://assets.example.com/notes/ab/ab12cd.png',
      );
    });

    it('end-to-end: resolved URL matches public_base_url + key exactly, with a trailing-slash base', async () => {
      const bytes = writeAttachmentFile('image.jpg', 'golden-bytes');
      const hex = sha256Hex(bytes);
      const attachments: Attachment[] = [{ identifier: 'id-1', path: 'image.jpg' }];
      const markdown = `![](${makeAssetPlaceholder('id-1')})`;

      const store = await freshStore();
      const client = makeFakeClient();
      const trailingSlashAssets: AssetsConfig = {
        ...ASSETS_CONFIG,
        public_base_url: 'https://assets.example.com/',
      };

      const result = await processNoteBody({
        markdown,
        attachments,
        exportDir,
        noteUuid: NOTE_UUID_A,
        service: SERVICE,
        assets: trailingSlashAssets,
        state: store,
        client,
      });

      const expectedKey = `notes/${hex.slice(0, 2)}/${hex}.jpg`;
      const expectedUrl = joinPublicUrl(trailingSlashAssets.public_base_url, expectedKey);
      expect(expectedUrl).toBe(`https://assets.example.com/notes/${hex.slice(0, 2)}/${hex}.jpg`);
      // 末尾スラッシュ有り (`public_base_url`) でも、末尾スラッシュ無しの
      // `ASSETS_CONFIG` と同じ URL になることを確認する(決定的な結合)。
      expect(result.markdown).toContain(expectedUrl);
      expect(store.getAsset(`sha256:${hex}`)?.url).toBe(expectedUrl);
    });
  });
});
