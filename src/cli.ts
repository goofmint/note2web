#!/usr/bin/env node

import { access, constants as fsConstants } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createS3UploaderClient } from './assets/uploader.js';
import { ConfigValidationError, loadConfig } from './config.js';
import { DoctorError, runDoctorChecks } from './doctor.js';
import { loadEnvFile } from './env-file.js';
import { PRECONDITION_FAILURE, SUCCESS } from './exit-codes.js';
import { InitError, runInit } from './init.js';
import { createLogger } from './logger.js';
import { expandHome } from './paths.js';
import {
  createPublisher,
  PublisherNotImplementedError,
  resolveRenderer,
} from './publishers/factory.js';
import { resolveStatePath } from './state/derive.js';
import { runSync } from './sync.js';

/** 許可されたサブコマンド(design.md §5.1。`init` は T-29・issue #61 で追加)。 */
const SUBCOMMANDS = ['sync', 'doctor', 'init'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(value: string | undefined): value is Subcommand {
  return value !== undefined && (SUBCOMMANDS as readonly string[]).includes(value);
}

const USAGE = [
  'Usage: note2web <sync|doctor|init> --config <path> [--env-file <path>]',
  '',
  '  sync    Export, transform, and publish notes',
  '  doctor  Check dependencies, environment, and configuration only',
  '  init    Interactively generate a configuration file and launchd files',
  '',
  'Options:',
  '  --config <path>    Path to the configuration YAML file',
  '                      (required for sync/doctor; optional for init, which',
  '                      picks a default path from the selected service)',
  '  --env-file <path>  Path to an env file to load before checking/using',
  '                      environment variables (sync/doctor only; ignored by',
  '                      init). Defaults to "env" next to the config file.',
  '                      Names already set in the environment always win.',
].join('\n');

/** `runCli` の結果。プロセスを直接終了させず、呼び出し側(main / テスト)が扱えるようにする。 */
export interface CliResult {
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

/**
 * 引数解析・前提条件チェックの本体。`process.exit` を呼ばない純粋寄りの関数として切り出し、
 * vitest から直接テストできるようにする(プロセス起動を伴う `main` とは分離)。
 */
export async function runCli(argv: string[]): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const [subcommandArg, ...rest] = argv;

  if (!isSubcommand(subcommandArg)) {
    stderr.push(USAGE);
    return { exitCode: PRECONDITION_FAILURE, stdout, stderr };
  }
  const subcommand: Subcommand = subcommandArg;

  let configPath: string | undefined;
  let envFileArg: string | undefined;
  try {
    const { values } = parseArgs({
      args: rest,
      options: {
        config: { type: 'string' },
        'env-file': { type: 'string' },
      },
      allowPositionals: false,
    });
    configPath = values.config;
    envFileArg = values['env-file'];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.push(`note2web: failed to parse arguments: ${message}`);
    return { exitCode: PRECONDITION_FAILURE, stdout, stderr };
  }

  if (subcommand === 'init') {
    // T-29(issue #61)。`init` は他の2サブコマンドと異なり `--config` が任意
    // (サービス選択後に既定パス `~/.config/note2web/<service>.yaml` を決める)であり、
    // 生成対象のファイルがまだ存在しない・スキーマを満たしていないのが通常のため
    // `loadConfig` は意図的に呼ばない。対話プロンプト自体の出力は既定の `promptFn`
    // (実 stdin/stdout の readline)を経由し、ここでバッファする `stdout`/`stderr` には
    // 載らない——最終的な成功サマリのみが `stdout` へ積まれる。
    try {
      const result = await runInit({ configPath });
      stdout.push(...result.summary);
      return { exitCode: SUCCESS, stdout, stderr };
    } catch (error) {
      if (error instanceof InitError) {
        // doctor と同じ整形規約(`note2web: <subcommand>: <message>`)。
        for (const problem of error.problems) {
          stderr.push(`note2web: init: ${problem.message}`);
        }
        return { exitCode: error.exitCode, stdout, stderr };
      }
      throw error;
    }
  }

  if (configPath === undefined) {
    stderr.push('note2web: missing required option --config <path>');
    return { exitCode: PRECONDITION_FAILURE, stdout, stderr };
  }

  // env ファイル読み込み(issue #69「doctor と sync-under-launchd とで検証環境が一致しない」)。
  // launchd(issue #71 以降は `node` を直接起動し、`EnvironmentVariables` には非秘匿の
  // `PATH` しか置かない)経由の実行では、秘匿情報を含む環境変数は plist ではなくこの
  // CLI 自身の起動時読み込みでしか渡す手段が無い。しかし `loadConfig` の `*_env` チェック・
  // `checkDependencies` の `GH_TOKEN` 等はかつて env ファイルを一切読んでおらず、対話シェル
  // から直接 `doctor`/`sync` を実行した場合に「環境変数が未設定」という偽陽性を報告して
  // いた。ここで doctor/sync 共通に、設定ファイルと同じディレクトリの既定パス(`env`。
  // `--env-file` で上書き可能)を読み込み、**まだ `process.env` に無い名前だけ**を補う
  // ——既存のシェル環境変数は常に優先する。値は一切ログに出さない(`src/env-file.ts`
  // 参照)。`init` は生成物を書き出すだけのサブコマンドで、この時点では既に `return` 済みの
  // ため、ここへは到達しない(`init` の未設定環境変数の案内は意図的に現在のシェルの状態を
  // そのまま反映する)。
  const expandedConfigPath = expandHome(configPath);
  const envFilePath =
    envFileArg !== undefined ? expandHome(envFileArg) : join(dirname(expandedConfigPath), 'env');

  if (envFileArg !== undefined) {
    // `--env-file` は利用者が明示的に指定したパスのため、既定パスと異なり
    // 「存在しなければ黙って何もしない」では利用者の意図(このファイルを読ませたい)を
    // 裏切ってしまう。存在しない場合は設定エラーとして扱う(他の CLI 使用法エラーと
    // 同じ整形: stderr + exit 2)。
    try {
      await access(envFilePath, fsConstants.F_OK);
    } catch {
      stderr.push(`note2web: env file not found: ${envFilePath}`);
      return { exitCode: PRECONDITION_FAILURE, stdout, stderr };
    }
  }

  let envFileValues: Record<string, string>;
  try {
    envFileValues = await loadEnvFile(envFilePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.push(`note2web: failed to read env file (${envFilePath}): ${message}`);
    return { exitCode: PRECONDITION_FAILURE, stdout, stderr };
  }
  for (const [name, value] of Object.entries(envFileValues)) {
    if (process.env[name] === undefined) {
      process.env[name] = value;
    }
  }

  let config;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      for (const problem of error.problems) {
        const location = problem.path === '' ? '' : ` at ${problem.path}`;
        stderr.push(`note2web: config error${location}: ${problem.message}`);
      }
      return { exitCode: PRECONDITION_FAILURE, stdout, stderr };
    }
    throw error;
  }

  if (subcommand === 'doctor') {
    // design.md §5.1「doctor は … 事前チェックのみ実行」(T-15、issue #20)。
    // `runDoctorChecks` は `sync` の依存チェック(`src/dependencies.ts`)を再利用しつつ、
    // Git モードでは `gh auth status` / 対象リポジトリの push・PR 作成権限も確認する。
    try {
      await runDoctorChecks(config);
    } catch (error) {
      if (error instanceof DoctorError) {
        for (const problem of error.problems) {
          stderr.push(`note2web: doctor: ${problem.message}`);
        }
        return { exitCode: error.exitCode, stdout, stderr };
      }
      throw error;
    }
    stdout.push(`note2web: doctor: all checks passed for service "${config.service}"`);
    return { exitCode: SUCCESS, stdout, stderr };
  }

  // subcommand === 'sync'(T-14。design.md §6 の実フローへ接続する)。
  // logger は createPublisher より前に用意する(CodeRabbit review, PR #49): Git モードの
  // GitRepoPublisher(T-16)は差分ゼロでのブランチ破棄などを `logger.warn` で報告するため、
  // 生成時点で渡せる必要がある。
  const statePath = resolveStatePath(configPath, config);
  const logger = createLogger({ file: config.log?.file, timezone: config.timezone });

  let publisher;
  try {
    publisher = createPublisher(config, { logger });
  } catch (error) {
    if (error instanceof PublisherNotImplementedError) {
      // 実サービスへの Publisher 実装は T-16 以降(design.md §5.7)。sync フロー自体
      // (src/sync.ts)は完成しているが、CLI からの実配信はまだ何も行えないため、
      // ロック取得・エクスポート等を試みる前にここで打ち切る(「何も配信せず exit 2」)。
      stderr.push(`note2web: ${error.message}`);
      return { exitCode: PRECONDITION_FAILURE, stdout, stderr };
    }
    throw error;
  }

  const uploaderClient = createS3UploaderClient(config.assets);

  // service 別の NoteRenderer 選択(design.md §5.7、T-17 / issue #22)。zenn は
  // `renderZennArticle`(src/publishers/zenn.ts)、それ以外は暫定の `renderGenericArticle`
  // (`src/publishers/factory.ts` の `resolveRenderer` 参照)。
  const renderNote = resolveRenderer(config.service);

  const result = await runSync({
    config,
    statePath,
    logger,
    publisher,
    uploaderClient,
    renderNote,
  });

  if (result.error !== undefined) {
    stderr.push(`note2web: ${result.error}`);
  }
  return { exitCode: result.exitCode, stdout, stderr };
}

async function main(): Promise<void> {
  const result = await runCli(process.argv.slice(2));
  for (const line of result.stdout) {
    process.stdout.write(`${line}\n`);
  }
  for (const line of result.stderr) {
    process.stderr.write(`${line}\n`);
  }
  // process.exit() はパイプ接続時に未フラッシュの出力を破棄しうるため、
  // exitCode を設定して自然終了させる。
  process.exitCode = result.exitCode;
}

/**
 * 実行中のモジュールがエントリポイントかを判定する。
 * 手組みの `file://` 連結はパスに空白・`#`・`%` を含むと `import.meta.url` と
 * 一致しなくなるため、`pathToFileURL` で正規化して比較する。
 *
 * **シンボリックリンク経由の実行に対応する**: `npm`/`npx` は CLI を
 * `node_modules/.bin/note2web` のようなシンボリックリンク経由で起動する。Node の
 * ESM ローダーは `import.meta.url` をシンボリックリンクの実体パス(realpath)へ解決するが、
 * `process.argv[1]` は起動時に渡された(シンボリックリンクのままの)パスを保持するため、
 * 素朴な比較では一致せず `main()` が一切呼ばれずに exit code 0 で無言終了する
 * (npm パッケージングの検証で発見。`npm pack` → `npm install <tarball>` →
 * `node_modules/.bin/note2web` 実行で再現した)。`argv1` を `realpathSync` してから
 * 比較することで、シンボリックリンク経由でも直接パス指定でも判定できるようにする。
 * `realpathSync` が失敗した場合(理論上、起動中の自スクリプトなので通常起きない)は
 * 元の(非解決)パスでの比較にフォールバックする。
 */
export function isMainEntry(importMetaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) {
    return false;
  }
  if (importMetaUrl === pathToFileURL(argv1).href) {
    return true;
  }
  try {
    const resolvedArgv1 = realpathSync(argv1);
    return importMetaUrl === pathToFileURL(resolvedArgv1).href;
  } catch {
    return false;
  }
}

const isMainModule = isMainEntry(import.meta.url, process.argv[1]);

if (isMainModule) {
  void main();
}
