/**
 * GitRepoPublisher(design.md §5.7「GitRepoPublisher(Zenn / Hugo / Jekyll 共通基盤)」、
 * T-16 / issue #21)。
 *
 * Zenn / Hugo / Jekyll に共通する Git リポジトリ出力基盤。design.md §5.7 の手順どおり:
 *
 *   1. `prepare()`: `repo_path` で `git fetch` → `base_branch` から作業ブランチ
 *      `note2web/sync-<UTC時刻>`(`YYYYMMDDTHHMMSSZ`、`:` を含めない)を作成する(FR-19)。
 *   2. `publish()`: 変更のあったノートのファイルを規約パス(`article.artifactPath`、
 *      `repo_path` からの相対パス)へ書き込み、結果を**保留リスト**に積むだけ(状態 JSON は
 *      一切更新しない——`src/state/store.ts` の `StateStore` に触れないのは意図的な設計で、
 *      状態確定のタイミング制御は sync フロー(`src/sync.ts`)側の責務のまま保つ)。
 *   3. `finalize()`: `git status` で差分ゼロならブランチを削除して終了(コミット・PR なし、
 *      FR-22)。差分があればコミット・`git push`・`gh pr create`(FR-20)。`auto_merge: true`
 *      なら `gh pr merge --merge --delete-branch`(FR-21)。
 *   4. **状態更新のトランザクション**(design.md §5.7 手順4): 確定基準は「PR 作成成功」。
 *      push / `gh pr create` の失敗は例外を投げ、sync フロー(`src/sync.ts`)に「確定しない
 *      ・失敗」として扱わせる。PR 作成に成功した時点で `FinalizeOutcome.persist: true` を
 *      返し(auto_merge の有無に関わらず)、sync フローが `StateStore.flush()` を呼べるように
 *      する。`auto_merge` のマージ失敗は「状態は保存済みのまま(`persist: true`)実行は失敗
 *      (`failed: true`)」として報告する(design.md §10「`gh pr merge` 失敗… PR は残し、
 *      実行は失敗として報告」)。`FinalizeOutcome` の詳しい設計根拠は
 *      `src/publishers/types.ts` 冒頭の JSDoc を参照。
 *
 * 全ての git / gh コマンドは注入可能な `runner`(既定 `src/subprocess.ts` の
 * `runSubprocess`)を経由する。テストではモック runner を注入し、実際の git / gh を
 * 実行しない。
 *
 * サービス別のファイルパス・frontmatter(Zenn の UUID 小文字化、Hugo の `output_dir`、
 * Jekyll の日付付きファイル名固定等。design.md §5.7 サービス別表)は本モジュールの範囲外
 * (T-17〜T-19)。ここでは `RenderedArticle.artifactPath` に既に解決済みのパスがそのまま
 * 使われる前提で、Git リポジトリへの書き込み・コミット・PR 作成という共通処理のみを担う。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { expandHome } from '../paths.js';
import type { RunSubprocessOptions, RunSubprocessResult } from '../subprocess.js';
import { firstNonEmptyLine, runSubprocess } from '../subprocess.js';
import type { NoteState } from '../state/store.js';
import type { FinalizeOutcome, Publisher, PublishResult, RenderedArticle } from './types.js';

/** git / gh コマンド実行の注入点(テスト用)。既定は本物の `runSubprocess`。 */
export type GitRepoRunner = (options: RunSubprocessOptions) => Promise<RunSubprocessResult>;

/** `createGitRepoPublisher` のオプション。 */
export interface CreateGitRepoPublisherOptions {
  /** 検証済み設定。`config.git` が必須(zenn/hugo/jekyll のいずれか、`src/config.ts` 参照)。 */
  config: Config;
  /** git / gh コマンド実行の注入点(テスト用)。既定は本物の `runSubprocess`。 */
  runner?: GitRepoRunner;
  /** ログ出力先(任意)。渡された場合、差分ゼロでの破棄など診断的な `warn` を発行する。 */
  logger?: Logger;
  /** 時刻注入点(テスト用)。既定は `() => new Date()`。ブランチ名の決定性に使う(FR-19)。 */
  now?: () => Date;
  /** 環境変数の参照元(`GH_TOKEN` 抽出用、テスト用)。既定は `process.env`。 */
  env?: NodeJS.ProcessEnv;
}

/** 作業ブランチ名の接頭辞(design.md §5.7)。 */
const BRANCH_PREFIX = 'note2web/sync-';

/**
 * 全ての `git` 呼び出しのサブコマンドの前に付与する引数(design.md §5.7「認証」節、
 * NFR「launchd で対話なし」、issue: 実機 Mac での Git Credential Manager(GCM)ポップアップ)。
 *
 * **背景(実機で観測された問題)**: `git push` が HTTPS リモートに対して実行されると、git は
 * `credential.helper` を **system → global → local の設定順にすべて** 呼び出す仕様になって
 * いる。ユーザーの Mac では `gh auth setup-git` を実行済みでも、system レベルに Git
 * Credential Manager(GCM)や `osxkeychain` の helper が既に登録されており、`gh` の helper
 * より先にそちらが呼ばれてしまう。結果、launchd 経由の非対話実行中に GUI の認証ポップアップ
 * が表示され、応答が無いまま停止する。さらにユーザーは `gh` に GitHub アカウントを2つ認証
 * 済みで、`gh` 自身の「アクティブアカウント」解決に頼るとどちらが使われるか曖昧になる。
 *
 * **対策**: `git` を呼ぶたびに以下の2つの `-c credential.helper=...` をサブコマンドより前に
 * 付与する(git の `-c` はそのプロセス実行中のみ有効な一度限りの上書きで、リポジトリや
 * 環境のグローバルな git 設定は一切書き換えない):
 *   1. `-c credential.helper=`(空値)— それまでに system/global/local で設定された
 *      credential helper の連鎖を**すべてクリアする**(git の `credential.helper` は空文字列
 *      を与えると「これより前の設定を無視する」という特別な意味を持つ)。
 *   2. `-c credential.helper=!gh auth git-credential` — その上で `gh` の credential helper
 *      **のみ**を有効にする。`gh auth git-credential` は環境変数 `GH_TOKEN` を `gh` 自身の
 *      複数アカウント状態より優先して参照するため、note2web が渡す `GH_TOKEN`(下記
 *      `runnerEnv`)がそのまま認証アカウントを決定的に決める(2アカウント問題を回避)。
 *      これにより `gh auth setup-git` の実行は不要になる。
 *
 * トークンの値そのものは引数(argv)には一切現れない——`gh auth git-credential` が実行時に
 * 環境変数から読むだけであり、コマンドラインには秘匿情報を含めないという規約(FR-30)と
 * 整合する。
 *
 * `status`/`add`/`commit`/`checkout`/`branch -D` のようなローカル専用コマンド(認証を伴わない)
 * にもこの前置きを一律で付ける。無害なので、認証が必要なコマンドかどうかで分岐を増やさず
 * `run()` の実装を単純に保つ。
 */
export const GIT_CREDENTIAL_ARGS: readonly string[] = [
  '-c',
  'credential.helper=',
  '-c',
  'credential.helper=!gh auth git-credential',
];

/**
 * `date`(UTC)を `YYYYMMDDTHHMMSSZ` 形式へ整形する(design.md §5.7「時刻部分は
 * `YYYYMMDDTHHMMSSZ` 形式とし、Git の ref 名に使えない `:` 等を含めない」)。
 */
function formatBranchTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const year = String(date.getUTCFullYear());
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

/**
 * `absolutePath` が `root` の配下(`root` 自身を含む)かどうかを判定する(CodeRabbit review,
 * PR #49。`src/assets/uploader.ts` の `isPathWithinRoot` と同じ防御パターン)。
 * `article.artifactPath` は現状 Renderer(`src/publishers/render.ts` 等)が組み立てる内部値
 * だが、将来のサービス別 Renderer(T-17〜T-19)がノートのタイトル・UUID 等の外部由来の値を
 * ファイル名へ混ぜ込む可能性があり、トラバーサル(`../`)や絶対パスによる `repo_path` 外への
 * 書き込みを許してはならない。`relative(root, absolutePath)` が `..` から始まる、または
 * それ自体が絶対パスになる場合は `root` の外側を指している。
 */
function isPathWithinRoot(root: string, absolutePath: string): boolean {
  const rel = relative(root, absolutePath);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** `publish()` で書き込み・保留リストに積んだ1件。 */
interface PendingEntry {
  uuid: string;
  /** `repo_path` からの相対パス(`RenderedArticle.artifactPath` と同じ)。 */
  artifactPath: string;
}

/** design.md §7 の `git` ブロック(`repo_path`/`base_branch`/`output_dir`/`auto_merge`)。 */
type GitConfig = NonNullable<Config['git']>;

/**
 * `config.git` の存在を検証して返す。単に `config.git` を参照し続けると、TypeScript は
 * 「クロージャ内(`prepare`/`publish`/`finalize` 等のネストした関数)ではこの undefined
 * チェックによる narrowing を保持しない」ため、返り値の型を `NonNullable` に確定させて
 * 以後クロージャ内でも安全に参照できるようにする。
 */
function requireGitConfig(config: Config): GitConfig {
  if (config.git === undefined) {
    throw new Error(
      `internal error: createGitRepoPublisher requires config.git (service "${config.service}" has none)`,
    );
  }
  return config.git;
}

/**
 * design.md §5.7 GitRepoPublisher を実装する `Publisher` を作る。
 *
 * `config.git` が未定義の場合は即座に例外を投げる(呼び出し側 = `src/publishers/factory.ts`
 * が `isGitModeService` かつ `config.git !== undefined` を確認してから呼ぶ想定だが、防御的に
 * 検証する)。
 */
export function createGitRepoPublisher(options: CreateGitRepoPublisherOptions): Publisher {
  const {
    config,
    runner = runSubprocess,
    logger,
    now = () => new Date(),
    env = process.env,
  } = options;

  const gitConfig = requireGitConfig(config);
  const repoPath = expandHome(gitConfig.repo_path);
  const ghToken = env.GH_TOKEN;
  // GH_TOKEN は gh コマンドの認証に必須(design.md §5.7 NFR-03)。`git fetch`/`git push` も
  // HTTPS リモート + `gh` の git credential helper 経由で認証する構成では同じトークンを
  // 参照するため、git / gh いずれのコマンドにも渡す(issue #21 の要求は gh コマンドのみだが、
  // push が実際に認証を通すにはここまで必要になる実運用上の理由による拡張)。`git` 呼び出し
  // 側で credential helper を `gh auth git-credential` 一本に強制する仕組みは
  // `GIT_CREDENTIAL_ARGS` のコメントを参照。
  const runnerEnv: Record<string, string> | undefined =
    ghToken !== undefined && ghToken !== '' ? { GH_TOKEN: ghToken } : undefined;

  let branchName: string | undefined;
  const pending: PendingEntry[] = [];

  async function run(command: string, args: string[]): Promise<RunSubprocessResult> {
    if (command === 'git') {
      // `GIT_CREDENTIAL_ARGS` をサブコマンドより前に付与し(詳細は同定数のコメント参照)、
      // 加えて `GIT_TERMINAL_PROMPT=0` と `GIT_ASKPASS=''`(空)を渡す。credential helper の
      // 強制が何らかの理由で効かず認証情報が見つからない場合でも:
      //   - `GIT_ASKPASS=''`: 親環境から GUI の askpass プログラム(GIT_ASKPASS /
      //     core.askPass)を継承していても、空文字で上書きすることで git は askpass 経路を
      //     スキップする(git は askpass が「設定済みかつ非空」の場合のみ実行する)
      //   - `GIT_TERMINAL_PROMPT=0`: askpass スキップ後のターミナルプロンプトへの
      //     フォールバックも禁止し、即座にエラー終了させる
      // (NFR「launchd で対話なし」の最終防波堤。GUI・ターミナルの両経路を塞ぐ)。
      // `env` は常にオブジェクトを渡す(GH_TOKEN 未設定でも渡る)—— `runSubprocess`
      // (`src/subprocess.ts`)は `env` が渡されればマージ(`{ ...process.env, ...env }`)、
      // 未指定なら `process.env` をそのまま使うため、ここで空でないオブジェクトを渡しても
      // 既存の環境変数を破壊しない。
      return runner({
        command,
        args: [...GIT_CREDENTIAL_ARGS, ...args],
        cwd: repoPath,
        env: { ...runnerEnv, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
      });
    }
    // gh コマンドは変更なし(既に GH_TOKEN 環境変数で認証する。issue #21)。
    return runner({ command, args, cwd: repoPath, env: runnerEnv });
  }

  /** コマンド失敗時、コマンドライン(トークンを含みうる)は出さず分類のみを含めて例外を投げる。 */
  function assertSuccess(result: RunSubprocessResult, description: string): void {
    if (result.status !== 'success') {
      const detail =
        firstNonEmptyLine(result.stderr) ?? firstNonEmptyLine(result.stdout) ?? 'unknown error';
      throw new Error(
        `${description} failed (exitCode=${String(result.exitCode)}, signal=${String(result.signal)}): ${detail}`,
      );
    }
  }

  function requireBranch(): string {
    if (branchName === undefined) {
      throw new Error(
        'GitRepoPublisher.finalize() called before prepare() succeeded (no work branch); ' +
          'this indicates a sync-flow bug (src/sync.ts should always call prepare() first)',
      );
    }
    return branchName;
  }

  /**
   * design.md §5.7 手順1: `git fetch` → `base_branch` から作業ブランチを作成する(FR-19)。
   * `origin/<base_branch>` から分岐させる(ローカルの `base_branch` が古い可能性があるため、
   * fetch 直後の最新のリモート追跡ブランチを基点にする)。
   */
  async function prepare(): Promise<void> {
    branchName = `${BRANCH_PREFIX}${formatBranchTimestamp(now())}`;

    assertSuccess(await run('git', ['fetch', 'origin']), '"git fetch origin"');
    assertSuccess(
      await run('git', ['checkout', '-b', branchName, `origin/${gitConfig.base_branch}`]),
      `"git checkout -b ${branchName} origin/${gitConfig.base_branch}"`,
    );
  }

  /**
   * design.md §5.7 手順2: 規約パスへファイルを書き込み、保留リストへ積むだけ(状態 JSON は
   * 更新しない)。`article.artifactPath` は Git モードでは必須(`RenderedArticle` 型は
   * サービス非依存の任意フィールドだが、Git モードの Renderer は必ず設定する。
   * `src/publishers/render.ts` 参照)。
   */
  async function publish(article: RenderedArticle, prev: NoteState | null): Promise<PublishResult> {
    if (article.artifactPath === undefined) {
      throw new Error(
        `GitRepoPublisher.publish: note "${article.noteUuid}" has no artifactPath ` +
          '(git-mode Renderer must set one; design.md §8)',
      );
    }

    // `resolve`(`join` ではなく)を使う: `join` は第2引数が絶対パスに見えても連結して
    // 正規化するだけで実際には `repoPath` 配下に収めてしまい、絶対パスによる置き換え攻撃を
    // 見逃す。`resolve` は絶対パスの引数をそのまま採用する(POSIX の実際のパス解決と同じ
    // 挙動)ため、直後の `isPathWithinRoot` 検査が絶対パス・トラバーサルの両方を正しく
    // 検出できる(CodeRabbit review, PR #49)。
    const absolutePath = resolve(repoPath, article.artifactPath);
    // mkdir/writeFile の前に repo_path 配下であることを検証する。
    if (!isPathWithinRoot(repoPath, absolutePath)) {
      throw new Error(
        `GitRepoPublisher.publish: note "${article.noteUuid}" has an artifactPath that escapes ` +
          `repo_path (traversal or absolute path rejected): "${article.artifactPath}"`,
      );
    }
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, article.artifact, 'utf8');

    pending.push({ uuid: article.noteUuid, artifactPath: article.artifactPath });

    // Git モードでは remoteId は常に null(design.md §8)。PR の URL は finalize() の
    // PR 作成成功まで判明しないため、url は設定しない(サービス別 Publisher が必要なら
    // 独自に埋める。design.md §5.7 のサービス別表は本モジュールの範囲外)。
    return { result: prev === null ? 'created' : 'updated', remoteId: null };
  }

  /** 差分ゼロだった場合の後始末: 作業ブランチへ切り替えたまま残さず、破棄する(FR-22)。 */
  async function discardBranch(branch: string): Promise<void> {
    assertSuccess(
      await run('git', ['checkout', gitConfig.base_branch]),
      `"git checkout ${gitConfig.base_branch}"`,
    );
    assertSuccess(await run('git', ['branch', '-D', branch]), `"git branch -D ${branch}"`);
  }

  function buildCommitMessage(count: number): string {
    return `note2web: sync ${String(count)} note${count === 1 ? '' : 's'}`;
  }

  function buildPrBody(entries: readonly PendingEntry[]): string {
    const lines = entries.map((entry) => `- ${entry.artifactPath} (${entry.uuid})`);
    return ['Automated update by note2web sync.', '', ...lines].join('\n');
  }

  /**
   * design.md §5.7 手順3・4: 差分確認 → (差分ゼロならブランチ破棄で終了) → コミット・push・
   * PR 作成 → (auto_merge ならマージ)。戻り値の意味は `FinalizeOutcome`(`./types.ts`)参照。
   */
  async function finalize(): Promise<FinalizeOutcome> {
    const branch = requireBranch();

    if (pending.length === 0) {
      // publish() が一度も呼ばれなかった(変更ノートが無かった)。差分ゼロと同じ扱い。
      await discardBranch(branch);
      return { persist: false };
    }

    const paths = pending.map((entry) => entry.artifactPath);
    const statusResult = await run('git', ['status', '--porcelain', '--', ...paths]);
    assertSuccess(statusResult, '"git status --porcelain" (checking for changes)');

    if (statusResult.stdout.trim() === '') {
      // design.md §5.7 手順3「git status で差分ゼロなら、ブランチを削除して終了。コミットも
      // PR も作らない(FR-22)」。publish() が書いた内容が既にリポジトリの内容と一致していた
      // ケース(状態 JSON が失われた/未保存のまま再実行された等)。状態は確定しない
      // (PR が作られていないため。design.md §5.7 手順4の確定基準は「PR 作成成功」)。
      logger?.warn({
        message:
          `finalize: no changes detected across ${String(pending.length)} pending note(s); ` +
          `discarding work branch "${branch}" without commit/PR (design.md §5.7 FR-22)`,
      });
      await discardBranch(branch);
      return { persist: false };
    }

    assertSuccess(await run('git', ['add', '--', ...paths]), '"git add"');
    assertSuccess(
      await run('git', ['commit', '-m', buildCommitMessage(pending.length)]),
      '"git commit"',
    );

    // push / gh pr create の失敗はここで例外として投げる(design.md §5.7 手順4「push や
    // PR 作成に失敗した場合は何も確定せず、全ノートが次回実行で再試行される」)。
    // sync フロー(src/sync.ts)が catch し、flush() を呼ばずに実行を失敗として扱う。
    assertSuccess(
      await run('git', ['push', '-u', 'origin', branch]),
      `"git push -u origin ${branch}"`,
    );

    const prTitle = buildCommitMessage(pending.length);
    const prResult = await run('gh', [
      'pr',
      'create',
      '--base',
      gitConfig.base_branch,
      '--head',
      branch,
      '--title',
      prTitle,
      '--body',
      buildPrBody(pending),
    ]);
    assertSuccess(prResult, '"gh pr create"');

    if (gitConfig.auto_merge !== true) {
      // PR 作成成功時点で確定する(design.md §5.7 手順4)。
      return { persist: true };
    }

    // `gh pr create` は成功時、stdout の先頭行に作成した PR の URL を出力する。カレント
    // ブランチから対象 PR を暗黙解決させず、明示的に URL を渡す(CodeRabbit review, PR #49。
    // 曖昧な解決に頼らないほうが安全で、他コマンドの失敗調査時にもログの手掛かりが残る)。
    // URL が取れない(想定外の出力形式)場合でも、カレントブランチからの暗黙解決に
    // フォールバックする。
    const prUrl = firstNonEmptyLine(prResult.stdout);
    const mergeArgs = [
      'pr',
      'merge',
      ...(prUrl !== undefined ? [prUrl] : []),
      '--merge',
      '--delete-branch',
    ];
    const mergeResult = await run('gh', mergeArgs);
    if (mergeResult.status !== 'success') {
      // design.md §10「`gh pr merge` 失敗(保護ルール等) → PR は残し、実行は失敗として報告」。
      // issue #21「auto_merge のマージ失敗時は状態保存済みのまま失敗扱い」: PR は既に作成
      // 済みのため persist: true のまま、failed: true で実行全体を失敗として報告する。
      const detail =
        firstNonEmptyLine(mergeResult.stderr) ??
        firstNonEmptyLine(mergeResult.stdout) ??
        'unknown error';
      return {
        persist: true,
        failed: true,
        reason: `"gh pr merge --merge --delete-branch" failed, PR left open for manual merge: ${detail}`,
      };
    }

    return { persist: true };
  }

  return { prepare, publish, finalize };
}
