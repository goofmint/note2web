import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { DoctorError, runDoctorChecks, type RunDoctorOptions } from './doctor.js';
import type { RunSubprocessOptions, RunSubprocessResult } from './subprocess.js';

/** `runDoctorChecks` が `DoctorError` で reject することを検証しつつ、その値を受け取る。 */
async function expectDoctorError(config: Config, options?: RunDoctorOptions): Promise<DoctorError> {
  try {
    await runDoctorChecks(config, options);
  } catch (error) {
    expect(error).toBeInstanceOf(DoctorError);
    return error as DoctorError;
  }
  throw new Error('unreachable: runDoctorChecks was expected to reject with DoctorError');
}

/** `runDoctorChecks` に渡す最小限の検証済み設定。`overrides` でサービス別ブロックを足す。 */
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
      repo_path: '~/src/zenn-content',
      base_branch: 'main',
      output_dir: 'articles',
      auto_merge: true,
    },
    ...overrides,
  };
}

function success(stdout = ''): RunSubprocessResult {
  return { status: 'success', exitCode: 0, signal: null, stdout, stderr: '' };
}

function failure(stderr = 'error'): RunSubprocessResult {
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
 * `checkDependencies`(issue #67 で追加された `ruby -v` / `bundle check`)が実ホストの
 * サブプロセスに触れないようにする既定成功フェイク。`runDoctorChecks` の
 * `dependencyRunSubprocessFn` に渡す(`gh auth status` 用の `runSubprocessFn` とは別物)。
 */
function fakeRubyBundleSubprocess(): (
  options: RunSubprocessOptions,
) => Promise<RunSubprocessResult> {
  return (options) => {
    if (options.command === 'ruby') {
      return Promise.resolve(success('ruby 3.2.2p53 (2023-03-30 revision e51014f9c0)\n'));
    }
    if (options.command === 'bundle') {
      return Promise.resolve(success("The Gemfile's dependencies are satisfied\n"));
    }
    return Promise.reject(
      new Error(`test fake: unexpected command in dependencyRunSubprocessFn: ${options.command}`),
    );
  };
}

describe('runDoctorChecks', () => {
  let dir: string;
  let parserPath: string;
  const allCommandsPresent = new Set(['ruby', 'bundle', 'git', 'gh', 'node', 'npx', 'noet']);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'note2web-doctor-test-'));
    parserPath = join(dir, 'parser');
    // issue #72: 実在チェックの対象が upstream の `lib/AppleNoteStore.rb` に変わった
    // (以前は `notes_cloud_ripper.rb` エントリポイント自体を見ていた)。
    mkdirSync(join(parserPath, 'lib'), { recursive: true });
    writeFileSync(join(parserPath, 'lib', 'AppleNoteStore.rb'), '# fixture stub\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('git-mode services (zenn/hugo/jekyll)', () => {
    it('passes when all dependencies, gh auth, and repo permission are satisfied', async () => {
      const runSubprocessFn = vi.fn<
        (options: RunSubprocessOptions) => Promise<RunSubprocessResult>
      >((options) => {
        if (options.args.join(' ') === 'auth status') return Promise.resolve(success());
        if (options.args[0] === 'repo' && options.args[1] === 'view') {
          return Promise.resolve(success(JSON.stringify({ viewerPermission: 'WRITE' })));
        }
        throw new Error(`unexpected gh invocation: ${options.args.join(' ')}`);
      });

      await expect(
        runDoctorChecks(
          buildConfig({ exporter: { parser_path: parserPath, notes_container: '/dev/null' } }),
          {
            commandExistsFn: (command) => Promise.resolve(allCommandsPresent.has(command)),
            env: { GH_TOKEN: 'token-value' },
            runSubprocessFn,
            dependencyRunSubprocessFn: fakeRubyBundleSubprocess(),
            fileReadableFn: () => Promise.resolve(true),
          },
        ),
      ).resolves.toBeUndefined();

      expect(runSubprocessFn).toHaveBeenCalledTimes(2);
    });

    it('reports "gh auth status" failure and does not attempt the permission check', async () => {
      const runSubprocessFn = vi.fn<
        (options: RunSubprocessOptions) => Promise<RunSubprocessResult>
      >(() => Promise.resolve(failure('not logged in')));

      const error = await expectDoctorError(
        buildConfig({ exporter: { parser_path: parserPath, notes_container: '/dev/null' } }),
        {
          commandExistsFn: (command) => Promise.resolve(allCommandsPresent.has(command)),
          env: { GH_TOKEN: 'token-value' },
          runSubprocessFn,
          dependencyRunSubprocessFn: fakeRubyBundleSubprocess(),
        },
      );

      expect(error.exitCode).toBe(2);
      const messages = error.problems.map((problem) => problem.message).join('\n');
      expect(messages).toMatch(/gh auth status.*failed/);
      expect(messages).toMatch(/not logged in/);
      // 認証が失敗した時点で打ち切り、権限確認(2回目の gh 呼び出し)は行わない。
      expect(runSubprocessFn).toHaveBeenCalledTimes(1);
    });

    it('reports insufficient push/PR permission when viewerPermission is below WRITE', async () => {
      const runSubprocessFn = vi.fn<
        (options: RunSubprocessOptions) => Promise<RunSubprocessResult>
      >((options) => {
        if (options.args.join(' ') === 'auth status') return Promise.resolve(success());
        return Promise.resolve(success(JSON.stringify({ viewerPermission: 'READ' })));
      });

      const error = await expectDoctorError(
        buildConfig({ exporter: { parser_path: parserPath, notes_container: '/dev/null' } }),
        {
          commandExistsFn: (command) => Promise.resolve(allCommandsPresent.has(command)),
          env: { GH_TOKEN: 'token-value' },
          runSubprocessFn,
          dependencyRunSubprocessFn: fakeRubyBundleSubprocess(),
        },
      );

      const messages = error.problems.map((problem) => problem.message).join('\n');
      expect(messages).toMatch(/insufficient push\/PR permission/);
      expect(messages).toMatch(/viewerPermission="READ"/);
    });

    it('treats malformed "gh repo view" stdout as unknown permission (JSON-parse fallback)', async () => {
      // `gh repo view` 自体は成功(exit 0)したが、stdout が JSON として解釈できない
      // 場合(将来の `gh` の出力仕様変更等を想定)。`JSON.parse` の catch 節が
      // `viewerPermission` を `undefined` のままにし、"unknown" として報告されることを確認する。
      const runSubprocessFn = vi.fn<
        (options: RunSubprocessOptions) => Promise<RunSubprocessResult>
      >((options) => {
        if (options.args.join(' ') === 'auth status') return Promise.resolve(success());
        return Promise.resolve(success('not json'));
      });

      const error = await expectDoctorError(
        buildConfig({ exporter: { parser_path: parserPath, notes_container: '/dev/null' } }),
        {
          commandExistsFn: (command) => Promise.resolve(allCommandsPresent.has(command)),
          env: { GH_TOKEN: 'token-value' },
          runSubprocessFn,
          dependencyRunSubprocessFn: fakeRubyBundleSubprocess(),
        },
      );

      const messages = error.problems.map((problem) => problem.message).join('\n');
      expect(messages).toMatch(/insufficient push\/PR permission/);
      expect(messages).toMatch(/viewerPermission="unknown"/);
    });

    it('reports a permission-check failure when "gh repo view" itself fails', async () => {
      const runSubprocessFn = vi.fn<
        (options: RunSubprocessOptions) => Promise<RunSubprocessResult>
      >((options) => {
        if (options.args.join(' ') === 'auth status') return Promise.resolve(success());
        return Promise.resolve(failure('could not resolve repository'));
      });

      const error = await expectDoctorError(
        buildConfig({ exporter: { parser_path: parserPath, notes_container: '/dev/null' } }),
        {
          commandExistsFn: (command) => Promise.resolve(allCommandsPresent.has(command)),
          env: { GH_TOKEN: 'token-value' },
          runSubprocessFn,
          dependencyRunSubprocessFn: fakeRubyBundleSubprocess(),
        },
      );

      const messages = error.problems.map((problem) => problem.message).join('\n');
      expect(messages).toMatch(/failed to determine push\/PR permission/);
      expect(messages).toMatch(/could not resolve repository/);
    });

    it('skips gh auth/permission checks (and reports it via the reused dependency check) when gh is missing', async () => {
      const runSubprocessFn = vi.fn<
        (options: RunSubprocessOptions) => Promise<RunSubprocessResult>
      >(() => Promise.resolve(success()));
      const commands = new Set(['ruby', 'bundle', 'git']);

      const error = await expectDoctorError(
        buildConfig({ exporter: { parser_path: parserPath, notes_container: '/dev/null' } }),
        {
          commandExistsFn: (command) => Promise.resolve(commands.has(command)),
          env: { GH_TOKEN: 'token-value' },
          runSubprocessFn,
          dependencyRunSubprocessFn: fakeRubyBundleSubprocess(),
        },
      );

      const messages = error.problems.map((problem) => problem.message).join('\n');
      expect(messages).toMatch(/"gh"/);
      expect(runSubprocessFn).not.toHaveBeenCalled();
    });

    it('skips gh auth/permission checks (and reports it via the reused dependency check) when GH_TOKEN is unset', async () => {
      const runSubprocessFn = vi.fn<
        (options: RunSubprocessOptions) => Promise<RunSubprocessResult>
      >(() => Promise.resolve(success()));

      const error = await expectDoctorError(
        buildConfig({ exporter: { parser_path: parserPath, notes_container: '/dev/null' } }),
        {
          commandExistsFn: (command) => Promise.resolve(allCommandsPresent.has(command)),
          env: {},
          runSubprocessFn,
          dependencyRunSubprocessFn: fakeRubyBundleSubprocess(),
        },
      );

      const messages = error.problems.map((problem) => problem.message).join('\n');
      expect(messages).toMatch(/GH_TOKEN/);
      expect(runSubprocessFn).not.toHaveBeenCalled();
    });

    it('lists every simultaneous failure at once (missing ruby + failing gh auth)', async () => {
      const runSubprocessFn = vi.fn<
        (options: RunSubprocessOptions) => Promise<RunSubprocessResult>
      >(() => Promise.resolve(failure('auth error')));
      const commands = new Set(['git', 'gh']);

      const error = await expectDoctorError(
        buildConfig({ exporter: { parser_path: parserPath, notes_container: '/dev/null' } }),
        {
          commandExistsFn: (command) => Promise.resolve(commands.has(command)),
          env: { GH_TOKEN: 'token-value' },
          runSubprocessFn,
        },
      );

      const messages = error.problems.map((problem) => problem.message).join('\n');
      expect(messages).toMatch(/"ruby"/);
      expect(messages).toMatch(/gh auth status.*failed/);
      expect(error.problems.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('API-mode services (qiita/devto/note/hatena)', () => {
    it('does not run any gh checks for devto, even if gh/GH_TOKEN happen to be present', async () => {
      const runSubprocessFn = vi.fn<
        (options: RunSubprocessOptions) => Promise<RunSubprocessResult>
      >(() => Promise.resolve(success()));

      await expect(
        runDoctorChecks(
          buildConfig({
            service: 'devto',
            git: undefined,
            devto: { api_key_env: 'DEVTO_API_KEY' },
            exporter: { parser_path: parserPath, notes_container: '/dev/null' },
          }),
          {
            commandExistsFn: (command) => Promise.resolve(allCommandsPresent.has(command)),
            env: { GH_TOKEN: 'token-value' },
            runSubprocessFn,
            dependencyRunSubprocessFn: fakeRubyBundleSubprocess(),
            fileReadableFn: () => Promise.resolve(true),
          },
        ),
      ).resolves.toBeUndefined();

      expect(runSubprocessFn).not.toHaveBeenCalled();
    });

    it('passes for hatena using only the reused common/service checks', async () => {
      const runSubprocessFn = vi.fn<
        (options: RunSubprocessOptions) => Promise<RunSubprocessResult>
      >(() => Promise.resolve(success()));

      await expect(
        runDoctorChecks(
          buildConfig({
            service: 'hatena',
            git: undefined,
            hatena: {
              hatena_id: 'example',
              blog_id: 'example.hatenablog.com',
              api_key_env: 'HATENA_API_KEY',
            },
            exporter: { parser_path: parserPath, notes_container: '/dev/null' },
          }),
          {
            commandExistsFn: (command) => Promise.resolve(allCommandsPresent.has(command)),
            env: {},
            runSubprocessFn,
            dependencyRunSubprocessFn: fakeRubyBundleSubprocess(),
            fileReadableFn: () => Promise.resolve(true),
          },
        ),
      ).resolves.toBeUndefined();

      expect(runSubprocessFn).not.toHaveBeenCalled();
    });

    it('passes for qiita using only the reused common/service checks (issue #82: no more node/npx/qiita-cli checks)', async () => {
      const runSubprocessFn = vi.fn<
        (options: RunSubprocessOptions) => Promise<RunSubprocessResult>
      >(() => Promise.resolve(success()));

      await expect(
        runDoctorChecks(
          buildConfig({
            service: 'qiita',
            git: undefined,
            qiita: { token_env: 'QIITA_TOKEN' },
            exporter: { parser_path: parserPath, notes_container: '/dev/null' },
          }),
          {
            commandExistsFn: (command) => Promise.resolve(allCommandsPresent.has(command)),
            env: {},
            runSubprocessFn,
            dependencyRunSubprocessFn: fakeRubyBundleSubprocess(),
            fileReadableFn: () => Promise.resolve(true),
          },
        ),
      ).resolves.toBeUndefined();

      expect(runSubprocessFn).not.toHaveBeenCalled();
    });

    it('passes for note using only the reused common/service checks (issue #86: no more noet/NOET_PATH checks)', async () => {
      const runSubprocessFn = vi.fn<
        (options: RunSubprocessOptions) => Promise<RunSubprocessResult>
      >(() => Promise.resolve(success()));

      await expect(
        runDoctorChecks(
          buildConfig({
            service: 'note',
            git: undefined,
            note: { session_cookie_env: 'NOTE_SESSION_COOKIE' },
            exporter: { parser_path: parserPath, notes_container: '/dev/null' },
          }),
          {
            commandExistsFn: (command) => Promise.resolve(allCommandsPresent.has(command)),
            env: {},
            runSubprocessFn,
            dependencyRunSubprocessFn: fakeRubyBundleSubprocess(),
            fileReadableFn: () => Promise.resolve(true),
          },
        ),
      ).resolves.toBeUndefined();

      expect(runSubprocessFn).not.toHaveBeenCalled();
    });
  });

  it('reports the missing parser entry point, naming the resolved path', async () => {
    const error = await expectDoctorError(buildConfig(), {
      commandExistsFn: () => Promise.resolve(true),
      fileExistsFn: () => Promise.resolve(false),
      env: { GH_TOKEN: 'token-value' },
      runSubprocessFn: () => Promise.resolve(success()),
      dependencyRunSubprocessFn: fakeRubyBundleSubprocess(),
    });

    const messages = error.problems.map((problem) => problem.message).join('\n');
    expect(messages).toMatch(/apple_cloud_notes_parser lib\/ not found/);
    expect(messages).toContain(join('lib', 'AppleNoteStore.rb'));
  });
});
