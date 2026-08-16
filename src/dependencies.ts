/**
 * サービス別依存チェック(design.md §6「依存チェック(手順2)の対象は service と公開モードで
 * 決まる。不要な依存は要求しない」の表)。
 *
 * 次の依存は `src/config.ts`(`loadConfig`)が `*_env` キーの存在チェックとして既に
 * 検証済みであり、本モジュールでは再チェックしない:
 *   - R2 / S3 の認証環境変数(`assets.access_key_id_env` / `secret_access_key_env`。
 *     全サービス共通で `assets` ブロックは必須)
 *   - `QIITA_TOKEN` 相当(`qiita.token_env`)
 *   - `DEVTO_API_KEY` 相当(`devto.api_key_env`)
 *   - `HATENA_API_KEY` 相当(`hatena.api_key_env`)
 *
 * 本モジュールが追加でチェックするのは、config スキーマに現れない依存
 * (コマンドの実在・`GH_TOKEN` のような固定名の環境変数・parser 本体の実在)のみ:
 *   - 共通: `ruby` コマンド・そのバージョン(`ruby -v` を実行し >= 3.0 を要求)、
 *     `exporter.parser_path` 配下の `notes_cloud_ripper.rb`。加えて issue #67 で、
 *     `exporter.launcher`(既定 `'bundle'`)が `'bundle'` のときのみ `bundle` コマンドと
 *     gem の準備状況(`bundle check` を `parser_path` で実行)を検証する——launchd の
 *     最小限の環境では `bundle exec ruby` の前提(Bundler・gem のインストール)が
 *     欠けたまま実行され、`apple_cloud_notes_parser failed` としか分からない失敗に
 *     なりがちだったため(issue #67 の根本原因)
 *   - zenn/hugo/jekyll(Git モード): `git` / `gh` コマンド、`GH_TOKEN` 環境変数
 *     (`GH_TOKEN` は design.md §5.7 が定める固定名で、設定スキーマの `*_env` には
 *     現れないため、config.ts の汎用チェックではカバーされない)
 *   - qiita: `node` / `npx`(`@qiita/qiita-cli` を `npx --no-install qiita` 経由で呼ぶための
 *     実行手段)に加え、T-21(issue #26)で以下2点を追加した(design.md §5.7 セキュリティ
 *     制約・§6 依存表「`@qiita/qiita-cli`… 現時点では未導入・依存チェック未実装 = T-21 で
 *     実装する契約」):
 *       (a) `@qiita/qiita-cli` が note2web 自身の依存として実際にローカル解決できること
 *           (`package.json` の `dependencies` に固定バージョンで追加し `npm install` 済み
 *           であることの検証。`npx --no-install qiita` はこれが無いと失敗するため、
 *           `sync`/`doctor` の実行前に検出する)
 *       (b) 実行中の Node.js が qiita-cli の要求する engine を満たすこと(インストール済み
 *           パッケージの `engines.node` 宣言を優先し、取得できない場合は `>= 20` の下限)
 *   - devto: 上記の共通チェックのみ(`DEVTO_API_KEY` は config.ts が既にチェック済み)
 *   - note: `noet` コマンド(design.md は「認証設定」も要求するが、現行の設定スキーマ
 *     (`src/config.ts` の `noteSchema`)は `workspace` のみで認証用の `*_env` を
 *     持たない — §13-4 の実装時確認課題であり、T-14 の時点では追加できるチェックが無い)
 *   - hatena: 上記の共通チェックのみ(`HATENA_API_KEY` は config.ts が既にチェック済み)
 *
 * `gh auth status` の実行・対象リポジトリへの push/PR 作成権限確認は本モジュールでは
 * 行わない(`GH_TOKEN` の存在確認という副作用の無いチェックのみをここで扱う)。
 * これらはネットワーク呼び出しを伴うため `src/git-auth.ts`
 * (`checkGitModeAuthAndPermission`)へ分離してあり、`doctor`(design.md §5.1、T-15。
 * `src/doctor.ts`)と `sync`(T-16。`src/sync.ts` の `runSync`)の両方が、本モジュールの
 * チェックとは別の手順としてそれを呼び出す(design.md §5.7「`doctor` / `sync` 冒頭で
 * `GH_TOKEN` の存在・`gh auth status`・…権限を確認」は両コマンドでの実施を要求している)。
 */

import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Config } from './config.js';
import { PRECONDITION_FAILURE } from './exit-codes.js';
import { DEFAULT_PARSER_PATH } from './exporter/apple-notes.js';
import { expandHome } from './paths.js';
import {
  commandExists,
  firstNonEmptyLine,
  runSubprocess,
  type RunSubprocessOptions,
  type RunSubprocessResult,
} from './subprocess.js';

/**
 * `ruby -v` / `bundle check` の実行を差し替えるための最小限の関数シグネチャ(issue #67)。
 * `src/exporter/apple-notes.ts` の `SubprocessRunner` とちょうど同じ形(`RunSubprocessOptions`
 * → `Promise<RunSubprocessResult>`)。本番では `runSubprocess` をそのまま既定値として渡せ、
 * テストでは差し替えられるようにする。
 */
export type DependencySubprocessRunner = (
  options: RunSubprocessOptions,
) => Promise<RunSubprocessResult>;

/**
 * apple_cloud_notes_parser(notes_cloud_ripper.rb)を `bundle exec` で起動する前提として
 * 要求する Ruby の最低バージョン(issue #67)。`>= 3.0` は design.md 未記載の実務上の下限で、
 * 古い Ruby では Bundler / 依存 gem が要求する言語機能が欠けることがあるための予防的な下限。
 */
const RUBY_MIN_VERSION: readonly [number, number, number] = [3, 0, 0];

/**
 * qiita-cli(`@qiita/qiita-cli`)が要求する Node.js の最低メジャーバージョンの下限
 * (design.md §6)。実際の要求は、インストール済みパッケージの `engines.node` 宣言
 * (`defaultQiitaCliEnginesNode`)を優先して用い、宣言が取得できない・単純な `>=X.Y.Z`
 * 形式でない場合のみこの値へフォールバックする(固定バージョンの更新に検査が追随する
 * ようにするため。例: v1.10.0 の宣言は `>=22.22.1` で、この下限 20 より厳しい)。
 */
const QIITA_CLI_MIN_NODE_MAJOR = 20;

/**
 * インストール済み `@qiita/qiita-cli` の `package.json` から `engines.node` 宣言を読む
 * 既定実装。解決できない(未インストール等)場合や宣言が無い場合は `undefined` を返し、
 * 呼び出し側は `QIITA_CLI_MIN_NODE_MAJOR` の下限チェックへフォールバックする。
 */
function defaultQiitaCliEnginesNode(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('@qiita/qiita-cli/package.json') as {
      engines?: { node?: unknown };
    };
    return typeof pkg.engines?.node === 'string' ? pkg.engines.node : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `>=A.B.C`(A.B / A のみも可)という単純な engines 範囲文字列から最低バージョンの
 * 3つ組を取り出す。qiita-cli の宣言はこの形式(`>=22.22.1`)。複合範囲(`||` や上限付き)
 * には対応せず `undefined` を返す(その場合はメジャー下限チェックへフォールバック)。
 */
function parseSimpleMinimumEngineRange(range: string): [number, number, number] | undefined {
  const match = /^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(range.trim());
  if (match === null || match[1] === undefined) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2] ?? '0'), Number(match[3] ?? '0')];
}

/** `v22.22.2` のような Node.js バージョン文字列を [major, minor, patch] に分解する。 */
function parseNodeVersionTriple(version: string): [number, number, number] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    throw new Error(
      `internal error: could not parse Node.js version string: ${JSON.stringify(version)}`,
    );
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * `ruby -v` の出力(例: `"ruby 3.2.2p53 (2023-03-30 revision e51014f9c0) [x86_64-darwin23]"`)
 * から `[major, minor, patch]` を取り出す(issue #67)。先頭付近に `ruby X.Y.Z` があれば
 * 十分で、`p53` のようなパッチレベル接尾辞は無視する。マッチしない場合は `undefined`。
 */
function parseRubyVersionTriple(output: string): [number, number, number] | undefined {
  const match = /ruby\s+(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** バージョン3つ組の辞書式比較(a < b なら負、等しければ 0、a > b なら正)。 */
function compareVersionTriples(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * `@qiita/qiita-cli` が note2web 自身の依存としてローカル解決できるかどうかの既定実装
 * (design.md §5.7 セキュリティ制約「`@qiita/qiita-cli` は `dependencies` に固定バージョンで
 * 追加し… `npx --no-install` で解決」)。`createRequire(import.meta.url)` は本モジュール
 * (`src/dependencies.ts`)自身の位置から `node_modules` 解決を行うため、note2web パッケージの
 * 依存として実際にインストールされているかを問う——`npx --no-install` が実行時に行う解決と
 * 同じ前提(ローカル `node_modules` に存在すること)を、コマンドを実行せずに事前確認できる。
 */
function defaultQiitaCliResolvable(): boolean {
  try {
    createRequire(import.meta.url).resolve('@qiita/qiita-cli/package.json');
    return true;
  } catch {
    return false;
  }
}

/**
 * `v22.22.2` のような Node.js バージョン文字列からメジャーバージョンの整数を取り出す。
 * `process.version` は常にこの形式(先頭 `v` 付き)のため、パース不能は内部矛盾として例外を
 * 投げる(呼び出し側の注入テストが不正な文字列を渡した場合の早期検出も兼ねる)。
 */
function parseNodeMajorVersion(version: string): number {
  const match = /^v?(\d+)\./.exec(version);
  if (match === null || match[1] === undefined) {
    throw new Error(
      `internal error: could not parse Node.js version string: ${JSON.stringify(version)}`,
    );
  }
  return Number(match[1]);
}

/** 検出された依存不足1件。design.md §5.1「不足内容を呼び出し側へ返す」に対応する。 */
export interface DependencyProblem {
  message: string;
}

/**
 * 依存チェックに失敗したことを表すエラー(design.md §10「設定不正・環境変数未設定・
 * 依存 CLI 欠如 → 何も配信せず exit 2」)。`src/lock.ts` の `LockError` /
 * `src/state/store.ts` の `StateValidationError` と同じ `exitCode` プロパティ規約に従う。
 */
export class DependencyCheckError extends Error {
  readonly exitCode = PRECONDITION_FAILURE;
  readonly problems: DependencyProblem[];

  constructor(problems: DependencyProblem[]) {
    super(problems.map((problem) => problem.message).join('; '));
    this.name = 'DependencyCheckError';
    this.problems = problems;
  }
}

/** `checkDependencies` の挙動を差し替えるためのオプション(テスト用の注入点)。 */
export interface CheckDependenciesOptions {
  /** コマンド存在確認の注入点。既定は `src/subprocess.ts` の `commandExists`。 */
  commandExistsFn?: (command: string) => Promise<boolean>;
  /** ファイル存在確認の注入点(parser 本体の実在確認に使う)。既定は実 `fs.access`。 */
  fileExistsFn?: (path: string) => Promise<boolean>;
  /** 環境変数の参照元。既定は `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /**
   * `@qiita/qiita-cli` がローカル解決できるかどうかの注入点(テスト用)。既定は
   * `defaultQiitaCliResolvable`(`createRequire(import.meta.url).resolve` の成否)。
   */
  qiitaCliResolvableFn?: () => boolean;
  /** 実行中の Node.js バージョン文字列の注入点(テスト用)。既定は `process.version`。 */
  nodeVersionFn?: () => string;
  /**
   * インストール済み `@qiita/qiita-cli` の `engines.node` 宣言の注入点(テスト用)。
   * 既定は `defaultQiitaCliEnginesNode`(解決不能・宣言なしは `undefined`)。
   */
  qiitaCliEnginesFn?: () => string | undefined;
  /**
   * `ruby -v` / `bundle check` の実行を差し替える注入点(テスト用、issue #67)。
   * 既定は `src/subprocess.ts` の `runSubprocess`。
   */
  runSubprocessFn?: DependencySubprocessRunner;
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * design.md §6 の依存表に基づき、`config.service` に必要な依存だけを検証する
 * (「不要な依存は要求しない」)。不足があれば `DependencyCheckError` を投げる
 * (欠如1件につき `DependencyProblem` 1件。全件をまとめて報告し、1件見つかった時点で
 * 打ち切らない——利用者が1回の実行で複数の不足に気づけるようにするため)。
 */
export async function checkDependencies(
  config: Config,
  options: CheckDependenciesOptions = {},
): Promise<void> {
  const {
    commandExistsFn = commandExists,
    fileExistsFn = defaultFileExists,
    env = process.env,
    qiitaCliResolvableFn = defaultQiitaCliResolvable,
    nodeVersionFn = () => process.version,
    qiitaCliEnginesFn = defaultQiitaCliEnginesNode,
    runSubprocessFn = runSubprocess,
  } = options;

  const problems: DependencyProblem[] = [];

  const requireCommand = async (command: string, context: string): Promise<void> => {
    if (!(await commandExistsFn(command))) {
      problems.push({
        message: `required command "${command}" was not found on PATH (${context})`,
      });
    }
  };

  // 共通(design.md §6 依存表「共通」行。R2/S3 認証環境変数は config.ts が既に検証済み)。
  const rubyExists = await commandExistsFn('ruby');
  if (!rubyExists) {
    problems.push({
      message:
        'required command "ruby" was not found on PATH ' +
        '(required by apple_cloud_notes_parser / notes_cloud_ripper.rb, design.md §5.2)',
    });
  }

  const parserPath = expandHome(config.exporter?.parser_path ?? DEFAULT_PARSER_PATH);
  const parserEntryPoint = join(parserPath, 'notes_cloud_ripper.rb');
  if (!(await fileExistsFn(parserEntryPoint))) {
    problems.push({
      message: `apple_cloud_notes_parser entry point not found: ${parserEntryPoint} (check exporter.parser_path)`,
    });
  }

  // Ruby バージョンチェック(issue #67)。`ruby` コマンド自体が無い場合は上で既に問題を
  // 報告済みのため、ここでは実行を試みない(二重報告を避ける)。
  if (rubyExists) {
    const versionResult = await runSubprocessFn({
      command: 'ruby',
      args: ['-v'],
      timeoutMs: 10_000,
    });
    if (versionResult.status !== 'success') {
      const detail =
        firstNonEmptyLine(versionResult.stderr) ??
        firstNonEmptyLine(versionResult.stdout) ??
        'unknown error';
      problems.push({
        message: `failed to run "ruby -v" to determine the Ruby version: ${detail}`,
      });
    } else {
      const rubyVersion = parseRubyVersionTriple(versionResult.stdout);
      if (rubyVersion === undefined) {
        problems.push({
          message:
            'could not parse the Ruby version from "ruby -v" output: ' +
            (firstNonEmptyLine(versionResult.stdout) ?? '(empty output)'),
        });
      } else if (compareVersionTriples(rubyVersion, RUBY_MIN_VERSION) < 0) {
        problems.push({
          message:
            `Ruby ${rubyVersion.join('.')} is older than the required minimum ` +
            `(>=${RUBY_MIN_VERSION.join('.')}) for apple_cloud_notes_parser (notes_cloud_ripper.rb)`,
        });
      }
    }
  }

  // gem 起動方法の依存(issue #67)。既定 'bundle' のときのみ `bundle` コマンドと
  // gem の準備状況(`bundle check`)を検証する。'ruby' 起動を選んでいれば Bundler を
  // 経由しないため、これらのチェックは行わない。
  const launcher = config.exporter?.launcher ?? 'bundle';
  if (launcher === 'bundle') {
    const bundleExists = await commandExistsFn('bundle');
    if (!bundleExists) {
      problems.push({
        message:
          'required command "bundle" was not found on PATH ' +
          '(required by exporter.launcher "bundle" (default) to run ' +
          '"bundle exec ruby notes_cloud_ripper.rb"; install it with `gem install bundler`, ' +
          'or set exporter.launcher: ruby to bypass Bundler)',
      });
    } else {
      const bundleCheckResult = await runSubprocessFn({
        command: 'bundle',
        args: ['check'],
        cwd: parserPath,
        timeoutMs: 30_000,
      });
      if (bundleCheckResult.status !== 'success') {
        const detail =
          firstNonEmptyLine(bundleCheckResult.stderr) ??
          firstNonEmptyLine(bundleCheckResult.stdout) ??
          'unknown error';
        problems.push({
          message:
            `apple_cloud_notes_parser's gems are not installed ("bundle check" failed in ` +
            `${parserPath}); run "bundle install" there before syncing: ${detail}`,
        });
      }
    }
  }

  switch (config.service) {
    case 'zenn':
    case 'hugo':
    case 'jekyll': {
      await requireCommand('git', 'git mode, design.md §5.7 GitRepoPublisher');
      await requireCommand('gh', 'git mode, design.md §5.7 GitRepoPublisher');
      if (env.GH_TOKEN === undefined || env.GH_TOKEN === '') {
        problems.push({
          message:
            'environment variable "GH_TOKEN" is not set (required for gh authentication in git mode, design.md §5.7)',
        });
      }
      break;
    }
    case 'qiita': {
      await requireCommand(
        'node',
        'required to run @qiita/qiita-cli, design.md §5.7 QiitaPublisher',
      );
      await requireCommand(
        'npx',
        'used to invoke @qiita/qiita-cli via `npx --no-install`, design.md §5.7 QiitaPublisher',
      );
      // design.md §5.7 セキュリティ制約: `npx --no-install qiita` はローカル解決できる
      // `@qiita/qiita-cli` が無いと失敗する(素の `npx qiita` は禁止のため、未導入時に
      // フォールバックしてはならない)。T-21(issue #26)で追加。
      if (!qiitaCliResolvableFn()) {
        problems.push({
          message:
            '"@qiita/qiita-cli" is not resolvable from note2web\'s own dependencies (expected a ' +
            'pinned exact version in package.json "dependencies", installed via `npm install`; ' +
            'design.md §5.7 forbids falling back to bare `npx qiita`, which would resolve an ' +
            'unrelated npm package named "qiita")',
        });
      }
      // engine 検査は、インストール済みパッケージの `engines.node` 宣言(例: v1.10.0 は
      // `>=22.22.1`)を優先する。宣言が取得できない・単純な `>=X.Y.Z` 形式でない場合のみ
      // design.md §6 の下限(メジャー >= 20)へフォールバックする。
      const nodeVersion = nodeVersionFn();
      const declaredRange = qiitaCliEnginesFn();
      const declaredMinimum =
        declaredRange !== undefined ? parseSimpleMinimumEngineRange(declaredRange) : undefined;
      if (declaredMinimum !== undefined && declaredRange !== undefined) {
        if (compareVersionTriples(parseNodeVersionTriple(nodeVersion), declaredMinimum) < 0) {
          problems.push({
            message:
              `Node.js ${nodeVersion} does not satisfy @qiita/qiita-cli's declared engine ` +
              `requirement "${declaredRange}"; upgrade Node.js (design.md §6)`,
          });
        }
      } else {
        const nodeMajor = parseNodeMajorVersion(nodeVersion);
        if (nodeMajor < QIITA_CLI_MIN_NODE_MAJOR) {
          problems.push({
            message:
              `Node.js ${nodeVersion} does not satisfy @qiita/qiita-cli's engine requirement ` +
              `(>=${String(QIITA_CLI_MIN_NODE_MAJOR)}); upgrade Node.js (design.md §6)`,
          });
        }
      }
      // QIITA_TOKEN(config.qiita.token_env が指す環境変数)は config.ts が既に検証済み。
      break;
    }
    case 'devto': {
      // DEVTO_API_KEY(config.devto.api_key_env が指す環境変数)のみ(API 直接。CLI 不要)。
      // config.ts が既に検証済みのため、本モジュールで追加するチェックは無い。
      break;
    }
    case 'note': {
      await requireCommand('noet', 'design.md §5.7 NotePublisher');
      // 認証設定の具体的なチェックは §13-4 の実装時確認課題(現行スキーマに *_env が無い)。
      break;
    }
    case 'hatena': {
      // HATENA_API_KEY(config.hatena.api_key_env が指す環境変数)のみ。
      // config.ts が既に検証済みのため、本モジュールで追加するチェックは無い。
      break;
    }
    default: {
      // 網羅性チェック(CodeRabbit review, PR #47 nitpick): `config.service` に
      // `src/config.ts` の `SERVICES` へ新しいサービスが追加されたのに、ここへの
      // 対応が漏れた場合にコンパイルエラーとして検出する。実行時にも到達しないはず
      // だが、型が壊れた呼び出し元(any 経由等)からの防御として例外を投げる。
      const exhaustiveCheck: never = config.service;
      throw new Error(
        `internal error: unhandled service "${String(exhaustiveCheck)}" in checkDependencies`,
      );
    }
  }

  if (problems.length > 0) {
    throw new DependencyCheckError(problems);
  }
}
