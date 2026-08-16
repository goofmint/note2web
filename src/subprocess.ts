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
import { homedir } from 'node:os';

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
 * `termGraceMs` 経過後に確実にプロセスグループへ SIGKILL が送られるようにするため。
 * このタイマーは意図的に `unref()` しない — ホストプロセスが先に終了すると SIGKILL が
 * 発火せず、SIGTERM を無視する孫プロセスが孤児として残るため、タイムアウト経路では
 * 最大 `termGraceMs` だけイベントループを保持してエスカレーションを完走させる。
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
      // 猶予タイマーは一度武装したら取り消さない(直接の子が `close` しても、
      // SIGTERM を無視する孫プロセスが残っているかもしれないため)。意図的に
      // `unref()` もしない — ホストが先に終了すると SIGKILL が発火しないため、
      // 最大 `termGraceMs` だけイベントループを保持してエスカレーションを完走させる。
      setTimeout(() => {
        // 直接の子が既に `close` していても関知せず、プロセスグループ全体へ
        // 無条件で SIGKILL を送る(既に全滅していれば ESRCH を無視するだけ)。
        killProcessGroup('SIGKILL');
      }, termGraceMs);
    }, timeoutMs);

    const finish = (result: RunSubprocessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      // `timeoutTimer` は結果確定と同時に不要になるので必ず解除する。一方、
      // タイムアウト経路で武装済みの猶予タイマーは解除せず、上記の
      // SIGKILL エスカレーションを完走させる(孫プロセスの取り残し防止)。
      clearTimeoutTimer();

      if (result.status === 'failure' && logger !== undefined) {
        // コマンドライン(command / args)は API トークン等の秘匿情報を含みうるため
        // ログには出さない(FR-30)。一方、stdout/stderr の先頭1行(issue #67:
        // launchd 環境での原因調査を可能にするため)は診断に有用なので含める——
        // 各呼び出し元の argv には秘匿情報を含まない設計(FR-30 は「コマンドラインに
        // 秘匿情報を含めない」規約であり、出力内容の秘匿性はこの規約の対象外)。
        const rawOutputSummary =
          firstNonEmptyLine(result.stderr) ?? firstNonEmptyLine(result.stdout);
        const outputSummary =
          rawOutputSummary !== undefined ? sanitizeOutputSummary(rawOutputSummary) : undefined;
        logger.warn({
          message:
            `subprocess failed (${result.classification}): exitCode=${String(result.exitCode)}, signal=${String(result.signal)}` +
            (outputSummary !== undefined ? `, output: ${outputSummary}` : ''),
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
 * サブプロセスの stdout/stderr から、エラーメッセージ用に先頭の意味のある1行を取り出す。
 * `src/publishers/git-repo.ts` / `src/publishers/note.ts` / `src/publishers/qiita.ts` に
 * 個別に複製されていたローカル実装(挙動は同一)を、issue #67(CodeRabbit プラン)で
 * ここへ集約した。`src/exporter/apple-notes.ts` の `ExportError` メッセージ組み立てにも使う。
 */
export function firstNonEmptyLine(text: string): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

/** ログ出力長の上限(文字数)。超過分は末尾を `…` に置き換えて切り詰める。 */
const OUTPUT_SUMMARY_MAX_LENGTH = 200;

/**
 * ログに出す `firstNonEmptyLine` の結果を無害化する(issue #67 CodeRabbit フォローアップ)。
 * `command` / `args` 自体には秘匿情報を含めない設計だが(FR-30)、これはあくまで
 * コマンドライン組み立て側の規約であり、外部コマンドが stdout/stderr に何を出すかは
 * 呼び出し元では制御できない。ここでは簡易な正規表現でよくある秘匿情報の形を
 * マスクする多層防御(defense-in-depth)であり、完全な秘匿情報検出を保証するものではない。
 *
 * - 実行ユーザーのホームディレクトリ配下のパスは `~` に置き換え、ログにアカウント名が
 *   残らないようにする。
 * - GitHub トークン(`ghp_` / `gho_` / `ghs_` / `ghu_` / `github_pat_`)、Slack 風トークン
 *   (`xoxb-` 等)、AWS アクセスキー ID(`AKIA...`)、`Bearer <token>`、および
 *   `...token=` / `...key=` / `...secret=` / `...password=` 形式の `NAME=value` の値部分を
 *   `***` に置き換える。
 * - 200文字を超える場合は切り詰め、末尾に `…` を付与する。
 *
 * `homedirFn` はテスト用の注入点(既定は `node:os` の `homedir`)。
 */
export function sanitizeOutputSummary(line: string, homedirFn: () => string = homedir): string {
  const home = homedirFn();
  let sanitized = home.length > 0 ? line.split(home).join('~') : line;

  const maskPatterns: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
    // GitHub トークン(ghp_ / gho_ / ghs_ / ghu_)。
    { pattern: /\bgh[pous]_[A-Za-z0-9]{20,}\b/g, replacement: '***' },
    // GitHub のファイングレインド PAT(github_pat_...)。
    { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: '***' },
    // Slack 風トークン(xoxb- / xoxp- 等)。
    { pattern: /\bxox[a-z]-[A-Za-z0-9-]+\b/g, replacement: '***' },
    // AWS アクセスキー ID。
    { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '***' },
    // `Authorization: Bearer <token>` 等。
    { pattern: /\bBearer\s+\S+/gi, replacement: 'Bearer ***' },
    // NAME に token/key/secret/password を含む `NAME=value` 形式(値だけマスク)。
    { pattern: /\b([\w-]*(?:token|key|secret|password)[\w-]*)=(\S+)/gi, replacement: '$1=***' },
  ];
  for (const { pattern, replacement } of maskPatterns) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  if (sanitized.length > OUTPUT_SUMMARY_MAX_LENGTH) {
    sanitized = `${sanitized.slice(0, OUTPUT_SUMMARY_MAX_LENGTH)}…`;
  }

  return sanitized;
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
