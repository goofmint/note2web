import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandExists, DEFAULT_TIMEOUTS, runSubprocess } from '../src/subprocess.js';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/subprocess/', import.meta.url));
const fixture = (name: string): string => join(FIXTURES_DIR, name);

/** `pid` が現に生存しているか(`process.kill(pid, 0)` を投げずに判定する)。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** `pid` が `timeoutMs` 以内に消えることを、短い間隔でポーリングして待つ。 */
async function waitUntilDead(pid: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (isAlive(pid)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`pid ${pid} is still alive after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('DEFAULT_TIMEOUTS', () => {
  it('matches design.md §6 (parser: 15min, default: 5min)', () => {
    expect(DEFAULT_TIMEOUTS.parser).toBe(900_000);
    expect(DEFAULT_TIMEOUTS.default).toBe(300_000);
  });
});

describe('runSubprocess', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'note2web-subprocess-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('captures stdout and stderr separately on success', async () => {
    const result = await runSubprocess({
      command: process.execPath,
      args: [fixture('echo-stdout-stderr.js')],
      timeoutMs: 2000,
    });

    expect(result.status).toBe('success');
    expect(result.classification).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain('hello from stdout');
    expect(result.stderr).toContain('hello from stderr');
    expect(result.stdout).not.toContain('hello from stderr');
    expect(result.stderr).not.toContain('hello from stdout');
  });

  it('classifies a non-zero exit as exit_code', async () => {
    const result = await runSubprocess({
      command: process.execPath,
      args: [fixture('exit-code.js'), '7'],
      timeoutMs: 2000,
    });

    expect(result.status).toBe('failure');
    expect(result.classification).toBe('exit_code');
    expect(result.exitCode).toBe(7);
    expect(result.signal).toBeNull();
  });

  it('classifies a signal termination unrelated to the timeout as signal', async () => {
    const result = await runSubprocess({
      command: process.execPath,
      args: [fixture('self-signal.js')],
      // 十分大きく取り、タイムアウト起因の kill と混同しないようにする。
      timeoutMs: 2000,
    });

    expect(result.status).toBe('failure');
    expect(result.classification).toBe('signal');
    expect(result.signal).toBe('SIGINT');
    expect(result.exitCode).toBeNull();
  });

  it('kills the whole process group on timeout, leaving no orphaned grandchild', async () => {
    const pidFile = join(dir, 'pids.txt');

    const result = await runSubprocess({
      command: process.execPath,
      args: [fixture('hang-with-child.js'), pidFile],
      timeoutMs: 300,
      termGraceMs: 300,
    });

    expect(result.status).toBe('failure');
    expect(result.classification).toBe('timeout');

    const [selfPidRaw, childPidRaw] = readFileSync(pidFile, 'utf8').trim().split('\n');
    const selfPid = Number(selfPidRaw);
    const childPid = Number(childPidRaw);
    expect(Number.isInteger(selfPid)).toBe(true);
    expect(Number.isInteger(childPid)).toBe(true);

    await waitUntilDead(selfPid);
    await waitUntilDead(childPid);
  });

  it('escalates to SIGKILL after termGraceMs when the child ignores SIGTERM', async () => {
    const result = await runSubprocess({
      command: process.execPath,
      args: [fixture('ignore-term.js')],
      timeoutMs: 200,
      termGraceMs: 500,
    });

    expect(result.status).toBe('failure');
    expect(result.classification).toBe('timeout');
    expect(result.signal).toBe('SIGKILL');
  });

  it('keeps the grace timer armed to SIGKILL a grandchild after the direct child exits on SIGTERM', async () => {
    const pidFile = join(dir, 'pids.txt');

    const result = await runSubprocess({
      command: process.execPath,
      args: [fixture('term-exits-child-ignores-grandchild.js'), pidFile],
      timeoutMs: 300,
      termGraceMs: 300,
    });

    // 直接の子は SIGTERM を受けて素直に終了するので `close` は timeout 経由で
    // すぐ発火する。ここで runSubprocess が既に解決していることが、この経路の
    // バグ(graceTimer が close で取り消されてしまう)を再現する前提になる。
    expect(result.status).toBe('failure');
    expect(result.classification).toBe('timeout');

    const [, grandchildPidRaw] = readFileSync(pidFile, 'utf8').trim().split('\n');
    const grandchildPid = Number(grandchildPidRaw);
    expect(Number.isInteger(grandchildPid)).toBe(true);

    // runSubprocess は既に resolve 済みだが、termGraceMs 分の猶予が経過するまでは
    // 孫プロセスがまだ生きていてよい。猶予経過後に確実に死んでいることを確認する。
    await waitUntilDead(grandchildPid, 2000);
  });

  it('reports the failure classification to an injected logger', async () => {
    const warn = vi.fn();

    const result = await runSubprocess({
      command: process.execPath,
      args: [fixture('exit-code.js'), '3'],
      timeoutMs: 2000,
      logger: { warn },
    });

    expect(result.classification).toBe('exit_code');
    expect(warn).toHaveBeenCalledTimes(1);
    const [payload] = warn.mock.calls[0] as [{ message: string }];
    expect(payload.message).toContain('exit_code');
  });

  it('includes a one-line stderr/stdout output summary in the failure warn log (issue #67)', async () => {
    const warn = vi.fn();

    const result = await runSubprocess({
      command: process.execPath,
      args: [fixture('fail-with-output.js')],
      timeoutMs: 2000,
      logger: { warn },
    });

    expect(result.status).toBe('failure');
    expect(warn).toHaveBeenCalledTimes(1);
    const [payload] = warn.mock.calls[0] as [{ message: string }];
    // 出力の先頭意味のある1行(ここでは stderr の "hello from stderr")が含まれる。
    // コマンドライン(command/args)自体は含めない(FR-30)。
    expect(payload.message).toContain('output: hello from stderr');
    expect(payload.message).not.toContain(fixture('fail-with-output.js'));
  });

  it('does not call the logger on success', async () => {
    const warn = vi.fn();

    await runSubprocess({
      command: process.execPath,
      args: [fixture('echo-stdout-stderr.js')],
      timeoutMs: 2000,
      logger: { warn },
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it('runs with stdin ignored (no interactive prompt can block it)', async () => {
    // stdin が 'ignore' でなければ、標準入力を読もうとするスクリプトはハングしうる。
    // ここでは代わりに、'ignore' であること自体を child_process 経由で間接的に検証する:
    // タイムアウトを十分長く取った通常終了スクリプトが即座に完了することを確認する。
    const result = await runSubprocess({
      command: process.execPath,
      args: [fixture('echo-stdout-stderr.js')],
      timeoutMs: DEFAULT_TIMEOUTS.default,
    });
    expect(result.status).toBe('success');
  });

  it('gives the child stdin an immediate EOF instead of hanging (stdio[0] = ignore)', async () => {
    // stdin を実際に EOF まで読み切るスクリプトを短いタイムアウトで実行し、
    // ハングせず len=0 で終わることを直接検証する。
    const result = await runSubprocess({
      command: process.execPath,
      args: [fixture('read-stdin.js')],
      timeoutMs: 2000,
    });

    expect(result.status).toBe('success');
    expect(result.stdout).toContain('stdin-eof:0');
  });

  it('merges options.env over process.env, with the passed values winning', async () => {
    const expectedPathPresent = (process.env.PATH ?? '').length > 0 ? '1' : '0';
    const result = await runSubprocess({
      command: process.execPath,
      args: [fixture('print-env.js')],
      timeoutMs: 2000,
      env: { X: '1' },
    });

    expect(result.status).toBe('success');
    expect(result.stdout).toContain('X=1');
    // process.env(PATH を含む)がベースとして保持され続けていることを確認する。
    // 親プロセス自体に PATH がない環境でも成立するよう、期待値は親の状態から導出する。
    expect(result.stdout).toContain(`PATH_PRESENT=${expectedPathPresent}`);
  });
});

describe('commandExists', () => {
  it('resolves true for an absolute path to an existing executable', async () => {
    await expect(commandExists(process.execPath)).resolves.toBe(true);
  });

  it('resolves false for an absolute path that does not exist', async () => {
    await expect(commandExists('/no/such/path/does-not-exist-xyz')).resolves.toBe(false);
  });

  it('resolves true for a command name found via PATH', async () => {
    const nodeDir = dirname(process.execPath);
    vi.stubEnv('PATH', `${nodeDir}${delimiter}${process.env.PATH ?? ''}`);
    try {
      await expect(commandExists(basename(process.execPath))).resolves.toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('resolves false for a command name not found on PATH', async () => {
    await expect(commandExists('note2web-definitely-does-not-exist-xyz')).resolves.toBe(false);
  });
});
