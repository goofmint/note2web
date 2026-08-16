import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnvFile, parseEnvFile } from './env-file.js';

describe('parseEnvFile', () => {
  it('parses simple NAME=value lines', () => {
    expect(parseEnvFile('R2_ACCESS_KEY_ID=abc123\nR2_SECRET_ACCESS_KEY=def456\n')).toEqual({
      R2_ACCESS_KEY_ID: 'abc123',
      R2_SECRET_ACCESS_KEY: 'def456',
    });
  });

  it('ignores blank lines and comment lines (# at line start, possibly indented)', () => {
    const content = [
      '# top-level comment',
      '',
      '  # indented comment',
      'FOO=bar',
      '   ',
      'BAZ=qux',
    ].join('\n');
    expect(parseEnvFile(content)).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('tolerates leading whitespace before the variable name', () => {
    expect(parseEnvFile('   FOO=bar\n')).toEqual({ FOO: 'bar' });
  });

  it('tolerates an optional "export " prefix', () => {
    expect(parseEnvFile('export FOO=bar\n  export BAZ=qux\n')).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('trims whitespace around the value', () => {
    expect(parseEnvFile('FOO=   bar   \n')).toEqual({ FOO: 'bar' });
  });

  it('strips one pair of surrounding double quotes', () => {
    expect(parseEnvFile('FOO="bar baz"\n')).toEqual({ FOO: 'bar baz' });
  });

  it('strips one pair of surrounding single quotes', () => {
    expect(parseEnvFile("FOO='bar baz'\n")).toEqual({ FOO: 'bar baz' });
  });

  it('does not interpret escape sequences inside quotes (simple quoting only)', () => {
    // バックスラッシュはリテラルのまま残る(シェルのエスケープ処理は行わない)。
    expect(parseEnvFile('FOO="line1\\nline2"\n')).toEqual({ FOO: 'line1\\nline2' });
  });

  it('keeps literal $ and backtick characters as-is (no shell expansion)', () => {
    expect(parseEnvFile('FOO=$HOME/bin\nBAR=`whoami`\n')).toEqual({
      FOO: '$HOME/bin',
      BAR: '`whoami`',
    });
  });

  it('keeps an unmatched quote character literally (not a matching pair)', () => {
    expect(parseEnvFile('FOO="unterminated\n')).toEqual({ FOO: '"unterminated' });
  });

  it('ignores lines without an "=" (unparsable lines are skipped, not an error)', () => {
    expect(parseEnvFile('not a valid line\nFOO=bar\n')).toEqual({ FOO: 'bar' });
  });

  it('ignores lines whose name does not match the allowed identifier pattern', () => {
    expect(parseEnvFile('1FOO=bar\nFOO-BAR=baz\nOK=yes\n')).toEqual({ OK: 'yes' });
  });

  it('returns the last value when the same name appears more than once (later wins)', () => {
    expect(parseEnvFile('FOO=first\nFOO=second\n')).toEqual({ FOO: 'second' });
  });

  it('allows an empty value', () => {
    expect(parseEnvFile('FOO=\n')).toEqual({ FOO: '' });
  });

  it('returns an empty object for empty content', () => {
    expect(parseEnvFile('')).toEqual({});
  });

  it('handles CRLF line endings', () => {
    expect(parseEnvFile('FOO=bar\r\nBAZ=qux\r\n')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });
});

describe('loadEnvFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'note2web-env-file-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads and parses an existing file', async () => {
    const path = join(dir, 'env');
    writeFileSync(path, 'FOO=bar\nBAZ=qux\n');

    await expect(loadEnvFile(path)).resolves.toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('returns an empty object (not an error) when the file does not exist', async () => {
    const path = join(dir, 'does-not-exist');

    await expect(loadEnvFile(path)).resolves.toEqual({});
  });

  it('propagates non-ENOENT read errors instead of silently returning empty', async () => {
    const path = join(dir, 'env');
    const readFileFn = (): Promise<string> => {
      const error = new Error('permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      return Promise.reject(error);
    };

    await expect(loadEnvFile(path, { readFileFn })).rejects.toThrow('permission denied');
  });

  it('uses the injected readFileFn instead of touching the real filesystem', async () => {
    const readFileFn = (path: string): Promise<string> => {
      expect(path).toBe('/virtual/env');
      return Promise.resolve('FOO=bar\n');
    };

    await expect(loadEnvFile('/virtual/env', { readFileFn })).resolves.toEqual({ FOO: 'bar' });
  });
});
