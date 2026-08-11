#!/usr/bin/env node

import { existsSync } from 'node:fs';
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

  if (!existsSync(configPath)) {
    stderr.push(`note2web: config file not found: ${configPath}`);
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
  process.exit(result.exitCode);
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  void main();
}
