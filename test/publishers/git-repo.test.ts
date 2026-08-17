import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import type { Logger, WarnPayload } from '../../src/logger.js';
import {
  createGitRepoPublisher,
  GIT_CREDENTIAL_ARGS,
  type GitRepoRunner,
} from '../../src/publishers/git-repo.js';
import type { RenderedArticle } from '../../src/publishers/types.js';
import type { RunSubprocessOptions, RunSubprocessResult } from '../../src/subprocess.js';

// ---------------------------------------------------------------------------
// テスト用ヘルパー。
// ---------------------------------------------------------------------------

/** design.md §5.7 GitRepoPublisher が実際に使う service(zenn/hugo/jekyll)向けの最小 Config。 */
function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    service: 'zenn',
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
    git: {
      repo_path: '/unused-in-most-tests',
      base_branch: 'main',
      output_dir: 'articles',
      auto_merge: false,
    },
    ...overrides,
  };
}

function buildArticle(overrides: Partial<RenderedArticle> = {}): RenderedArticle {
  return {
    noteUuid: '5c1c2c3d-0000-0000-0000-000000000001',
    title: 'Hello World',
    artifact: '---\ntitle: "Hello World"\n---\nbody text\n',
    contentHash: 'sha256:deadbeef',
    artifactPath: 'articles/5c1c2c3d-0000-0000-0000-000000000001.md',
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
 * 返せば使い、`undefined` を返せば既定(成功・空出力)にフォールバックする。
 */
function makeMockRunner(handler?: (call: RecordedCall) => RunSubprocessResult | undefined): {
  runner: GitRepoRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner: GitRepoRunner = async (options: RunSubprocessOptions) => {
    const call: RecordedCall = {
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
    };
    calls.push(call);
    const custom = handler?.(call);
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

/**
 * `call.args` から、git 呼び出しに一律付与される credential-helper 強制の前置き
 * (`GIT_CREDENTIAL_ARGS`、`src/publishers/git-repo.ts` 参照)を取り除いた「実質的な」引数列
 * を返す。gh コマンドはそのまま返す(前置きは git 呼び出しにのみ付く)。
 */
function gitArgs(call: RecordedCall): string[] {
  return call.command === 'git' ? call.args.slice(GIT_CREDENTIAL_ARGS.length) : call.args;
}

function joinArgs(call: RecordedCall): string {
  return `${call.command} ${gitArgs(call).join(' ')}`;
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

const FIXED_NOW = () => new Date('2026-08-11T09:00:00Z');

// ---------------------------------------------------------------------------
// テスト本体。
// ---------------------------------------------------------------------------

describe('createGitRepoPublisher', () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'note2web-git-repo-test-'));
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  describe('prepare()', () => {
    it.each(['zenn', 'hugo', 'jekyll'] as const)(
      'creates a branch named "note2web/sync-<YYYYMMDDTHHMMSSZ>" (no colon) from origin/<base_branch> for service "%s"',
      async (service) => {
        const { runner, calls } = makeMockRunner();
        const publisher = createGitRepoPublisher({
          config: buildConfig({ service, git: { ...buildConfig().git!, repo_path: repoPath } }),
          runner,
          now: FIXED_NOW,
        });

        await publisher.prepare?.();

        expect(calls).toHaveLength(2);
        expect(joinArgs(calls[0]!)).toBe('git fetch origin');
        expect(joinArgs(calls[1]!)).toBe(
          'git checkout -b note2web/sync-20260811T090000Z origin/main',
        );
        // FR-19: ref 名に使えない ':' を含まない(args: ['checkout', '-b', <branch>, <start>])。
        expect(gitArgs(calls[1]!)[2]).not.toContain(':');
      },
    );

    it('runs git commands with cwd set to the (home-expanded) repo_path', async () => {
      const { runner, calls } = makeMockRunner();
      const publisher = createGitRepoPublisher({
        config: buildConfig({ git: { ...buildConfig().git!, repo_path: repoPath } }),
        runner,
        now: FIXED_NOW,
      });

      await publisher.prepare?.();

      expect(calls.every((call) => call.cwd === repoPath)).toBe(true);
    });

    it('throws when "git fetch" fails, without attempting to create the branch', async () => {
      const { runner, calls } = makeMockRunner((call) =>
        gitArgs(call).join(' ') === 'fetch origin' ? failure('network unreachable') : undefined,
      );
      const publisher = createGitRepoPublisher({
        config: buildConfig({ git: { ...buildConfig().git!, repo_path: repoPath } }),
        runner,
        now: FIXED_NOW,
      });

      await expect(publisher.prepare?.()).rejects.toThrow(/git fetch origin.*failed/);
      expect(calls).toHaveLength(1);
    });
  });

  describe('publish()', () => {
    it('writes the artifact under repo_path/artifactPath, creating parent directories', async () => {
      const { runner } = makeMockRunner();
      const publisher = createGitRepoPublisher({
        config: buildConfig({ git: { ...buildConfig().git!, repo_path: repoPath } }),
        runner,
        now: FIXED_NOW,
      });

      const article = buildArticle({ artifactPath: 'articles/nested/uuid-1.md', artifact: 'BODY' });
      const result = await publisher.publish(article, null);

      expect(result).toEqual({ result: 'created', remoteId: null });
      const written = await readFile(join(repoPath, 'articles/nested/uuid-1.md'), 'utf8');
      expect(written).toBe('BODY');
    });

    it('rejects an artifactPath that escapes repo_path via traversal ("../"), before touching the filesystem (CodeRabbit review, PR #49)', async () => {
      const { runner } = makeMockRunner();
      const publisher = createGitRepoPublisher({
        config: buildConfig({ git: { ...buildConfig().git!, repo_path: repoPath } }),
        runner,
        now: FIXED_NOW,
      });

      const article = buildArticle({ artifactPath: '../escape.md' });

      await expect(publisher.publish(article, null)).rejects.toThrow(
        /artifactPath that escapes repo_path/,
      );
      await expect(readFile(join(repoPath, '..', 'escape.md'), 'utf8')).rejects.toThrow();
    });

    it('rejects an absolute artifactPath (CodeRabbit review, PR #49)', async () => {
      const { runner } = makeMockRunner();
      const publisher = createGitRepoPublisher({
        config: buildConfig({ git: { ...buildConfig().git!, repo_path: repoPath } }),
        runner,
        now: FIXED_NOW,
      });

      const article = buildArticle({ artifactPath: '/etc/passwd' });

      await expect(publisher.publish(article, null)).rejects.toThrow(
        /artifactPath that escapes repo_path/,
      );
    });

    it('reports "updated" when a previous NoteState is given', async () => {
      const { runner } = makeMockRunner();
      const publisher = createGitRepoPublisher({
        config: buildConfig({ git: { ...buildConfig().git!, repo_path: repoPath } }),
        runner,
        now: FIXED_NOW,
      });

      const result = await publisher.publish(buildArticle(), {
        contentHash: 'sha256:old',
        remoteId: null,
        firstPublishedAt: '2026-08-01T00:00:00+09:00',
        lastPublishedAt: '2026-08-01T00:00:00+09:00',
      });

      expect(result.result).toBe('updated');
    });

    it('does not run any git/gh commands (state JSON is untouched by design; publish() only writes files)', async () => {
      const { runner, calls } = makeMockRunner();
      const publisher = createGitRepoPublisher({
        config: buildConfig({ git: { ...buildConfig().git!, repo_path: repoPath } }),
        runner,
        now: FIXED_NOW,
      });

      await publisher.publish(buildArticle(), null);

      expect(calls).toHaveLength(0);
    });
  });

  describe('finalize()', () => {
    async function prepareAndPublish(
      runner: GitRepoRunner,
      options: { logger?: Logger; autoMerge?: boolean } = {},
    ): Promise<ReturnType<typeof createGitRepoPublisher>> {
      const publisher = createGitRepoPublisher({
        config: buildConfig({
          git: {
            ...buildConfig().git!,
            repo_path: repoPath,
            auto_merge: options.autoMerge ?? false,
          },
        }),
        runner,
        now: FIXED_NOW,
        logger: options.logger,
      });
      await publisher.prepare?.();
      await publisher.publish(buildArticle(), null);
      return publisher;
    }

    it('zero pending notes: discards the branch without commit/PR and does not persist', async () => {
      const { runner, calls } = makeMockRunner();
      const publisher = createGitRepoPublisher({
        config: buildConfig({ git: { ...buildConfig().git!, repo_path: repoPath } }),
        runner,
        now: FIXED_NOW,
      });
      await publisher.prepare?.();
      calls.length = 0; // prepare() 分の記録をクリアし、finalize() の記録だけ検証する。

      const outcome = await publisher.finalize?.();

      expect(outcome).toEqual({ persist: false });
      expect(calls.map(joinArgs)).toEqual([
        'git checkout main',
        'git branch -D note2web/sync-20260811T090000Z',
      ]);
      // add/commit/push/gh のいずれも呼ばれていない。
      expect(calls.some((call) => call.command === 'gh')).toBe(false);
    });

    it('zero diff (git status --porcelain is empty despite pending notes): discards the branch, does not persist, warns', async () => {
      const { logger, warnings } = createFakeLogger();
      const { runner, calls } = makeMockRunner((call) =>
        gitArgs(call)[0] === 'status' ? success('') : undefined,
      );
      const publisher = await prepareAndPublish(runner, { logger });
      calls.length = 0;

      const outcome = await publisher.finalize?.();

      expect(outcome).toEqual({ persist: false });
      const commandNames = calls.map(joinArgs);
      expect(commandNames[0]).toMatch(/^git status --porcelain --/);
      expect(commandNames).toContain('git checkout main');
      expect(commandNames).toContain('git branch -D note2web/sync-20260811T090000Z');
      expect(commandNames.some((line) => line.startsWith('git commit'))).toBe(false);
      expect(commandNames.some((line) => line.startsWith('git push'))).toBe(false);
      expect(calls.some((call) => call.command === 'gh')).toBe(false);
      expect(warnings.some((warning) => warning.message.includes('no changes detected'))).toBe(
        true,
      );
    });

    it('diff exists, auto_merge false: adds/commits/pushes/creates a PR and persists (no merge attempted)', async () => {
      const { runner, calls } = makeMockRunner((call) =>
        gitArgs(call)[0] === 'status' ? success(' M articles/uuid.md\n') : undefined,
      );
      const publisher = await prepareAndPublish(runner, { autoMerge: false });
      calls.length = 0;

      const outcome = await publisher.finalize?.();

      expect(outcome).toEqual({ persist: true });
      const commandNames = calls.map(joinArgs);
      expect(commandNames[0]).toMatch(/^git status --porcelain --/);
      expect(commandNames[1]).toBe('git add -- articles/5c1c2c3d-0000-0000-0000-000000000001.md');
      expect(commandNames[2]).toMatch(/^git commit -m /);
      expect(commandNames[3]).toBe('git push -u origin note2web/sync-20260811T090000Z');
      expect(commandNames[4]).toMatch(/^gh pr create /);
      expect(commandNames[4]).toContain('--base main');
      expect(commandNames[4]).toContain('--head note2web/sync-20260811T090000Z');
      // auto_merge: false のため、gh pr merge は呼ばれない。
      expect(commandNames.some((line) => line.includes('pr merge'))).toBe(false);
    });

    it('throws when "git push" fails (does not persist; sync retries next run)', async () => {
      const { runner, calls } = makeMockRunner((call) => {
        if (gitArgs(call)[0] === 'status') return success(' M articles/uuid.md\n');
        if (gitArgs(call)[0] === 'push') return failure('remote rejected');
        return undefined;
      });
      const publisher = await prepareAndPublish(runner);

      await expect(publisher.finalize?.()).rejects.toThrow(/git push.*failed/);
      // gh pr create には到達していない。
      expect(calls.some((call) => call.command === 'gh')).toBe(false);
    });

    it('throws when "gh pr create" fails (does not persist; sync retries next run)', async () => {
      const { runner } = makeMockRunner((call) => {
        if (gitArgs(call)[0] === 'status') return success(' M articles/uuid.md\n');
        if (call.command === 'gh' && call.args[0] === 'pr' && call.args[1] === 'create') {
          return failure('could not create pull request');
        }
        return undefined;
      });
      const publisher = await prepareAndPublish(runner);

      await expect(publisher.finalize?.()).rejects.toThrow(/gh pr create.*failed/);
    });

    const PR_URL = 'https://github.com/example/zenn-content/pull/42';

    it('auto_merge: true and merge succeeds: issues "gh pr merge <PR URL> --merge --delete-branch" and persists', async () => {
      const { runner, calls } = makeMockRunner((call) => {
        if (gitArgs(call)[0] === 'status') return success(' M articles/uuid.md\n');
        if (call.command === 'gh' && call.args[0] === 'pr' && call.args[1] === 'create') {
          // `gh pr create` は成功時、stdout の先頭行に作成した PR の URL を出す。
          return success(`${PR_URL}\n`);
        }
        return undefined;
      });
      const publisher = await prepareAndPublish(runner, { autoMerge: true });
      calls.length = 0;

      const outcome = await publisher.finalize?.();

      expect(outcome).toEqual({ persist: true });
      const mergeCall = calls.find(
        (call) => call.command === 'gh' && call.args[0] === 'pr' && call.args[1] === 'merge',
      );
      expect(mergeCall).toBeDefined();
      // CodeRabbit review, PR #49: カレントブランチからの暗黙解決に頼らず、`gh pr create`
      // の stdout から得た PR URL を明示的に渡す。
      expect(mergeCall?.args).toContain(PR_URL);
      expect(mergeCall?.args).toContain('--merge');
      expect(mergeCall?.args).toContain('--delete-branch');
    });

    it('auto_merge: true and gh pr create has no usable stdout: falls back to implicit branch resolution (no URL arg)', async () => {
      const { runner, calls } = makeMockRunner((call) =>
        gitArgs(call)[0] === 'status' ? success(' M articles/uuid.md\n') : undefined,
      );
      const publisher = await prepareAndPublish(runner, { autoMerge: true });
      calls.length = 0;

      await publisher.finalize?.();

      const mergeCall = calls.find(
        (call) => call.command === 'gh' && call.args[0] === 'pr' && call.args[1] === 'merge',
      );
      expect(mergeCall?.args).toEqual(['pr', 'merge', '--merge', '--delete-branch']);
    });

    it('auto_merge: true and merge fails: persists (PR already created) but reports failure, leaving the PR open', async () => {
      const { runner, calls } = makeMockRunner((call) => {
        if (gitArgs(call)[0] === 'status') return success(' M articles/uuid.md\n');
        if (call.command === 'gh' && call.args[0] === 'pr' && call.args[1] === 'create') {
          return success(`${PR_URL}\n`);
        }
        if (call.command === 'gh' && call.args[0] === 'pr' && call.args[1] === 'merge') {
          return failure('branch protection rules prevent merging');
        }
        return undefined;
      });
      const publisher = await prepareAndPublish(runner, { autoMerge: true });
      calls.length = 0;

      const outcome = await publisher.finalize?.();

      expect(outcome?.persist).toBe(true);
      expect(outcome?.failed).toBe(true);
      expect(outcome?.reason).toMatch(/branch protection rules prevent merging/);
      const mergeCall = calls.find(
        (call) => call.command === 'gh' && call.args[0] === 'pr' && call.args[1] === 'merge',
      );
      expect(mergeCall?.args).toContain(PR_URL);
      // マージ失敗後にブランチを削除する等の後始末は行わない(PR を残す)。
      expect(calls.some((call) => call.args.join(' ').includes('branch -D'))).toBe(false);
    });

    it('passes GH_TOKEN via env to gh commands (and git commands, for credential-helper pushes)', async () => {
      const { runner, calls } = makeMockRunner((call) =>
        gitArgs(call)[0] === 'status' ? success(' M articles/uuid.md\n') : undefined,
      );
      const publisher = createGitRepoPublisher({
        config: buildConfig({ git: { ...buildConfig().git!, repo_path: repoPath } }),
        runner,
        now: FIXED_NOW,
        env: { GH_TOKEN: 'secret-token' },
      });
      await publisher.prepare?.();
      await publisher.publish(buildArticle(), null);

      await publisher.finalize?.();

      const ghCall = calls.find((call) => call.command === 'gh');
      expect(ghCall?.env).toEqual({ GH_TOKEN: 'secret-token' });
      expect(calls.every((call) => call.env?.GH_TOKEN === 'secret-token')).toBe(true);
      // git 呼び出しには併せて GIT_TERMINAL_PROMPT=0 と GIT_ASKPASS=""(空文字で GUI
      // askpass を無効化)が付く(gh 呼び出しには付かない)。
      const gitCallsWithToken = calls.filter((call) => call.command === 'git');
      expect(gitCallsWithToken.every((call) => call.env?.GIT_TERMINAL_PROMPT === '0')).toBe(true);
      expect(gitCallsWithToken.every((call) => call.env?.GIT_ASKPASS === '')).toBe(true);
      expect(ghCall?.env?.GIT_TERMINAL_PROMPT).toBeUndefined();
      expect(ghCall?.env?.GIT_ASKPASS).toBeUndefined();
    });

    it('commands receive no injected GH_TOKEN when absent from the injected env, but git commands still get GIT_TERMINAL_PROMPT=0 (CodeRabbit review, PR #49: this does not mean no commands run)', async () => {
      const { runner, calls } = makeMockRunner();
      const publisher = createGitRepoPublisher({
        config: buildConfig({ git: { ...buildConfig().git!, repo_path: repoPath } }),
        runner,
        now: FIXED_NOW,
        env: {},
      });
      await publisher.prepare?.();

      // prepare() 自体は GH_TOKEN 無しでも git fetch/checkout を試みる(SSH 鍵等の他の認証
      // 手段があり得るため、GitRepoPublisher は GH_TOKEN の有無で git コマンドの実行有無を
      // 変えない)。ここで検証するのは、渡す `env` に GH_TOKEN が無ければ、コマンドへは
      // GH_TOKEN を注入しないという一点。一方、git コマンドには GH_TOKEN の有無に関わらず
      // 常に GIT_TERMINAL_PROMPT=0 と GIT_ASKPASS=""(空文字)が付く(端末プロンプトと
      // GUI askpass の両方の対話フォールバックを防止、NFR)。
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((call) => call.env?.GH_TOKEN === undefined)).toBe(true);
      const gitCalls = calls.filter((call) => call.command === 'git');
      expect(gitCalls.length).toBeGreaterThan(0);
      expect(gitCalls.every((call) => call.env?.GIT_TERMINAL_PROMPT === '0')).toBe(true);
      expect(gitCalls.every((call) => call.env?.GIT_ASKPASS === '')).toBe(true);
    });
  });

  describe('credential-helper forcing (Mac GCM ポップアップ / gh マルチアカウント対策)', () => {
    it('prepends GIT_CREDENTIAL_ARGS to every git invocation, before the subcommand', async () => {
      const { runner, calls } = makeMockRunner((call) =>
        gitArgs(call)[0] === 'status' ? success(' M articles/uuid.md\n') : undefined,
      );
      const publisher = createGitRepoPublisher({
        config: buildConfig({ git: { ...buildConfig().git!, repo_path: repoPath } }),
        runner,
        now: FIXED_NOW,
      });
      await publisher.prepare?.();
      await publisher.publish(buildArticle(), null);
      await publisher.finalize?.();

      const gitCalls = calls.filter((call) => call.command === 'git');
      // fetch / checkout / status / add / commit / push の6件全てで前置きが付く
      // (design.md §5.7、`GIT_CREDENTIAL_ARGS` のコメント参照)。ローカル専用コマンドにも
      // 一律で付与する設計(認証を伴わないので無害)。
      expect(gitCalls.length).toBeGreaterThanOrEqual(6);
      for (const call of gitCalls) {
        expect(call.args.slice(0, GIT_CREDENTIAL_ARGS.length)).toEqual(GIT_CREDENTIAL_ARGS);
      }
      // gh コマンドには前置きが付かない。
      const ghCalls = calls.filter((call) => call.command === 'gh');
      expect(ghCalls.length).toBeGreaterThan(0);
      for (const call of ghCalls) {
        expect(call.args.slice(0, GIT_CREDENTIAL_ARGS.length)).not.toEqual(GIT_CREDENTIAL_ARGS);
      }
    });

    it('the push invocation carries the credential-forcing prefix, GIT_TERMINAL_PROMPT=0, empty GIT_ASKPASS and GH_TOKEN in env, with no token value in argv', async () => {
      const { runner, calls } = makeMockRunner((call) =>
        gitArgs(call)[0] === 'status' ? success(' M articles/uuid.md\n') : undefined,
      );
      const publisher = createGitRepoPublisher({
        config: buildConfig({ git: { ...buildConfig().git!, repo_path: repoPath } }),
        runner,
        now: FIXED_NOW,
        env: { GH_TOKEN: 'super-secret-token' },
      });
      await publisher.prepare?.();
      await publisher.publish(buildArticle(), null);
      await publisher.finalize?.();

      const pushCall = calls.find((call) => call.command === 'git' && gitArgs(call)[0] === 'push');
      expect(pushCall).toBeDefined();
      expect(pushCall?.args.slice(0, GIT_CREDENTIAL_ARGS.length)).toEqual(GIT_CREDENTIAL_ARGS);
      expect(pushCall?.env).toMatchObject({
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        GH_TOKEN: 'super-secret-token',
      });
      // argv 自体にはトークンの値が一切現れない(FR-30。gh auth git-credential が
      // 実行時に環境変数から読むだけ)。
      expect(pushCall?.args.some((arg) => arg.includes('super-secret-token'))).toBe(false);
    });
  });
});
