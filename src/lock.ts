/**
 * 多重起動防止のロックファイル機構(design.md §6「多重起動防止」)。
 *
 * 状態 JSON と同じ場所に `<state file>.lock` を置き、`O_CREAT | O_EXCL`(`wx` フラグ)で
 * アトミックに作成する。ロック内容は自プロセスの PID と、OS から取得したそのプロセスの
 * 開始時刻(`ps -p <pid> -o lstart=`)の JSON。既存ロックに遭遇した場合は、記録された PID が
 * 生存しており、かつ現在のプロセス開始時刻が記録と一致する(同一プロセスと確認できる)場合
 * のみ「生存中」と判定して `LockError`(exit 2)を投げる。PID が既に存在しない、または
 * 開始時刻が不一致(PID 再利用)の場合は stale と判定し、以下の TOCTOU セーフな手順で
 * 自動回収してから新規取得する:
 *
 *   1. ロックファイルを一時名(`<lock>.stale-<own pid>`)へ rename して隔離する
 *   2. 隔離したファイルの内容が、判定時に読んだ内容と一致するか確認する
 *   3. 一致すれば隔離ファイルを削除し、`O_CREAT | O_EXCL` で新規に取得する
 *   4. 一致しなければ、判定と rename の間に別プロセスが新しいロックを作った(競合)と
 *      判断し、隔離を取り消して `LockError` を投げる
 *
 * 生存・開始時刻のどちらかが確認できない(確認不能)場合は、誤って生存中のロックを
 * 奪わないよう、削除せず `LockError` を投げる。
 *
 * プロセスの生存確認・開始時刻取得は、いずれも `AcquireLockOptions` 経由で差し替え可能
 * (テストで実プロセス・実 `ps` に依存しないため)。
 */

import { execFileSync } from 'node:child_process';
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { PRECONDITION_FAILURE } from './exit-codes.js';

/** ロックファイルの内容(JSON)。 */
export interface LockContent {
  pid: number;
  startTime: string;
}

/** `checkAlive` が返しうるプロセス生存確認の結果。 */
export type ProcessAliveStatus = 'alive' | 'dead' | 'unknown';

/**
 * ロック取得・判定の挙動を差し替えるためのオプション。
 * `checkAlive` / `getStartTime` はテストで実プロセス・実 `ps` に依存せず
 * 各シナリオ(生存・死亡・PID 再利用・確認不能)を再現するための注入点。
 */
export interface AcquireLockOptions {
  /** 指定 PID の生存確認。既定は `process.kill(pid, 0)` を用いる実装。 */
  checkAlive?: (pid: number) => ProcessAliveStatus;
  /** 指定 PID の OS 報告の開始時刻を取得する。取得できない場合は `'unknown'`。既定は `ps -p <pid> -o lstart=` を用いる実装。 */
  getStartTime?: (pid: number) => string;
  /**
   * テスト専用の注入点。stale ロックの判定(既存ロック内容の読み取り)が完了した後、
   * 隔離のための rename を実行する直前に同期的に呼ばれる。判定〜隔離の間に別プロセスが
   * ロック内容を書き換える TOCTOU 競合(§6 手順4)を決定的に再現するためのフックで、
   * 通常の呼び出し側は指定しない。
   */
  __testOnlyBeforeQuarantine?: () => void;
  /**
   * テスト専用の注入点。隔離のための rename が完了した直後に同期的に呼ばれる。
   * 隔離後に別プロセスが新しいロックを作成する競合(隔離取り消し時の EEXIST 分岐と、
   * 回収後の新規取得での競り負け)を決定的に再現するためのフックで、
   * 通常の呼び出し側は指定しない。
   */
  __testOnlyAfterQuarantine?: () => void;
}

/** `acquireLock` が返す、取得済みロックのハンドル。 */
export interface LockHandle {
  /** 取得したロックファイルの絶対/相対パス。 */
  readonly path: string;
}

/**
 * ロック取得の前提が成立しなかったことを表すエラー。design.md §10 の「多重起動」に
 * 該当し、`exitCode`(= `PRECONDITION_FAILURE` = 2)で終了することを呼び出し側(cli.ts)
 * に伝える。以下のいずれかで送出される:
 *   - 記録された PID が生存中と確認できたロック(多重起動そのもの)
 *   - 生存・開始時刻のどちらかが確認できない(確認不能)ロック
 *   - stale 回収中に検出した TOCTOU 競合(判定後に別プロセスが新しいロックを作成)
 */
export class LockError extends Error {
  readonly exitCode = PRECONDITION_FAILURE;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LockError';
  }
}

/**
 * 状態 JSON のパスからロックファイルのパスを導出する(design.md §6)。
 * 状態 JSON と同じ場所に `<state file>.lock` を置く。
 */
export function lockPathFor(stateFilePath: string): string {
  return `${stateFilePath}.lock`;
}

/** Node の `NodeJS.ErrnoException`(`code` を持つ)かどうかの型ガード。 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * `process.kill(pid, 0)` による既定の生存確認(design.md §6)。
 * `ESRCH`(該当 PID が存在しない)なら `'dead'`、`EPERM`(存在はするが権限がない、
 * 別ユーザーのプロセス等)なら `'alive'`、それ以外の例外は `'unknown'`。
 */
function defaultCheckAlive(pid: number): ProcessAliveStatus {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (isErrnoException(error)) {
      if (error.code === 'ESRCH') {
        return 'dead';
      }
      if (error.code === 'EPERM') {
        return 'alive';
      }
    }
    return 'unknown';
  }
}

/**
 * `ps -p <pid> -o lstart=` による既定の開始時刻取得(design.md §6)。
 * 出力の前後の空白・内部の連続空白を1個へ正規化する。`ps` の実行自体が失敗した場合や
 * 出力が空の場合は `'unknown'`(確認不能)を返す。
 *
 * `ps` は本ツールの必須ランタイム依存とする(macOS には常設、Linux では procps)。
 * `/proc` 等への fallback は意図的に行わない — 記録時と確認時で開始時刻の取得元が
 * 混在すると、生存中のプロセスのロックを「開始時刻不一致(PID 再利用)」と誤判定して
 * 奪ってしまう危険があるため、取得できない場合は確認不能として安全側に倒す。
 */
function defaultGetStartTime(pid: number): string {
  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
    });
    const normalized = output.trim().replace(/\s+/g, ' ');
    return normalized.length > 0 ? normalized : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** ロックファイルの内容として妥当な JSON かどうかを検証しつつパースする。不正なら `undefined`。 */
function parseLockContent(raw: string): LockContent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const { pid, startTime } = parsed as Record<string, unknown>;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  if (typeof startTime !== 'string' || startTime.length === 0) {
    return undefined;
  }
  return { pid, startTime };
}

/**
 * ロックファイルの新規作成を試みる。成功時 `true`、既に存在した場合(`EEXIST`)は
 * `false`。それ以外の例外はそのまま投げる。
 *
 * `openSync(lockPath, 'wx')` → `writeSync` の直接書き込みだと、open と write の間で
 * クラッシュした場合に空のロックファイルが残り、内容不正=確認不能として以後の実行が
 * 自動回収できなくなる。そのため、自 PID 入りの一時名へ内容を書き切って fsync した後、
 * `linkSync`(宛先が既存なら `EEXIST` で失敗する)でアトミックに公開する。
 * 他プロセスから `lockPath` に観測されるのは常に完全な内容のファイルのみとなる。
 */
function tryCreateLockFile(lockPath: string, content: LockContent): boolean {
  // 一時名は自 PID 入りなので他プロセスとは衝突しない。過去の自プロセス異常終了の
  // 残骸があっても上書きしてよいため 'w' で開く。
  const tempPath = `${lockPath}.tmp-${process.pid}`;
  const fd = openSync(tempPath, 'w');
  try {
    writeSync(fd, JSON.stringify(content));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tempPath, lockPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'EEXIST') {
      return false;
    }
    throw error;
  } finally {
    rmSync(tempPath, { force: true });
  }
  return true;
}

/**
 * 隔離(rename)を取り消す。`linkSync`(ハードリンク作成)はリンク先が既に存在すると
 * `EEXIST` で失敗するため、`renameSync` と違い「宛先が空いている場合のみ」戻すことを
 * アトミックに保証できる(`rename(2)` は宛先が既存でも黙って上書きしてしまうため使えない)。
 * 宛先に新しいロックが既にできていた場合(`EEXIST`)は、それを壊さないよう隔離コピー側を
 * 削除するだけにとどめる。
 */
function undoQuarantine(lockPath: string, quarantinePath: string): void {
  try {
    linkSync(quarantinePath, lockPath);
    unlinkSync(quarantinePath);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'EEXIST') {
      rmSync(quarantinePath, { force: true });
      return;
    }
    throw error;
  }
}

/** 判定で stale と分かった既存ロックを、TOCTOU セーフな手順で回収して新規取得する(design.md §6)。 */
function reclaimStaleLock(
  lockPath: string,
  judgedRaw: string,
  ownContent: LockContent,
  testOnlyBeforeQuarantine: (() => void) | undefined,
  testOnlyAfterQuarantine: (() => void) | undefined,
): LockHandle {
  const quarantinePath = `${lockPath}.stale-${process.pid}`;

  testOnlyBeforeQuarantine?.();

  try {
    renameSync(lockPath, quarantinePath);
  } catch (error) {
    // 隔離自体に失敗した(既に別プロセスが取り除いた等)。安全側に倒し、削除は行わず例外を投げる。
    throw new LockError(`failed to quarantine stale lock file: ${lockPath}`, { cause: error });
  }

  testOnlyAfterQuarantine?.();

  let quarantinedRaw: string;
  try {
    quarantinedRaw = readFileSync(quarantinePath, 'utf8');
  } catch (error) {
    throw new LockError(`failed to read quarantined lock file: ${quarantinePath}`, {
      cause: error,
    });
  }

  if (quarantinedRaw !== judgedRaw) {
    // 判定時に読んだ内容と、隔離後に読み直した内容が異なる = 判定と rename の間に
    // 別プロセスが新しいロックを作成した(TOCTOU 競合)。隔離を取り消して exit 2。
    undoQuarantine(lockPath, quarantinePath);
    throw new LockError(
      'lock file content changed between judgment and quarantine (concurrent lock acquisition detected)',
    );
  }

  // 内容が一致 = 本当に stale だったと確認できた。隔離コピーを削除し、新規に取得する。
  rmSync(quarantinePath, { force: true });

  if (!tryCreateLockFile(lockPath, ownContent)) {
    // 隔離〜新規取得の間に別プロセスが先に取得した(競り負け)。
    throw new LockError(
      `lost the race to acquire the lock after reclaiming a stale lock: ${lockPath}`,
    );
  }

  return { path: lockPath };
}

/**
 * ロックファイルを取得する(design.md §6)。
 *
 * 既にロックが存在しない場合は `O_CREAT | O_EXCL` で新規作成し、自プロセスの PID と
 * 開始時刻を書き込んで即座に返す。既に存在する場合は、記録された PID の生存・開始時刻を
 * 確認し、生存中の別インスタンスと判断できれば `LockError`(exit 2)を投げる。stale と
 * 判断できた場合は TOCTOU セーフな手順で自動回収してから新規取得する。生存・開始時刻の
 * どちらかが確認できない(確認不能)場合は、既存ロックを削除せず `LockError` を投げる。
 *
 * ファイルシステム操作は同期 API のみを用いる(cli.ts の起動直後、他の非同期処理より
 * 前にロックの成否を確定させたいため)。
 */
export function acquireLock(lockPath: string, options: AcquireLockOptions = {}): LockHandle {
  const {
    checkAlive = defaultCheckAlive,
    getStartTime = defaultGetStartTime,
    __testOnlyBeforeQuarantine,
    __testOnlyAfterQuarantine,
  } = options;

  const ownStartTime = getStartTime(process.pid);
  if (ownStartTime === 'unknown') {
    // 自プロセス自身の開始時刻すら確認できないと、次回実行が本ロックの生死を
    // 安全に判定できなくなる。ロックを作らず確認不能として扱う。
    throw new LockError(
      `unable to determine this process's own start time (pid=${process.pid}); ` +
        'the "ps" command is a required dependency (preinstalled on macOS; procps on Linux). ' +
        'Refusing to create an unverifiable lock.',
    );
  }
  const ownContent: LockContent = { pid: process.pid, startTime: ownStartTime };

  // 既存ロックが判定直前に消えている(直前に保持者が正常終了した等)可能性があるため、
  // 新規作成 → (EEXIST なら)判定、を最大2回まで試みる。
  const MAX_ATTEMPTS = 2;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (tryCreateLockFile(lockPath, ownContent)) {
      return { path: lockPath };
    }

    let judgedRaw: string;
    try {
      judgedRaw = readFileSync(lockPath, 'utf8');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        // EEXIST と判明した直後に消えた(保持者が解放した等)。作成をやり直す。
        continue;
      }
      throw error;
    }

    const judgedContent = parseLockContent(judgedRaw);
    if (judgedContent === undefined) {
      // 内容が壊れていて生死を判定できない = 確認不能。削除せず exit 2。
      throw new LockError(`lock file is unparseable, refusing to touch it: ${lockPath}`);
    }

    const aliveStatus = checkAlive(judgedContent.pid);
    if (aliveStatus === 'unknown') {
      throw new LockError(
        `cannot determine whether pid ${judgedContent.pid} is alive; refusing to touch the lock file: ${lockPath}`,
      );
    }

    if (aliveStatus === 'alive') {
      const recordedStartTime = getStartTime(judgedContent.pid);
      if (recordedStartTime === 'unknown') {
        throw new LockError(
          `cannot determine the start time of pid ${judgedContent.pid}; refusing to touch the lock file: ${lockPath}`,
        );
      }
      if (recordedStartTime === judgedContent.startTime) {
        // 生存確認・開始時刻の一致まで取れた = 同一プロセスによる多重起動。
        throw new LockError(
          `another instance is already running (pid=${judgedContent.pid}, startTime=${judgedContent.startTime})`,
        );
      }
      // 生存はしているが開始時刻が異なる = PID 再利用。stale として回収する。
    }
    // ここに到達するのは「PID が既に存在しない」または「PID 再利用」のいずれか(stale)。

    return reclaimStaleLock(
      lockPath,
      judgedRaw,
      ownContent,
      __testOnlyBeforeQuarantine,
      __testOnlyAfterQuarantine,
    );
  }

  throw new LockError(`failed to acquire lock after ${String(MAX_ATTEMPTS)} attempts: ${lockPath}`);
}

/**
 * `acquireLock` が返したロックファイルを解放する(design.md §6)。
 * `ENOENT`(既に削除されている)は無視する(冪等)。
 */
export function releaseLock(handle: LockHandle): void {
  rmSync(handle.path, { force: true });
}
