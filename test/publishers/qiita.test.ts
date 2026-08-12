import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { createQiitaPublisher, type QiitaRunner } from '../../src/publishers/qiita.js';
import type { RenderedArticle } from '../../src/publishers/types.js';
import type { NoteState } from '../../src/state/store.js';
import type { RunSubprocessOptions, RunSubprocessResult } from '../../src/subprocess.js';

// ---------------------------------------------------------------------------
// テスト用ヘルパー(`test/publishers/git-repo.test.ts` と同じパターンを踏襲)。
// ---------------------------------------------------------------------------

function buildConfig(workspace: string, tokenEnv = 'QIITA_TOKEN'): Config {
  return {
    service: 'qiita',
    timezone: 'Asia/Tokyo',
    source: { folders: ['tech'] },
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
    qiita: { workspace, token_env: tokenEnv },
  };
}

const NOTE_UUID = '5c1c2c3d-0000-4000-8000-000000000001';

function buildArticle(overrides: Partial<RenderedArticle> = {}): RenderedArticle {
  return {
    noteUuid: NOTE_UUID,
    title: 'Hello World',
    artifact:
      '---\n' +
      'title: "Hello World"\n' +
      'tags: ["typescript"]\n' +
      'private: false\n' +
      'slide: false\n' +
      'id: null\n' +
      '---\n' +
      '\n' +
      'body text\n',
    contentHash: 'sha256:deadbeef',
    artifactPath: `public/${NOTE_UUID}.md`,
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

interface RecordedCall {
  command: string;
  args: string[];
  cwd: string | undefined;
  env: Record<string, string> | undefined;
}

/**
 * 記録可能・応答をスクリプト可能なモック runner。`handler` が特定コマンドに対する結果を
 * 返せば使い、`undefined` を返せば既定(成功・空出力)にフォールバックする
 * (`test/publishers/git-repo.test.ts` の `makeMockRunner` と同じパターン)。
 */
function makeMockRunner(
  handler?: (
    call: RecordedCall,
  ) => Promise<RunSubprocessResult | undefined> | RunSubprocessResult | undefined,
): { runner: QiitaRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner: QiitaRunner = async (options: RunSubprocessOptions) => {
    const call: RecordedCall = {
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
    };
    calls.push(call);
    const custom = await handler?.(call);
    if (custom !== undefined) {
      return custom;
    }
    return { status: 'success', exitCode: 0, signal: null, stdout: '', stderr: '' };
  };
  return { runner, calls };
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

/**
 * qiita-cli が `publish` 成功後にワークスペースのファイルへ `id` を書き戻す挙動を模倣する
 * (design.md §5.7「応答不明時の重複防止」)。`article.artifact` の `id: null` を実際の
 * 発行 ID へ置き換えてディスク上のファイルを書き換える。
 */
async function simulateQiitaCliWriteBackId(
  workspaceRoot: string,
  artifactPath: string,
  id: string,
): Promise<void> {
  const absolutePath = resolve(workspaceRoot, artifactPath);
  const content = await readFile(absolutePath, 'utf8');
  await writeFile(absolutePath, content.replace('id: null', `id: "${id}"`), 'utf8');
}

// ---------------------------------------------------------------------------
// テスト本体。
// ---------------------------------------------------------------------------

describe('createQiitaPublisher', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'note2web-qiita-test-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  describe('publish() success path', () => {
    it('writes the article file, then invokes "npx --no-install qiita publish <uuid> --root <workspace>"', async () => {
      const { runner, calls } = makeMockRunner(async (call) => {
        if (call.command === 'npx') {
          await simulateQiitaCliWriteBackId(
            workspaceRoot,
            `public/${NOTE_UUID}.md`,
            'generated-id-1',
          );
        }
        return undefined;
      });
      const config = buildConfig(workspaceRoot, 'MY_QIITA_TOKEN');
      const publisher = createQiitaPublisher({
        config,
        runner,
        env: { MY_QIITA_TOKEN: 'super-secret-token' },
      });

      const article = buildArticle();
      const result = await publisher.publish(article, null);

      expect(calls).toHaveLength(1);
      const call = calls[0];
      if (call === undefined) {
        throw new Error('test setup: runner was not called');
      }
      expect(call.command).toBe('npx');
      expect(call.args).toEqual([
        '--no-install',
        'qiita',
        'publish',
        NOTE_UUID,
        '--root',
        workspaceRoot,
      ]);
      // cwd must be note2web's own package root (where @qiita/qiita-cli is a pinned
      // dependency), never the (arbitrary, possibly dependency-less) qiita workspace —
      // otherwise `npx --no-install` could fail to resolve the local binary (module JSDoc
      // "npx --no-install の cwd").
      expect(call.cwd).not.toBe(workspaceRoot);
      const packageJson = JSON.parse(
        await readFile(resolve(call.cwd ?? '', 'package.json'), 'utf8'),
      ) as { name: string };
      expect(packageJson.name).toBe('note2web');

      // written article on disk matches the rendered artifact (before the CLI's id write-back
      // mutated it further in the mock).
      const onDisk = await readFile(resolve(workspaceRoot, article.artifactPath ?? ''), 'utf8');
      expect(onDisk).toContain('title: "Hello World"');

      expect(result).toMatchObject({
        result: 'created',
        remoteId: 'generated-id-1',
        url: 'https://qiita.com/items/generated-id-1',
      });
    });

    it('passes the token from the configured token_env indirection as child env QIITA_TOKEN (fixed name)', async () => {
      const { runner, calls } = makeMockRunner(async (call) => {
        if (call.command === 'npx') {
          await simulateQiitaCliWriteBackId(workspaceRoot, `public/${NOTE_UUID}.md`, 'id-2');
        }
        return undefined;
      });
      const config = buildConfig(workspaceRoot, 'CUSTOM_TOKEN_VAR_NAME');
      const publisher = createQiitaPublisher({
        config,
        runner,
        env: { CUSTOM_TOKEN_VAR_NAME: 'the-actual-token-value' },
      });

      await publisher.publish(buildArticle(), null);

      const call = calls[0];
      if (call === undefined) {
        throw new Error('test setup: runner was not called');
      }
      // child env carries the fixed name QIITA_TOKEN, regardless of the configured token_env name.
      expect(call.env).toEqual({ QIITA_TOKEN: 'the-actual-token-value' });
      // the token value never appears in argv.
      expect(call.args.join(' ')).not.toContain('the-actual-token-value');
    });

    it('returns result "created" when prev is null', async () => {
      const { runner } = makeMockRunner(async (call) => {
        if (call.command === 'npx') {
          await simulateQiitaCliWriteBackId(workspaceRoot, `public/${NOTE_UUID}.md`, 'new-id');
        }
        return undefined;
      });
      const publisher = createQiitaPublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: { QIITA_TOKEN: 'token' },
      });

      const result = await publisher.publish(buildArticle(), null);
      expect(result.result).toBe('created');
    });

    it('returns result "created" when prev.remoteId is null (previously unpublished)', async () => {
      const { runner } = makeMockRunner(async (call) => {
        if (call.command === 'npx') {
          await simulateQiitaCliWriteBackId(workspaceRoot, `public/${NOTE_UUID}.md`, 'new-id');
        }
        return undefined;
      });
      const publisher = createQiitaPublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: { QIITA_TOKEN: 'token' },
      });

      const result = await publisher.publish(buildArticle(), buildPrevState({ remoteId: null }));
      expect(result.result).toBe('created');
    });

    it('returns result "updated" when prev.remoteId is already set', async () => {
      const { runner } = makeMockRunner(async (call) => {
        if (call.command === 'npx') {
          // re-publish: id was already "existing-id" in the article (renderer would have put
          // prev.remoteId there); simulate qiita-cli leaving it unchanged.
          await simulateQiitaCliWriteBackId(workspaceRoot, `public/${NOTE_UUID}.md`, 'existing-id');
        }
        return undefined;
      });
      const publisher = createQiitaPublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: { QIITA_TOKEN: 'token' },
      });

      const article = buildArticle({
        artifact: buildArticle().artifact.replace('id: null', 'id: "existing-id"'),
      });
      const result = await publisher.publish(article, buildPrevState({ remoteId: 'existing-id' }));
      expect(result).toMatchObject({ result: 'updated', remoteId: 'existing-id' });
    });
  });

  describe('publish() failure paths', () => {
    it('rejects an artifactPath that escapes the workspace via traversal, without invoking the runner', async () => {
      const { runner, calls } = makeMockRunner();
      const publisher = createQiitaPublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: { QIITA_TOKEN: 'token' },
      });

      const article = buildArticle({ artifactPath: '../../etc/evil.md' });
      await expect(publisher.publish(article, null)).rejects.toThrow(/escapes/);
      expect(calls).toHaveLength(0);
    });

    it('rejects an absolute artifactPath, without invoking the runner', async () => {
      const { runner, calls } = makeMockRunner();
      const publisher = createQiitaPublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: { QIITA_TOKEN: 'token' },
      });

      const article = buildArticle({ artifactPath: '/etc/evil.md' });
      await expect(publisher.publish(article, null)).rejects.toThrow(/escapes/);
      expect(calls).toHaveLength(0);
    });

    it('rejects when the configured token_env environment variable is not set, without invoking the runner', async () => {
      const { runner, calls } = makeMockRunner();
      const publisher = createQiitaPublisher({
        config: buildConfig(workspaceRoot, 'QIITA_TOKEN'),
        runner,
        env: {}, // QIITA_TOKEN not set
      });

      await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(/QIITA_TOKEN/);
      expect(calls).toHaveLength(0);
    });

    it('rejects when the configured token_env environment variable is set to an empty string', async () => {
      const { runner, calls } = makeMockRunner();
      const publisher = createQiitaPublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: { QIITA_TOKEN: '' },
      });

      await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(/QIITA_TOKEN/);
      expect(calls).toHaveLength(0);
    });

    it('does not leak the token value in the thrown error message on CLI failure', async () => {
      const { runner } = makeMockRunner(() => failure('some qiita-cli error detail'));
      const publisher = createQiitaPublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: { QIITA_TOKEN: 'super-secret-token-value' },
      });

      try {
        await publisher.publish(buildArticle(), null);
        expect.unreachable('publish() should have thrown');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain('super-secret-token-value');
        expect(message).toContain('some qiita-cli error detail');
      }
    });

    it('throws when the CLI exits with a failure status', async () => {
      const { runner } = makeMockRunner(() => failure('network unreachable'));
      const publisher = createQiitaPublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: { QIITA_TOKEN: 'token' },
      });

      await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(/network unreachable/);
    });

    it('throws when the CLI exits successfully but did not write back an "id" (treated as failure to avoid a false-confirmed publish)', async () => {
      const { runner } = makeMockRunner(); // default success, no id write-back
      const publisher = createQiitaPublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: { QIITA_TOKEN: 'token' },
      });

      await expect(publisher.publish(buildArticle(), null)).rejects.toThrow(
        /did not write back an "id"/,
      );
    });

    it('throws when article.artifactPath is undefined', async () => {
      const { runner, calls } = makeMockRunner();
      const publisher = createQiitaPublisher({
        config: buildConfig(workspaceRoot),
        runner,
        env: { QIITA_TOKEN: 'token' },
      });

      const article = buildArticle({ artifactPath: undefined });
      await expect(publisher.publish(article, null)).rejects.toThrow(/artifactPath/);
      expect(calls).toHaveLength(0);
    });
  });

  describe('createQiitaPublisher() construction', () => {
    it('has no prepare/finalize (API/CLI mode)', () => {
      const publisher = createQiitaPublisher({
        config: buildConfig(workspaceRoot),
        env: { QIITA_TOKEN: 'token' },
      });
      expect(publisher.prepare).toBeUndefined();
      expect(publisher.finalize).toBeUndefined();
    });

    it('throws immediately when config.qiita is undefined', () => {
      const config = buildConfig(workspaceRoot);
      const brokenConfig = { ...config, qiita: undefined };
      expect(() => createQiitaPublisher({ config: brokenConfig })).toThrow(/config\.qiita/);
    });
  });
});
