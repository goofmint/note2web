import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { DependencyCheckError } from '../src/dependencies.js';
import { PARTIAL_FAILURE, PRECONDITION_FAILURE, SUCCESS } from '../src/exit-codes.js';
import type { SubprocessRunner } from '../src/exporter/apple-notes.js';
import { acquireLock, lockPathFor, releaseLock, type LockHandle } from '../src/lock.js';
import type { Logger } from '../src/logger.js';
import type { PutObjectParams, UploaderClient } from '../src/assets/uploader.js';
import type { Publisher, PublishResult, RenderedArticle } from '../src/publishers/types.js';
import type { NoteState, StateFile } from '../src/state/store.js';
import { runSync, type RunSyncOptions } from '../src/sync.js';
import type { RunSubprocessOptions } from '../src/subprocess.js';

/**
 * T-08(GitHub issue #13)の成果物。読み取り専用として扱う(`test/exporter.test.ts` と同じ
 * fixture-copy パターン。§12「結合」)。
 */
const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/parser-output/', import.meta.url));

// UUID は test/exporter.test.ts と同じ fixture 由来(design.md §12)。
const ARCHIVE_NOTE_UUID = '77777777-7777-4777-8777-777777777777'; // Archive/🚀 Launch Notes
const TECH_SALES_TABLE_UUID = '44444444-4444-4444-8444-444444444444';
const TECH_GROCERY_CHECKLIST_UUID = '55555555-5555-4555-8555-555555555555';
const TECH_WHITEBOARD_SKETCH_UUID = '66666666-6666-4666-8666-666666666666'; // 添付(画像)を持つ

// ---------------------------------------------------------------------------
// テスト用ヘルパー(test/exporter.test.ts / test/asset-uploader.test.ts のパターンを踏襲)。
// ---------------------------------------------------------------------------

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    service: 'qiita',
    timezone: 'Asia/Tokyo',
    source: { folders: ['Archive'] },
    assets: {
      provider: 'r2',
      bucket: 'blog-assets',
      endpoint: 'https://example-account.r2.cloudflarestorage.com',
      region: 'auto',
      prefix: 'notes/',
      public_base_url: 'https://assets.example.com/notes/',
      access_key_id_env: 'R2_ACCESS_KEY_ID',
      secret_access_key_env: 'R2_SECRET_ACCESS_KEY',
    },
    qiita: { workspace: '/workspaces/qiita', token_env: 'QIITA_TOKEN' },
    ...overrides,
  };
}

function buildGitConfig(overrides: Partial<Config> = {}): Config {
  return buildConfig({
    service: 'zenn',
    qiita: undefined,
    git: {
      repo_path: '/repos/zenn-content',
      base_branch: 'main',
      output_dir: 'articles',
      auto_merge: true,
    },
    ...overrides,
  });
}

function createFakeLogger(): { logger: Logger; events: string[] } {
  const events: string[] = [];
  const logger: Logger = {
    runStart: vi.fn(() => {
      events.push('run_start');
    }),
    runEnd: vi.fn((payload) => {
      events.push(
        `run_end:${String(payload.published)}/${String(payload.skipped)}/${String(payload.failed)}`,
      );
    }),
    exportDone: vi.fn((payload) => {
      events.push(`export_done:${String(payload.noteCount)}`);
    }),
    notePublished: vi.fn((payload) => {
      events.push(`note_published:${payload.noteUuid}:${payload.result}`);
    }),
    noteSkipped: vi.fn((payload) => {
      events.push(`note_skipped:${payload.noteUuid}`);
    }),
    noteFailed: vi.fn((payload) => {
      events.push(`note_failed:${payload.noteUuid}`);
    }),
    assetUploaded: vi.fn((payload) => {
      events.push(`asset_uploaded:${payload.assetHash}`);
    }),
    warn: vi.fn((payload) => {
      events.push(`warn:${payload.message}`);
    }),
  };
  return { logger, events };
}

interface MockPublisherOptions {
  publishImpl?: (article: RenderedArticle, prev: NoteState | null) => Promise<PublishResult>;
  withPrepare?: boolean;
  withFinalize?: boolean;
  finalizeImpl?: () => Promise<void>;
}

interface MockPublisherHandle {
  publisher: Publisher;
  publishCalls: Array<{ article: RenderedArticle; prev: NoteState | null }>;
  readonly prepareCalls: number;
  readonly finalizeCalls: number;
}

/** design.md §5.7 の `Publisher` を満たすモック(記録可能・成否/finalize 挙動を設定可能)。 */
function createMockPublisher(options: MockPublisherOptions = {}): MockPublisherHandle {
  const publishCalls: MockPublisherHandle['publishCalls'] = [];
  const counters = { prepareCalls: 0, finalizeCalls: 0 };

  const publisher: Publisher = {
    async publish(article, prev) {
      publishCalls.push({ article, prev });
      if (options.publishImpl) {
        return options.publishImpl(article, prev);
      }
      return {
        result: prev === null ? 'created' : 'updated',
        remoteId: `remote-${article.noteUuid}`,
        url: `https://example.test/articles/${article.noteUuid}`,
      };
    },
  };

  if (options.withPrepare === true) {
    publisher.prepare = async () => {
      counters.prepareCalls += 1;
    };
  }

  if (options.withFinalize === true) {
    publisher.finalize = async () => {
      counters.finalizeCalls += 1;
      if (options.finalizeImpl) {
        await options.finalizeImpl();
      }
    };
  }

  return {
    publisher,
    publishCalls,
    get prepareCalls() {
      return counters.prepareCalls;
    },
    get finalizeCalls() {
      return counters.finalizeCalls;
    },
  };
}

function createFakeUploaderClient(): UploaderClient & { putObjectCalls: PutObjectParams[] } {
  const putObjectCalls: PutObjectParams[] = [];
  return {
    putObjectCalls,
    async putObject(params) {
      putObjectCalls.push(params);
    },
  };
}

/**
 * `RunSubprocessOptions` → `Promise<RunSubprocessResult>` を満たすフェイク。呼ばれると
 * `-o` 引数の指す出力先へ T-08 の fixture ツリーを再帰コピーする(test/exporter.test.ts と
 * 同じパターン)。
 */
function makeFixtureRunner(afterCopy?: (outDir: string) => Promise<void>): {
  runner: SubprocessRunner;
  calls: RunSubprocessOptions[];
} {
  const calls: RunSubprocessOptions[] = [];
  const runner: SubprocessRunner = async (options) => {
    calls.push(options);
    const outIndex = options.args.indexOf('-o');
    const outDir = outIndex >= 0 ? options.args[outIndex + 1] : undefined;
    if (outDir === undefined) {
      throw new Error('test fixture runner: -o argument not found in args');
    }
    await cp(FIXTURE_ROOT, outDir, { recursive: true });
    await afterCopy?.(outDir);
    return { status: 'success', exitCode: 0, signal: null, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

/** parser 実行自体を失敗させるランナー(design.md §10「parser の実行失敗」)。 */
function makeFailingRunner(): { runner: SubprocessRunner; calls: RunSubprocessOptions[] } {
  const calls: RunSubprocessOptions[] = [];
  const runner: SubprocessRunner = async (options) => {
    calls.push(options);
    return {
      status: 'failure',
      classification: 'exit_code',
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'boom',
    };
  };
  return { runner, calls };
}

const NOOP_CHECK_DEPENDENCIES = async (): Promise<void> => {
  // このテストスイートは runSync の統合(design.md §6)を検証する対象であり、
  // checkDependencies 自体のロジックは src/dependencies.test.ts で個別に検証済み。
  // ホスト環境の実コマンド(ruby/git/gh 等)の有無に左右されないよう常に成功させる。
};

const FIXED_NOW = () => new Date('2026-08-11T00:00:00Z');

function readStateFile(statePath: string): StateFile {
  return JSON.parse(readFileSync(statePath, 'utf8')) as StateFile;
}

// ---------------------------------------------------------------------------
// テスト本体。
// ---------------------------------------------------------------------------

describe('runSync', () => {
  let exportWorkDir: string;
  let stateDir: string;
  let statePath: string;

  beforeEach(async () => {
    exportWorkDir = await mkdtemp(join(tmpdir(), 'note2web-sync-test-export-'));
    stateDir = await mkdtemp(join(tmpdir(), 'note2web-sync-test-state-'));
    statePath = join(stateDir, 'note2web.state.json');
  });

  afterEach(async () => {
    await rm(exportWorkDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  function baseOptions(
    overrides: Partial<RunSyncOptions> = {},
  ): Omit<RunSyncOptions, 'config' | 'publisher'> {
    return {
      statePath,
      now: FIXED_NOW,
      checkDependenciesFn: NOOP_CHECK_DEPENDENCIES,
      uploaderClient: createFakeUploaderClient(),
      logger: createFakeLogger().logger,
      ...overrides,
    };
  }

  it('scenario 1: all-success — exit 0, publishes every note, and confirms state on disk immediately (API/CLI mode)', async () => {
    const { runner } = makeFixtureRunner();
    const { logger, events } = createFakeLogger();
    const mock = createMockPublisher();
    const uploaderClient = createFakeUploaderClient();

    const result = await runSync({
      config: buildConfig({ source: { folders: ['Archive'] } }),
      publisher: mock.publisher,
      ...baseOptions({ runner, tmpDirFactory: async () => exportWorkDir, logger, uploaderClient }),
    });

    expect(result).toMatchObject({ exitCode: SUCCESS, published: 1, skipped: 0, failed: 0 });
    expect(mock.publishCalls).toHaveLength(1);
    expect(mock.publishCalls[0]?.prev).toBeNull();

    expect(events[0]).toBe('run_start');
    expect(events).toContain(`note_published:${ARCHIVE_NOTE_UUID}:created`);
    expect(events[events.length - 1]).toBe('run_end:1/0/0');

    const onDisk = readStateFile(statePath);
    const entry = onDisk.notes[ARCHIVE_NOTE_UUID];
    expect(entry).toBeDefined();
    expect(entry?.remoteId).toBe(`remote-${ARCHIVE_NOTE_UUID}`);
    expect(entry?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry?.firstPublishedAt).toBe(entry?.lastPublishedAt);
    expect(entry?.firstPublishedAt).toBe('2026-08-11T09:00:00+09:00');

    // 一時エクスポートディレクトリ・ロックの後片付けが行われていること(design.md §6 手順8)。
    expect(existsSync(exportWorkDir)).toBe(false);
    expect(existsSync(lockPathFor(statePath))).toBe(false);
  });

  it('scenario 2: all-skip on re-run — second run detects an unchanged content hash, skips, and never calls publish', async () => {
    const first = makeFixtureRunner();
    const firstMock = createMockPublisher();
    const config = buildConfig({ source: { folders: ['Archive'] } });

    const firstResult = await runSync({
      config,
      publisher: firstMock.publisher,
      ...baseOptions({ runner: first.runner, tmpDirFactory: async () => exportWorkDir }),
    });
    expect(firstResult.exitCode).toBe(SUCCESS);
    expect(firstResult.published).toBe(1);

    // 2回目実行用に別の一時エクスポートディレクトリを使う(fixture の内容は同一のため、
    // アセットのハッシュ・本文とも決定的に同じになり、状態上のハッシュと一致する)。
    const secondWorkDir = await mkdtemp(join(tmpdir(), 'note2web-sync-test-export-2-'));
    try {
      const second = makeFixtureRunner();
      const secondMock = createMockPublisher();
      const { logger, events } = createFakeLogger();

      const secondResult = await runSync({
        config,
        publisher: secondMock.publisher,
        ...baseOptions({ runner: second.runner, tmpDirFactory: async () => secondWorkDir, logger }),
      });

      expect(secondResult).toMatchObject({
        exitCode: SUCCESS,
        published: 0,
        skipped: 1,
        failed: 0,
      });
      expect(secondMock.publishCalls).toHaveLength(0);
      expect(events).toContain(`note_skipped:${ARCHIVE_NOTE_UUID}`);
    } finally {
      await rm(secondWorkDir, { recursive: true, force: true });
    }
  });

  it('scenario 3: partial failure — isolates the failing note, exit 1, other notes confirmed, failed note left untouched (NFR-06)', async () => {
    const { runner } = makeFixtureRunner();
    const { logger, events } = createFakeLogger();
    const mock = createMockPublisher({
      publishImpl: async (article, prev) => {
        if (article.noteUuid === TECH_WHITEBOARD_SKETCH_UUID) {
          throw new Error('simulated publish failure');
        }
        return {
          result: prev === null ? 'created' : 'updated',
          remoteId: `remote-${article.noteUuid}`,
        };
      },
    });

    const result = await runSync({
      config: buildConfig({ source: { folders: ['Tech'] } }),
      publisher: mock.publisher,
      ...baseOptions({ runner, tmpDirFactory: async () => exportWorkDir, logger }),
    });

    // Tech ルート3件 + Archive(Tech 配下)1件 = 4件、うち1件が失敗。
    expect(result).toMatchObject({
      exitCode: PARTIAL_FAILURE,
      published: 3,
      skipped: 0,
      failed: 1,
    });
    expect(events).toContain(`note_failed:${TECH_WHITEBOARD_SKETCH_UUID}`);
    expect(events[events.length - 1]).toBe('run_end:3/0/1');

    const onDisk = readStateFile(statePath);
    expect(onDisk.notes[TECH_WHITEBOARD_SKETCH_UUID]).toBeUndefined();
    expect(onDisk.notes[TECH_SALES_TABLE_UUID]).toBeDefined();
    expect(onDisk.notes[TECH_GROCERY_CHECKLIST_UUID]).toBeDefined();
    expect(onDisk.notes[ARCHIVE_NOTE_UUID]).toBeDefined();

    // design.md §5.6 書き込みポイント1: アセットアップロード成功は、後段のノート失敗
    // (Whiteboard Sketch 自身の publish 失敗)があっても維持される。
    expect(Object.keys(onDisk.assets)).toHaveLength(1);
  });

  it('scenario 4: all-fail — exit 1, no state entries are confirmed', async () => {
    const { runner } = makeFixtureRunner();
    const { logger, events } = createFakeLogger();
    const mock = createMockPublisher({
      publishImpl: async () => {
        throw new Error('simulated publish failure');
      },
    });

    const result = await runSync({
      config: buildConfig({ source: { folders: ['Tech'] } }),
      publisher: mock.publisher,
      ...baseOptions({ runner, tmpDirFactory: async () => exportWorkDir, logger }),
    });

    expect(result).toMatchObject({
      exitCode: PARTIAL_FAILURE,
      published: 0,
      skipped: 0,
      failed: 4,
    });
    expect(events.filter((event) => event.startsWith('note_failed:'))).toHaveLength(4);

    // 状態 JSON は「新規」からアセットの書き込みポイントでしか作られないため、ここでは
    // アセット1件(Whiteboard Sketch)のみが記録され、notes は空のままである。
    const onDisk = readStateFile(statePath);
    expect(onDisk.notes).toEqual({});
  });

  it('scenario 5: parser failure — aborts the whole run at exit 1 before touching any note or the Publisher', async () => {
    const { runner, calls } = makeFailingRunner();
    const { logger, events } = createFakeLogger();
    const mock = createMockPublisher();

    const result = await runSync({
      config: buildConfig({ source: { folders: ['Archive'] } }),
      publisher: mock.publisher,
      ...baseOptions({ runner, tmpDirFactory: async () => exportWorkDir, logger }),
    });

    expect(result.exitCode).toBe(PARTIAL_FAILURE);
    expect(result.published).toBe(0);
    expect(result.failed).toBe(0);
    expect(calls).toHaveLength(1);
    expect(mock.publishCalls).toHaveLength(0);
    // 前提条件不成立に準ずる中断(design.md §10)のため run_end は発行しない。
    expect(events).toContain('run_start');
    expect(events.some((event) => event.startsWith('run_end'))).toBe(false);

    expect(existsSync(statePath)).toBe(false);
    expect(existsSync(lockPathFor(statePath))).toBe(false);
  });

  it('scenario 6: lock held — exits 2 immediately without exporting or publishing anything', async () => {
    const holderLock: LockHandle = acquireLock(lockPathFor(statePath));
    try {
      const { runner, calls } = makeFixtureRunner();
      const mock = createMockPublisher();

      const result = await runSync({
        config: buildConfig({ source: { folders: ['Archive'] } }),
        publisher: mock.publisher,
        ...baseOptions({ runner, tmpDirFactory: async () => exportWorkDir }),
      });

      expect(result.exitCode).toBe(PRECONDITION_FAILURE);
      expect(result.published).toBe(0);
      expect(calls).toHaveLength(0);
      expect(mock.publishCalls).toHaveLength(0);
      // 保持者のロックは奪われず、そのまま残っている。
      expect(existsSync(lockPathFor(statePath))).toBe(true);
    } finally {
      releaseLock(holderLock);
    }
  });

  it('scenario 7: missing dependency — exits 2 before acquiring the lock or exporting anything', async () => {
    const { runner, calls } = makeFixtureRunner();
    const mock = createMockPublisher();

    const result = await runSync({
      config: buildConfig({ source: { folders: ['Archive'] } }),
      publisher: mock.publisher,
      ...baseOptions({
        runner,
        tmpDirFactory: async () => exportWorkDir,
        checkDependenciesFn: async () => {
          throw new DependencyCheckError([
            { message: 'required command "ruby" was not found on PATH' },
          ]);
        },
      }),
    });

    expect(result.exitCode).toBe(PRECONDITION_FAILURE);
    expect(result.error).toMatch(/ruby/);
    expect(calls).toHaveLength(0);
    expect(mock.publishCalls).toHaveLength(0);
    // 依存チェックはロック取得より前(design.md §6)。ロックファイルは作られない。
    expect(existsSync(lockPathFor(statePath))).toBe(false);
  });

  it('scenario 8: git mode staging — state is not persisted until finalize() succeeds, then flushed', async () => {
    const { runner } = makeFixtureRunner();
    const { logger } = createFakeLogger();
    let statePathExistedDuringFinalize: boolean | undefined;
    const mock = createMockPublisher({
      withFinalize: true,
      finalizeImpl: async () => {
        statePathExistedDuringFinalize = existsSync(statePath);
      },
    });

    const result = await runSync({
      config: buildGitConfig({ source: { folders: ['Archive'] } }),
      publisher: mock.publisher,
      ...baseOptions({ runner, tmpDirFactory: async () => exportWorkDir, logger }),
    });

    expect(result).toMatchObject({ exitCode: SUCCESS, published: 1, skipped: 0, failed: 0 });
    expect(mock.publishCalls).toHaveLength(1);
    expect(mock.finalizeCalls).toBe(1);
    // finalize() が呼ばれた時点では、まだ state.flush() されておらずディスク上に無い
    // (design.md §5.6 書き込みポイント2: Git モードは finalize() の PR 作成成功後に一括)。
    expect(statePathExistedDuringFinalize).toBe(false);

    // finalize() 成功後に flush() され、ディスクに反映されている。
    const onDisk = readStateFile(statePath);
    expect(onDisk.notes[ARCHIVE_NOTE_UUID]).toBeDefined();
  });

  it('scenario 8b: git mode finalize failure — staged notes are never flushed, exit 1', async () => {
    const { runner } = makeFixtureRunner();
    const { logger, events } = createFakeLogger();
    const mock = createMockPublisher({
      withFinalize: true,
      finalizeImpl: async () => {
        throw new Error('simulated PR creation failure');
      },
    });

    const result = await runSync({
      config: buildGitConfig({ source: { folders: ['Archive'] } }),
      publisher: mock.publisher,
      ...baseOptions({ runner, tmpDirFactory: async () => exportWorkDir, logger }),
    });

    expect(result.exitCode).toBe(PARTIAL_FAILURE);
    expect(mock.publishCalls).toHaveLength(1);
    expect(mock.finalizeCalls).toBe(1);
    expect(events.some((event) => event.startsWith('warn:'))).toBe(true);

    // 保留(stageNote)されたエントリは一切ディスクへ書かれない。
    expect(existsSync(statePath)).toBe(false);
  });

  it('calls Publisher.prepare() before exporting when the git-mode Publisher defines it', async () => {
    const { runner } = makeFixtureRunner();
    const mock = createMockPublisher({ withPrepare: true, withFinalize: true });

    await runSync({
      config: buildGitConfig({ source: { folders: ['Archive'] } }),
      publisher: mock.publisher,
      ...baseOptions({ runner, tmpDirFactory: async () => exportWorkDir }),
    });

    expect(mock.prepareCalls).toBe(1);
  });

  it('does not call Publisher.prepare()/finalize() for API/CLI-mode services even when defined', async () => {
    const { runner } = makeFixtureRunner();
    const mock = createMockPublisher({ withPrepare: true, withFinalize: true });

    const result = await runSync({
      config: buildConfig({ source: { folders: ['Archive'] } }),
      publisher: mock.publisher,
      ...baseOptions({ runner, tmpDirFactory: async () => exportWorkDir }),
    });

    expect(result.exitCode).toBe(SUCCESS);
    expect(mock.prepareCalls).toBe(0);
    expect(mock.finalizeCalls).toBe(0);
    // API/CLI モードは publish() 成功ごとに即時確定(design.md §5.6)。
    const onDisk = readStateFile(statePath);
    expect(onDisk.notes[ARCHIVE_NOTE_UUID]).toBeDefined();
  });
});
