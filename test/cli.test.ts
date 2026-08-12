import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isMainEntry, runCli } from '../src/cli.js';
import { DoctorError, runDoctorChecks } from '../src/doctor.js';
import { PARTIAL_FAILURE, PRECONDITION_FAILURE, SUCCESS } from '../src/exit-codes.js';

/**
 * `doctor` の実チェック(host の ruby/git/gh 等の実在有無)は `src/doctor.test.ts` が
 * 注入可能な `commandExistsFn`/`runSubprocessFn` で決定的に検証する。ここ(CLI 統合テスト)
 * では `runDoctorChecks` 自体をモックし、`runCli` が「成功サマリ / `DoctorError.problems`
 * を stderr 行へ展開する処理」を正しく配線しているかだけを検証する(CodeRabbit review,
 * PR #48: 実行ホストの状態に依存すると CI 環境間でテスト結果がぶれるため)。
 */
vi.mock('../src/doctor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/doctor.js')>();
  return {
    ...actual,
    runDoctorChecks: vi.fn(),
  };
});

/** T-04 で追加した schema 検証済み fixture(service: zenn、assets+git を満たす)。 */
const VALID_CONFIG_PATH = fileURLToPath(new URL('./fixtures/configs/zenn.yaml', import.meta.url));
const VALID_CONFIG_ENV_VARS = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

describe('exit codes', () => {
  it('keeps the documented numeric contract (design.md §5.1)', () => {
    expect(SUCCESS).toBe(0);
    expect(PARTIAL_FAILURE).toBe(1);
    expect(PRECONDITION_FAILURE).toBe(2);
  });
});

describe('runCli', () => {
  let dir: string;
  let configPath: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'note2web-cli-test-'));
    // schema 上は不正(必須キー欠如・未知キー)な設定ファイル。サブコマンド解析や
    // --config の存在確認そのものを検証するテストで使う。
    configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, 'placeholder: true\n');

    for (const name of VALID_CONFIG_ENV_VARS) {
      originalEnv[name] = process.env[name];
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const name of VALID_CONFIG_ENV_VARS) {
      if (originalEnv[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = originalEnv[name];
      }
    }
    vi.mocked(runDoctorChecks).mockReset();
  });

  it('exits 2 with usage on stderr when no subcommand is given', async () => {
    const result = await runCli([]);

    expect(result.exitCode).toBe(PRECONDITION_FAILURE);
    expect(result.stderr.join('\n')).toMatch(/usage/i);
    expect(result.stdout).toHaveLength(0);
  });

  it('exits 2 with usage on stderr for an unknown subcommand', async () => {
    const result = await runCli(['publish', '--config', configPath]);

    expect(result.exitCode).toBe(PRECONDITION_FAILURE);
    expect(result.stderr.join('\n')).toMatch(/usage/i);
  });

  it('exits 2 with an error on stderr when --config is missing', async () => {
    const result = await runCli(['sync']);

    expect(result.exitCode).toBe(PRECONDITION_FAILURE);
    expect(result.stderr.join('\n')).toMatch(/--config/);
  });

  it('exits 2 with an error containing the path when the config file does not exist', async () => {
    const missingPath = join(dir, 'does-not-exist.yaml');

    const result = await runCli(['sync', '--config', missingPath]);

    expect(result.exitCode).toBe(PRECONDITION_FAILURE);
    expect(result.stderr.join('\n')).toContain(missingPath);
  });

  it('exits 0 with the success summary when runDoctorChecks resolves (T-15)', async () => {
    // `runDoctorChecks` 自体のチェック内容は `src/doctor.test.ts` の責務。ここでは
    // `runCli` が成功時に stdout へサマリを出し SUCCESS を返す配線だけを検証する。
    vi.stubEnv('R2_ACCESS_KEY_ID', 'dummy-value');
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 'dummy-value');
    try {
      vi.mocked(runDoctorChecks).mockResolvedValueOnce(undefined);

      const result = await runCli(['doctor', '--config', VALID_CONFIG_PATH]);

      expect(result.exitCode).toBe(SUCCESS);
      expect(result.stderr).toHaveLength(0);
      expect(result.stdout.join('\n')).toMatch(/all checks passed for service "zenn"/);
      expect(runDoctorChecks).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('exits 2 and lists every problem on stderr with the "note2web: doctor:" prefix when runDoctorChecks rejects with DoctorError (T-15)', async () => {
    // `DoctorError.problems` の中身(何が足りないか)は `src/doctor.test.ts` の責務。
    // ここでは `runCli` が `problems` を1件ずつ stderr 行へ展開し、`error.exitCode` を
    // そのまま返す配線だけを検証する(複数件が全件列挙されることも合わせて確認)。
    vi.stubEnv('R2_ACCESS_KEY_ID', 'dummy-value');
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 'dummy-value');
    try {
      vi.mocked(runDoctorChecks).mockRejectedValueOnce(
        new DoctorError([
          { message: 'required command "gh" was not found on PATH' },
          { message: 'environment variable "GH_TOKEN" is not set' },
        ]),
      );

      const result = await runCli(['doctor', '--config', VALID_CONFIG_PATH]);

      expect(result.exitCode).toBe(PRECONDITION_FAILURE);
      expect(result.stdout).toHaveLength(0);
      expect(result.stderr).toEqual([
        'note2web: doctor: required command "gh" was not found on PATH',
        'note2web: doctor: environment variable "GH_TOKEN" is not set',
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('exits 2 with an error when --config points to a directory', async () => {
    const dirPath = join(dir, 'config-dir');
    mkdirSync(dirPath);

    const result = await runCli(['sync', '--config', dirPath]);

    expect(result.exitCode).toBe(PRECONDITION_FAILURE);
    expect(result.stderr.join('\n')).toContain(dirPath);
  });

  it('exits 2 with an error naming the problem key when the config file fails schema validation', async () => {
    // `configPath` (beforeEach) is `placeholder: true`: missing required keys and containing
    // an unknown key, so it must fail zod validation rather than pass the old existence-only check.
    const result = await runCli(['sync', '--config', configPath]);

    expect(result.exitCode).toBe(PRECONDITION_FAILURE);
    expect(result.stdout).toHaveLength(0);
    const stderr = result.stderr.join('\n');
    expect(stderr).toMatch(/service/);
  });

  it('exits 2 with an error naming the env var when a config-referenced *_env value is unset', async () => {
    // Only one of the two required env vars is set; the other must be reported by key path.
    process.env.R2_ACCESS_KEY_ID = 'dummy-value';
    delete process.env.R2_SECRET_ACCESS_KEY;

    const result = await runCli(['sync', '--config', VALID_CONFIG_PATH]);

    expect(result.exitCode).toBe(PRECONDITION_FAILURE);
    expect(result.stderr.join('\n')).toContain('R2_SECRET_ACCESS_KEY');
  });
});

describe('isMainEntry', () => {
  it('returns false when argv[1] is undefined', () => {
    expect(isMainEntry('file:///opt/app/dist/cli.js', undefined)).toBe(false);
  });

  it('matches plain paths', () => {
    const path = '/opt/app/dist/cli.js';
    expect(isMainEntry(pathToFileURL(path).href, path)).toBe(true);
  });

  it.each([
    '/opt/note 2 web/dist/cli.js',
    '/opt/note#2web/dist/cli.js',
    '/opt/note%2web/dist/cli.js',
  ])(
    'matches paths with special characters that break naive file:// concatenation (%s)',
    (path) => {
      const importMetaUrl = pathToFileURL(path).href;
      expect(isMainEntry(importMetaUrl, path)).toBe(true);
      // 手組み連結では一致しない(旧実装の回帰確認)
      expect(importMetaUrl === `file://${path}`).toBe(false);
    },
  );

  it('returns false for a different module path', () => {
    expect(isMainEntry(pathToFileURL('/opt/app/dist/cli.js').href, '/opt/app/dist/other.js')).toBe(
      false,
    );
  });

  it('matches when argv[1] is a symlink to the real module path (npm/npx bin resolution)', () => {
    // npm/npx invoke the CLI via a `node_modules/.bin/<name>` symlink. Node's ESM loader
    // resolves `import.meta.url` to the symlink's realpath, but `process.argv[1]` keeps the
    // symlink path as given — a naive comparison never matches, so `main()` silently never
    // runs (discovered via `npm pack` -> `npm install <tarball>` -> running the installed
    // bin symlink, which exited 0 with no output). Reproduce that shape here.
    const dir = mkdtempSync(join(tmpdir(), 'note2web-cli-symlink-'));
    try {
      const realFile = join(dir, 'cli.js');
      writeFileSync(realFile, '// stub\n');
      const binDir = join(dir, 'bin');
      mkdirSync(binDir);
      const symlinkPath = join(binDir, 'note2web');
      symlinkSync(realFile, symlinkPath);

      // import.meta.url, as Node's loader would compute it: the symlink's realpath.
      const importMetaUrl = pathToFileURL(realFile).href;
      // process.argv[1], as npm/npx would set it: the symlink path, unresolved.
      expect(isMainEntry(importMetaUrl, symlinkPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when argv[1] does not exist and does not match directly', () => {
    expect(isMainEntry(pathToFileURL('/opt/app/dist/cli.js').href, '/opt/does/not/exist.js')).toBe(
      false,
    );
  });
});
