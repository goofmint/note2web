import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { PRECONDITION_FAILURE, SUCCESS } from '../src/exit-codes.js';

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
    expect(result.stdout.join('\n')).toMatch(/not implemented yet/);
    expect(result.stderr).toHaveLength(0);
  });

  it('exits 0 for doctor when --config points to an existing file', async () => {
    const result = await runCli(['doctor', '--config', configPath]);

    expect(result.exitCode).toBe(SUCCESS);
    expect(result.stdout.join('\n')).toMatch(/not implemented yet/);
    expect(result.stderr).toHaveLength(0);
  });
});
