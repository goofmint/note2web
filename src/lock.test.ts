import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireLock,
  lockPathFor,
  LockError,
  releaseLock,
  type AcquireLockOptions,
  type ProcessAliveStatus,
} from './lock.js';

describe('lockPathFor', () => {
  it('appends .lock to the state file path', () => {
    expect(lockPathFor('/path/to/zenn.state.json')).toBe('/path/to/zenn.state.json.lock');
  });
});

describe('acquireLock / releaseLock', () => {
  const LOCK_BASENAME = 'state.json.lock';
  const OWN_START_TIME = 'Tue Aug 11 09:00:00 2026';
  // 既存ロックの判定に使う、自プロセスとは別の PID(テスト上どんな値でもよい)。
  const RECORDED_PID = 424242;

  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'note2web-lock-test-'));
    lockPath = join(dir, LOCK_BASENAME);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * PID → 生存確認結果 / 開始時刻 のフェイク注入関数を組み立てる。
   * 実プロセス・実 `ps` に一切依存せず、各シナリオを決定的に再現するための注入点
   * (`AcquireLockOptions.checkAlive` / `getStartTime`)を埋める。
   */
  function inspectorsFor(
    aliveByPid: Record<number, ProcessAliveStatus>,
    startTimeByPid: Record<number, string>,
  ): AcquireLockOptions {
    return {
      checkAlive: (pid) => aliveByPid[pid] ?? 'dead',
      getStartTime: (pid) => startTimeByPid[pid] ?? 'unknown',
    };
  }

  it('a. fresh acquire succeeds and writes own pid + startTime as JSON', () => {
    const options = inspectorsFor({}, { [process.pid]: OWN_START_TIME });

    const handle = acquireLock(lockPath, options);

    expect(handle.path).toBe(lockPath);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual({
      pid: process.pid,
      startTime: OWN_START_TIME,
    });
    expect(readdirSync(dir)).toEqual([LOCK_BASENAME]);
  });

  it('b. 生存プロセス: alive pid with matching startTime throws LockError(2) and leaves the lock file untouched', () => {
    const original = { pid: RECORDED_PID, startTime: 'Tue Aug 11 08:00:00 2026' };
    writeFileSync(lockPath, JSON.stringify(original));
    const options = inspectorsFor(
      { [RECORDED_PID]: 'alive' },
      { [RECORDED_PID]: original.startTime, [process.pid]: OWN_START_TIME },
    );

    let thrown: unknown;
    try {
      acquireLock(lockPath, options);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LockError);
    expect((thrown as LockError).exitCode).toBe(2);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(original);
  });

  it('c. 死亡プロセス: dead recorded pid triggers stale reclamation and reacquires with own pid', () => {
    const original = { pid: RECORDED_PID, startTime: 'Tue Aug 11 08:00:00 2026' };
    writeFileSync(lockPath, JSON.stringify(original));
    const options = inspectorsFor({ [RECORDED_PID]: 'dead' }, { [process.pid]: OWN_START_TIME });

    const handle = acquireLock(lockPath, options);

    expect(handle.path).toBe(lockPath);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual({
      pid: process.pid,
      startTime: OWN_START_TIME,
    });
    // 隔離用の一時ファイルが残っていない(=正しく削除された)ことも確認する。
    expect(readdirSync(dir)).toEqual([LOCK_BASENAME]);
  });

  it('d. PID 再利用: alive recorded pid with a different startTime triggers stale reclamation', () => {
    const original = { pid: RECORDED_PID, startTime: 'Tue Aug 11 08:00:00 2026' };
    writeFileSync(lockPath, JSON.stringify(original));
    const options = inspectorsFor(
      { [RECORDED_PID]: 'alive' },
      {
        // 同じ PID だが開始時刻が記録と異なる = 別プロセスによる PID 再利用。
        [RECORDED_PID]: 'Tue Aug 11 09:45:00 2026',
        [process.pid]: OWN_START_TIME,
      },
    );

    const handle = acquireLock(lockPath, options);

    expect(handle.path).toBe(lockPath);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual({
      pid: process.pid,
      startTime: OWN_START_TIME,
    });
    expect(readdirSync(dir)).toEqual([LOCK_BASENAME]);
  });

  it('e. 隔離中の競合: content changed between judgment and quarantine undoes the quarantine and throws', () => {
    const original = { pid: RECORDED_PID, startTime: 'Tue Aug 11 08:00:00 2026' };
    writeFileSync(lockPath, JSON.stringify(original));
    // 判定(既存ロック内容の読み取り)は `dead` で stale と判断させ、隔離(rename)の
    // 直前というタイミングで別プロセスが新しいロックを書き込んだ状況を、
    // テスト専用フック(`__testOnlyBeforeQuarantine`)で決定的に再現する。
    const raceWinner = { pid: RECORDED_PID + 1, startTime: 'Tue Aug 11 09:50:00 2026' };
    const options: AcquireLockOptions = {
      ...inspectorsFor({ [RECORDED_PID]: 'dead' }, { [process.pid]: OWN_START_TIME }),
      __testOnlyBeforeQuarantine: () => {
        writeFileSync(lockPath, JSON.stringify(raceWinner));
      },
    };

    let thrown: unknown;
    try {
      acquireLock(lockPath, options);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LockError);
    expect((thrown as LockError).exitCode).toBe(2);
    // 隔離は取り消され、競合相手(race winner)が書いた内容がそのまま残っている。
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(raceWinner);
    // 隔離用の一時ファイルは残らない。
    expect(readdirSync(dir)).toEqual([LOCK_BASENAME]);
  });

  describe('確認不能 (unverifiable): throws LockError without deleting the existing lock', () => {
    it('f1. unparseable lock content', () => {
      writeFileSync(lockPath, 'not json');
      const options = inspectorsFor({}, { [process.pid]: OWN_START_TIME });

      let thrown: unknown;
      try {
        acquireLock(lockPath, options);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(LockError);
      expect((thrown as LockError).exitCode).toBe(2);
      expect(readFileSync(lockPath, 'utf8')).toBe('not json');
    });

    it('f2. alive-status of the recorded pid cannot be determined', () => {
      const original = { pid: RECORDED_PID, startTime: 'Tue Aug 11 08:00:00 2026' };
      writeFileSync(lockPath, JSON.stringify(original));
      const options = inspectorsFor(
        { [RECORDED_PID]: 'unknown' },
        { [process.pid]: OWN_START_TIME },
      );

      expect(() => acquireLock(lockPath, options)).toThrow(LockError);
      expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(original);
    });

    it('f3. start time of an alive recorded pid cannot be determined', () => {
      const original = { pid: RECORDED_PID, startTime: 'Tue Aug 11 08:00:00 2026' };
      writeFileSync(lockPath, JSON.stringify(original));
      // RECORDED_PID の開始時刻を意図的にマップから外し、'unknown' を返させる。
      const options = inspectorsFor({ [RECORDED_PID]: 'alive' }, { [process.pid]: OWN_START_TIME });

      expect(() => acquireLock(lockPath, options)).toThrow(LockError);
      expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(original);
    });

    it('f4. own start time cannot be determined: never creates a lock file', () => {
      const options = inspectorsFor({}, {}); // process.pid も 'unknown' になる

      expect(() => acquireLock(lockPath, options)).toThrow(LockError);
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  describe('releaseLock', () => {
    it('removes the acquired lock file', () => {
      const options = inspectorsFor({}, { [process.pid]: OWN_START_TIME });
      const handle = acquireLock(lockPath, options);
      expect(existsSync(lockPath)).toBe(true);

      releaseLock(handle);

      expect(existsSync(lockPath)).toBe(false);
    });

    it('is idempotent: does not throw when the file is already gone', () => {
      expect(existsSync(lockPath)).toBe(false);

      expect(() => releaseLock({ path: lockPath })).not.toThrow();
      expect(() => releaseLock({ path: lockPath })).not.toThrow();
    });
  });
});
