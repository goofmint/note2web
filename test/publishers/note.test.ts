import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import type { Logger, WarnPayload } from '../../src/logger.js';
import {
  createNotePublisher,
  NoteAmbiguousTitleMatchError,
  type NoteRunner,
} from '../../src/publishers/note.js';
import type { RenderedArticle } from '../../src/publishers/types.js';
import type { NoteState } from '../../src/state/store.js';
import type { RunSubprocessOptions, RunSubprocessResult } from '../../src/subprocess.js';

// ---------------------------------------------------------------------------
// テスト用ヘルパー(`test/publishers/qiita.test.ts` の `makeMockRunner`、
// `test/publishers/devto.test.ts` の `createFakeLogger` と同じパターンを踏襲する)。
// ---------------------------------------------------------------------------

function buildConfig(workspace: string): Config {
  return {
    service: 'note',
    timezone: 'Asia/Tokyo',
    source: { folders: ['tech'] },
    assets: {
      provider: 's3',
      bucket: 'blog-assets-note',
      public_base_url: 'https://assets.example.com/notes/',
      access_key_id_env: 'NOTE_S3_ACCESS_KEY_ID',
      secret_access_key_env: 'NOTE_S3_SECRET_ACCESS_KEY',
    },
    note: { workspace },
  };
}

const NOTE_UUID = '5c1c2c3d-0000-4000-8000-000000000001';

/**
 * `noet` の解決に使う `NOET_PATH`(`resolveNoetCommand`、実機報告)。PATH フォールバックが
 * 廃止されたため、`publish()` を実際に呼ぶテストは全てこれを渡す必要がある——ホスト環境の
 * `process.env.NOET_PATH` に依存すると、CI/実行環境によって偶然通ったり失敗したりする
 * (テストが環境依存になる)のを避けるため、既定は本テストファイル内で固定する。
 */
const NOET_ENV: NodeJS.ProcessEnv = { NOET_PATH: '/opt/tools/noet' };

function buildArticle(overrides: Partial<RenderedArticle> = {}): RenderedArticle {
  return {
    noteUuid: NOTE_UUID,
    title: 'Hello World',
    artifact: '---\ntitle: "Hello World"\ntags: []\n---\n\nbody text\n',
    contentHash: 'sha256:deadbeef',
    artifactPath: `${NOTE_UUID}.md`,
    ...overrides,
  };
}

function buildPrevState(overrides: Partial<NoteState> = {}): NoteState {
  return {
    contentHash: 'sha256:previous',
    remoteId: null,
    firstPublishedAt: '2026-08-01T00:00:00+09:00',
    lastPublishedAt: '2026-08-01T00:00:00+09:00',
    ...overrides,
  };
}

function createFakeLogger(): { logger: Logger; warnings: WarnPayload[] } {
  const warnings: WarnPayload[] = [];
  const logger: Logger = {
    runStart: () => {},
    runEnd: () => {},
    exportDone: () => {},
    notePublished: () => {},
    noteSkipped: () => {},
    noteFailed: () => {},
    assetUploaded: () => {},
    warn: (payload) => {
      warnings.push(payload);
    },
  };
  return { logger, warnings };
}

interface RecordedCall {
  command: string;
  args: string[];
  cwd: string | undefined;
}

/**
 * 記録可能・応答をスクリプト可能なモック runner(`test/publishers/qiita.test.ts` の
 * `makeMockRunner` と同じパターン)。`handler` が特定コマンドに対する結果を返せば使い、
 * `undefined` を返せば既定(成功・空出力)にフォールバックする。
 */
function makeMockRunner(
  handler?: (
    call: RecordedCall,
  ) => Promise<RunSubprocessResult | undefined> | RunSubprocessResult | undefined,
): { runner: NoteRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner: NoteRunner = async (options: RunSubprocessOptions) => {
    const call: RecordedCall = { command: options.command, args: options.args, cwd: options.cwd };
    calls.push(call);
    const custom = await handler?.(call);
    if (custom !== undefined) {
      return custom;
    }
    return { status: 'success', exitCode: 0, signal: null, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

function success(stdout = ''): RunSubprocessResult {
  return { status: 'success', exitCode: 0, signal: null, stdout, stderr: '' };
}

function failure(stderr = 'boom'): RunSubprocessResult {
  return {
    status: 'failure',
    classification: 'exit_code',
    exitCode: 1,
    signal: null,
    stdout: '',
    stderr,
  };
}

/** `noet list` の1行(タブ区切り `title\tkey\tstatus`。`src/publishers/note.ts` の `parseNoteList` 参照)。 */
function listLine(title: string, key: string, status = 'published'): string {
  return `${title}\t${key}\t${status}`;
}

function createUrl(key: string, user = 'example-user'): string {
  return `https://note.com/${user}/n/${key}`;
}

// ---------------------------------------------------------------------------
// テスト本体。
// ---------------------------------------------------------------------------

describe('createNotePublisher', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'note2web-note-test-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  describe('publish() with a known remoteId (no listing)', () => {
    it('writes the article file, then invokes "noet update <remoteId> <file>" directly, with no "noet list" call', async () => {
      const { runner, calls } = makeMockRunner((call) => {
        if (call.args[0] === 'update') {
          return success(createUrl('existing-key'));
        }
        return undefined;
      });
      const publisher = createNotePublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: NOET_ENV,
      });

      const article = buildArticle();
      const result = await publisher.publish(article, buildPrevState({ remoteId: 'existing-key' }));

      expect(calls).toHaveLength(1);
      const call = calls[0];
      if (call === undefined) throw new Error('test setup: runner was not called');
      expect(call.command).toBe('/opt/tools/noet');
      expect(call.args).toEqual([
        'update',
        'existing-key',
        resolve(workspaceRoot, `${NOTE_UUID}.md`),
      ]);
      expect(call.cwd).toBe(workspaceRoot);

      expect(result).toMatchObject({
        result: 'updated',
        remoteId: 'existing-key',
        url: createUrl('existing-key'),
      });

      const onDisk = await readFile(resolve(workspaceRoot, article.artifactPath ?? ''), 'utf8');
      expect(onDisk).toBe(article.artifact);
    });

    it('falls back to prev.url when "noet update" output has no extractable URL', async () => {
      const { runner } = makeMockRunner(() => success('OK, updated.'));
      const publisher = createNotePublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: NOET_ENV,
      });

      const result = await publisher.publish(
        buildArticle(),
        buildPrevState({ remoteId: 'existing-key', url: createUrl('existing-key') }),
      );

      expect(result).toMatchObject({
        result: 'updated',
        remoteId: 'existing-key',
        url: createUrl('existing-key'),
      });
    });
  });

  describe('publish() recovery path (no remoteId): "noet list" then create/update', () => {
    it('creates when "noet list" output is completely empty (confirmed-empty account, design.md §5.7)', async () => {
      const { runner, calls } = makeMockRunner((call) => {
        if (call.args[0] === 'list') return success('');
        if (call.args[0] === 'create') return success(createUrl('brand-new-key'));
        return undefined;
      });
      const publisher = createNotePublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: NOET_ENV,
      });

      const result = await publisher.publish(buildArticle(), null);

      expect(calls.map((call) => call.args[0])).toEqual(['list', 'create']);
      const createCall = calls[1];
      if (createCall === undefined) throw new Error('test setup: create was not called');
      expect(createCall.args).toEqual(['create', resolve(workspaceRoot, `${NOTE_UUID}.md`)]);
      expect(createCall.cwd).toBe(workspaceRoot);

      expect(result).toMatchObject({
        result: 'created',
        remoteId: 'brand-new-key',
        url: createUrl('brand-new-key'),
      });
    });

    it('falls back to prev.url when prev exists with remoteId null and the update output has no URL', async () => {
      // remoteId が null の既存状態(過去に失敗した等)からの回復パス。update 出力に URL が
      // 無い場合、PublishResult.url は prev.url へフォールバックする。
      const { runner } = makeMockRunner((call) => {
        if (call.args[0] === 'list') return success(listLine('Hello World', 'matched-key'));
        if (call.args[0] === 'update') return success('updated without url output');
        return undefined;
      });
      const publisher = createNotePublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: NOET_ENV,
      });

      const result = await publisher.publish(
        buildArticle({ title: 'Hello World' }),
        buildPrevState({ remoteId: null, url: 'https://note.com/user/n/prev-url-key' }),
      );

      expect(result).toMatchObject({
        result: 'updated',
        remoteId: 'matched-key',
        url: 'https://note.com/user/n/prev-url-key',
      });
    });

    it('adopts the key and updates on exactly 1 title match', async () => {
      const { runner, calls } = makeMockRunner((call) => {
        if (call.args[0] === 'list') return success(listLine('Hello World', 'matched-key'));
        if (call.args[0] === 'update') return success(createUrl('matched-key'));
        return undefined;
      });
      const publisher = createNotePublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: NOET_ENV,
      });

      const result = await publisher.publish(buildArticle({ title: 'Hello World' }), null);

      expect(calls.map((call) => call.args[0])).toEqual(['list', 'update']);
      const updateCall = calls[1];
      if (updateCall === undefined) throw new Error('test setup: update was not called');
      expect(updateCall.args).toEqual([
        'update',
        'matched-key',
        resolve(workspaceRoot, `${NOTE_UUID}.md`),
      ]);
      expect(result).toMatchObject({ result: 'updated', remoteId: 'matched-key' });
    });

    it('throws NoteAmbiguousTitleMatchError on 2+ title matches, warns, and sends no create/update', async () => {
      const { runner, calls } = makeMockRunner((call) => {
        if (call.args[0] === 'list') {
          return success([listLine('Dup', 'key-1'), listLine('Dup', 'key-2')].join('\n'));
        }
        throw new Error('test setup: no create/update should have been sent');
      });
      const { logger, warnings } = createFakeLogger();
      const publisher = createNotePublisher({
        config: buildConfig(workspaceRoot),
        runner,
        logger,
        env: NOET_ENV,
      });

      await expect(
        publisher.publish(buildArticle({ noteUuid: 'dup-note', title: 'Dup' }), null),
      ).rejects.toThrow(NoteAmbiguousTitleMatchError);

      expect(calls.filter((call) => call.args[0] !== 'list')).toHaveLength(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ service: 'note', noteUuid: 'dup-note', title: 'Dup' });
    });

    it('throws (completeness-unconfirmable) when the title has 0 matches within a non-empty listing, without calling create', async () => {
      const { runner, calls } = makeMockRunner((call) => {
        if (call.args[0] === 'list') return success(listLine('Some Other Article', 'other-key'));
        throw new Error('test setup: no create/update should have been sent');
      });
      const publisher = createNotePublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: NOET_ENV,
      });

      await expect(publisher.publish(buildArticle({ title: 'Hello World' }), null)).rejects.toThrow(
        /could not confirm/,
      );
      expect(calls.filter((call) => call.args[0] !== 'list')).toHaveLength(0);
    });

    it('throws (completeness-unconfirmable) when "noet list" output does not parse into the expected row shape', async () => {
      const { runner, calls } = makeMockRunner((call) => {
        if (call.args[0] === 'list') return success('some unstructured human-readable text\n');
        throw new Error('test setup: no create/update should have been sent');
      });
      const publisher = createNotePublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: NOET_ENV,
      });

      await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(/could not confirm/);
      expect(calls.filter((call) => call.args[0] !== 'list')).toHaveLength(0);
    });

    it('throws when "noet create" succeeds but no note.com URL can be extracted from its output', async () => {
      const { runner } = makeMockRunner((call) => {
        if (call.args[0] === 'list') return success('');
        if (call.args[0] === 'create') return success('Draft saved locally.');
        return undefined;
      });
      const publisher = createNotePublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: NOET_ENV,
      });

      await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(
        /no note\.com article URL/,
      );
    });

    it('fetches "noet list" only once per run and reuses the cache for later notes', async () => {
      const { runner, calls } = makeMockRunner((call) => {
        if (call.args[0] === 'list') return success('');
        if (call.args[0] === 'create') return success(createUrl('cached-key'));
        return undefined;
      });
      const publisher = createNotePublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: NOET_ENV,
      });

      const first = await publisher.publish(
        buildArticle({ noteUuid: 'u1', title: 'Same Title' }),
        null,
      );
      const second = await publisher.publish(
        buildArticle({ noteUuid: 'u2', title: 'Same Title' }),
        null,
      );

      expect(calls.filter((call) => call.args[0] === 'list')).toHaveLength(1);
      expect(first.result).toBe('created');
      expect(second).toMatchObject({ result: 'updated', remoteId: 'cached-key' });
      expect(calls.filter((call) => call.args[0] === 'create')).toHaveLength(1);
    });

    it('serializes concurrent publishes: two same-title notes via Promise.all cause exactly 1 "noet create"', async () => {
      const { runner, calls } = makeMockRunner((call) => {
        if (call.args[0] === 'list') return success('');
        if (call.args[0] === 'create') return success(createUrl('concurrent-key'));
        return undefined;
      });
      const publisher = createNotePublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: NOET_ENV,
      });

      const [first, second] = await Promise.all([
        publisher.publish(buildArticle({ noteUuid: 'c1', title: 'Concurrent Title' }), null),
        publisher.publish(buildArticle({ noteUuid: 'c2', title: 'Concurrent Title' }), null),
      ]);

      expect(calls.filter((call) => call.args[0] === 'create')).toHaveLength(1);
      expect(first.result).toBe('created');
      expect(second).toMatchObject({ result: 'updated', remoteId: 'concurrent-key' });
    });
  });

  describe('publish() failure paths', () => {
    it('rejects an artifactPath that escapes the workspace via traversal, without invoking the runner', async () => {
      const { runner, calls } = makeMockRunner();
      const publisher = createNotePublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: NOET_ENV,
      });

      const article = buildArticle({ artifactPath: '../../etc/evil.md' });
      await expect(publisher.publish(article, null)).rejects.toThrow(/escapes/);
      expect(calls).toHaveLength(0);
    });

    it('rejects an absolute artifactPath, without invoking the runner', async () => {
      const { runner, calls } = makeMockRunner();
      const publisher = createNotePublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: NOET_ENV,
      });

      const article = buildArticle({ artifactPath: '/etc/evil.md' });
      await expect(publisher.publish(article, null)).rejects.toThrow(/escapes/);
      expect(calls).toHaveLength(0);
    });

    it('throws when article.artifactPath is undefined', async () => {
      const { runner, calls } = makeMockRunner();
      const publisher = createNotePublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: NOET_ENV,
      });

      const article = buildArticle({ artifactPath: undefined });
      await expect(publisher.publish(article, null)).rejects.toThrow(/artifactPath/);
      expect(calls).toHaveLength(0);
    });

    it('throws a descriptive error (with the stderr detail line, no full command echo) on CLI failure, for create', async () => {
      const { runner } = makeMockRunner((call) => {
        if (call.args[0] === 'list') return success('');
        if (call.args[0] === 'create') return failure('some noet CLI error detail');
        return undefined;
      });
      const publisher = createNotePublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: NOET_ENV,
      });

      try {
        await publisher.publish(buildArticle(), null);
        expect.unreachable('publish() should have thrown');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain('some noet CLI error detail');
        // the full argv (e.g. the absolute file path) is not echoed into the error message.
        expect(message).not.toContain(workspaceRoot);
      }
    });

    it('throws a descriptive error on CLI failure, for update (known remoteId)', async () => {
      const { runner } = makeMockRunner(() => failure('connection refused'));
      const publisher = createNotePublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: NOET_ENV,
      });

      await expect(
        publisher.publish(buildArticle(), buildPrevState({ remoteId: 'some-key' })),
      ).rejects.toThrow(/connection refused/);
    });

    it('throws a descriptive error on CLI failure, for "noet list" itself', async () => {
      const { runner } = makeMockRunner(() => failure('extension not connected'));
      const publisher = createNotePublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: NOET_ENV,
      });

      await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(
        /extension not connected/,
      );
    });
  });

  describe('createNotePublisher() construction', () => {
    it('has no prepare/finalize (API/CLI mode)', () => {
      const publisher = createNotePublisher({ config: buildConfig(workspaceRoot) });
      expect(publisher.prepare).toBeUndefined();
      expect(publisher.finalize).toBeUndefined();
    });

    it('throws immediately when config.note is undefined', () => {
      const config = buildConfig(workspaceRoot);
      const brokenConfig = { ...config, note: undefined };
      expect(() => createNotePublisher({ config: brokenConfig })).toThrow(/config\.note/);
    });
  });

  // -------------------------------------------------------------------------
  // NOET_PATH の解決(実機報告: cargo install の noet が launchd の PATH に無い)。
  // PATH フォールバックは廃止済みのため、未設定/空は明確なエラーになる
  // (`src/publishers/note.ts` の `resolveNoetCommand` 参照)。
  // -------------------------------------------------------------------------
  describe('NOET_PATH resolution (resolveNoetCommand)', () => {
    it('uses the absolute NOET_PATH value as the "noet" command for every invocation', async () => {
      const { runner, calls } = makeMockRunner((call) => {
        if (call.args[0] === 'list') return success('');
        if (call.args[0] === 'create') return success(createUrl('key-1'));
        return undefined;
      });
      const publisher = createNotePublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: { NOET_PATH: '/opt/tools/noet' },
      });

      await publisher.publish(buildArticle(), null);

      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.command).toBe('/opt/tools/noet');
      }
    });

    it('expands a leading "~" in NOET_PATH against the home directory', async () => {
      const { runner, calls } = makeMockRunner((call) => {
        if (call.args[0] === 'list') return success('');
        if (call.args[0] === 'create') return success(createUrl('key-1'));
        return undefined;
      });
      const publisher = createNotePublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: { NOET_PATH: '~/bin/noet' },
      });

      await publisher.publish(buildArticle(), null);

      const expected = join(homedir(), 'bin', 'noet');
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.command).toBe(expected);
      }
    });

    it('rejects (no PATH fallback) when NOET_PATH is unset, without invoking the runner', async () => {
      const { runner, calls } = makeMockRunner();
      const publisher = createNotePublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: {},
      });

      await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(/NOET_PATH/);
      expect(calls).toHaveLength(0);
    });

    it('rejects (no PATH fallback) when NOET_PATH is the empty string, without invoking the runner', async () => {
      const { runner, calls } = makeMockRunner();
      const publisher = createNotePublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: { NOET_PATH: '' },
      });

      await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(/NOET_PATH/);
      expect(calls).toHaveLength(0);
    });
  });
});
