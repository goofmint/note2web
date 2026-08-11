import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isMainEntry, runCli } from '../src/cli.js';
import { PARTIAL_FAILURE, PRECONDITION_FAILURE, SUCCESS } from '../src/exit-codes.js';

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

  it('exits 2 for sync when --config points to a schema-valid file (no Publisher implementation yet, T-16+)', async () => {
    // T-14 は sync フロー自体(src/sync.ts)を実装するが、実サービスの Publisher は
    // T-16 以降まで存在しない(src/publishers/factory.ts)。そのため、設定検証を通過した
    // 有効な設定であっても、ロック取得・エクスポート等を試みる前に exit 2 で打ち切られる。
    for (const name of VALID_CONFIG_ENV_VARS) {
      process.env[name] = 'dummy-value';
    }

    const result = await runCli(['sync', '--config', VALID_CONFIG_PATH]);

    expect(result.exitCode).toBe(PRECONDITION_FAILURE);
    expect(result.stdout).toHaveLength(0);
    expect(result.stderr.join('\n')).toMatch(/no Publisher implementation is registered yet/);
  });

  it('exits 2 for doctor when --config points to a schema-valid file but dependencies are missing on this host (T-15)', async () => {
    // このテスト環境には apple_cloud_notes_parser 等が実在しないため、実 commandExistsFn /
    // fileExistsFn を使う `runCli` 経由の doctor は必ず不足を報告する。「何も配信せず
    // exit 2」に加え、doctor 固有のプレフィックス("note2web: doctor: ")が付くことを検証する
    // (T-15 実装後は「未実装」ではなく、実チェック結果として exit 2 になる)。
    for (const name of VALID_CONFIG_ENV_VARS) {
      process.env[name] = 'dummy-value';
    }

    const result = await runCli(['doctor', '--config', VALID_CONFIG_PATH]);

    expect(result.exitCode).toBe(PRECONDITION_FAILURE);
    expect(result.stdout).toHaveLength(0);
    // git モード(zenn)なのに、この実行環境には apple_cloud_notes_parser も `gh` も
    // `GH_TOKEN` も無いため、複数件の不足が同時に報告される(1件で打ち切らない)。
    expect(result.stderr.length).toBeGreaterThanOrEqual(2);
    for (const line of result.stderr) {
      expect(line).toMatch(/^note2web: doctor: /);
    }
  });

  it('exits 0 for doctor when every dependency is actually satisfiable on this host (T-15, no injection)', async () => {
    // `devto` は API 直接配信のため git/gh 系の追加チェックが一切走らない(§6 依存表)。
    // ここでは実 commandExistsFn/fileExistsFn を経由させたまま(モックなし)、
    // `ruby` は実行環境に実在する前提で、`exporter.parser_path` だけこのテスト用の
    // 一時ディレクトリへ差し替えて「本当に全部揃っている」状態を作る。
    const parserPath = join(dir, 'parser');
    mkdirSync(parserPath, { recursive: true });
    writeFileSync(join(parserPath, 'notes_cloud_ripper.rb'), '# fixture stub\n');

    const devtoConfigPath = join(dir, 'devto-doctor-ok.yaml');
    writeFileSync(
      devtoConfigPath,
      [
        'service: devto',
        'source:',
        '  folders: [tech]',
        'exporter:',
        `  parser_path: ${parserPath}`,
        'assets:',
        '  provider: s3',
        '  bucket: blog-assets-devto',
        '  public_base_url: https://assets.example.com/notes/',
        '  access_key_id_env: DEVTO_DOCTOR_S3_ACCESS_KEY_ID',
        '  secret_access_key_env: DEVTO_DOCTOR_S3_SECRET_ACCESS_KEY',
        'devto:',
        '  api_key_env: DEVTO_DOCTOR_API_KEY',
        '',
      ].join('\n'),
    );

    process.env.DEVTO_DOCTOR_S3_ACCESS_KEY_ID = 'dummy-value';
    process.env.DEVTO_DOCTOR_S3_SECRET_ACCESS_KEY = 'dummy-value';
    process.env.DEVTO_DOCTOR_API_KEY = 'dummy-value';
    try {
      const result = await runCli(['doctor', '--config', devtoConfigPath]);

      expect(result.exitCode).toBe(SUCCESS);
      expect(result.stderr).toHaveLength(0);
      expect(result.stdout.join('\n')).toMatch(/all checks passed for service "devto"/);
    } finally {
      delete process.env.DEVTO_DOCTOR_S3_ACCESS_KEY_ID;
      delete process.env.DEVTO_DOCTOR_S3_SECRET_ACCESS_KEY;
      delete process.env.DEVTO_DOCTOR_API_KEY;
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
