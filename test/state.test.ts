import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `node:fs/promises` の `rename` だけを差し替え可能にするモック。
 * `renameOverride.impl` が設定されていればそれを使い、無ければ実体を呼ぶ。
 * StateStore.persist の「一時ファイル書き込み後の rename」を狙って失敗させ、
 * クラッシュ安全性(既存ファイルが無傷のまま残ること)を検証するために使う。
 */
const renameOverride: { impl: ((...args: unknown[]) => Promise<unknown>) | null } = {
  impl: null,
};

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (renameOverride.impl) {
        return renameOverride.impl(...args);
      }
      return actual.rename(...args);
    },
  };
});

const { CURRENT_STATE_VERSION, StateStore, StateValidationError } =
  await import('../src/state/store.js');
type NoteState = import('../src/state/store.js').NoteState;
type AssetState = import('../src/state/store.js').AssetState;
const { PRECONDITION_FAILURE } = await import('../src/exit-codes.js');

const SERVICE = 'zenn';
const TARGET = '/repos/example';

const NOTE_UUID = '5c1c2c3d-0000-0000-0000-000000000001';
const OTHER_UUID = '5c1c2c3d-0000-0000-0000-000000000002';
const CONTENT_HASH = 'sha256:aaaa';

function makeNote(overrides: Partial<NoteState> = {}): NoteState {
  return {
    contentHash: 'sha256:ab12',
    remoteId: null,
    firstPublishedAt: '2026-08-11T00:00:00+09:00',
    lastPublishedAt: '2026-08-11T00:00:00+09:00',
    ...overrides,
  };
}

function makeAsset(overrides: Partial<AssetState> = {}): AssetState {
  return {
    key: 'notes/ab/ab12cd.png',
    url: 'https://assets.example.com/notes/ab/ab12cd.png',
    uploadedAt: '2026-08-11T00:00:00+09:00',
    ...overrides,
  };
}

function validStateFileObject(): Record<string, unknown> {
  return {
    version: CURRENT_STATE_VERSION,
    service: SERVICE,
    target: TARGET,
    notes: {
      [NOTE_UUID]: makeNote(),
    },
    assets: {
      [CONTENT_HASH]: makeAsset(),
    },
  };
}

describe('StateStore', () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'note2web-state-test-'));
    statePath = join(dir, 'zenn.state.json');
    renameOverride.impl = null;
  });

  afterEach(() => {
    renameOverride.impl = null;
    rmSync(dir, { recursive: true, force: true });
  });

  describe('load: fresh (no existing file)', () => {
    it('creates an in-memory state without touching disk', async () => {
      const store = await StateStore.load({ statePath, service: SERVICE, target: TARGET });

      expect(existsSync(statePath)).toBe(false);
      expect(store.getNote(NOTE_UUID)).toBeUndefined();
      expect(store.getAsset(CONTENT_HASH)).toBeUndefined();
      expect(store.hasAsset(CONTENT_HASH)).toBe(false);
    });

    it('records service/target/version correctly on the first persisted save', async () => {
      const store = await StateStore.load({ statePath, service: SERVICE, target: TARGET });
      const asset = makeAsset();

      await store.saveAsset(CONTENT_HASH, asset);

      const onDisk = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
      expect(onDisk).toEqual({
        version: CURRENT_STATE_VERSION,
        service: SERVICE,
        target: TARGET,
        notes: {},
        assets: { [CONTENT_HASH]: asset },
      });
    });
  });

  describe('load: validation failures (exitCode PRECONDITION_FAILURE)', () => {
    it('rejects on version mismatch', async () => {
      writeFileSync(
        statePath,
        JSON.stringify({ ...validStateFileObject(), version: 999 }, null, 2),
      );

      const error = await StateStore.load({ statePath, service: SERVICE, target: TARGET }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(StateValidationError);
      expect((error as InstanceType<typeof StateValidationError>).exitCode).toBe(
        PRECONDITION_FAILURE,
      );
    });

    it('rejects on service mismatch', async () => {
      writeFileSync(statePath, JSON.stringify(validStateFileObject(), null, 2));

      const error = await StateStore.load({
        statePath,
        service: 'hugo',
        target: TARGET,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(StateValidationError);
      expect((error as InstanceType<typeof StateValidationError>).exitCode).toBe(
        PRECONDITION_FAILURE,
      );
    });

    it('rejects on target mismatch', async () => {
      writeFileSync(statePath, JSON.stringify(validStateFileObject(), null, 2));

      const error = await StateStore.load({
        statePath,
        service: SERVICE,
        target: '/repos/other',
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(StateValidationError);
      expect((error as InstanceType<typeof StateValidationError>).exitCode).toBe(
        PRECONDITION_FAILURE,
      );
    });

    it('rejects on corrupt JSON', async () => {
      writeFileSync(statePath, '{ this is not valid json');

      const error = await StateStore.load({ statePath, service: SERVICE, target: TARGET }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(StateValidationError);
      expect((error as InstanceType<typeof StateValidationError>).exitCode).toBe(
        PRECONDITION_FAILURE,
      );
    });

    it('rejects on schema-invalid content (missing required field)', async () => {
      const invalid = validStateFileObject();
      delete (invalid.notes as Record<string, unknown>)[NOTE_UUID];
      (invalid.notes as Record<string, unknown>)[NOTE_UUID] = { contentHash: 'sha256:ab12' }; // missing remoteId etc.
      writeFileSync(statePath, JSON.stringify(invalid, null, 2));

      const error = await StateStore.load({ statePath, service: SERVICE, target: TARGET }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(StateValidationError);
      expect((error as InstanceType<typeof StateValidationError>).exitCode).toBe(
        PRECONDITION_FAILURE,
      );
    });

    it('rejects on schema-invalid content (unknown top-level key)', async () => {
      const invalid = { ...validStateFileObject(), unexpected: true };
      writeFileSync(statePath, JSON.stringify(invalid, null, 2));

      const error = await StateStore.load({ statePath, service: SERVICE, target: TARGET }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(StateValidationError);
      expect((error as InstanceType<typeof StateValidationError>).exitCode).toBe(
        PRECONDITION_FAILURE,
      );
    });

    it('reports a version mismatch even when the future version adds unknown fields', async () => {
      // 将来バージョンでフィールドが増えたファイルは .strict() の未知キー拒否にも
      // 該当するが、原因は「未知バージョン」としてユーザーに伝わるべき。
      const future = { ...validStateFileObject(), version: 2, addedInV2: true };
      writeFileSync(statePath, JSON.stringify(future, null, 2));

      const error = await StateStore.load({ statePath, service: SERVICE, target: TARGET }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(StateValidationError);
      expect((error as InstanceType<typeof StateValidationError>).message).toMatch(/version 2/);
      expect((error as InstanceType<typeof StateValidationError>).message).not.toMatch(
        /schema validation/,
      );
    });

    it('rejects when the state path exists but is not readable as a file (EISDIR)', async () => {
      // ENOENT(新規作成)以外の読み取り失敗経路。ディレクトリを statePath として
      // 渡すことでモックなしで再現できる。
      const error = await StateStore.load({
        statePath: dir,
        service: SERVICE,
        target: TARGET,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(StateValidationError);
      expect((error as InstanceType<typeof StateValidationError>).exitCode).toBe(
        PRECONDITION_FAILURE,
      );
    });
  });

  describe('load: round-trip', () => {
    it('loads back a file it previously saved', async () => {
      const first = await StateStore.load({ statePath, service: SERVICE, target: TARGET });
      const note = makeNote();
      const asset = makeAsset();
      await first.saveAsset(CONTENT_HASH, asset);
      await first.confirmNote(NOTE_UUID, note);

      const second = await StateStore.load({ statePath, service: SERVICE, target: TARGET });

      expect(second.getNote(NOTE_UUID)).toEqual(note);
      expect(second.getAsset(CONTENT_HASH)).toEqual(asset);
    });
  });

  describe('crash-safety', () => {
    it('leaves the existing state file untouched when rename fails mid-save', async () => {
      const bootstrap = await StateStore.load({ statePath, service: SERVICE, target: TARGET });
      await bootstrap.saveAsset(CONTENT_HASH, makeAsset());
      const originalRaw = readFileSync(statePath, 'utf8');

      const store = await StateStore.load({ statePath, service: SERVICE, target: TARGET });
      renameOverride.impl = () => Promise.reject(new Error('simulated crash during rename'));

      await expect(
        store.confirmNote(NOTE_UUID, makeNote({ contentHash: 'sha256:changed' })),
      ).rejects.toThrow('simulated crash during rename');

      expect(readFileSync(statePath, 'utf8')).toBe(originalRaw);

      // 一時ファイルも掃除されている(rename 失敗経路での後始末)。
      const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp-'));
      expect(leftovers).toHaveLength(0);
    });
  });

  describe('read-your-writes (memory view only)', () => {
    it('saveAsset is visible immediately via getAsset/hasAsset', async () => {
      const store = await StateStore.load({ statePath, service: SERVICE, target: TARGET });
      const asset = makeAsset();

      await store.saveAsset(CONTENT_HASH, asset);

      expect(store.getAsset(CONTENT_HASH)).toEqual(asset);
      expect(store.hasAsset(CONTENT_HASH)).toBe(true);
    });

    it('confirmNote is visible immediately via getNote', async () => {
      const store = await StateStore.load({ statePath, service: SERVICE, target: TARGET });
      const note = makeNote();

      await store.confirmNote(NOTE_UUID, note);

      expect(store.getNote(NOTE_UUID)).toEqual(note);
    });

    it('stageNote is visible immediately via getNote (before any flush)', async () => {
      const store = await StateStore.load({ statePath, service: SERVICE, target: TARGET });
      const note = makeNote();

      store.stageNote(NOTE_UUID, note);

      expect(store.getNote(NOTE_UUID)).toEqual(note);
    });
  });

  describe('single disk read (no re-read after load)', () => {
    it('getters keep returning load-time values after the file is overwritten externally', async () => {
      const bootstrap = await StateStore.load({ statePath, service: SERVICE, target: TARGET });
      const originalNote = makeNote({ contentHash: 'sha256:original' });
      await bootstrap.confirmNote(NOTE_UUID, originalNote);

      const store = await StateStore.load({ statePath, service: SERVICE, target: TARGET });

      // load 後に外部から状態ファイルを書き換える。
      const overwritten = {
        version: CURRENT_STATE_VERSION,
        service: SERVICE,
        target: TARGET,
        notes: {
          [NOTE_UUID]: makeNote({ contentHash: 'sha256:overwritten-externally' }),
        },
        assets: {},
      };
      writeFileSync(statePath, JSON.stringify(overwritten, null, 2));

      expect(store.getNote(NOTE_UUID)).toEqual(originalNote);
    });
  });

  describe('write points (exactly two)', () => {
    it('load and readers never write to disk', async () => {
      const store = await StateStore.load({ statePath, service: SERVICE, target: TARGET });
      store.getNote(NOTE_UUID);
      store.getAsset(CONTENT_HASH);
      store.hasAsset(CONTENT_HASH);

      expect(existsSync(statePath)).toBe(false);
    });

    it('saveAsset persists to disk', async () => {
      const store = await StateStore.load({ statePath, service: SERVICE, target: TARGET });
      const asset = makeAsset();

      await store.saveAsset(CONTENT_HASH, asset);

      const onDisk = JSON.parse(readFileSync(statePath, 'utf8')) as { assets: unknown };
      expect(onDisk.assets).toEqual({ [CONTENT_HASH]: asset });
    });

    it('confirmNote persists to disk', async () => {
      const store = await StateStore.load({ statePath, service: SERVICE, target: TARGET });
      const note = makeNote();

      await store.confirmNote(NOTE_UUID, note);

      const onDisk = JSON.parse(readFileSync(statePath, 'utf8')) as { notes: unknown };
      expect(onDisk.notes).toEqual({ [NOTE_UUID]: note });
    });

    it('stageNote does NOT persist to disk until flush() is called', async () => {
      const store = await StateStore.load({ statePath, service: SERVICE, target: TARGET });
      const note = makeNote();

      store.stageNote(NOTE_UUID, note);
      expect(existsSync(statePath)).toBe(false);

      // 他ノートも重ねてステージングできる。
      store.stageNote(OTHER_UUID, makeNote({ contentHash: 'sha256:other' }));
      expect(existsSync(statePath)).toBe(false);

      await store.flush();

      const onDisk = JSON.parse(readFileSync(statePath, 'utf8')) as { notes: unknown };
      expect(onDisk.notes).toEqual({
        [NOTE_UUID]: note,
        [OTHER_UUID]: makeNote({ contentHash: 'sha256:other' }),
      });
    });

    it('stageNote leaves an already-persisted file unchanged until flush()', async () => {
      const bootstrap = await StateStore.load({ statePath, service: SERVICE, target: TARGET });
      await bootstrap.confirmNote(NOTE_UUID, makeNote());
      const beforeStage = readFileSync(statePath, 'utf8');

      const store = await StateStore.load({ statePath, service: SERVICE, target: TARGET });
      store.stageNote(OTHER_UUID, makeNote({ contentHash: 'sha256:other' }));

      expect(readFileSync(statePath, 'utf8')).toBe(beforeStage);

      await store.flush();

      expect(readFileSync(statePath, 'utf8')).not.toBe(beforeStage);
      const onDisk = JSON.parse(readFileSync(statePath, 'utf8')) as { notes: unknown };
      expect(onDisk.notes).toEqual({
        [NOTE_UUID]: makeNote(),
        [OTHER_UUID]: makeNote({ contentHash: 'sha256:other' }),
      });
    });
  });
});
