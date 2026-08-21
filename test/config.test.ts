import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigValidationError, loadConfig } from '../src/config.js';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/configs/', import.meta.url));

/** サービスごとの fixture が要求する `*_env` 環境変数名。 */
const FIXTURE_ENV_VARS: Record<string, string[]> = {
  zenn: ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'],
  hugo: ['HUGO_S3_ACCESS_KEY_ID', 'HUGO_S3_SECRET_ACCESS_KEY'],
  jekyll: ['JEKYLL_R2_ACCESS_KEY_ID', 'JEKYLL_R2_SECRET_ACCESS_KEY'],
  qiita: ['QIITA_S3_ACCESS_KEY_ID', 'QIITA_S3_SECRET_ACCESS_KEY', 'QIITA_TOKEN'],
  devto: ['DEVTO_S3_ACCESS_KEY_ID', 'DEVTO_S3_SECRET_ACCESS_KEY', 'DEVTO_API_KEY'],
  note: ['NOTE_S3_ACCESS_KEY_ID', 'NOTE_S3_SECRET_ACCESS_KEY', 'NOTE_SESSION_COOKIE'],
  hatena: ['HATENA_S3_ACCESS_KEY_ID', 'HATENA_S3_SECRET_ACCESS_KEY', 'HATENA_API_KEY'],
};

const ALL_FIXTURE_ENV_VARS = Object.values(FIXTURE_ENV_VARS).flat();

describe('loadConfig', () => {
  let dir: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'note2web-config-test-'));
    for (const name of ALL_FIXTURE_ENV_VARS) {
      originalEnv[name] = process.env[name];
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const name of ALL_FIXTURE_ENV_VARS) {
      if (originalEnv[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = originalEnv[name];
      }
    }
  });

  describe.each(Object.keys(FIXTURE_ENV_VARS))('%s fixture', (service) => {
    it('parses successfully once the referenced env vars are set', () => {
      for (const name of FIXTURE_ENV_VARS[service]) {
        process.env[name] = 'dummy-value';
      }

      const config = loadConfig(join(FIXTURES_DIR, `${service}.yaml`));

      expect(config.service).toBe(service);
    });

    it('fails with ConfigValidationError naming the unset env var when a referenced env var is missing', () => {
      const [firstEnvVar, ...rest] = FIXTURE_ENV_VARS[service];
      for (const name of rest) {
        process.env[name] = 'dummy-value';
      }
      delete process.env[firstEnvVar];

      expect(() => loadConfig(join(FIXTURES_DIR, `${service}.yaml`))).toThrow(
        ConfigValidationError,
      );

      try {
        loadConfig(join(FIXTURES_DIR, `${service}.yaml`));
        expect.unreachable('loadConfig should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError);
        const validationError = error as ConfigValidationError;
        expect(
          validationError.problems.some((problem) => problem.message.includes(firstEnvVar)),
        ).toBe(true);
      }
    });
  });

  it('applies the Asia/Tokyo default when timezone is omitted', () => {
    for (const name of FIXTURE_ENV_VARS.zenn) {
      process.env[name] = 'dummy-value';
    }

    const config = loadConfig(join(FIXTURES_DIR, 'zenn.yaml'));

    expect(config.timezone).toBe('Asia/Tokyo');
  });

  it('honors an explicit timezone override', () => {
    for (const name of FIXTURE_ENV_VARS.zenn) {
      process.env[name] = 'dummy-value';
    }
    const configPath = join(dir, 'config.yaml');
    writeFileSync(
      configPath,
      [
        'service: zenn',
        'timezone: America/New_York',
        'source:',
        '  folders: [tech]',
        'assets:',
        '  provider: r2',
        '  bucket: blog-assets',
        '  endpoint: https://example.r2.cloudflarestorage.com',
        '  public_base_url: https://assets.example.com/notes/',
        '  access_key_id_env: R2_ACCESS_KEY_ID',
        '  secret_access_key_env: R2_SECRET_ACCESS_KEY',
        'git:',
        '  repo_path: ~/src/zenn-content',
        '  base_branch: main',
        '  output_dir: articles',
        '',
      ].join('\n'),
    );

    const config = loadConfig(configPath);

    expect(config.timezone).toBe('America/New_York');
  });

  it('rejects a config missing the service-specific required block (qiita.token_env)', () => {
    const configPath = join(dir, 'config.yaml');
    writeFileSync(
      configPath,
      [
        'service: qiita',
        'source:',
        '  folders: [tech]',
        'assets:',
        '  provider: s3',
        '  bucket: blog-assets',
        '  public_base_url: https://assets.example.com/notes/',
        '  access_key_id_env: QIITA_S3_ACCESS_KEY_ID',
        '  secret_access_key_env: QIITA_S3_SECRET_ACCESS_KEY',
        'qiita: {}',
        '',
      ].join('\n'),
    );

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
    try {
      loadConfig(configPath);
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      const validationError = error as ConfigValidationError;
      expect(validationError.problems.some((problem) => problem.path === 'qiita.token_env')).toBe(
        true,
      );
    }
  });

  it('rejects a config missing the service-specific required block (hatena.blog_id)', () => {
    const configPath = join(dir, 'config.yaml');
    writeFileSync(
      configPath,
      [
        'service: hatena',
        'source:',
        '  folders: [tech]',
        'assets:',
        '  provider: s3',
        '  bucket: blog-assets',
        '  public_base_url: https://assets.example.com/notes/',
        '  access_key_id_env: HATENA_S3_ACCESS_KEY_ID',
        '  secret_access_key_env: HATENA_S3_SECRET_ACCESS_KEY',
        'hatena:',
        '  hatena_id: example',
        '  api_key_env: HATENA_API_KEY',
        '',
      ].join('\n'),
    );

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
    try {
      loadConfig(configPath);
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      const validationError = error as ConfigValidationError;
      expect(validationError.problems.some((problem) => problem.path === 'hatena.blog_id')).toBe(
        true,
      );
    }
  });

  it('rejects a config that is missing the whole service block for the declared service', () => {
    const configPath = join(dir, 'config.yaml');
    writeFileSync(
      configPath,
      [
        'service: devto',
        'source:',
        '  folders: [tech]',
        'assets:',
        '  provider: s3',
        '  bucket: blog-assets',
        '  public_base_url: https://assets.example.com/notes/',
        '  access_key_id_env: DEVTO_S3_ACCESS_KEY_ID',
        '  secret_access_key_env: DEVTO_S3_SECRET_ACCESS_KEY',
        '',
      ].join('\n'),
    );

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
    try {
      loadConfig(configPath);
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      const validationError = error as ConfigValidationError;
      expect(validationError.problems.some((problem) => problem.path === 'devto')).toBe(true);
    }
  });

  it('rejects a config missing the git block for a git-based service (hugo)', () => {
    const configPath = join(dir, 'config.yaml');
    writeFileSync(
      configPath,
      [
        'service: hugo',
        'source:',
        '  folders: [tech]',
        'assets:',
        '  provider: s3',
        '  bucket: blog-assets',
        '  public_base_url: https://assets.example.com/notes/',
        '  access_key_id_env: HUGO_S3_ACCESS_KEY_ID',
        '  secret_access_key_env: HUGO_S3_SECRET_ACCESS_KEY',
        '',
      ].join('\n'),
    );

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
    try {
      loadConfig(configPath);
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      const validationError = error as ConfigValidationError;
      expect(validationError.problems.some((problem) => problem.path === 'git')).toBe(true);
    }
  });

  it('rejects r2 assets without an endpoint', () => {
    const configPath = join(dir, 'config.yaml');
    writeFileSync(
      configPath,
      [
        'service: zenn',
        'source:',
        '  folders: [tech]',
        'assets:',
        '  provider: r2',
        '  bucket: blog-assets',
        '  public_base_url: https://assets.example.com/notes/',
        '  access_key_id_env: R2_ACCESS_KEY_ID',
        '  secret_access_key_env: R2_SECRET_ACCESS_KEY',
        'git:',
        '  repo_path: ~/src/zenn-content',
        '  base_branch: main',
        '  output_dir: articles',
        '',
      ].join('\n'),
    );

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
    try {
      loadConfig(configPath);
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      const validationError = error as ConfigValidationError;
      expect(validationError.problems.some((problem) => problem.path === 'assets.endpoint')).toBe(
        true,
      );
    }
  });

  it('rejects an r2 endpoint that is not a valid URL', () => {
    const configPath = join(dir, 'config.yaml');
    writeFileSync(
      configPath,
      [
        'service: zenn',
        'source:',
        '  folders: [tech]',
        'assets:',
        '  provider: r2',
        '  bucket: blog-assets',
        '  endpoint: not-a-url',
        '  public_base_url: https://assets.example.com/notes/',
        '  access_key_id_env: R2_ACCESS_KEY_ID',
        '  secret_access_key_env: R2_SECRET_ACCESS_KEY',
        'git:',
        '  repo_path: ~/src/zenn-content',
        '  base_branch: main',
        '  output_dir: articles',
        '',
      ].join('\n'),
    );

    try {
      loadConfig(configPath);
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const validationError = error as ConfigValidationError;
      expect(validationError.problems.some((problem) => problem.path === 'assets.endpoint')).toBe(
        true,
      );
    }
  });

  it('rejects a directly-written secret value as an unknown key (FR-30)', () => {
    const configPath = join(dir, 'config.yaml');
    writeFileSync(
      configPath,
      [
        'service: qiita',
        'source:',
        '  folders: [tech]',
        'assets:',
        '  provider: s3',
        '  bucket: blog-assets',
        '  public_base_url: https://assets.example.com/notes/',
        '  access_key_id_env: QIITA_S3_ACCESS_KEY_ID',
        '  secret_access_key_env: QIITA_S3_SECRET_ACCESS_KEY',
        'qiita:',
        '  token_env: QIITA_TOKEN',
        '  token: xxxxxxxxxxxxxxxx',
        '',
      ].join('\n'),
    );

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
    try {
      loadConfig(configPath);
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      const validationError = error as ConfigValidationError;
      expect(
        validationError.problems.some(
          (problem) => problem.path === 'qiita.token' && /unknown key/i.test(problem.message),
        ),
      ).toBe(true);
    }
  });

  it('rejects a top-level secret literal (e.g. assets.secret_access_key) as an unknown key', () => {
    const configPath = join(dir, 'config.yaml');
    writeFileSync(
      configPath,
      [
        'service: zenn',
        'source:',
        '  folders: [tech]',
        'assets:',
        '  provider: r2',
        '  bucket: blog-assets',
        '  endpoint: https://example.r2.cloudflarestorage.com',
        '  public_base_url: https://assets.example.com/notes/',
        '  access_key_id_env: R2_ACCESS_KEY_ID',
        '  secret_access_key_env: R2_SECRET_ACCESS_KEY',
        '  secret_access_key: literally-a-secret',
        'git:',
        '  repo_path: ~/src/zenn-content',
        '  base_branch: main',
        '  output_dir: articles',
        '',
      ].join('\n'),
    );

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
    try {
      loadConfig(configPath);
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      const validationError = error as ConfigValidationError;
      expect(
        validationError.problems.some((problem) => problem.path === 'assets.secret_access_key'),
      ).toBe(true);
    }
  });

  it('fails with ConfigValidationError when the config file does not exist', () => {
    const missingPath = join(dir, 'does-not-exist.yaml');

    expect(() => loadConfig(missingPath)).toThrow(ConfigValidationError);
    try {
      loadConfig(missingPath);
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      const validationError = error as ConfigValidationError;
      expect(validationError.message).toContain(missingPath);
    }
  });

  it('fails with ConfigValidationError when the file is not valid YAML', () => {
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, 'service: [this is: not, valid\n');

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
  });
});
