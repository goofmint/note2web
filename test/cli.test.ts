import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

/**
 * T-21(issue #26)時点でも Publisher 未実装のサービス(devto。`src/publishers/factory.ts`
 * 参照)向けの schema 検証済み fixture。「Publisher 未登録」を決定的に検証するテスト
 * (`createPublisher` が `runSync` より前に呼ばれ、host 環境の ruby/gh 有無に左右されない)は
 * これを使う——zenn は T-16 で `GitRepoPublisher` が、qiita は T-21 で `createQiitaPublisher`
 * が配線されたため、もはやこのエラーにはならない(T-16・T-21 対応で変更)。
 */
const UNIMPLEMENTED_SERVICE_CONFIG_PATH = fileURLToPath(
  new URL('./fixtures/configs/devto.yaml', import.meta.url),
);
const UNIMPLEMENTED_SERVICE_CONFIG_ENV_VARS = [
  'DEVTO_S3_ACCESS_KEY_ID',
  'DEVTO_S3_SECRET_ACCESS_KEY',
  'DEVTO_API_KEY',
];

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

    for (const name of [...VALID_CONFIG_ENV_VARS, ...UNIMPLEMENTED_SERVICE_CONFIG_ENV_VARS]) {
      originalEnv[name] = process.env[name];
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const name of [...VALID_CONFIG_ENV_VARS, ...UNIMPLEMENTED_SERVICE_CONFIG_ENV_VARS]) {
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

  it('exits 2 for sync when --config points to a schema-valid file for a still-unimplemented service (devto, T-22+)', async () => {
    // T-16 で zenn/hugo/jekyll(Git モード)の Publisher(GitRepoPublisher)が、T-21 で
    // qiita の Publisher(`createQiitaPublisher`)が実装された(`src/publishers/factory.ts`)。
    // devto/note/hatena は T-22 以降まで存在しないため、設定検証を通過した有効な設定であっても、
    // ロック取得・エクスポート等を試みる前に exit 2 で打ち切られる。
    for (const name of UNIMPLEMENTED_SERVICE_CONFIG_ENV_VARS) {
      process.env[name] = 'dummy-value';
    }

    const result = await runCli(['sync', '--config', UNIMPLEMENTED_SERVICE_CONFIG_PATH]);

    expect(result.exitCode).toBe(PRECONDITION_FAILURE);
    expect(result.stdout).toHaveLength(0);
    expect(result.stderr.join('\n')).toMatch(/no Publisher implementation is registered yet/);
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
});
