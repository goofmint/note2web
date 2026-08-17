import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import type {
  FinalizeOutcome,
  Publisher,
  PublishResult,
  RenderedArticle,
} from '../src/publishers/types.js';
import type { NoteState, StateFile } from '../src/state/store.js';
import { runSync, type RunSyncOptions } from '../src/sync.js';
import type { RunSubprocessOptions } from '../src/subprocess.js';
import { renderZennArticle } from '../src/publishers/zenn.js';

/**
 * `node:fs/promises` の `rename` だけを差し替え可能にするモック(`test/state.test.ts` と
 * 同じパターン)。`src/state/store.ts` の `persist()`(`confirmNote`/`flush` の実体)が
 * この `rename` を経由するため、CodeRabbit review(PR #47)が要求する「publish() は
 * 成功したが状態の確定保存が失敗するケース」を、実ファイルシステムの権限操作(root では
 * 意味を成さない)に頼らず決定的に再現できる。
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
  prepareImpl?: () => Promise<void>;
  withFinalize?: boolean;
  /**
   * T-16(issue #21)で `Publisher.finalize()` の戻り値が `FinalizeOutcome` になった
   * (`src/publishers/types.ts` 参照)。既定は `{ persist: true }`(旧来の「finalize が
   * 例外を投げなければ確定・flush」という挙動と等価)。
   */
  finalizeImpl?: () => Promise<FinalizeOutcome>;
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
      if (options.prepareImpl) {
        await options.prepareImpl();
      }
    };
  }

  if (options.withFinalize === true) {
    publisher.finalize = async () => {
      counters.finalizeCalls += 1;
      if (options.finalizeImpl) {
        return options.finalizeImpl();
      }
      return { persist: true };
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

const NOOP_CHECK_GIT_AUTH = async (): Promise<void> => {
  // T-16(issue #21)で追加した `checkGitAuthFn` の既定は実 `gh auth status` / `gh repo view`
  // を呼ぶため、ホスト環境の `gh` コマンド・`GH_TOKEN` の有無に依存させないよう、
  // このテストスイートの既定では常に成功させる(`src/git-auth.test.ts` で個別に検証)。
  // 認証・権限チェック自体を検証するテストだけがこれを上書きする。
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
    renameOverride.impl = null;
  });

  function baseOptions(
    overrides: Partial<RunSyncOptions> = {},
  ): Omit<RunSyncOptions, 'config' | 'publisher'> {
    return {
      statePath,
      now: FIXED_NOW,
      checkDependenciesFn: NOOP_CHECK_DEPENDENCIES,
      checkGitAuthFn: NOOP_CHECK_GIT_AUTH,
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
      withPrepare: true,
      withFinalize: true,
      finalizeImpl: async () => {
        statePathExistedDuringFinalize = existsSync(statePath);
        return { persist: true };
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
      withPrepare: true,
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

  // -------------------------------------------------------------------------
  // T-16(issue #21)対応分: `FinalizeOutcome`(persist/failed の独立した2軸)。
  // -------------------------------------------------------------------------

  it('scenario 8c: git mode zero-diff (persist: false) — exit 0, but staged notes are not flushed to disk', async () => {
    const { runner } = makeFixtureRunner();
    const { logger, events } = createFakeLogger();
    const mock = createMockPublisher({
      withPrepare: true,
      withFinalize: true,
      finalizeImpl: async () => ({ persist: false }),
    });

    const result = await runSync({
      config: buildGitConfig({ source: { folders: ['Archive'] } }),
      publisher: mock.publisher,
      ...baseOptions({ runner, tmpDirFactory: async () => exportWorkDir, logger }),
    });

    // design.md §5.7 手順3「差分ゼロならブランチを削除して終了」: PR が作られていないため
    // 確定基準(手順4)を満たさず、実行自体は失敗でもない(exit 0)。
    expect(result.exitCode).toBe(SUCCESS);
    expect(mock.publishCalls).toHaveLength(1);
    expect(mock.finalizeCalls).toBe(1);
    // issue #72: fixture の json/all_notes_1.json は `skipped_encrypted`/`skipped_errors`
    // を1件ずつ持ち、Exporter はフォルダの絞り込みに関わらず両方に対して必ず
    // `logger.warn` を発行する(design.md §5.2「対象内ノートの1件の失敗で全体を中断しない」)。
    // これはこのシナリオ(zero-diff)の検証対象ではないため、その2件を除いた「その他の
    // 予期しない warning が無い」ことだけを検証する。ただし CodeRabbit review(issue #73)
    // の指摘どおり、除外する前に両方の UUID の warning が実際に存在することを明示的に
    // 確認しておく(そうしないと、以下の `unexpectedWarnings` が空になる理由が
    // 「両方とも期待どおり発行されたから」なのか「Exporter がそもそも何も warn していない
    // だけ」なのかを区別できない)。
    expect(
      events.some(
        (event) =>
          event.startsWith('warn:') && event.includes('ffffffff-6666-4fff-8fff-ffffffffffff'),
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.startsWith('warn:') && event.includes('12121212-7777-4121-8121-121212121212'),
      ),
    ).toBe(true);

    const unexpectedWarnings = events.filter(
      (event) =>
        event.startsWith('warn:') &&
        !event.includes('ffffffff-6666-4fff-8fff-ffffffffffff') &&
        !event.includes('12121212-7777-4121-8121-121212121212'),
    );
    expect(unexpectedWarnings).toEqual([]);
    expect(existsSync(statePath)).toBe(false);
  });

  it('scenario 8d: git mode auto_merge merge failure (persist: true, failed: true) — state IS persisted, but the run is reported failed (exit 1)', async () => {
    const { runner } = makeFixtureRunner();
    const { logger, events } = createFakeLogger();
    const mock = createMockPublisher({
      withPrepare: true,
      withFinalize: true,
      finalizeImpl: async () => ({
        persist: true,
        failed: true,
        reason: 'gh pr merge failed: branch protection rules prevent merging',
      }),
    });

    const result = await runSync({
      config: buildGitConfig({ source: { folders: ['Archive'] } }),
      publisher: mock.publisher,
      ...baseOptions({ runner, tmpDirFactory: async () => exportWorkDir, logger }),
    });

    // issue #21「auto_merge のマージ失敗時は状態保存済みのまま失敗扱い」。
    expect(result.exitCode).toBe(PARTIAL_FAILURE);
    expect(mock.finalizeCalls).toBe(1);
    expect(
      events.some((event) => event.startsWith('warn:') && event.includes('branch protection')),
    ).toBe(true);

    const onDisk = readStateFile(statePath);
    expect(onDisk.notes[ARCHIVE_NOTE_UUID]).toBeDefined();
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

  // -------------------------------------------------------------------------
  // CodeRabbit review (PR #47) 対応分。
  // -------------------------------------------------------------------------

  it('scenario 9a: git-mode Publisher missing prepare() — exit 2 before acquiring the lock or exporting anything', async () => {
    const { runner, calls } = makeFixtureRunner();
    const mock = createMockPublisher({ withPrepare: false, withFinalize: true });

    const result = await runSync({
      config: buildGitConfig({ source: { folders: ['Archive'] } }),
      publisher: mock.publisher,
      ...baseOptions({ runner, tmpDirFactory: async () => exportWorkDir }),
    });

    expect(result.exitCode).toBe(PRECONDITION_FAILURE);
    // 不足 hook の動的部分(missing: 以降)を検証する(固定文言だけでは 9a/9b を区別できない)。
    expect(result.error).toContain('missing: prepare');
    expect(result.error).not.toContain('missing: prepare, finalize');
    expect(calls).toHaveLength(0);
    expect(mock.publishCalls).toHaveLength(0);
    expect(mock.finalizeCalls).toBe(0);
    // 検証はロック取得より前(design.md §5.7 の JSDoc / CodeRabbit review, PR #47)。
    expect(existsSync(lockPathFor(statePath))).toBe(false);
  });

  it('scenario 9b: git-mode Publisher missing finalize() — exit 2 before acquiring the lock or exporting anything', async () => {
    const { runner, calls } = makeFixtureRunner();
    const mock = createMockPublisher({ withPrepare: true, withFinalize: false });

    const result = await runSync({
      config: buildGitConfig({ source: { folders: ['Archive'] } }),
      publisher: mock.publisher,
      ...baseOptions({ runner, tmpDirFactory: async () => exportWorkDir }),
    });

    expect(result.exitCode).toBe(PRECONDITION_FAILURE);
    expect(result.error).toContain('missing: finalize');
    expect(calls).toHaveLength(0);
    expect(mock.publishCalls).toHaveLength(0);
    expect(mock.prepareCalls).toBe(0);
    expect(existsSync(lockPathFor(statePath))).toBe(false);
  });

  it('scenario 9c: git-mode Publisher missing both prepare() and finalize() — exit 2, message names both', async () => {
    const { runner, calls } = makeFixtureRunner();
    const mock = createMockPublisher({ withPrepare: false, withFinalize: false });

    const result = await runSync({
      config: buildGitConfig({ source: { folders: ['Archive'] } }),
      publisher: mock.publisher,
      ...baseOptions({ runner, tmpDirFactory: async () => exportWorkDir }),
    });

    expect(result.exitCode).toBe(PRECONDITION_FAILURE);
    expect(result.error).toContain('missing: prepare, finalize');
    expect(calls).toHaveLength(0);
  });

  it('scenario 9d: API/CLI-mode Publisher without prepare()/finalize() is not affected by the git-mode contract check', async () => {
    const { runner } = makeFixtureRunner();
    // withPrepare/withFinalize 既定は false: このモックは prepare/finalize を一切持たない。
    const mock = createMockPublisher();

    const result = await runSync({
      config: buildConfig({ source: { folders: ['Archive'] } }),
      publisher: mock.publisher,
      ...baseOptions({ runner, tmpDirFactory: async () => exportWorkDir }),
    });

    expect(result.exitCode).toBe(SUCCESS);
  });

  // -------------------------------------------------------------------------
  // T-16(issue #21)対応分: GH_TOKEN 認証・リポジトリ権限の事前検証
  // (`src/git-auth.ts` の `checkGitModeAuthAndPermission`。design.md §5.7)。
  // -------------------------------------------------------------------------

  it('scenario 12a: "gh auth status" failure — exit 2 before the lock, export, prepare(), or any Publisher call; StateStore untouched', async () => {
    const { runner, calls } = makeFixtureRunner();
    const mock = createMockPublisher({ withPrepare: true, withFinalize: true });

    const result = await runSync({
      config: buildGitConfig({ source: { folders: ['Archive'] } }),
      publisher: mock.publisher,
      ...baseOptions({
        runner,
        tmpDirFactory: async () => exportWorkDir,
        checkGitAuthFn: async () => {
          throw new DependencyCheckError([
            {
              message:
                '"gh auth status" failed (design.md §5.7 GH_TOKEN authentication): not logged in',
            },
          ]);
        },
      }),
    });

    expect(result.exitCode).toBe(PRECONDITION_FAILURE);
    expect(result.error).toMatch(/gh auth status/);
    // Git / gh の書き込み副作用(prepare() のブランチ作成含む)は一切行われない。
    expect(calls).toHaveLength(0);
    expect(mock.prepareCalls).toBe(0);
    expect(mock.publishCalls).toHaveLength(0);
    expect(mock.finalizeCalls).toBe(0);
    // ロック・状態 JSON のいずれも作られない。
    expect(existsSync(lockPathFor(statePath))).toBe(false);
    expect(existsSync(statePath)).toBe(false);
  });

  it('scenario 12b: insufficient push/PR permission on the target repository — exit 2 before any Git/gh write or Publisher call; StateStore untouched', async () => {
    const { runner, calls } = makeFixtureRunner();
    const mock = createMockPublisher({ withPrepare: true, withFinalize: true });

    const result = await runSync({
      config: buildGitConfig({ source: { folders: ['Archive'] } }),
      publisher: mock.publisher,
      ...baseOptions({
        runner,
        tmpDirFactory: async () => exportWorkDir,
        checkGitAuthFn: async () => {
          throw new DependencyCheckError([
            {
              message:
                'insufficient push/PR permission on target repository (/repos/zenn-content): ' +
                'viewerPermission="READ" (need one of WRITE/MAINTAIN/ADMIN, design.md §5.7)',
            },
          ]);
        },
      }),
    });

    expect(result.exitCode).toBe(PRECONDITION_FAILURE);
    expect(result.error).toMatch(/insufficient push\/PR permission/);
    expect(calls).toHaveLength(0);
    expect(mock.prepareCalls).toBe(0);
    expect(mock.publishCalls).toHaveLength(0);
    expect(mock.finalizeCalls).toBe(0);
    expect(existsSync(lockPathFor(statePath))).toBe(false);
    expect(existsSync(statePath)).toBe(false);
  });

  it('scenario 12c: the git-auth check runs after checkDependencies/validateGitModePublisherContract but before lock acquisition', async () => {
    const { runner, calls } = makeFixtureRunner();
    const mock = createMockPublisher({ withPrepare: true, withFinalize: true });
    const order: string[] = [];

    const result = await runSync({
      config: buildGitConfig({ source: { folders: ['Archive'] } }),
      publisher: mock.publisher,
      ...baseOptions({
        runner,
        tmpDirFactory: async () => exportWorkDir,
        checkDependenciesFn: async () => {
          order.push('checkDependencies');
        },
        checkGitAuthFn: async () => {
          order.push('checkGitAuth');
          throw new DependencyCheckError([{ message: 'auth failed' }]);
        },
        acquireLockFn: (path) => {
          order.push('acquireLock');
          return acquireLock(path);
        },
      }),
    });

    expect(result.exitCode).toBe(PRECONDITION_FAILURE);
    expect(order).toEqual(['checkDependencies', 'checkGitAuth']);
    expect(calls).toHaveLength(0);
  });

  it('scenario 10: Publisher.prepare() failure aborts the run at exit 1 before exporting anything', async () => {
    const { runner, calls } = makeFixtureRunner();
    const { logger, events } = createFakeLogger();
    const mock = createMockPublisher({
      withPrepare: true,
      withFinalize: true,
      prepareImpl: async () => {
        throw new Error('simulated branch creation failure');
      },
    });

    const result = await runSync({
      config: buildGitConfig({ source: { folders: ['Archive'] } }),
      publisher: mock.publisher,
      ...baseOptions({ runner, tmpDirFactory: async () => exportWorkDir, logger }),
    });

    expect(result.exitCode).toBe(PARTIAL_FAILURE);
    expect(result.error).toMatch(/prepare/i);
    expect(mock.prepareCalls).toBe(1);
    // prepare() が失敗した以上、ブランチが存在しないためエクスポート・配信は一切行わない。
    expect(calls).toHaveLength(0);
    expect(mock.publishCalls).toHaveLength(0);
    expect(mock.finalizeCalls).toBe(0);
    expect(events.some((event) => event.startsWith('warn:'))).toBe(true);
    // 前提条件不成立に準ずる中断のため run_end は発行しない。
    expect(events.some((event) => event.startsWith('run_end'))).toBe(false);
  });

  it('scenario 11: note_published is emitted only after state persistence succeeds; a confirmNote failure logs note_failed instead (API/CLI mode)', async () => {
    const { runner } = makeFixtureRunner();
    const { logger, events } = createFakeLogger();
    const mock = createMockPublisher();

    renameOverride.impl = () => {
      throw new Error('simulated disk failure during state persistence');
    };

    const result = await runSync({
      config: buildConfig({ source: { folders: ['Archive'] } }),
      publisher: mock.publisher,
      ...baseOptions({ runner, tmpDirFactory: async () => exportWorkDir, logger }),
    });

    // publish() 自体は成功しているが、confirmNote(状態確定)が失敗したのでノートは failed。
    expect(result).toMatchObject({
      exitCode: PARTIAL_FAILURE,
      published: 0,
      skipped: 0,
      failed: 1,
    });
    expect(mock.publishCalls).toHaveLength(1);
    expect(events).toContain(`note_failed:${ARCHIVE_NOTE_UUID}`);
    expect(events.some((event) => event.startsWith(`note_published:${ARCHIVE_NOTE_UUID}`))).toBe(
      false,
    );

    // 状態 JSON には一切反映されない(NFR-06。次回再試行される)。
    expect(existsSync(statePath)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // T-17(issue #22)対応分: 実際の renderZennArticle を注入した E2E — type 不正ノートの隔離
  // (FR-24)。cli.ts が config.service === 'zenn' のとき自動的に選ぶ Renderer
  // (`src/publishers/factory.ts` の `resolveRenderer`)を、ここでは明示的に `renderNote` へ
  // 注入して runSync レベルで検証する。fixture のフォルダ名(Tech/Archive/Dev/Ops: Log)は
  // どれも Zenn の type 制約(フォルダパスを葉から根へ遡り、最初に一致した tech/idea を採用)
  // を満たさないため、対象ノート1件だけを JSON 上で新設した `tech`/`idea` 子フォルダへ
  // 付け替えて(`folder_key`/`folder` の両方を更新)「有効な type」と「無効な type」を
  // 混在させる。新フォルダは元の親フォルダのサブツリー内にあるため、`source.folders` による
  // 対象ノートの絞り込み結果は変わらない(実際の運用——親フォルダの下に `tech`/`idea`
  // サブフォルダを作る——をそのまま模した経路)。
  // ---------------------------------------------------------------------------

  describe('with the real Zenn renderer (T-17)', () => {
    /**
     * fixture JSON の `folders` ツリーの1エントリの最小形(`addTypeSubfolder` が使うフィールド
     * のみ)。`account` は `src/exporter/apple-notes.ts` の `folderJsonSchema` が必須とするため、
     * 新設フォルダにも必ず含める。
     */
    interface FixtureFolderJson {
      primary_key: number;
      name: string;
      account: string;
      parent_folder_id: number | null;
      child_folders: Record<string, FixtureFolderJson>;
    }

    /** `folders` ツリーを再帰的に辿り、`primary_key` が一致するフォルダを探す。 */
    function findFolderByPk(
      folders: Record<string, FixtureFolderJson>,
      pk: number,
    ): FixtureFolderJson | undefined {
      for (const folder of Object.values(folders)) {
        if (folder.primary_key === pk) {
          return folder;
        }
        const found = findFolderByPk(folder.child_folders, pk);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    }

    /**
     * コピー済み fixture の `json/all_notes_1.json` を読み、`parentFolderPk` の下に
     * `newFolderName`(`tech`/`idea`)という名前の子フォルダ(primary_key `newFolderPk`)を
     * 追加したうえで、指定した note key(JSON トップレベルの `notes` のキー。UUID ではない)
     * をその新フォルダへ付け替える(`folder_key`/`folder` の両方を更新)。新フォルダは
     * `parentFolderPk` のサブツリーの内側にあるため、`source.folders` による対象ノートの
     * 絞り込み結果は変わらない。
     */
    async function addTypeSubfolder(
      outDir: string,
      params: {
        parentFolderPk: number;
        newFolderPk: number;
        newFolderName: 'tech' | 'idea';
        noteKey: string;
      },
    ): Promise<void> {
      const jsonPath = join(outDir, 'json', 'all_notes_1.json');
      const raw = JSON.parse(await readFile(jsonPath, 'utf8')) as {
        folders: Record<string, FixtureFolderJson>;
        notes: Record<string, { folder: string; folder_key: number | string }>;
      };
      const parentFolder = findFolderByPk(raw.folders, params.parentFolderPk);
      if (parentFolder === undefined) {
        throw new Error(
          `test fixture: folder primary_key ${String(params.parentFolderPk)} not found in ${jsonPath}`,
        );
      }
      parentFolder.child_folders[String(params.newFolderPk)] = {
        primary_key: params.newFolderPk,
        name: params.newFolderName,
        account: parentFolder.account,
        parent_folder_id: params.parentFolderPk,
        child_folders: {},
      };

      const note = raw.notes[params.noteKey];
      if (note === undefined) {
        throw new Error(`test fixture: note key "${params.noteKey}" not found in ${jsonPath}`);
      }
      note.folder_key = params.newFolderPk;
      note.folder = params.newFolderName;

      await writeFile(jsonPath, JSON.stringify(raw), 'utf8');
    }

    it('isolates the invalid-type note: 1 note moved into a new "tech" subfolder publishes, the other 3 (Tech/Tech/Archive) fail with InvalidZennTypeError, exit 1', async () => {
      // fixture note key "201" == uuid TECH_SALES_TABLE_UUID(folder "Tech" in the raw JSON).
      // Tech(primary_key 10)の下に "tech" 子フォルダ(primary_key 99)を新設し、201 を
      // そこへ付け替える → folderPath ['Tech', 'tech'] → type "tech"。
      const { runner } = makeFixtureRunner((outDir) =>
        addTypeSubfolder(outDir, {
          parentFolderPk: 10,
          newFolderPk: 99,
          newFolderName: 'tech',
          noteKey: '201',
        }),
      );
      const { logger, events } = createFakeLogger();
      const mock = createMockPublisher({ withPrepare: true, withFinalize: true });

      const result = await runSync({
        config: buildGitConfig({ source: { folders: ['Tech'] } }),
        publisher: mock.publisher,
        renderNote: renderZennArticle,
        ...baseOptions({ runner, tmpDirFactory: async () => exportWorkDir, logger }),
      });

      // Tech ルート3件(201 は新設した Tech/tech へ付け替え済み/202 Tech のまま/203 Tech のまま)
      // + Archive(Tech 配下)1件(204 Archive のまま)= 4件、うち type "tech" の1件のみ成功。
      expect(result).toMatchObject({
        exitCode: PARTIAL_FAILURE,
        published: 1,
        skipped: 0,
        failed: 3,
      });
      expect(events).toContain(`note_published:${TECH_SALES_TABLE_UUID}:created`);
      expect(events).toContain(`note_failed:${TECH_GROCERY_CHECKLIST_UUID}`);
      expect(events).toContain(`note_failed:${TECH_WHITEBOARD_SKETCH_UUID}`);
      expect(events).toContain(`note_failed:${ARCHIVE_NOTE_UUID}`);

      // 成功した1件は Publisher.publish() へ Zenn 規約どおりの articles/<uuid小文字>.md で渡る。
      expect(mock.publishCalls).toHaveLength(1);
      expect(mock.publishCalls[0]?.article.artifactPath).toBe(
        `articles/${TECH_SALES_TABLE_UUID}.md`,
      );

      // 失敗した3件は状態に一切反映されない(NFR-06)。成功した1件のみ finalize() 経由で確定。
      const onDisk = readStateFile(statePath);
      expect(onDisk.notes[TECH_SALES_TABLE_UUID]).toBeDefined();
      expect(onDisk.notes[TECH_GROCERY_CHECKLIST_UUID]).toBeUndefined();
      expect(onDisk.notes[TECH_WHITEBOARD_SKETCH_UUID]).toBeUndefined();
      expect(onDisk.notes[ARCHIVE_NOTE_UUID]).toBeUndefined();
    });

    it('all notes valid ("tech"/"idea"): every note publishes via the real Zenn renderer', async () => {
      // Archive(primary_key 11)の下に "idea" 子フォルダ(primary_key 98)を新設し、
      // Archive/🚀 Launch Notes(note key 204)をそこへ付け替える →
      // folderPath [..., 'Archive', 'idea'] → type "idea"。
      const { runner } = makeFixtureRunner(async (outDir) => {
        await addTypeSubfolder(outDir, {
          parentFolderPk: 11,
          newFolderPk: 98,
          newFolderName: 'idea',
          noteKey: '204',
        });
      });
      const { logger } = createFakeLogger();
      const mock = createMockPublisher({ withPrepare: true, withFinalize: true });

      const result = await runSync({
        config: buildGitConfig({ source: { folders: ['Archive'] } }),
        publisher: mock.publisher,
        renderNote: renderZennArticle,
        ...baseOptions({ runner, tmpDirFactory: async () => exportWorkDir, logger }),
      });

      expect(result).toMatchObject({ exitCode: SUCCESS, published: 1, skipped: 0, failed: 0 });
      expect(mock.publishCalls).toHaveLength(1);
      const article = mock.publishCalls[0]?.article;
      // Archive ノートは絵文字タイトル("🚀 Launch Notes")→ 先頭絵文字を emoji として抽出済み、
      // タグは #planning/#launch/#productivity → topics は "#" を除いた語(モジュール冒頭 JSDoc)。
      expect(article?.artifact).toContain('emoji: "🚀"');
      expect(article?.artifact).toContain('type: "idea"');
      expect(article?.artifact).toContain('topics: ["planning","launch","productivity"]');
      expect(article?.artifact).toContain('published: true');
      expect(article?.artifactPath).toBe(`articles/${ARCHIVE_NOTE_UUID}.md`);
    });
  });
});
