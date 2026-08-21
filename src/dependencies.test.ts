import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkDependencies,
  DependencyCheckError,
  type CheckDependenciesOptions,
  type DependencySubprocessRunner,
} from './dependencies.js';
import type { Config } from './config.js';
import type { RunSubprocessResult } from './subprocess.js';

/** `checkDependencies` が `DependencyCheckError` で reject することを検証しつつ、その値を受け取る。 */
async function expectDependencyError(
  config: Config,
  options?: CheckDependenciesOptions,
): Promise<DependencyCheckError> {
  try {
    await checkDependencies(config, options);
  } catch (error) {
    expect(error).toBeInstanceOf(DependencyCheckError);
    return error as DependencyCheckError;
  }
  throw new Error(
    'unreachable: checkDependencies was expected to reject with DependencyCheckError',
  );
}

/** `checkDependencies` に渡す最小限の検証済み設定。`overrides` でサービス別ブロックを足す。 */
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

/**
 * `ruby -v` / `bundle check` 実行の既定成功フェイク(issue #67)。既存の(ruby/bundle
 * チェックとは無関係な)テストが実ホストのサブプロセスに触れず、決定的に振る舞うようにする。
 * `rubyResult` / `bundleResult` で個別に上書きできる。
 */
function fakeRubyBundleSubprocess(
  overrides: Partial<{ rubyResult: RunSubprocessResult; bundleResult: RunSubprocessResult }> = {},
): DependencySubprocessRunner {
  const rubyResult: RunSubprocessResult = overrides.rubyResult ?? {
    status: 'success',
    exitCode: 0,
    signal: null,
    stdout: 'ruby 3.2.2p53 (2023-03-30 revision e51014f9c0) [x86_64-darwin23]\n',
    stderr: '',
  };
  const bundleResult: RunSubprocessResult = overrides.bundleResult ?? {
    status: 'success',
    exitCode: 0,
    signal: null,
    stdout: "The Gemfile's dependencies are satisfied\n",
    stderr: '',
  };
  return (options) => {
    if (options.command === 'ruby') {
      return Promise.resolve(rubyResult);
    }
    if (options.command === 'bundle') {
      return Promise.resolve(bundleResult);
    }
    return Promise.reject(
      new Error(`test fake: unexpected command passed to runSubprocessFn: ${options.command}`),
    );
  };
}

describe('checkDependencies', () => {
  let dir: string;
  let parserPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'note2web-dependencies-test-'));
    parserPath = join(dir, 'parser');
    // issue #72: 実在チェックの対象が upstream の `lib/AppleNoteStore.rb` に変わった
    // (以前は `notes_cloud_ripper.rb` エントリポイント自体を見ていた)。
    mkdirSync(join(parserPath, 'lib'), { recursive: true });
    writeFileSync(join(parserPath, 'lib', 'AppleNoteStore.rb'), '# fixture stub\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes for a git-mode service when ruby/bundle/git/gh exist, the parser entry point exists, gems are ready, and GH_TOKEN is set', async () => {
    const commands = new Set(['ruby', 'bundle', 'git', 'gh']);
    await expect(
      checkDependencies(
        buildConfig({ exporter: { parser_path: parserPath, notes_container: '/dev/null' } }),
        {
          commandExistsFn: (command) => Promise.resolve(commands.has(command)),
          env: { GH_TOKEN: 'token-value' },
          runSubprocessFn: fakeRubyBundleSubprocess(),
          fileReadableFn: () => Promise.resolve(true),
        },
      ),
    ).resolves.toBeUndefined();
  });

  it('reports every missing common dependency at once (ruby + bundle + parser entry point)', async () => {
    const error = await expectDependencyError(
      buildConfig({
        exporter: { parser_path: join(dir, 'missing-parser'), notes_container: '/dev/null' },
      }),
      { commandExistsFn: () => Promise.resolve(false), env: { GH_TOKEN: 'token-value' } },
    );

    expect(error.exitCode).toBe(2);
    const messages = error.problems.map((problem) => problem.message).join('\n');
    expect(messages).toMatch(/"ruby"/);
    expect(messages).toMatch(/"bundle"/);
    expect(messages).toMatch(/apple_cloud_notes_parser lib\/ not found/);
    // git mode の git/gh も同時に不足として報告される(1件見つけて打ち切らない)。
    expect(error.problems.length).toBeGreaterThanOrEqual(5);
  });

  it('requires git, gh, and GH_TOKEN for git-mode services (zenn/hugo/jekyll) but not for others', async () => {
    const commands = new Set(['ruby', 'bundle']);
    const error = await expectDependencyError(
      buildConfig({ exporter: { parser_path: parserPath, notes_container: '/dev/null' } }),
      {
        commandExistsFn: (command) => Promise.resolve(commands.has(command)),
        env: {},
        runSubprocessFn: fakeRubyBundleSubprocess(),
      },
    );

    const messages = error.problems.map((problem) => problem.message).join('\n');
    expect(messages).toMatch(/"git"/);
    expect(messages).toMatch(/"gh"/);
    expect(messages).toMatch(/GH_TOKEN/);
  });

  it('requires nothing beyond the common checks for qiita (QIITA_TOKEN is validated by config.ts; issue #82 removed the node/npx/@qiita/qiita-cli checks)', async () => {
    const commands = new Set(['ruby', 'bundle']);
    await expect(
      checkDependencies(
        buildConfig({
          service: 'qiita',
          git: undefined,
          qiita: { token_env: 'QIITA_TOKEN' },
          exporter: { parser_path: parserPath, notes_container: '/dev/null' },
        }),
        {
          commandExistsFn: (command) => Promise.resolve(commands.has(command)),
          env: {},
          runSubprocessFn: fakeRubyBundleSubprocess(),
          fileReadableFn: () => Promise.resolve(true),
        },
      ),
    ).resolves.toBeUndefined();
  });

  it('requires nothing beyond the common checks for devto (DEVTO_API_KEY is validated by config.ts)', async () => {
    const commands = new Set(['ruby', 'bundle']);
    await expect(
      checkDependencies(
        buildConfig({
          service: 'devto',
          git: undefined,
          devto: { api_key_env: 'DEVTO_API_KEY' },
          exporter: { parser_path: parserPath, notes_container: '/dev/null' },
        }),
        {
          commandExistsFn: (command) => Promise.resolve(commands.has(command)),
          env: {},
          runSubprocessFn: fakeRubyBundleSubprocess(),
          fileReadableFn: () => Promise.resolve(true),
        },
      ),
    ).resolves.toBeUndefined();
  });

  it('requires nothing beyond the common checks for hatena (HATENA_API_KEY is validated by config.ts)', async () => {
    const commands = new Set(['ruby', 'bundle']);
    await expect(
      checkDependencies(
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
          commandExistsFn: (command) => Promise.resolve(commands.has(command)),
          env: {},
          runSubprocessFn: fakeRubyBundleSubprocess(),
          fileReadableFn: () => Promise.resolve(true),
        },
      ),
    ).resolves.toBeUndefined();
  });

  describe('note dependency check (NOET_PATH; no PATH fallback for "noet")', () => {
    const buildNoteConfig = (): Config =>
      buildConfig({
        service: 'note',
        git: undefined,
        note: { workspace: '~/src/note-content' },
        exporter: { parser_path: parserPath, notes_container: '/dev/null' },
      });

    it('reports a problem naming NOET_PATH when it is unset, and never falls back to a PATH lookup for "noet"', async () => {
      const commands = new Set(['ruby', 'bundle', 'noet']); // "noet" IS on PATH, but must be ignored.
      const error = await expectDependencyError(buildNoteConfig(), {
        commandExistsFn: (command) => Promise.resolve(commands.has(command)),
        env: {},
        runSubprocessFn: fakeRubyBundleSubprocess(),
      });

      const messages = error.problems.map((problem) => problem.message).join('\n');
      expect(messages).toMatch(/NOET_PATH/);
      expect(messages).toMatch(/note2web init/);
      expect(messages).toMatch(/~\/\.cargo\/bin\/noet/);
      // PATH フォールバックは行わない契約(たとえ "noet" が PATH 上にあっても未設定は問題)。
      expect(messages).not.toMatch(/was not found on PATH/);
    });

    it('reports a problem when NOET_PATH is the empty string', async () => {
      const commands = new Set(['ruby', 'bundle']);
      const error = await expectDependencyError(buildNoteConfig(), {
        commandExistsFn: (command) => Promise.resolve(commands.has(command)),
        env: { NOET_PATH: '' },
        runSubprocessFn: fakeRubyBundleSubprocess(),
      });

      expect(error.problems.map((problem) => problem.message).join('\n')).toMatch(/NOET_PATH/);
    });

    it('reports a problem containing the resolved path when NOET_PATH points at a missing or non-executable file', async () => {
      const commands = new Set(['ruby', 'bundle']);
      const noetPath = '/opt/tools/noet';
      const error = await expectDependencyError(buildNoteConfig(), {
        commandExistsFn: (command) => Promise.resolve(commands.has(command)),
        env: { NOET_PATH: noetPath },
        // NoteStore.sqlite 側の読み取り可否チェック(fileReadableFn)は成功させ、
        // noet バイナリの実行可否チェック(executableFileFn)だけを失敗させる。
        fileReadableFn: () => Promise.resolve(true),
        executableFileFn: () => Promise.resolve(false),
        runSubprocessFn: fakeRubyBundleSubprocess(),
      });

      const messages = error.problems.map((problem) => problem.message).join('\n');
      expect(messages).toContain(noetPath);
      expect(messages).toMatch(/NOET_PATH/);
      expect(messages).toMatch(/executable regular file/);
    });

    it('passes (no problem) when NOET_PATH is set and the file is an executable regular file', async () => {
      const commands = new Set(['ruby', 'bundle']);
      await expect(
        checkDependencies(buildNoteConfig(), {
          commandExistsFn: (command) => Promise.resolve(commands.has(command)),
          env: { NOET_PATH: '/opt/tools/noet' },
          fileReadableFn: () => Promise.resolve(true),
          executableFileFn: () => Promise.resolve(true),
          runSubprocessFn: fakeRubyBundleSubprocess(),
        }),
      ).resolves.toBeUndefined();
    });

    it('expands a leading ~ in NOET_PATH before checking executability', async () => {
      const commands = new Set(['ruby', 'bundle']);
      const checkedPaths: string[] = [];
      await checkDependencies(buildNoteConfig(), {
        commandExistsFn: (command) => Promise.resolve(commands.has(command)),
        env: { NOET_PATH: '~/bin/noet' },
        fileReadableFn: () => Promise.resolve(true),
        executableFileFn: (path) => {
          checkedPaths.push(path);
          return Promise.resolve(true);
        },
        runSubprocessFn: fakeRubyBundleSubprocess(),
      });

      const expanded = checkedPaths.find((path) => path.endsWith(join('bin', 'noet')));
      expect(expanded).toBeDefined();
      expect(expanded?.startsWith('~')).toBe(false);
    });

    // 相対パスは cwd 依存で launchd 実行時に解決先が変わるため拒否する
    // (PR #84 CodeRabbit レビュー。PATH フォールバック廃止と同じ理由)。
    it.each(['noet', './noet'])(
      'reports a problem for the relative NOET_PATH %j without checking the filesystem',
      async (relativePath) => {
        const commands = new Set(['ruby', 'bundle']);
        const executableChecked: string[] = [];
        const error = await expectDependencyError(buildNoteConfig(), {
          commandExistsFn: (command) => Promise.resolve(commands.has(command)),
          env: { NOET_PATH: relativePath },
          fileReadableFn: () => Promise.resolve(true),
          executableFileFn: (path) => {
            executableChecked.push(path);
            return Promise.resolve(true);
          },
          runSubprocessFn: fakeRubyBundleSubprocess(),
        });

        const messages = error.problems.map((problem) => problem.message).join('\n');
        expect(messages).toMatch(/not an absolute path/);
        expect(executableChecked).toHaveLength(0);
      },
    );

    // 既定の executableFileFn(実ファイルシステム): 「実行可能な通常ファイル」以外を弾く
    // (PR #84 CodeRabbit レビュー: ディレクトリ・実行権限の無いファイルの拒否)。
    describe('default executableFileFn against the real filesystem', () => {
      const runWithRealCheck = (noetPath: string): Promise<void> =>
        checkDependencies(buildNoteConfig(), {
          commandExistsFn: (command) => Promise.resolve(new Set(['ruby', 'bundle']).has(command)),
          env: { NOET_PATH: noetPath },
          fileReadableFn: () => Promise.resolve(true),
          // executableFileFn は注入しない = 既定実装(stat + R_OK|X_OK)を使う。
          runSubprocessFn: fakeRubyBundleSubprocess(),
        });

      it('rejects a directory', async () => {
        const dirPath = join(dir, 'noet-as-dir');
        mkdirSync(dirPath);
        await expect(runWithRealCheck(dirPath)).rejects.toThrow(/executable regular file/);
      });

      it('rejects a regular file without execute permission', async () => {
        const filePath = join(dir, 'noet-not-executable');
        writeFileSync(filePath, '#!/bin/sh\n');
        chmodSync(filePath, 0o644);
        await expect(runWithRealCheck(filePath)).rejects.toThrow(/executable regular file/);
      });

      it('accepts an executable regular file', async () => {
        const filePath = join(dir, 'noet-executable');
        writeFileSync(filePath, '#!/bin/sh\n');
        chmodSync(filePath, 0o755);
        await expect(runWithRealCheck(filePath)).resolves.toBeUndefined();
      });
    });
  });

  it('expands a leading ~ in exporter.parser_path when locating upstream lib/AppleNoteStore.rb', async () => {
    // 実ファイルシステムに依存せず、fileExistsFn へ渡された実際のパスを記録して検証する
    // (CodeRabbit review, PR #47: ホスト環境の実在有無に依存させない)。`fileExistsFn` は
    // parser 本体(lib/)の実在確認・note2web 自身のスクリプトの実在確認・issue #69 で
    // 追加した Notes コンテナディレクトリの実在確認に使われるため、ここでは3回
    // (parser lib/ → note2web スクリプト → notes container の順)呼ばれる(issue #72)。
    const commands = new Set(['ruby', 'bundle', 'git', 'gh']);
    const checkedPaths: string[] = [];
    const error = await expectDependencyError(buildConfig(), {
      commandExistsFn: (command) => Promise.resolve(commands.has(command)),
      fileExistsFn: (path) => {
        checkedPaths.push(path);
        return Promise.resolve(false);
      },
      env: { GH_TOKEN: 'token-value' },
      runSubprocessFn: fakeRubyBundleSubprocess(),
    });

    expect(checkedPaths).toHaveLength(3);
    const checkedPath = checkedPaths[0];
    if (checkedPath === undefined) {
      throw new Error('test setup: fileExistsFn was not called');
    }
    // `~` が展開され、絶対パス(`~/` を含まない)になっていること。
    expect(checkedPath).not.toContain('~/');
    expect(checkedPath).toMatch(/^\//);
    expect(checkedPath.endsWith(join('lib', 'AppleNoteStore.rb'))).toBe(true);

    // 2件目は note2web 自身のスクリプト(parser_path に依存しない絶対パス)。
    const scriptCheckedPath = checkedPaths[1];
    if (scriptCheckedPath === undefined) {
      throw new Error('test setup: fileExistsFn was not called for the note2web script');
    }
    expect(scriptCheckedPath.endsWith(join('ruby', 'note2web_export.rb'))).toBe(true);

    // 3件目(Notes コンテナディレクトリ)も同じく `~` が展開されていること。
    const containerCheckedPath = checkedPaths[2];
    if (containerCheckedPath === undefined) {
      throw new Error('test setup: fileExistsFn was not called for the notes container');
    }
    expect(containerCheckedPath).not.toContain('~/');
    expect(containerCheckedPath).toMatch(/^\//);

    const message = error.problems.map((problem) => problem.message).join('\n');
    expect(message).not.toContain('~/');
    expect(message).toContain(checkedPath);
    expect(message).toContain(containerCheckedPath);
  });

  describe('Ruby version check (issue #67)', () => {
    it('does not attempt "ruby -v" when the ruby command itself is missing (avoids double-reporting)', async () => {
      // bundle はコマンドとして存在させておき(bundle check は別チェック)、ここでは
      // "ruby -v" を試みないことだけを検証する。
      const commands = new Set(['bundle', 'git', 'gh']);
      let rubyVersionCallCount = 0;
      const error = await expectDependencyError(
        buildConfig({ exporter: { parser_path: parserPath, notes_container: '/dev/null' } }),
        {
          commandExistsFn: (command) => Promise.resolve(commands.has(command)),
          env: { GH_TOKEN: 'token-value' },
          runSubprocessFn: (options) => {
            if (options.command === 'ruby') {
              rubyVersionCallCount += 1;
            }
            return fakeRubyBundleSubprocess()(options);
          },
        },
      );

      expect(rubyVersionCallCount).toBe(0);
      const messages = error.problems.map((problem) => problem.message).join('\n');
      expect(messages).toMatch(/"ruby"/);
    });

    it('reports a problem when "ruby -v" itself fails to run', async () => {
      const commands = new Set(['ruby', 'bundle', 'git', 'gh']);
      const error = await expectDependencyError(
        buildConfig({ exporter: { parser_path: parserPath, notes_container: '/dev/null' } }),
        {
          commandExistsFn: (command) => Promise.resolve(commands.has(command)),
          env: { GH_TOKEN: 'token-value' },
          runSubprocessFn: fakeRubyBundleSubprocess({
            rubyResult: {
              status: 'failure',
              classification: 'exit_code',
              exitCode: 127,
              signal: null,
              stdout: '',
              stderr: 'command not found: ruby\n',
            },
          }),
        },
      );

      const messages = error.problems.map((problem) => problem.message).join('\n');
      expect(messages).toMatch(/failed to run "ruby -v"/);
      expect(messages).toMatch(/command not found: ruby/);
    });

    it('reports a problem when "ruby -v" output cannot be parsed as a version', async () => {
      const commands = new Set(['ruby', 'bundle', 'git', 'gh']);
      const error = await expectDependencyError(
        buildConfig({ exporter: { parser_path: parserPath, notes_container: '/dev/null' } }),
        {
          commandExistsFn: (command) => Promise.resolve(commands.has(command)),
          env: { GH_TOKEN: 'token-value' },
          runSubprocessFn: fakeRubyBundleSubprocess({
            rubyResult: {
              status: 'success',
              exitCode: 0,
              signal: null,
              stdout: 'not a version string\n',
              stderr: '',
            },
          }),
        },
      );

      const messages = error.problems.map((problem) => problem.message).join('\n');
      expect(messages).toMatch(/could not parse the Ruby version/);
    });

    it('reports a problem when the Ruby version is older than 3.0', async () => {
      const commands = new Set(['ruby', 'bundle', 'git', 'gh']);
      const error = await expectDependencyError(
        buildConfig({ exporter: { parser_path: parserPath, notes_container: '/dev/null' } }),
        {
          commandExistsFn: (command) => Promise.resolve(commands.has(command)),
          env: { GH_TOKEN: 'token-value' },
          runSubprocessFn: fakeRubyBundleSubprocess({
            rubyResult: {
              status: 'success',
              exitCode: 0,
              signal: null,
              stdout: 'ruby 2.7.6p219 (2022-04-12 revision c9c2245c0a) [x86_64-linux]\n',
              stderr: '',
            },
          }),
        },
      );

      const messages = error.problems.map((problem) => problem.message).join('\n');
      expect(messages).toMatch(/2\.7\.6/);
      expect(messages).toMatch(/>=3\.0\.0/);
    });

    it('passes when the Ruby version is exactly the minimum (3.0.0)', async () => {
      const commands = new Set(['ruby', 'bundle', 'git', 'gh']);
      await expect(
        checkDependencies(
          buildConfig({ exporter: { parser_path: parserPath, notes_container: '/dev/null' } }),
          {
            commandExistsFn: (command) => Promise.resolve(commands.has(command)),
            env: { GH_TOKEN: 'token-value' },
            runSubprocessFn: fakeRubyBundleSubprocess({
              rubyResult: {
                status: 'success',
                exitCode: 0,
                signal: null,
                stdout: 'ruby 3.0.0p0 (2020-12-25 revision 95aff21468) [x86_64-linux]\n',
                stderr: '',
              },
            }),
            fileReadableFn: () => Promise.resolve(true),
          },
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('launcher: bundle (default) — bundle command & gem readiness (issue #67)', () => {
    it('reports a problem when the bundle command is missing', async () => {
      const commands = new Set(['ruby', 'git', 'gh']);
      const error = await expectDependencyError(
        buildConfig({ exporter: { parser_path: parserPath, notes_container: '/dev/null' } }),
        {
          commandExistsFn: (command) => Promise.resolve(commands.has(command)),
          env: { GH_TOKEN: 'token-value' },
          runSubprocessFn: fakeRubyBundleSubprocess(),
        },
      );

      const messages = error.problems.map((problem) => problem.message).join('\n');
      expect(messages).toMatch(/"bundle"/);
    });

    it('reports a problem, including the parser path and first output line, when "bundle check" fails', async () => {
      const commands = new Set(['ruby', 'bundle', 'git', 'gh']);
      const error = await expectDependencyError(
        buildConfig({ exporter: { parser_path: parserPath, notes_container: '/dev/null' } }),
        {
          commandExistsFn: (command) => Promise.resolve(commands.has(command)),
          env: { GH_TOKEN: 'token-value' },
          runSubprocessFn: fakeRubyBundleSubprocess({
            bundleResult: {
              status: 'failure',
              classification: 'exit_code',
              exitCode: 1,
              signal: null,
              stdout: '',
              stderr: 'The following gems are missing\n  * sqlite3\n',
            },
          }),
        },
      );

      const messages = error.problems.map((problem) => problem.message).join('\n');
      expect(messages).toMatch(/bundle install/);
      expect(messages).toContain(parserPath);
      expect(messages).toMatch(/The following gems are missing/);
    });

    it('does not invoke "bundle check" when the parser entry point is missing (reports only the parser_path problem)', async () => {
      const commands = new Set(['ruby', 'bundle', 'git', 'gh']);
      const calls: string[] = [];
      const missingParserPath = join(dir, 'missing-parser');
      const error = await expectDependencyError(
        buildConfig({
          exporter: { parser_path: missingParserPath, notes_container: '/dev/null' },
        }),
        {
          commandExistsFn: (command) => Promise.resolve(commands.has(command)),
          env: { GH_TOKEN: 'token-value' },
          runSubprocessFn: (options) => {
            calls.push(options.command);
            return fakeRubyBundleSubprocess()(options);
          },
        },
      );

      // "bundle check" は起動されない(呼ばれるのは "ruby -v" のみ)。
      expect(calls).not.toContain('bundle');
      expect(calls).toEqual(['ruby']);

      const messages = error.problems.map((problem) => problem.message).join('\n');
      expect(messages).toMatch(/apple_cloud_notes_parser lib\/ not found/);
      expect(messages).not.toMatch(/bundle install/);
    });

    it('does not check bundle command or gem readiness when exporter.launcher is "ruby"', async () => {
      const commands = new Set(['ruby', 'git', 'gh']);
      let bundleCalled = false;
      await expect(
        checkDependencies(
          buildConfig({
            exporter: {
              parser_path: parserPath,
              notes_container: '/dev/null',
              launcher: 'ruby',
            },
          }),
          {
            commandExistsFn: (command) => Promise.resolve(commands.has(command)),
            env: { GH_TOKEN: 'token-value' },
            runSubprocessFn: (options) => {
              if (options.command === 'bundle') {
                bundleCalled = true;
              }
              return fakeRubyBundleSubprocess()(options);
            },
            fileReadableFn: () => Promise.resolve(true),
          },
        ),
      ).resolves.toBeUndefined();
      expect(bundleCalled).toBe(false);
    });
  });

  describe('Notes container / NoteStore.sqlite preflight (issue #69)', () => {
    it('reports a problem naming the path and config key when the notes container directory is missing', async () => {
      const commands = new Set(['ruby', 'bundle', 'git', 'gh']);
      const missingContainer = join(dir, 'missing-container');
      const error = await expectDependencyError(
        buildConfig({
          exporter: { parser_path: parserPath, notes_container: missingContainer },
        }),
        {
          commandExistsFn: (command) => Promise.resolve(commands.has(command)),
          env: { GH_TOKEN: 'token-value' },
          runSubprocessFn: fakeRubyBundleSubprocess(),
        },
      );

      const messages = error.problems.map((problem) => problem.message).join('\n');
      expect(messages).toMatch(/Apple Notes container directory not found/);
      expect(messages).toContain(missingContainer);
      expect(messages).toMatch(/exporter\.notes_container/);
    });

    it('reports a Full Disk Access hint when the container exists but NoteStore.sqlite is missing/unreadable', async () => {
      const commands = new Set(['ruby', 'bundle', 'git', 'gh']);
      const containerDir = join(dir, 'notes-container');
      mkdirSync(containerDir, { recursive: true });
      // NoteStore.sqlite は意図的に作らない(存在しない = 読み取り不可のケースを兼ねる)。

      const error = await expectDependencyError(
        buildConfig({
          exporter: { parser_path: parserPath, notes_container: containerDir },
        }),
        {
          commandExistsFn: (command) => Promise.resolve(commands.has(command)),
          env: { GH_TOKEN: 'token-value' },
          runSubprocessFn: fakeRubyBundleSubprocess(),
        },
      );

      const messages = error.problems.map((problem) => problem.message).join('\n');
      expect(messages).toMatch(/Apple Notes database not found or not readable/);
      expect(messages).toContain(join(containerDir, 'NoteStore.sqlite'));
      expect(messages).toMatch(/Full Disk Access/);
      expect(messages).toMatch(/フルディスクアクセス/);
    });

    it('reports the Full Disk Access hint when NoteStore.sqlite exists but is not readable', async () => {
      const commands = new Set(['ruby', 'bundle', 'git', 'gh']);
      const containerDir = join(dir, 'notes-container-unreadable');
      mkdirSync(containerDir, { recursive: true });
      writeFileSync(join(containerDir, 'NoteStore.sqlite'), 'fixture stub');

      const error = await expectDependencyError(
        buildConfig({
          exporter: { parser_path: parserPath, notes_container: containerDir },
        }),
        {
          commandExistsFn: (command) => Promise.resolve(commands.has(command)),
          env: { GH_TOKEN: 'token-value' },
          runSubprocessFn: fakeRubyBundleSubprocess(),
          fileReadableFn: () => Promise.resolve(false),
        },
      );

      const messages = error.problems.map((problem) => problem.message).join('\n');
      expect(messages).toMatch(/Apple Notes database not found or not readable/);
      expect(messages).toMatch(/Full Disk Access/);
    });

    it('does not report a notes-container problem when the container exists and NoteStore.sqlite is readable', async () => {
      const commands = new Set(['ruby', 'bundle', 'git', 'gh']);
      const containerDir = join(dir, 'notes-container-ok');
      mkdirSync(containerDir, { recursive: true });
      writeFileSync(join(containerDir, 'NoteStore.sqlite'), 'fixture stub');

      await expect(
        checkDependencies(
          buildConfig({
            exporter: { parser_path: parserPath, notes_container: containerDir },
          }),
          {
            commandExistsFn: (command) => Promise.resolve(commands.has(command)),
            env: { GH_TOKEN: 'token-value' },
            runSubprocessFn: fakeRubyBundleSubprocess(),
          },
        ),
      ).resolves.toBeUndefined();
    });
  });
});
