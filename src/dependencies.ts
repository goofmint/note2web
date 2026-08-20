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
 *     `exporter.parser_path` 配下の upstream `lib/`(issue #72。note2web は自前の
 *     `ruby/note2web_export.rb` を起動し、そこから upstream の `lib/` だけを require
 *     するため、以前チェックしていた `notes_cloud_ripper.rb` エントリポイントの代わりに
 *     `lib/AppleNoteStore.rb` の実在を見る)・note2web 自身の `ruby/note2web_export.rb`
 *     が同梱されていること。加えて issue #67 で、
 *     `exporter.launcher`(既定 `'bundle'`)が `'bundle'` のときのみ `bundle` コマンドと
 *     gem の準備状況(`bundle check` を `parser_path` で実行)を検証する——launchd の
 *     最小限の環境では `bundle exec ruby` の前提(Bundler・gem のインストール)が
 *     欠けたまま実行され、`apple_cloud_notes_parser failed` としか分からない失敗に
 *     なりがちだったため(issue #67 の根本原因)
 *   - zenn/hugo/jekyll(Git モード): `git` / `gh` コマンド、`GH_TOKEN` 環境変数
 *     (`GH_TOKEN` は design.md §5.7 が定める固定名で、設定スキーマの `*_env` には
 *     現れないため、config.ts の汎用チェックではカバーされない)
 *   - qiita: 上記の共通チェックのみ(`QIITA_TOKEN` 相当は config.ts が既にチェック済み。
 *     issue #82 で qiita-cli サブプロセス方式(`npx --no-install qiita` 起動・CLI の
 *     ローカル解決確認・Node engine 確認)を廃止し、dev.to と同じ「HTTP を直叩きする API
 *     モード」へ移行したため、この節にあった `node`/`npx` コマンド確認・
 *     `@qiita/qiita-cli` の解決確認・engine 確認は不要になった)
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
import { join } from 'node:path';
import type { Config } from './config.js';
import { PRECONDITION_FAILURE } from './exit-codes.js';
import {
  DEFAULT_NOTES_CONTAINER,
  DEFAULT_PARSER_PATH,
  NOTE2WEB_EXPORT_SCRIPT_PATH,
} from './exporter/apple-notes.js';
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
  /**
   * ファイル存在確認の注入点(parser 本体・Notes コンテナディレクトリの実在確認に使う。
   * issue #69)。既定は実 `fs.access(path, constants.F_OK)`。
   */
  fileExistsFn?: (path: string) => Promise<boolean>;
  /**
   * ファイル読み取り可否確認の注入点(`NoteStore.sqlite` の読み取り可否確認に使う。
   * issue #69)。既定は実 `fs.access(path, constants.R_OK)`。
   */
  fileReadableFn?: (path: string) => Promise<boolean>;
  /** 環境変数の参照元。既定は `process.env`。 */
  env?: NodeJS.ProcessEnv;
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

/** `fileReadableFn` の既定実装(issue #69)。読み取り権限(`R_OK`)まで確認する。 */
async function defaultFileReadable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
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
    fileReadableFn = defaultFileReadable,
    env = process.env,
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
        '(required by note2web_export.rb / apple_cloud_notes_parser, design.md §5.2)',
    });
  }

  // parser 本体の実在チェック(issue #72): 以前は upstream の `notes_cloud_ripper.rb`
  // (エントリポイント)自体の実在を確認していたが、note2web は自前の
  // `ruby/note2web_export.rb` を起動し、そこから upstream の `lib/` だけを requireするため
  // (`src/exporter/apple-notes.ts` runExport)、確認すべき対象も変わった:
  //   (a) `exporter.parser_path` 配下に upstream の `lib/` ディレクトリ(の代表として
  //       `lib/AppleNoteStore.rb`)が存在すること
  //   (b) note2web に同梱される `ruby/note2web_export.rb` 自体が実在すること
  //       (npm パッケージとして正しく配布されていることの確認も兼ねる)
  const parserPath = expandHome(config.exporter?.parser_path ?? DEFAULT_PARSER_PATH);
  const parserLibEntryPoint = join(parserPath, 'lib', 'AppleNoteStore.rb');
  // parser 本体の実在チェックの結果を保持しておく。存在しない場合は後段の
  // `bundle check`(下記)を実行しない — parser_path が誤っている状態で
  // `bundle check` を parserPath 配下で実行しても意味のある結果にならず、
  // 本来の原因(parser_path 設定)を覆い隠す「bundle install してください」という
  // 誤誘導のメッセージを追加してしまうため。
  const parserEntryPointExists = await fileExistsFn(parserLibEntryPoint);
  if (!parserEntryPointExists) {
    problems.push({
      message:
        `apple_cloud_notes_parser lib/ not found: ${parserLibEntryPoint} ` +
        '(check exporter.parser_path; expected an external clone of ' +
        'https://github.com/threeplanetssoftware/apple_cloud_notes_parser with its Ruby ' +
        'dependencies already set up there)',
    });
  }

  const note2webScriptExists = await fileExistsFn(NOTE2WEB_EXPORT_SCRIPT_PATH);
  if (!note2webScriptExists) {
    problems.push({
      message:
        `note2web's own export script not found: ${NOTE2WEB_EXPORT_SCRIPT_PATH} ` +
        '(this indicates a broken/incomplete note2web installation, not a user configuration issue)',
    });
  }

  // Notes コンテナディレクトリ / NoteStore.sqlite の事前チェック(issue #69 問題2)。
  // フルディスクアクセス未許可・Notes.app が開いたままで WAL 未チェックポイント・macOS の
  // バージョン間でのスキーマ不一致といった状況では、parser の実行が
  // `no such table: ZACCOUNT: (SQLite3::SQLException)` という原因の分かりにくいエラーで
  // 失敗しがちだった。parser を実際に起動する前にコンテナディレクトリと NoteStore.sqlite の
  // 存在・読み取り可否を確認し、最も疑わしい原因(フルディスクアクセス)へ早期に誘導する
  // (`src/exporter/apple-notes.ts` の `runExport` 側にも、実際に parser がこの種のエラーで
  // 失敗した場合の同種のヒントを追加している。どちらも自動修復は行わず、案内のみ)。
  const notesContainer = expandHome(config.exporter?.notes_container ?? DEFAULT_NOTES_CONTAINER);
  const noteStorePath = join(notesContainer, 'NoteStore.sqlite');
  const notesContainerExists = await fileExistsFn(notesContainer);
  if (!notesContainerExists) {
    problems.push({
      message:
        `Apple Notes container directory not found: ${notesContainer} ` +
        '(check exporter.notes_container)',
    });
  } else if (!(await fileReadableFn(noteStorePath))) {
    problems.push({
      message:
        `Apple Notes database not found or not readable: ${noteStorePath}; ` +
        'this most likely means Full Disk Access (フルディスクアクセス) has not been granted ' +
        'to the process executing note2web (the Terminal app for interactive runs, or the ' +
        'launchd/cron execution context itself for unattended runs) — see the README ' +
        'troubleshooting section for how to grant it',
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
    } else if (parserEntryPointExists) {
      // parser_path が有効なときだけ `bundle check` を実行する(上記の parser 本体
      // 実在チェック参照)。parser_path が無効な場合は、上で既に parser_path の
      // 問題を報告済みなので、ここでの二重報告(かつ誤誘導)を避ける。
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
      // issue #82: qiita-cli サブプロセス方式(node/npx コマンド確認・
      // @qiita/qiita-cli のローカル解決確認・Node engine 確認)を廃止し、dev.to と同じ
      // 「HTTP を直叩きする API モード」へ移行したため、追加のチェックは無い。
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
