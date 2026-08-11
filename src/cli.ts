#!/usr/bin/env node

import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PRECONDITION_FAILURE, SUCCESS } from './exit-codes.js';

/** 許可されたサブコマンド(design.md §5.1)。 */
const SUBCOMMANDS = ['sync', 'doctor'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(value: string | undefined): value is Subcommand {
  return value !== undefined && (SUBCOMMANDS as readonly string[]).includes(value);
}

const USAGE = [
  'Usage: note2web <sync|doctor> --config <path>',
  '',
  '  sync    Export, transform, and publish notes',
  '  doctor  Check dependencies, environment, and configuration only',
  '',
  'Options:',
  '  --config <path>  Path to the configuration YAML file (required)',
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
  try {
    const { values } = parseArgs({
      args: rest,
      options: {
        config: { type: 'string' },
      },
      allowPositionals: false,
    });
    configPath = values.config;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.push(`note2web: failed to parse arguments: ${message}`);
    return { exitCode: PRECONDITION_FAILURE, stdout, stderr };
  }

  if (configPath === undefined) {
    stderr.push('note2web: missing required option --config <path>');
    return { exitCode: PRECONDITION_FAILURE, stdout, stderr };
  }

  let isFile: boolean;
  try {
    isFile = statSync(configPath).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    stderr.push(`note2web: config file not found or not a regular file: ${configPath}`);
    return { exitCode: PRECONDITION_FAILURE, stdout, stderr };
  }

  // プレースホルダ: sync / doctor 本体は後続タスク(T-14, T-15)で実装する。
  // ここでは「設定ファイルの存在確認」までを前提条件チェックとして通過させる。
  stdout.push(`note2web ${subcommand}: not implemented yet`);
  return { exitCode: SUCCESS, stdout, stderr };
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
 */
export function isMainEntry(importMetaUrl: string, argv1: string | undefined): boolean {
  return argv1 !== undefined && importMetaUrl === pathToFileURL(argv1).href;
}

const isMainModule = isMainEntry(import.meta.url, process.argv[1]);

if (isMainModule) {
  void main();
}
