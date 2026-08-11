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
 * 追従、T-16 時点で更新)**: `checkDependencies`(T-14)は意図的に `gh auth status` /
 * 権限確認を行わない(同ファイル冒頭の JSDoc 参照)。理由は、`GH_TOKEN` の存在確認という
 * 副作用の無いチェックと、実際にネットワーク呼び出しを伴う認証・権限確認とを分離し、
 * `checkDependencies` 自体は「不要な依存は要求しない」設定検証の一部として副作用なく
 * 完結させたいため。ただし design.md §5.7 は「`doctor` / `sync` 冒頭で… `gh auth status`
 * … 権限を確認」と、**両方**での実施を明示的に要求しており、T-16(issue #21)の受け入れ
 * 条件も「権限が無い場合…Git / gh 書き込みを一切行わず exit 2」を `sync` 自身に要求する
 * ため、`src/sync.ts` の `runSync` も `src/git-auth.ts` の `checkGitModeAuthAndPermission`
 * を(`prepare()` 等の Git 副作用より前に)呼び出す。本モジュールはその実装を共有する側。
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
 *
 * **T-16(issue #21)時点の追記**: `gh auth status` / 権限確認の実体は `src/git-auth.ts`
 * (`checkGitModeAuthAndPermission`)へ切り出した。design.md §5.7 の文言(「`doctor` /
 * `sync` 冒頭で…確認」)は `sync` 冒頭でも同じ確認を要求しており、`src/sync.ts` の
 * `runSync` もこれを共有するため(同ファイル冒頭 JSDoc 参照)。本モジュールの挙動は
 * 変更していない。
 */

import type { Config } from './config.js';
import {
  checkDependencies,
  DependencyCheckError,
  type CheckDependenciesOptions,
  type DependencyProblem,
} from './dependencies.js';
import { PRECONDITION_FAILURE } from './exit-codes.js';
import { checkGitModeAuthAndPermission } from './git-auth.js';
import {
  commandExists,
  runSubprocess,
  type RunSubprocessOptions,
  type RunSubprocessResult,
} from './subprocess.js';

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
