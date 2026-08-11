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
import { StringDecoder } from 'node:string_decoder';
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
  /**
   * 子プロセスへ渡す環境変数。指定した場合は `process.env` とマージされ
   * (`{ ...process.env, ...env }`)、キーが重なる項目は `env` の値が優先される。
   * 未指定なら `process.env` をそのまま渡す。
   */
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
 * 直接の子プロセスの `close`(stdout/stderr のフラッシュ完了後に発火する)は即座に
 * `runSubprocess` の結果を確定させるが、タイムアウト経路で武装済みの猶予タイマーは
 * 直接の子の `close` では取り消さない — SIGTERM を無視する孫プロセスが残っていても
 * `termGraceMs` 経過後に確実にプロセスグループへ SIGKILL が送られるようにするためで、
 * このタイマーは `unref()` 済みのためイベントループを保持し続けることはない。
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
      env: env !== undefined ? { ...process.env, ...env } : process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    let timeoutTimer: NodeJS.Timeout | undefined;
    // タイムアウト経路で武装(arm)された後は、直接の子プロセスが `close` しても
    // (孫プロセスが SIGTERM を無視して生き残っているかもしれないため)
    // `graceTimer` を取り消さない。`termGraceMs` 経過後に無条件でプロセスグループへ
    // SIGKILL を送ってから、自身をクリアする。
    let graceTimer: NodeJS.Timeout | undefined;

    const clearTimeoutTimer = (): void => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
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
      stdout += stdoutDecoder.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += stderrDecoder.write(chunk);
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcessGroup('SIGTERM');
      graceTimer = setTimeout(() => {
        // 直接の子が既に `close` していても関知せず、プロセスグループ全体へ
        // 無条件で SIGKILL を送る(既に全滅していれば ESRCH を無視するだけ)。
        killProcessGroup('SIGKILL');
        graceTimer = undefined;
      }, termGraceMs);
      graceTimer.unref();
    }, timeoutMs);

    const finish = (result: RunSubprocessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      // `timeoutTimer` は結果確定と同時に不要になるので必ず解除する。一方
      // `graceTimer` はタイムアウト経路で既に武装されていれば解除せず、上記の
      // SIGKILL エスカレーションを完走させる(孫プロセスの取り残し防止)。
      clearTimeoutTimer();

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
      // design.md §6 は失敗分類を timeout / exit_code / signal の3種のみと定めており、
      // ENOENT のような起動失敗を表す専用分類は存在しない。そのためここでは
      // `exit_code`(`exitCode: null`)へ意図的に丸めている。呼び出し側でコマンドの
      // 存在を事前に区別したい場合は `commandExists` で事前検証すること。
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
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();

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
