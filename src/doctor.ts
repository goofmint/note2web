/**
 * `doctor` サブコマンドの本体(design.md §5.1「依存 CLI・環境変数・権限の事前チェックのみ
 * 実行」、issue #20 / T-15)。
 *
 * `src/dependencies.ts` の `checkDependencies`(T-14。`sync` 冒頭でも使う共通・service別
 * 依存チェック)をそのまま再利用し、重複実装しない。`doctor` はそれに加えて、Git モード
 * (zenn/hugo/jekyll)専用の追加チェックを行う:
 *
 *   - `gh auth status` が成功すること(design.md §5.7「`gh auth status` … を確認し、
 *     不備があれば配信前に exit 2」)
 *   - 対象リポジトリ(`git.repo_path`)への push / PR 作成権限があること
 *     (design.md §5.7 同箇所「対象リポジトリへの push / PR 作成権限を確認」)
 *
 * **sync と doctor の役割分担(design.md §5.7 と `src/dependencies.ts` の既存方針への
 * 追従)**: `checkDependencies`(T-14)は意図的に `gh auth status` 権限確認を行わない
 * (同ファイル冒頭の JSDoc 参照)。理由は、sync の毎回実行のたびに追加のネットワーク
 * 呼び出しを強制しないこと、および design.md §5.1 が `doctor` を独立コマンドとして
 * 用意した意図(事前チェックを sync から分離できるようにする)を尊重すること。
 * したがって本モジュールの `gh auth status` / 権限確認は **doctor 専用**であり、
 * `sync`(`src/sync.ts` → `checkDependencies`)からは呼ばれない。
 *
 * **権限確認の具体的なコマンド**: design.md §5.7 は「対象リポジトリへの push / PR
 * 作成権限を確認」とだけ書き、具体的な `gh` サブコマンドを規定していない
 * (CodeRabbit のプランはこの理由で権限確認自体を省略したが、design.md の文言は
 * 確認の実施そのものを明確に要求しているため、本実装では省略せず実施する)。
 * ここでは `gh repo view --json viewerPermission`(cwd を `git.repo_path` に設定)
 * を選んだ。`gh` はカレントディレクトリの git remote から対象リポジトリを自動解決し、
 * 認証ユーザーの `viewerPermission`(`ADMIN` / `MAINTAIN` / `WRITE` / `TRIAGE` / `READ` /
 * `NONE`)を返す。push / PR 作成には `WRITE` 以上が必要なため、
 * `WRITE` / `MAINTAIN` / `ADMIN` のいずれかであることを要求する。
 */

import type { Config } from './config.js';
import {
  checkDependencies,
  DependencyCheckError,
  type CheckDependenciesOptions,
  type DependencyProblem,
} from './dependencies.js';
import { expandHome } from './exporter/apple-notes.js';
import { PRECONDITION_FAILURE } from './exit-codes.js';
import { isGitModeService } from './publishers/mode.js';
import {
  commandExists,
  DEFAULT_TIMEOUTS,
  runSubprocess,
  type RunSubprocessOptions,
  type RunSubprocessResult,
} from './subprocess.js';

/** push / PR 作成が可能とみなす `gh repo view --json viewerPermission` の値(design.md §5.7)。 */
const SUFFICIENT_REPO_PERMISSIONS = new Set(['WRITE', 'MAINTAIN', 'ADMIN']);

/**
 * `doctor` のチェックに失敗したことを表すエラー。`src/dependencies.ts` の
 * `DependencyCheckError` / `src/lock.ts` の `LockError` と同じ `exitCode` 規約に従う。
 * 見つかった不足は `problems` に **全件** 蓄積する(1件目で打ち切らない。issue #20 の
 * 受け入れ条件「依存欠如ごとに何が足りないか明示して exit 2」)。
 */
export class DoctorError extends Error {
  readonly exitCode = PRECONDITION_FAILURE;
  readonly problems: DependencyProblem[];

  constructor(problems: DependencyProblem[]) {
    super(problems.map((problem) => problem.message).join('; '));
    this.name = 'DoctorError';
    this.problems = problems;
  }
}

/** `runDoctorChecks` の挙動を差し替えるためのオプション(テスト用の注入点)。 */
export interface RunDoctorOptions {
  /** コマンド存在確認の注入点。既定は `src/subprocess.ts` の `commandExists`。 */
  commandExistsFn?: (command: string) => Promise<boolean>;
  /** ファイル存在確認の注入点(`checkDependencies` にそのまま渡す)。既定は実 `fs.access`。 */
  fileExistsFn?: (path: string) => Promise<boolean>;
  /** 環境変数の参照元。既定は `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** サブプロセス実行の注入点(`gh auth status` / `gh repo view` に使う)。既定は本物の `runSubprocess`。 */
  runSubprocessFn?: (options: RunSubprocessOptions) => Promise<RunSubprocessResult>;
}

/** サブプロセスの stdout/stderr から、エラーメッセージ用に先頭の意味のある1行を取り出す。 */
function firstNonEmptyLine(text: string): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

/**
 * Git モード(zenn/hugo/jekyll)専用の追加チェック: `gh auth status` の成否と、
 * 対象リポジトリ(`config.git.repo_path`)への push / PR 作成権限。
 *
 * `gh` コマンド自体が無い、または `GH_TOKEN` が未設定の場合は、`checkDependencies`
 * (共通・service別チェック)が既にその旨を `problems` へ積んでいるはずなので、
 * ここでは追加のサブプロセス実行を行わない(存在しないコマンドの実行や、無意味な
 * 認証エラーで問題を重複報告することを避けるため)。
 */
async function checkGitModeAuthAndPermission(
  config: Config,
  problems: DependencyProblem[],
  options: Required<Pick<RunDoctorOptions, 'commandExistsFn' | 'env' | 'runSubprocessFn'>>,
): Promise<void> {
  const { commandExistsFn, env, runSubprocessFn } = options;

  if (!isGitModeService(config.service)) {
    return;
  }

  const ghToken = env.GH_TOKEN;
  const hasGhToken = ghToken !== undefined && ghToken !== '';
  const hasGhCommand = await commandExistsFn('gh');
  if (!hasGhCommand || !hasGhToken) {
    // どちらも checkDependencies(共通・service別チェック)が既に報告済み。
    return;
  }

  const authResult = await runSubprocessFn({
    command: 'gh',
    args: ['auth', 'status'],
    env: { GH_TOKEN: ghToken },
    timeoutMs: DEFAULT_TIMEOUTS.default,
  });
  if (authResult.status !== 'success') {
    const detail =
      firstNonEmptyLine(authResult.stderr) ??
      firstNonEmptyLine(authResult.stdout) ??
      'unknown error';
    problems.push({
      message: `"gh auth status" failed (design.md §5.7 GH_TOKEN authentication): ${detail}`,
    });
    return;
  }

  // config スキーマ上、git モードの service は git ブロックが必須(src/config.ts の
  // superRefine)。TS の型は optional のままなので、防御的に undefined を弾く。
  if (config.git === undefined) {
    problems.push({
      message: `internal error: git-mode service "${config.service}" has no "git" config block`,
    });
    return;
  }

  const repoPath = expandHome(config.git.repo_path);
  const permissionResult = await runSubprocessFn({
    command: 'gh',
    args: ['repo', 'view', '--json', 'viewerPermission'],
    cwd: repoPath,
    env: { GH_TOKEN: ghToken },
    timeoutMs: DEFAULT_TIMEOUTS.default,
  });
  if (permissionResult.status !== 'success') {
    const detail = firstNonEmptyLine(permissionResult.stderr) ?? 'unknown error';
    problems.push({
      message:
        `failed to determine push/PR permission on target repository ` +
        `("gh repo view --json viewerPermission" in ${repoPath}, design.md §5.7): ${detail}`,
    });
    return;
  }

  let viewerPermission: string | undefined;
  try {
    const parsed: unknown = JSON.parse(permissionResult.stdout);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'viewerPermission' in parsed &&
      typeof (parsed as Record<string, unknown>).viewerPermission === 'string'
    ) {
      viewerPermission = (parsed as Record<string, string>).viewerPermission;
    }
  } catch {
    viewerPermission = undefined;
  }

  if (viewerPermission === undefined || !SUFFICIENT_REPO_PERMISSIONS.has(viewerPermission)) {
    problems.push({
      message:
        `insufficient push/PR permission on target repository (${repoPath}): ` +
        `viewerPermission="${viewerPermission ?? 'unknown'}" (need one of ` +
        `${[...SUFFICIENT_REPO_PERMISSIONS].join('/')}, design.md §5.7)`,
    });
  }
}

/**
 * `doctor` の本体。design.md §6 の依存表に基づく service別チェック(`checkDependencies`
 * の再利用)に加え、Git モードでは `gh auth status` と対象リポジトリの push / PR 作成権限を
 * 確認する。不足は1件目で打ち切らず全件集め、1件以上あれば `DoctorError` を投げる。
 * 不足がなければ正常に返る。
 */
export async function runDoctorChecks(
  config: Config,
  options: RunDoctorOptions = {},
): Promise<void> {
  const {
    commandExistsFn = commandExists,
    fileExistsFn,
    env = process.env,
    runSubprocessFn = runSubprocess,
  } = options;

  const problems: DependencyProblem[] = [];

  const dependencyOptions: CheckDependenciesOptions = { commandExistsFn, env };
  if (fileExistsFn !== undefined) {
    dependencyOptions.fileExistsFn = fileExistsFn;
  }

  try {
    await checkDependencies(config, dependencyOptions);
  } catch (error) {
    if (error instanceof DependencyCheckError) {
      problems.push(...error.problems);
    } else {
      throw error;
    }
  }

  await checkGitModeAuthAndPermission(config, problems, {
    commandExistsFn,
    env,
    runSubprocessFn,
  });

  if (problems.length > 0) {
    throw new DoctorError(problems);
  }
}
