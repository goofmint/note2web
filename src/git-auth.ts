/**
 * Git モード(zenn/hugo/jekyll)専用の `gh` 認証・リポジトリ権限検証(design.md §5.7
 * 「認証: `gh` は `GH_TOKEN` 環境変数で認証する… `doctor` / `sync` 冒頭で `GH_TOKEN`
 * の存在・`gh auth status`・対象リポジトリへの push / PR 作成権限を確認し、不備があれば
 * 配信前に exit 2」)。
 *
 * 元は `src/doctor.ts`(T-15)に private 実装として存在していたが、design.md §5.7 の文言は
 * `doctor` だけでなく `sync` 冒頭でも同じ確認を要求している。T-14/T-15 実装時点の
 * `src/dependencies.ts` は「`sync` は存在確認のみ、フル検証は `doctor` に委譲」という
 * より狭い解釈を採っていたが(同ファイル冒頭 JSDoc 参照)、T-16(issue #21)の受け入れ条件
 * ——「`GH_TOKEN` と `gh auth status` が有効でも対象リポジトリへの push / PR 作成権限が
 * 無い場合…ブランチ作成・push・`gh pr create` のいずれの Git / gh 書き込みも行わず、
 * StateStore も更新せずに exit 2」——は `sync` 自身がこの確認を行うことを明示的に要求して
 * おり、design.md の文言とも一致する。そのため本モジュールへ切り出し、`doctor.ts`
 * (既存の呼び出し元)と `sync.ts`(T-16 で追加する呼び出し元)の双方から共有する
 * (CodeRabbit issue #21 プラン Phase 1 とも一致する結論)。
 *
 * 挙動は `doctor.ts` に元々あった実装から変更していない。
 */

import type { Config } from './config.js';
import type { DependencyProblem } from './dependencies.js';
import { expandHome } from './paths.js';
import { isGitModeService } from './publishers/mode.js';
import {
  DEFAULT_TIMEOUTS,
  type RunSubprocessOptions,
  type RunSubprocessResult,
} from './subprocess.js';

/** push / PR 作成が可能とみなす `gh repo view --json viewerPermission` の値(design.md §5.7)。 */
export const SUFFICIENT_REPO_PERMISSIONS = new Set(['WRITE', 'MAINTAIN', 'ADMIN']);

/** サブプロセスの stdout/stderr から、エラーメッセージ用に先頭の意味のある1行を取り出す。 */
function firstNonEmptyLine(text: string): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

/** `checkGitModeAuthAndPermission` に渡す注入点。 */
export interface GitAuthCheckOptions {
  /** コマンド存在確認の注入点(`gh`/`GH_TOKEN` が既に他所で報告済みかどうかの判定に使う)。 */
  commandExistsFn: (command: string) => Promise<boolean>;
  /** 環境変数の参照元。 */
  env: NodeJS.ProcessEnv;
  /** サブプロセス実行の注入点(`gh auth status` / `gh repo view` に使う)。 */
  runSubprocessFn: (options: RunSubprocessOptions) => Promise<RunSubprocessResult>;
}

/**
 * Git モード(zenn/hugo/jekyll)専用の追加チェック: `gh auth status` の成否と、
 * 対象リポジトリ(`config.git.repo_path`)への push / PR 作成権限。
 *
 * `gh` コマンド自体が無い、または `GH_TOKEN` が未設定の場合は、呼び出し側
 * (`checkDependencies` 等)が既にその旨を `problems` へ積んでいるはずなので、
 * ここでは追加のサブプロセス実行を行わない(存在しないコマンドの実行や、無意味な
 * 認証エラーで問題を重複報告することを避けるため)。
 *
 * Git モードでない `service` の場合は何もしない(呼び出し側で `isGitModeService` を
 * 判定する必要はない)。
 */
export async function checkGitModeAuthAndPermission(
  config: Config,
  problems: DependencyProblem[],
  options: GitAuthCheckOptions,
): Promise<void> {
  const { commandExistsFn, env, runSubprocessFn } = options;

  if (!isGitModeService(config.service)) {
    return;
  }

  const ghToken = env.GH_TOKEN;
  const hasGhToken = ghToken !== undefined && ghToken !== '';
  const hasGhCommand = await commandExistsFn('gh');
  if (!hasGhCommand || !hasGhToken) {
    // どちらも呼び出し側(共通・service別チェック)が既に報告済み。
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
