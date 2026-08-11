import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isMainEntry, runCli } from '../src/cli.js';
import { PARTIAL_FAILURE, PRECONDITION_FAILURE, SUCCESS } from '../src/exit-codes.js';

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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'note2web-cli-test-'));
    configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, 'placeholder: true\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
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

  it('exits 0 for sync when --config points to an existing file', async () => {
    const result = await runCli(['sync', '--config', configPath]);

    expect(result.exitCode).toBe(SUCCESS);
    expect(result.stdout).toEqual(['note2web sync: not implemented yet']);
    expect(result.stderr).toHaveLength(0);
  });

  it('exits 0 for doctor when --config points to an existing file', async () => {
    const result = await runCli(['doctor', '--config', configPath]);

    expect(result.exitCode).toBe(SUCCESS);
    expect(result.stdout).toEqual(['note2web doctor: not implemented yet']);
    expect(result.stderr).toHaveLength(0);
  });

  it('exits 2 with an error when --config points to a directory', async () => {
    const dirPath = join(dir, 'config-dir');
    mkdirSync(dirPath);

    const result = await runCli(['sync', '--config', dirPath]);

    expect(result.exitCode).toBe(PRECONDITION_FAILURE);
    expect(result.stderr.join('\n')).toContain(dirPath);
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
