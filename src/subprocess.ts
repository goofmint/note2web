/**
 * サブプロセス実行の共通ユーティリティ(design.md §6「サブプロセス実行の共通規約」)。
 *
 * `apple_cloud_notes_parser` / `gh` / `qiita-cli` / `noet` / `git` などの外部 CLI を
 * 呼び出す全箇所がここを経由する。`detached: true` で新しいプロセスグループを作成し、
 * タイムアウト超過時は `process.kill(-pid, ...)` でプロセスグループごと終了させることで、
 * 子プロセスがさらに孫プロセスを起動していても取り残さない。stdin は常に `'ignore'` とし、
 * 対話的なプロンプトが発生しても入力を待って停止しないようにする(NFR-03)。
 *
 * ロック・一時ディレクトリのライフサイクルは呼び出し側が try/finally で保証する。
 * ハードクラッシュ(SIGKILL 相当・プロセスの異常終了)でそれが実施できなかった場合は、
 * 次回実行時の T-06 の stale ロック回収で回復する。ここでは関知しない。
 */

import { spawn } from 'node:child_process';
import { stat, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

/**
 * design.md §6 が定める既定タイムアウト。呼び出し側が用途に応じて選び、
 * `runSubprocess` の `timeoutMs` に渡す。`runSubprocess` 自身の既定値は
 * `DEFAULT_TIMEOUTS.default`(その他用途の5分)。
 */
export const DEFAULT_TIMEOUTS = {
  /** apple_cloud_notes_parser 用: 15分。 */
  parser: 900_000,
  /** gh / qiita-cli / noet / git などその他のコマンド用: 5分。 */
  default: 300_000,
} as const;

/** SIGTERM 送出後、残存していれば SIGKILL へ移行するまでの既定猶予時間。 */
const DEFAULT_TERM_GRACE_MS = 10_000;

/** 失敗理由の分類。design.md §6。 */
export type SubprocessClassification = 'timeout' | 'exit_code' | 'signal';

/**
 * `runSubprocess` が失敗分類を通知するために必要とする最小限のロガーインターフェース。
 * T-03 の `Logger` の `warn` メソッドはこれを満たすため、そのまま渡せる。
 */
export interface SubprocessLogger {
  warn(payload: { message: string }): void;
}

/** `runSubprocess` のオプション。 */
export interface RunSubprocessOptions {
  /** 実行するコマンド(PATH 解決に任せる名前、または絶対パス)。 */
  command: string;
  /** コマンドライン引数。シェルを介さず直接 `execve` されるため、シェル展開はされない。 */
  args: string[];
  /** 作業ディレクトリ。未指定なら現在の作業ディレクトリ。 */
  cwd?: string;
  /** 子プロセスへ渡す環境変数。未指定なら `process.env` をそのまま渡す。 */
  env?: Record<string, string>;
  /** タイムアウト(ミリ秒)。未指定なら `DEFAULT_TIMEOUTS.default`。 */
  timeoutMs?: number;
  /** SIGTERM から SIGKILL までの猶予(ミリ秒)。未指定なら 10_000。テスト用に短縮可能。 */
  termGraceMs?: number;
  /** 失敗分類を `warn` イベントとして出力する先(任意注入)。 */
  logger?: SubprocessLogger;
}

/** `runSubprocess` の実行結果。 */
export interface RunSubprocessResult {
  status: 'success' | 'failure';
  /** `status: 'failure'` のときのみ設定される失敗理由の分類。 */
  classification?: SubprocessClassification;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * 子プロセスを `detached: true`(新しいプロセスグループのリーダー)で起動し、完了まで待つ。
 * stdin は `'ignore'`(対話不許可、NFR-03)。stdout / stderr は別々にバッファへキャプチャする。
 *
 * タイムアウトを超過すると `process.kill(-pid, 'SIGTERM')` でプロセスグループ全体へ
 * SIGTERM を送り、`termGraceMs` 待っても子プロセスが残っていれば `SIGKILL` を送る。
 * タイマーは `close` イベント(stdout/stderr のフラッシュ完了後に発火する)で必ず解除し、
 * ゾンビタイマー・ハンドルを残さない。
 *
 * 戻り値は以下のいずれかに分類される:
 * - `status: 'success'`(exit code 0)
 * - `status: 'failure', classification: 'timeout'`(タイムアウトによる kill が原因)
 * - `status: 'failure', classification: 'exit_code'`(タイムアウト以外の非ゼロ終了)
 * - `status: 'failure', classification: 'signal'`(タイムアウト以外の理由によるシグナル終了)
 *
 * 失敗時、`logger` が渡されていれば分類を含む `warn` イベントを1件発行する。
 */
export function runSubprocess(options: RunSubprocessOptions): Promise<RunSubprocessResult> {
  const {
    command,
    args,
    cwd,
    env,
    timeoutMs = DEFAULT_TIMEOUTS.default,
    termGraceMs = DEFAULT_TERM_GRACE_MS,
    logger,
  } = options;

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    let timeoutTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
    };

    const killProcessGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) {
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        // 既に終了している等。close イベント側で最終結果を確定させるので無視してよい。
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcessGroup('SIGTERM');
      graceTimer = setTimeout(() => {
        killProcessGroup('SIGKILL');
      }, termGraceMs);
    }, timeoutMs);

    const finish = (result: RunSubprocessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();

      if (result.status === 'failure' && logger !== undefined) {
        logger.warn({
          message: `subprocess failed (${result.classification}): ${[command, ...args].join(' ')} (exitCode=${String(result.exitCode)}, signal=${String(result.signal)})`,
        });
      }

      resolve(result);
    };

    child.on('error', (error) => {
      // 実行ファイルが存在しない等、起動自体に失敗した場合。`close` が後続しない実装差にも
      // 対応できるよう、ここで確定させる(`close` が来ても `settled` ガードで二重解決しない)。
      finish({
        status: 'failure',
        classification: 'exit_code',
        exitCode: null,
        signal: null,
        stdout,
        stderr: stderr.length > 0 ? `${stderr}\n${error.message}` : error.message,
      });
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        finish({
          status: 'failure',
          classification: 'timeout',
          exitCode: code,
          signal,
          stdout,
          stderr,
        });
      } else if (signal !== null) {
        finish({
          status: 'failure',
          classification: 'signal',
          exitCode: code,
          signal,
          stdout,
          stderr,
        });
      } else if (code !== 0) {
        finish({
          status: 'failure',
          classification: 'exit_code',
          exitCode: code,
          signal,
          stdout,
          stderr,
        });
      } else {
        finish({ status: 'success', exitCode: code, signal, stdout, stderr });
      }
    });
  });
}

/**
 * `command` が PATH 上(または渡されたのが絶対パスならそのパス)に存在し、実行可能な
 * 通常ファイルかどうかを確認する(`which` 相当の自前実装)。非対話・短時間で完了し、
 * 実行(spawn)は一切行わない。
 */
export async function commandExists(command: string): Promise<boolean> {
  if (path.isAbsolute(command)) {
    return isExecutableFile(command);
  }

  const pathEnv = process.env.PATH ?? '';
  const dirs = pathEnv.split(path.delimiter).filter((dir) => dir.length > 0);

  for (const dir of dirs) {
    if (await isExecutableFile(path.join(dir, command))) {
      return true;
    }
  }
  return false;
}

/** `candidate` が存在する通常ファイルで、かつ実行権限を持つか確認する。 */
async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const stats = await stat(candidate);
    if (!stats.isFile()) {
      return false;
    }
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
