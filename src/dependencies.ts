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
 *   - 共通: `ruby` コマンド、`exporter.parser_path` 配下の `notes_cloud_ripper.rb`
 *   - zenn/hugo/jekyll(Git モード): `git` / `gh` コマンド、`GH_TOKEN` 環境変数
 *     (`GH_TOKEN` は design.md §5.7 が定める固定名で、設定スキーマの `*_env` には
 *     現れないため、config.ts の汎用チェックではカバーされない)
 *   - qiita: `node` / `npx`(`@qiita/qiita-cli` を `npx qiita` 経由で呼ぶための実行手段。
 *     design.md §13-3 は無人実行の詳細確認を残課題としており、ここでは実行手段の
 *     存在確認にとどめる)
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
import { DEFAULT_PARSER_PATH } from './exporter/apple-notes.js';
import { expandHome } from './paths.js';
import { commandExists } from './subprocess.js';

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
  await requireCommand('ruby', 'required by apple_cloud_notes_parser, design.md §5.2');

  const parserPath = expandHome(config.exporter?.parser_path ?? DEFAULT_PARSER_PATH);
  const parserEntryPoint = join(parserPath, 'notes_cloud_ripper.rb');
  if (!(await fileExistsFn(parserEntryPoint))) {
    problems.push({
      message: `apple_cloud_notes_parser entry point not found: ${parserEntryPoint} (check exporter.parser_path)`,
    });
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
      await requireCommand('npx', 'used to invoke @qiita/qiita-cli, design.md §5.7 QiitaPublisher');
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
