/**
 * `note2web init` サブコマンドの本体(design.md §5.1 CLI 構成 / §7 設定 YAML スキーマ、
 * T-29・issue #61)。
 *
 * CodeRabbit の実装プラン(issue #61)をベースにしつつ、次の3点は既にマージ済みの決定
 * (PR #60 レビュー・T-21)を優先して上書きする:
 *
 * 1. **launchd 生成のセキュリティ契約(PR #60 レビュー、issue #71 で node 直接起動へ改訂)**:
 *    README の「cron / launchd での定期実行」節が定める「env ファイル + plist」の2点構成を
 *    踏襲し、**秘匿情報(または `*_env` が指す値)を plist の `EnvironmentVariables` へ書かない**。
 *    値そのものは常に空欄のテンプレートとしてのみ `~/.config/note2web/env` に書く。
 *    `EnvironmentVariables` に書いてよいのは非秘匿の `PATH` 一つだけ(理由は `buildPlist` の
 *    JSDoc を参照)。
 * 2. **依存 CLI のアシスト(T-21)**: `@qiita/qiita-cli` は note2web 自身の `dependencies`
 *    に固定バージョンで既に同梱されているため、ローカル解決できるかの確認のみ行う
 *    (`src/dependencies.ts` の `defaultQiitaCliResolvable` と同じ手法)。ruby /
 *    apple_cloud_notes_parser / gh / noet が無い場合も **自動インストールは一切行わず**、
 *    手順を日本語で案内するだけに留める(`init` の目的はブートストラップの補助であり、
 *    欠如を理由に失敗させない)。
 * 3. **書き込み後のスキーマ検証(FR-30)**: 生成した YAML の検証には `src/config.ts` の
 *    `validateConfigObject`(スキーマのみ。`*_env` 環境変数の存在確認は行わない)を使う。
 *    利用者はまだ env ファイルへ値を書き込んでいない段階のため、未設定の環境変数は
 *    エラーではなく成功サマリの「次にやること」として列挙する。
 */

import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_TIMEZONE,
  SERVICES,
  serializeConfig,
  validateConfigObject,
  type Config,
  type ServiceName,
} from './config.js';
import { DEFAULT_PARSER_PATH } from './exporter/apple-notes.js';
import { PRECONDITION_FAILURE } from './exit-codes.js';
import { expandHome } from './paths.js';
import { isGitModeService } from './publishers/mode.js';
import { commandExists } from './subprocess.js';

/** `runInit` の対話プロンプト1問分の関数型。空文字を返すと「既定値を採用」として扱われる。 */
export type InitPromptFn = (question: string) => Promise<string>;

/** `note2web init` の検証で見つかった1件の問題。 */
export interface InitProblem {
  message: string;
}

/**
 * `init` の実行前提が満たせなかった(生成した設定がスキーマ検証に落ちた等)ことを表す
 * エラー。`src/doctor.ts` の `DoctorError` と同じ `exitCode` 規約に従う。
 */
export class InitError extends Error {
  readonly exitCode = PRECONDITION_FAILURE;
  readonly problems: InitProblem[];

  constructor(problems: InitProblem[]) {
    super(problems.map((problem) => problem.message).join('; '));
    this.name = 'InitError';
    this.problems = problems;
  }
}

/** `runInit` が成功時に返すサマリ。`src/cli.ts` がそのまま stdout へ積む。 */
export interface InitResult {
  /** 人間向けの1行ずつのサマリ(生成物のパス・警告・次にやること)。 */
  summary: string[];
}

/** ファイル書き込み時に指定できるオプション(新規作成時のみ有効な `mode`)。 */
export interface WriteFileOptions {
  mode?: number;
}

/** `runInit` の挙動を差し替えるためのオプション(テスト用の注入点)。既定値は実ファイルシステム/実 CLI を使う。 */
export interface RunInitOptions {
  /** 書き込み先(または再読み込み対象)の設定 YAML パス。省略時はサービス選択後に既定パスを決める。 */
  configPath?: string;
  /** 対話プロンプトの注入点。既定は実 stdin/stdout の readline。 */
  promptFn?: InitPromptFn;
  /** ファイル存在確認の注入点。既定は `fs/promises` の `access`。 */
  fileExistsFn?: (path: string) => Promise<boolean>;
  /** ファイル読み込みの注入点(UTF-8)。既定は `fs/promises` の `readFile`。 */
  readFileFn?: (path: string) => Promise<string>;
  /** ファイル書き込みの注入点。既定は `fs/promises` の `writeFile`。 */
  writeFileFn?: (path: string, content: string, options?: WriteFileOptions) => Promise<void>;
  /** ディレクトリ作成(再帰的)の注入点。既定は `fs/promises` の `mkdir`。 */
  mkdirFn?: (path: string) => Promise<void>;
  /** パーミッション変更の注入点(env ファイル 600 用)。既定は `fs/promises` の `chmod`。 */
  chmodFn?: (path: string, mode: number) => Promise<void>;
  /** コマンド存在確認の注入点。既定は `src/subprocess.ts` の `commandExists`。 */
  commandExistsFn?: (command: string) => Promise<boolean>;
  /** `@qiita/qiita-cli` がローカル解決できるかどうかの注入点(テスト用)。 */
  qiitaCliResolvableFn?: () => boolean;
  /** 実行中インストールの `dist/cli.js` の絶対パスを解決する注入点(テスト用)。既定は `resolveCliEntrypoint`。 */
  resolveCliEntrypointFn?: () => string | undefined;
  /**
   * launchd の plist の `ProgramArguments[0]` に埋め込む `node` 実行ファイルの絶対パスを
   * 解決する注入点(テスト用)。既定は `() => process.execPath`(= `note2web init` 自身を
   * 起動している `node` のパス)。issue #71: TCC(macOS のプライバシー制御)の
   * responsible process は `ProgramArguments[0]` で決まるため、シェルスクリプトではなく
   * この `node` 実行ファイル自身にフルディスクアクセスを付与できるようにする。
   */
  nodeExecPathFn?: () => string;
  /** 環境変数の参照元。既定は `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** ホームディレクトリ(`~` 展開・既定パス算出の基準)。既定は `os.homedir()`。テストで実ホームを触らないための注入点。 */
  homeDir?: string;
}

/** `${value}\n` を安全に取り出すための小さな成型ヘルパー。 */
function withDefaultSuffix(question: string, defaultValue: string | undefined): string {
  if (defaultValue === undefined || defaultValue === '') {
    return `${question}: `;
  }
  return `${question} [${defaultValue}]: `;
}

/** 1問だけ尋ね、空入力なら `defaultValue`(未指定なら空文字)を返す。 */
async function ask(
  promptFn: InitPromptFn,
  question: string,
  defaultValue?: string,
): Promise<string> {
  const answer = (await promptFn(withDefaultSuffix(question, defaultValue))).trim();
  return answer === '' ? (defaultValue ?? '') : answer;
}

/** 空文字を許さない1問。空のままなら「必須」であることを付記して再度尋ね直す。 */
async function askRequired(
  promptFn: InitPromptFn,
  question: string,
  defaultValue?: string,
): Promise<string> {
  let currentQuestion = question;
  for (;;) {
    const value = await ask(promptFn, currentQuestion, defaultValue);
    if (value !== '') {
      return value;
    }
    currentQuestion = `${question} (required, cannot be empty)`;
  }
}

/** 絶対 URL であることを要求する1問(`z.url()` と同じ制約)。空文字を許す場合は `required: false`。 */
async function askUrl(
  promptFn: InitPromptFn,
  question: string,
  defaultValue: string | undefined,
  required: boolean,
): Promise<string | undefined> {
  let currentQuestion = question;
  for (;;) {
    const value = await ask(promptFn, currentQuestion, defaultValue);
    if (value === '') {
      if (!required) {
        return undefined;
      }
      currentQuestion = `${question} (required, cannot be empty)`;
      continue;
    }
    try {
      // 構文検証のみが目的で、生成したインスタンスは使わない。
      new URL(value);
      return value;
    } catch {
      currentQuestion = `${question} (must be a valid absolute URL, e.g. https://example.com/)`;
    }
  }
}

/**
 * POSIX シェルの単一引数として安全になるようシングルクォートで囲む(サマリで案内する
 * コマンド用。パスに空白や `&` が含まれてもコピー&ペーストでそのまま動くようにする)。
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** `askYesNo` / `askChoice` が無効な入力を受け取り続けたときに諦めるまでの最大再試行回数。 */
const MAX_PROMPT_RETRIES = 10;

/** y/N の2択。空入力は `defaultValue` を採用する。無効な入力が続く場合は `InitError` を投げる。 */
async function askYesNo(
  promptFn: InitPromptFn,
  question: string,
  defaultValue: boolean,
): Promise<boolean> {
  const suffix = defaultValue ? 'Y/n' : 'y/N';
  for (let attempt = 0; attempt < MAX_PROMPT_RETRIES; attempt++) {
    const answer = (await promptFn(`${question} [${suffix}]: `)).trim().toLowerCase();
    if (answer === '') {
      return defaultValue;
    }
    if (answer === 'y' || answer === 'yes') {
      return true;
    }
    if (answer === 'n' || answer === 'no') {
      return false;
    }
  }
  throw new InitError([{ message: `too many invalid answers to "${question}" (expected y/n)` }]);
}

/** 選択肢一覧から1つを選ばせる(番号入力・名前入力のどちらも許可)。無効な入力が続く場合は `InitError` を投げる。 */
async function askChoice<T extends string>(
  promptFn: InitPromptFn,
  question: string,
  choices: readonly T[],
  defaultValue: T | undefined,
): Promise<T> {
  const listing = choices.map((choice, index) => `  ${String(index + 1)}) ${choice}`).join('\n');
  const defaultIndex = defaultValue !== undefined ? choices.indexOf(defaultValue) : -1;
  const defaultAnswer = defaultIndex >= 0 ? String(defaultIndex + 1) : undefined;
  for (let attempt = 0; attempt < MAX_PROMPT_RETRIES; attempt++) {
    const answer = await ask(
      promptFn,
      `${question}\n${listing}\nEnter number or name`,
      defaultAnswer,
    );
    const asNumber = Number(answer);
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= choices.length) {
      const choice = choices[asNumber - 1];
      if (choice !== undefined) {
        return choice;
      }
    }
    const byName = choices.find((choice) => choice === answer);
    if (byName !== undefined) {
      return byName;
    }
  }
  throw new InitError([
    {
      message: `too many invalid answers to "${question}" (expected one of: ${choices.join(', ')})`,
    },
  ]);
}

/** カンマ区切りの入力を、空要素を除いた配列へ変換する(`source.folders` 用)。 */
function parseCommaSeparated(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * readline を使った既定の `promptFn` を1つ作る。プロセスの実 stdin/stdout に対して対話する。
 * stdin が EOF(パイプの終端など)に達して readline が閉じた場合、`rl.question` は
 * reject するかそのまま解決しないため、`close` イベントを見て待機中の質問を
 * `InitError` で reject し直し、`runInit` が無限に待ち続けないようにする。
 */
function createDefaultPromptFn(): { promptFn: InitPromptFn; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  const eofError = (): InitError =>
    new InitError([{ message: 'stdin closed (EOF) before init finished prompting' }]);
  // readline/promises の `question` は、待機中にインターフェースが閉じても reject せず
  // 保留のままになりうる。`close` イベントで reject する Promise と race させることで、
  // EOF 到達時に待機中の質問も即座に `InitError` で失敗させる。
  const closedDuringPrompt = new Promise<never>((_, reject) => {
    rl.once('close', () => {
      closed = true;
      reject(eofError());
    });
  });
  // race に参加しないタイミング(正常終了時の close())での unhandled rejection を防ぐ。
  closedDuringPrompt.catch(() => {
    // 意図的に無視。
  });
  return {
    promptFn: async (question) => {
      if (closed) {
        throw eofError();
      }
      try {
        const answer = await Promise.race([rl.question(question), closedDuringPrompt]);
        return answer.trim();
      } catch (error) {
        if (closed) {
          throw eofError();
        }
        throw error;
      }
    },
    close: () => {
      rl.close();
    },
  };
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultReadFile(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

async function defaultWriteFile(
  path: string,
  content: string,
  options?: WriteFileOptions,
): Promise<void> {
  if (options?.mode !== undefined) {
    await writeFile(path, content, { mode: options.mode });
    return;
  }
  await writeFile(path, content);
}

async function defaultMkdir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function defaultChmod(path: string, mode: number): Promise<void> {
  await chmod(path, mode);
}

/**
 * `@qiita/qiita-cli` が note2web 自身の依存としてローカル解決できるかどうかの既定実装。
 * `src/dependencies.ts` の `defaultQiitaCliResolvable` と同じ手法(T-21・design.md §5.7
 * セキュリティ制約)だが、依存モジュールを増やさないためここでも小さく複製している
 * (挙動は同一)。
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
 * 実行中の note2web インストールにおける CLI エントリポイント(`dist/cli.js`)の絶対パスを
 * 解決する(issue #63: note2web は npm へ公開されていないため、`npx --yes note2web@<version>`
 * を plist から呼ぶと必ず 404 になる。代わりに `node` でこのエントリポイントを直接起動する
 * ——issue #71 以降は生成した plist の `ProgramArguments` へ直接埋め込む)。
 * `src/publishers/qiita.ts` の `NOTE2WEB_PACKAGE_ROOT` と同じ手法で、`import.meta.url`
 * (実行時は `dist/init.js`)から見た兄弟ファイルとして `cli.js`(= `dist/cli.js`)を解決する。
 *
 * この関数自体は存在確認を行わない(純粋にパスを計算するのみ)——ここで `existsSync` 等の
 * 実ファイルシステムを直接見てしまうと、テストの DI フェイクからは見えない実ファイルの
 * 有無に依存してしまう。実ファイルの存在確認は呼び出し側(`runInit`)が注入済みの
 * `fileExistsFn`(テストではフェイク fs)を使って行う——`src/` から直接動かす開発時の実行
 * (ビルド前で `dist/cli.js` が無い)を、CodeRabbit レビュー(issue #71)で指摘のとおり
 * 「パスは解決できるがファイルが実在しない」ケースとして検出し、`undefined` の場合と同様に
 * plist の生成自体をスキップする。
 */
function resolveCliEntrypoint(): string | undefined {
  try {
    return fileURLToPath(new URL('cli.js', import.meta.url));
  } catch {
    return undefined;
  }
}

function stringField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  if (obj === undefined) {
    return undefined;
  }
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

function boolField(obj: Record<string, unknown> | undefined, key: string): boolean | undefined {
  if (obj === undefined) {
    return undefined;
  }
  const value = obj[key];
  return typeof value === 'boolean' ? value : undefined;
}

function objectField(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = obj[key];
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 既存設定 YAML から緩く(zod を経由せず)取り出したデフォルト値。 */
interface ExistingDefaults {
  service?: string;
  timezone?: string;
  folders?: string[];
  assets?: Record<string, unknown>;
  git?: Record<string, unknown>;
  qiita?: Record<string, unknown>;
  devto?: Record<string, unknown>;
  note?: Record<string, unknown>;
  hatena?: Record<string, unknown>;
}

/**
 * 既存設定 YAML を「再実行時のデフォルト値」として緩く読み取る。zod による厳格な検証は
 * 行わない——再実行時点の設定は(例えば旧バージョンの note2web が書いたもの、あるいは
 * 利用者が手で編集して一時的に壊れているもの)であっても、init はできる限り値を拾って
 * プロンプトの初期値に使いたいため。パース不能な場合は `undefined` を返し、呼び出し側が
 * 警告して「デフォルト値なしで続行」する。
 */
function extractExistingDefaults(parsed: unknown): ExistingDefaults | undefined {
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;
  const defaults: ExistingDefaults = {};

  const service = stringField(obj, 'service');
  if (service !== undefined) {
    defaults.service = service;
  }
  const timezone = stringField(obj, 'timezone');
  if (timezone !== undefined) {
    defaults.timezone = timezone;
  }

  const source = objectField(obj, 'source');
  const folders = source?.folders;
  if (Array.isArray(folders)) {
    defaults.folders = folders.filter((item): item is string => typeof item === 'string');
  }

  const assets = objectField(obj, 'assets');
  if (assets !== undefined) {
    defaults.assets = assets;
  }

  for (const key of ['git', 'qiita', 'devto', 'note', 'hatena'] as const) {
    const block = objectField(obj, key);
    if (block !== undefined) {
      defaults[key] = block;
    }
  }

  return defaults;
}

/** サービス名から `assets.*_env` の初期候補を作る(既存値があればそちらを優先)。 */
function defaultEnvVarName(
  provider: 'r2' | 's3',
  suffix: 'ACCESS_KEY_ID' | 'SECRET_ACCESS_KEY',
): string {
  return `${provider.toUpperCase()}_${suffix}`;
}

/** `assets` ブロックを対話収集する。 */
async function collectAssets(
  promptFn: InitPromptFn,
  defaults: Record<string, unknown> | undefined,
): Promise<Config['assets']> {
  const assetProviders = ['r2', 's3'] as const;
  const existingProvider = stringField(defaults, 'provider');
  const defaultProvider =
    existingProvider !== undefined &&
    (assetProviders as readonly string[]).includes(existingProvider)
      ? (existingProvider as 'r2' | 's3')
      : 'r2';
  const provider = await askChoice(
    promptFn,
    'Asset storage provider (image/attachment uploads)',
    assetProviders,
    defaultProvider,
  );
  const bucket = await askRequired(promptFn, 'Bucket name', stringField(defaults, 'bucket'));
  const endpoint = await askUrl(
    promptFn,
    provider === 'r2'
      ? 'R2 endpoint (e.g. https://<account>.r2.cloudflarestorage.com)'
      : 'S3-compatible endpoint (leave blank for AWS S3)',
    stringField(defaults, 'endpoint'),
    provider === 'r2',
  );
  const region = await ask(promptFn, 'Region (optional)', stringField(defaults, 'region'));
  const prefix = await ask(promptFn, 'Key prefix (optional)', stringField(defaults, 'prefix'));
  const publicBaseUrl = await askUrl(
    promptFn,
    'Public base URL that serves uploaded assets',
    stringField(defaults, 'public_base_url'),
    true,
  );
  const accessKeyIdEnv = await askRequired(
    promptFn,
    'Environment variable name that holds the access key ID (value itself is never written to the config, FR-30)',
    stringField(defaults, 'access_key_id_env') ?? defaultEnvVarName(provider, 'ACCESS_KEY_ID'),
  );
  const secretAccessKeyEnv = await askRequired(
    promptFn,
    'Environment variable name that holds the secret access key',
    stringField(defaults, 'secret_access_key_env') ??
      defaultEnvVarName(provider, 'SECRET_ACCESS_KEY'),
  );

  const assets: Config['assets'] = {
    provider,
    bucket,
    public_base_url: publicBaseUrl as string,
    access_key_id_env: accessKeyIdEnv,
    secret_access_key_env: secretAccessKeyEnv,
  };
  if (endpoint !== undefined) {
    assets.endpoint = endpoint;
  }
  if (region !== '') {
    assets.region = region;
  }
  if (prefix !== '') {
    assets.prefix = prefix;
  }
  return assets;
}

/** Git 出力モード(zenn/hugo/jekyll)の `git` ブロックを対話収集する(design.md §5.7 サービス別差分)。 */
async function collectGitBlock(
  promptFn: InitPromptFn,
  service: 'zenn' | 'hugo' | 'jekyll',
  defaults: Record<string, unknown> | undefined,
): Promise<NonNullable<Config['git']>> {
  const repoPath = await askRequired(
    promptFn,
    'Local path of the target Git repository (already cloned & gh-authenticated)',
    stringField(defaults, 'repo_path') ?? `~/src/${service}-content`,
  );
  const baseBranch = await askRequired(
    promptFn,
    'Base branch',
    stringField(defaults, 'base_branch') ?? 'main',
  );
  // Zenn は README / design.md §5.7 の表のとおり articles 固定(出力パス規約)。
  const outputDir =
    service === 'zenn'
      ? 'articles'
      : await askRequired(
          promptFn,
          'Output directory (relative to the repository root)',
          stringField(defaults, 'output_dir') ??
            (service === 'jekyll' ? '_posts' : 'content/posts'),
        );
  const autoMerge = await askYesNo(
    promptFn,
    'Automatically merge the PR after creating it (auto_merge)?',
    boolField(defaults, 'auto_merge') ?? false,
  );
  return {
    repo_path: repoPath,
    base_branch: baseBranch,
    output_dir: outputDir,
    auto_merge: autoMerge,
  };
}

async function collectQiitaBlock(
  promptFn: InitPromptFn,
  defaults: Record<string, unknown> | undefined,
): Promise<NonNullable<Config['qiita']>> {
  const workspace = await askRequired(
    promptFn,
    'qiita-cli workspace directory',
    stringField(defaults, 'workspace') ?? '~/src/qiita-content',
  );
  const tokenEnv = await askRequired(
    promptFn,
    'Environment variable name that holds the Qiita token',
    stringField(defaults, 'token_env') ?? 'QIITA_TOKEN',
  );
  return { workspace, token_env: tokenEnv };
}

async function collectDevtoBlock(
  promptFn: InitPromptFn,
  defaults: Record<string, unknown> | undefined,
): Promise<NonNullable<Config['devto']>> {
  const apiKeyEnv = await askRequired(
    promptFn,
    'Environment variable name that holds the dev.to API key',
    stringField(defaults, 'api_key_env') ?? 'DEVTO_API_KEY',
  );
  const canonicalBaseUrl = await askUrl(
    promptFn,
    'Canonical base URL (optional, sets canonical_url on published articles)',
    stringField(defaults, 'canonical_base_url'),
    false,
  );
  const devto: NonNullable<Config['devto']> = { api_key_env: apiKeyEnv };
  if (canonicalBaseUrl !== undefined) {
    devto.canonical_base_url = canonicalBaseUrl;
  }
  return devto;
}

async function collectNoteBlock(
  promptFn: InitPromptFn,
  defaults: Record<string, unknown> | undefined,
): Promise<NonNullable<Config['note']>> {
  const workspace = await askRequired(
    promptFn,
    'noet workspace directory (working directory for the noet CLI)',
    stringField(defaults, 'workspace') ?? '~/src/note-content',
  );
  return { workspace };
}

async function collectHatenaBlock(
  promptFn: InitPromptFn,
  defaults: Record<string, unknown> | undefined,
): Promise<NonNullable<Config['hatena']>> {
  const hatenaId = await askRequired(promptFn, 'Hatena ID', stringField(defaults, 'hatena_id'));
  const blogId = await askRequired(
    promptFn,
    'Blog ID (e.g. example.hatenablog.com)',
    stringField(defaults, 'blog_id'),
  );
  const apiKeyEnv = await askRequired(
    promptFn,
    'Environment variable name that holds the Hatena API key',
    stringField(defaults, 'api_key_env') ?? 'HATENA_API_KEY',
  );
  return { hatena_id: hatenaId, blog_id: blogId, api_key_env: apiKeyEnv };
}

/**
 * 選択された service に基づき、依存 CLI・環境の欠如を検出して日本語の対処手順を返す
 * (CORRECTION B: 自動インストールは行わず、案内のみ。1件も無ければ空配列)。
 */
async function collectDependencyWarnings(
  service: ServiceName,
  parserEntryPoint: string,
  requiredEnvNames: readonly string[],
  options: {
    commandExistsFn: (command: string) => Promise<boolean>;
    fileExistsFn: (path: string) => Promise<boolean>;
    qiitaCliResolvableFn: () => boolean;
    env: NodeJS.ProcessEnv;
  },
): Promise<string[]> {
  const { commandExistsFn, fileExistsFn, qiitaCliResolvableFn, env } = options;
  const warnings: string[] = [];

  if (!(await commandExistsFn('ruby'))) {
    warnings.push(
      '[依存] Ruby が見つかりません。apple_cloud_notes_parser の実行に必要です。' +
        'https://www.ruby-lang.org/ の手順に従ってインストールしてください。',
    );
  }
  if (!(await fileExistsFn(parserEntryPoint))) {
    warnings.push(
      `[依存] apple_cloud_notes_parser が見つかりません(${parserEntryPoint})。` +
        '以下の手順で導入してください:\n' +
        '    git clone https://github.com/threeplanetssoftware/apple_cloud_notes_parser ~/tools/apple_cloud_notes_parser\n' +
        '    cd ~/tools/apple_cloud_notes_parser && bundle install',
    );
  }

  if (isGitModeService(service)) {
    if (!(await commandExistsFn('git'))) {
      warnings.push(
        '[依存] git が見つかりません。https://git-scm.com/ の手順に従ってインストールしてください。',
      );
    }
    if (!(await commandExistsFn('gh'))) {
      warnings.push(
        '[依存] gh(GitHub CLI)が見つかりません。https://cli.github.com/ の手順に従ってインストールしてください。',
      );
    }
    if (env.GH_TOKEN === undefined || env.GH_TOKEN === '') {
      warnings.push(
        '[依存] 環境変数 GH_TOKEN が未設定です。GitHub の Personal Access Token(repo 権限)を発行し、' +
          '生成した env ファイルに設定してください(`gh auth login` は無人実行の cron / launchd では使えないため、' +
          'GH_TOKEN 方式を用います)。',
      );
    }
  } else if (service === 'qiita') {
    if (!qiitaCliResolvableFn()) {
      warnings.push(
        '[依存] note2web に同梱されているはずの @qiita/qiita-cli が解決できません。' +
          '`npm install` をやり直してください。',
      );
    }
  } else if (service === 'note') {
    if (!(await commandExistsFn('noet'))) {
      warnings.push(
        '[依存] noet コマンドが見つかりません。https://github.com/kako-jun/noet の手順に従って' +
          'インストールしてください。加えて、note.com にログイン済みの実 Chrome ブラウザと noet 拡張機能が' +
          '常時起動している必要があります(詳細は README の「note.com」節を参照)。',
      );
    }
  }

  const unsetEnvNames = requiredEnvNames.filter(
    (name) => env[name] === undefined || env[name] === '',
  );
  if (unsetEnvNames.length > 0) {
    warnings.push(
      `[環境変数] 次の環境変数が現在のシェルには設定されていません(sync 実行前に env ファイルへ値を記入してください): ${unsetEnvNames.join(', ')}`,
    );
  }

  return warnings;
}

/** env ファイルの1行を組み立てる(値は常に空欄。FR-30 / PR #60 レビューの契約)。 */
function envFileLine(name: string): string {
  return `# ${name}: 値をここに設定してください\n${name}=\n`;
}

/**
 * `~/.config/note2web/env` を作成、または既存ファイルに不足している変数名だけを追記する。
 * 既存の値は一切書き換えない(CORRECTION A)。
 */
async function ensureEnvFile(
  envPath: string,
  requiredNames: readonly string[],
  options: {
    fileExistsFn: (path: string) => Promise<boolean>;
    readFileFn: (path: string) => Promise<string>;
    writeFileFn: (path: string, content: string, options?: WriteFileOptions) => Promise<void>;
    mkdirFn: (path: string) => Promise<void>;
    chmodFn: (path: string, mode: number) => Promise<void>;
  },
): Promise<{ created: boolean; addedNames: string[] }> {
  const { fileExistsFn, readFileFn, writeFileFn, mkdirFn, chmodFn } = options;
  await mkdirFn(dirname(envPath));

  const exists = await fileExistsFn(envPath);
  if (!exists) {
    const header =
      '# note2web 環境変数ファイル(chmod 600 で保護)。\n' +
      '# 設定 YAML の *_env が指す名前で、値を直接ここに記入してください(YAML には書きません)。\n' +
      '#\n' +
      '# [Ruby 環境のヒント](issue #67)。rbenv / rvm / Homebrew の ruby を使っている場合、\n' +
      '# 対話シェルから直接 `note2web doctor`/`sync` を実行するときに、bundle exec ruby の\n' +
      '# 起動に必要な GEM_HOME 等をここへ追記できます。PATH はこのファイルには書きません:\n' +
      '# 対話実行時の PATH はシェルの初期化ファイル(~/.zshrc 等)で設定してください。launchd\n' +
      '# 経由で実行する場合は、生成済み plist の EnvironmentVariables の PATH が使われます\n' +
      '# (issue #71)。cron を使う場合は crontab 側の PATH 設定を使ってください。\n' +
      '# 必要に応じて以下のような変数をここへ追記してください:\n' +
      '#   GEM_HOME=$HOME/.gem\n' +
      '#   BUNDLE_GEMFILE=/path/to/apple_cloud_notes_parser/Gemfile\n\n';
    const body = requiredNames.map((name) => envFileLine(name)).join('\n');
    await writeFileFn(envPath, `${header}${body}`, { mode: 0o600 });
    await chmodFn(envPath, 0o600);
    return { created: true, addedNames: [...requiredNames] };
  }

  const existingContent = await readFileFn(envPath);
  const existingNames = new Set(
    [...existingContent.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/gm)].map(
      (match) => match[1],
    ),
  );
  const missingNames = requiredNames.filter((name) => !existingNames.has(name));
  if (missingNames.length > 0) {
    const appendix =
      `\n# note2web init により追記(${new Date().toISOString()})。値をここに設定してください。\n` +
      missingNames.map((name) => envFileLine(name)).join('\n');
    await writeFileFn(envPath, `${existingContent}${appendix}`, { mode: 0o600 });
  }
  await chmodFn(envPath, 0o600);
  return { created: false, addedNames: missingNames };
}

/**
 * launchd の PATH 探索対象になり得るバージョンマネージャの shim / bin ディレクトリ
 * (`<home>` からの相対位置。存在するものだけを `buildLaunchdPath` が PATH へ加える)。
 */
const VERSION_MANAGER_PATH_SUFFIXES = [
  ['.rbenv', 'shims'],
  ['.asdf', 'shims'],
  ['.rvm', 'bin'],
] as const;

/** launchd の最小限の PATH に必ず含める OS 標準ディレクトリ(rbenv 等の shim より後ろに置く)。 */
const STANDARD_PATH_TAIL = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
] as const;

/**
 * launchd の plist に埋め込む `PATH` を init 実行時点で確定させる(issue #71)。`PATH` は
 * 秘匿情報ではないため、env ファイルではなく plist の `EnvironmentVariables` に直接書ける
 * ——README のトラブルシューティング「ruby / bundle が cron / launchd の PATH に無い」節が
 * 示すとおり、launchd の実行環境は `/usr/bin:/bin` 程度の最小限の PATH しか持たず、
 * rbenv / asdf / rvm 等のバージョンマネージャの shim ディレクトリが無いと
 * `bundle exec ruby`(apple_cloud_notes_parser の起動、issue #67)が解決できない。
 *
 * 並び順: (1) `node` 実行ファイル自身のディレクトリ、(2) 利用者のホームディレクトリに
 * 実在するバージョンマネージャの shim/bin ディレクトリ(存在しないものは、使っていない
 * バージョンマネージャの解決不能なパスを PATH に混入させないため加えない)、(3) Homebrew /
 * OS 標準ディレクトリの固定末尾。同じディレクトリが重複した場合は最初の出現だけを残す。
 */
async function buildLaunchdPath(
  nodeExecPath: string,
  homeDir: string,
  fileExistsFn: (path: string) => Promise<boolean>,
): Promise<string> {
  const candidates = [dirname(nodeExecPath)];
  for (const suffix of VERSION_MANAGER_PATH_SUFFIXES) {
    const dir = join(homeDir, ...suffix);
    if (await fileExistsFn(dir)) {
      candidates.push(dir);
    }
  }
  candidates.push(...STANDARD_PATH_TAIL);

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const dir of candidates) {
    if (!seen.has(dir)) {
      seen.add(dir);
      deduped.push(dir);
    }
  }
  return deduped.join(':');
}

/** XML の特殊文字をエスケープする(plist に埋め込むパス等が `&`/`<`/`>`/`"`/`'` を含み得るため)。 */
function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * README「launchd の例」節と同一の形の plist(issue #71: `node` を直接起動する構成へ改訂)。
 *
 * **`ProgramArguments[0]` を `node` 実行ファイル自身にする理由**: launchd が Apple の
 * TCC(プライバシー制御。フルディスクアクセス等)へ通知する「責任のあるプロセス
 * (responsible process)」は `ProgramArguments[0]` の実行ファイルで決まる。以前の実装
 * (シェルラッパー `~/bin/note2web-sync.sh` を `ProgramArguments[0]` に置く構成)では
 * `/bin/sh` にフルディスクアクセスを許可しても TCC が正しく紐付かず、実機で権限が
 * 効かないという報告があった。`node` 実行ファイル自身を `ProgramArguments[0]` にすれば、
 * その `node` バイナリへフルディスクアクセスを許可するだけでジョブ全体(`node` が
 * `child_process` で起動する `ruby`/`bundle` を含む)に権限が及ぶ(子プロセスは責任のある
 * プロセスの権限を継承する)。
 *
 * **`EnvironmentVariables` には決して秘匿情報を書かない**: `PATH` 一つだけが例外で、
 * それ以外のキー(トークン等、`*_env` が指す値)は plist へ一切書かない。plist は
 * `chmod 600` の env ファイルと異なり平文で読まれ得るため、秘匿情報は引き続き
 * `~/.config/note2web/env` にのみ置き、note2web の CLI 自身がそれを自動読み込みする
 * (issue #69)。
 *
 * ホームディレクトリや設定パスに `&` 等の XML 特殊文字が含まれていても壊れた plist を
 * 生成しないよう、すべての埋め込み値を `escapeXml` で通す。
 */
function buildPlist(options: {
  label: string;
  programArguments: readonly string[];
  path: string;
  startInterval: number;
  stdoutLogPath: string;
  stderrLogPath: string;
}): string {
  const { label, programArguments, path, startInterval, stdoutLogPath, stderrLogPath } = options;
  const programArgumentsXml = programArguments
    .map((argument) => `    <string>${escapeXml(argument)}</string>\n`)
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    '<dict>\n' +
    '  <key>Label</key>\n' +
    `  <string>${escapeXml(label)}</string>\n` +
    '  <key>ProgramArguments</key>\n' +
    '  <array>\n' +
    programArgumentsXml +
    '  </array>\n' +
    '  <key>EnvironmentVariables</key>\n' +
    '  <dict>\n' +
    '    <key>PATH</key>\n' +
    `    <string>${escapeXml(path)}</string>\n` +
    '  </dict>\n' +
    '  <key>StartInterval</key>\n' +
    `  <integer>${String(startInterval)}</integer>\n` +
    '  <key>StandardOutPath</key>\n' +
    `  <string>${escapeXml(stdoutLogPath)}</string>\n` +
    '  <key>StandardErrorPath</key>\n' +
    `  <string>${escapeXml(stderrLogPath)}</string>\n` +
    '</dict>\n' +
    '</plist>\n'
  );
}

/**
 * `note2web init` の本体。対話的にサービス・設定を収集して設定 YAML を書き出し、
 * 依存 CLI の状況を報告し、希望すれば launchd 用の2ファイル(env / plist、issue #71 で
 * ラッパースクリプトを廃止)も生成する。design.md §7 のスキーマに沿った `Config` を
 * 組み立て、書き出し後に `validateConfigObject`(スキーマのみ)で検証する——ここで問題が
 * 出るのは init 自身の生成ロジックの不具合を意味するため `InitError` を投げる(CORRECTION C)。
 */
export async function runInit(options: RunInitOptions = {}): Promise<InitResult> {
  const {
    configPath,
    fileExistsFn = defaultFileExists,
    readFileFn = defaultReadFile,
    writeFileFn = defaultWriteFile,
    mkdirFn = defaultMkdir,
    chmodFn = defaultChmod,
    commandExistsFn = commandExists,
    qiitaCliResolvableFn = defaultQiitaCliResolvable,
    resolveCliEntrypointFn = resolveCliEntrypoint,
    nodeExecPathFn = () => process.execPath,
    env = process.env,
    homeDir = homedir(),
  } = options;

  let promptFn = options.promptFn;
  let closePrompt: (() => void) | undefined;
  if (promptFn === undefined) {
    const created = createDefaultPromptFn();
    promptFn = created.promptFn;
    closePrompt = created.close;
  }
  const ask_ = promptFn;

  try {
    const summary: string[] = [];

    // --- 1. 書き込み先パスと、再実行時のデフォルト値の決定 ---------------------------
    // `--config` が与えられていれば、サービスを尋ねるより前にそのパスの既存設定を読み、
    // サービス選択自体の既定値にする(「再実行時は既存値を選択肢の既定値として提示する」)。
    // 与えられていなければサービス選択が先(既定の出力パスがサービス名に依存するため)。
    let targetPath = '';
    let existingDefaults: ExistingDefaults | undefined = undefined;

    if (configPath !== undefined) {
      targetPath = expandHome(configPath);
      existingDefaults = await tryLoadExistingDefaults(targetPath, {
        fileExistsFn,
        readFileFn,
        summary,
      });
    }

    const existingServiceName = existingDefaults?.service;
    const defaultService =
      configPath !== undefined &&
      existingServiceName !== undefined &&
      (SERVICES as readonly string[]).includes(existingServiceName)
        ? (existingServiceName as ServiceName)
        : undefined;
    const service = await askChoice(ask_, 'Select the target service', SERVICES, defaultService);

    if (configPath === undefined) {
      const defaultPath = join(homeDir, '.config', 'note2web', `${service}.yaml`);
      const answeredPath = await ask(ask_, 'Output config file path', defaultPath);
      targetPath = expandHome(answeredPath);
      existingDefaults = await tryLoadExistingDefaults(targetPath, {
        fileExistsFn,
        readFileFn,
        summary,
      });
    }

    // --- 2. 共通ブロックの収集 ------------------------------------------------------
    const foldersAnswer = await askRequired(
      ask_,
      'Apple Notes source folders (comma-separated)',
      existingDefaults?.folders?.join(', ') ?? 'tech',
    );
    const folders = parseCommaSeparated(foldersAnswer);

    const assets = await collectAssets(ask_, existingDefaults?.assets);

    // --- 3. サービス固有ブロックの収集(design.md §7: 該当 service のときのみ1つ) -----
    // `timezone` はプロンプトでは尋ねない(Phase 2 の収集対象外)が、既存設定に値があれば
    // 上書きせず引き継ぐ(無ければ design.md §7 の既定値)。
    const timezone = existingDefaults?.timezone ?? DEFAULT_TIMEZONE;
    const config: Config = {
      service,
      timezone,
      source: { folders },
      assets,
    };

    const requiredEnvNames = [assets.access_key_id_env, assets.secret_access_key_env];

    if (isGitModeService(service)) {
      config.git = await collectGitBlock(ask_, service, existingDefaults?.git);
    } else if (service === 'qiita') {
      config.qiita = await collectQiitaBlock(ask_, existingDefaults?.qiita);
      requiredEnvNames.push(config.qiita.token_env);
    } else if (service === 'devto') {
      config.devto = await collectDevtoBlock(ask_, existingDefaults?.devto);
      requiredEnvNames.push(config.devto.api_key_env);
    } else if (service === 'note') {
      config.note = await collectNoteBlock(ask_, existingDefaults?.note);
    } else if (service === 'hatena') {
      config.hatena = await collectHatenaBlock(ask_, existingDefaults?.hatena);
      requiredEnvNames.push(config.hatena.api_key_env);
    }
    if (isGitModeService(service)) {
      requiredEnvNames.push('GH_TOKEN');
    }

    // --- 4. 書き出し ---------------------------------------------------------------
    await mkdirFn(dirname(targetPath));
    const yamlText = serializeConfig(config);
    await writeFileFn(targetPath, yamlText);
    summary.push(`Wrote configuration to ${targetPath}`);

    // --- 5. 書き込み後のスキーマ検証(CORRECTION C: スキーマ違反のみ InitError) -------
    let writtenBack: unknown;
    try {
      writtenBack = parseYaml(await readFileFn(targetPath));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new InitError([
        {
          message: `internal error: generated config could not be parsed back as YAML (${targetPath}): ${detail}`,
        },
      ]);
    }
    const schemaProblems = validateConfigObject(writtenBack);
    if (schemaProblems.length > 0) {
      throw new InitError(
        schemaProblems.map((problem) => ({
          message:
            problem.path === ''
              ? `internal error: generated config failed schema validation: ${problem.message}`
              : `internal error: generated config failed schema validation at "${problem.path}": ${problem.message}`,
        })),
      );
    }

    // --- 6. 依存 CLI・環境の案内(CORRECTION B: 失敗させず警告のみ) -------------------
    const parserEntryPoint = join(expandHome(DEFAULT_PARSER_PATH), 'notes_cloud_ripper.rb');
    const dependencyWarnings = await collectDependencyWarnings(
      service,
      parserEntryPoint,
      requiredEnvNames,
      { commandExistsFn, fileExistsFn, qiitaCliResolvableFn, env },
    );
    summary.push(...dependencyWarnings);

    // --- 7. launchd 用ファイルの生成(任意) ------------------------------------------
    const generateLaunchd = await askYesNo(
      ask_,
      'Generate the launchd auto-run files (env template + plist)?',
      false,
    );
    if (generateLaunchd) {
      // issue #71 レビュー: env ファイルは設定 YAML と同じディレクトリに置く(`--config` で
      // カスタムパスを指定した場合も含む)。CLI の自動読み込み(issue #70、`src/cli.ts` の
      // `join(dirname(configPath), 'env')`)が探すパスと一致させる必要があるため。
      const envPath = join(dirname(targetPath), 'env');
      const envResult = await ensureEnvFile(envPath, requiredEnvNames, {
        fileExistsFn,
        readFileFn,
        writeFileFn,
        mkdirFn,
        chmodFn,
      });
      if (envResult.created) {
        summary.push(`Created env file template: ${envPath} (chmod 600, values still blank)`);
      } else if (envResult.addedNames.length > 0) {
        summary.push(
          `Appended missing variable name(s) to existing env file (${envPath}): ${envResult.addedNames.join(', ')}`,
        );
      } else {
        summary.push(`Existing env file already lists all required variable names: ${envPath}`);
      }

      // issue #71: 以前のバージョンが生成していたラッパースクリプトはもう使われない
      // (launchd は node を直接起動する)。旧ファイルが残っていても実害は無いが、放置される
      // と紛らわしいため、存在すれば削除してよい旨だけをサマリで案内する(自動削除はしない
      // ——他の用途に転用されている可能性を否定できないため)。
      const oldWrapperPath = join(homeDir, 'bin', 'note2web-sync.sh');
      if (await fileExistsFn(oldWrapperPath)) {
        summary.push(
          `Note: an old wrapper script from a previous note2web version still exists at ` +
            `${oldWrapperPath}; it is no longer used by note2web (launchd now runs node directly, ` +
            'issue #71). You can delete it if you are not using it for anything else.',
        );
      }

      const cliEntrypoint = resolveCliEntrypointFn();
      // issue #71 レビュー: パスが解決できても、実際に `dist/cli.js` が存在するとは限らない
      // (`npm run build` していないソースチェックアウトから `note2web init` を実行した場合
      // 等)。存在しないパスを plist の ProgramArguments に埋め込むと、launchd がロードは
      // できても起動のたびに失敗するだけの plist を書き出してしまうため、未解決の場合と
      // 同様に扱ってスキップする。
      const cliEntrypointExists =
        cliEntrypoint !== undefined && (await fileExistsFn(cliEntrypoint));
      if (cliEntrypoint === undefined || !cliEntrypointExists) {
        // dist/cli.js が解決できない、または解決はできても実ファイルが存在しない状態で
        // plist を生成すると、動かない ProgramArguments を持つ plist をそのまま書き出して
        // しまう。env ファイルは(値を後から埋めれば使えるため)引き続き書き出すが、plist の
        // 生成はスキップし、利用者にビルド済み/インストール済みの状態で再実行するよう案内する。
        summary.push(
          'Warning: could not find the note2web CLI entrypoint (dist/cli.js); ' +
            'skipping launchd plist generation. Run "npm run build" in the note2web checkout, ' +
            'then re-run init ("node dist/cli.js init --config <path>") to generate the plist.',
        );
        summary.push('');
        summary.push('次に実行するコマンド(上から順に):');
        summary.push(`  1. env ファイルに値を記入する: \${EDITOR:-vi} ${shellQuote(envPath)}`);
        summary.push(`     (必要な変数: ${requiredEnvNames.join(', ')})`);
        // この分岐は dist/cli.js が無い(=未ビルドで note2web コマンドも PATH に無い)状態
        // なので、PATH 上の `note2web` ではなく、ビルド後に成果物を node で直接実行する
        // 手順を案内する(issue #71 レビュー)。
        summary.push('  2. note2web をビルドする: npm run build (note2web のチェックアウトで実行)');
        summary.push(
          `  3. 事前チェック: node dist/cli.js doctor --config ${shellQuote(targetPath)}`,
        );
        summary.push(
          `  4. 手動で初回同期: node dist/cli.js sync --config ${shellQuote(targetPath)}`,
        );
      } else {
        const nodeExecPath = nodeExecPathFn();
        const path = await buildLaunchdPath(nodeExecPath, homeDir, fileExistsFn);

        const intervalAnswer = await askRequired(ask_, 'launchd StartInterval in seconds', '1800');
        const startInterval = Number(intervalAnswer);
        const logsDir = join(homeDir, 'Library', 'Logs', 'note2web');
        await mkdirFn(logsDir);

        const label = `com.note2web.${service}`;
        const stdoutLogPath = join(logsDir, `${service}.log`);
        const stderrLogPath = join(logsDir, `${service}.err.log`);
        const plistPath = join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
        await mkdirFn(dirname(plistPath));
        const plistContent = buildPlist({
          label,
          programArguments: [nodeExecPath, cliEntrypoint, 'sync', '--config', targetPath],
          path,
          // `<integer>` に書き込むため、小数や安全でない大きさの数値は既定値 1800 へ倒す
          // (`1.5` 等をそのまま埋め込むと launchctl がロードできない plist になる)。
          startInterval:
            Number.isSafeInteger(startInterval) && startInterval > 0 ? startInterval : 1800,
          stdoutLogPath,
          stderrLogPath,
        });
        await writeFileFn(plistPath, plistContent);
        summary.push(
          `Wrote launchd plist: ${plistPath} (runs node directly; EnvironmentVariables contains only PATH)`,
        );
        summary.push('note2web does not run launchctl for you; review the generated files first.');

        // 次に実行するコマンドの案内。launchd(LaunchAgent)はユーザー単位のため、
        // `sudo` を付けると LaunchDaemons 扱いになりロードに失敗する(Load failed: 5)。
        // レガシーな `launchctl load` ではなく、エラーが読みやすい `bootstrap` 形式を案内する。
        // env ファイルの読み込みは note2web の CLI 自身が自動で行う(issue #70)ため、
        // 以前あった「現在のシェルに読み込む(set -a; . env; set +a)」の手順は不要。
        summary.push('');
        summary.push('次に実行するコマンド(上から順に):');
        summary.push(`  1. env ファイルに値を記入する: \${EDITOR:-vi} ${shellQuote(envPath)}`);
        summary.push(`     (必要な変数: ${requiredEnvNames.join(', ')})`);
        summary.push(`  2. 事前チェック: note2web doctor --config ${shellQuote(targetPath)}`);
        summary.push(`  3. 手動で初回同期: note2web sync --config ${shellQuote(targetPath)}`);
        summary.push(
          `  4. フルディスクアクセスを付与する(launchd 実行に必須、issue #71): ` +
            'システム設定 → プライバシーとセキュリティ → フルディスクアクセス を開き ' +
            '(Cmd+Shift+G でパス入力可)、次の node 実行ファイルを追加する: ' +
            shellQuote(nodeExecPath),
        );
        summary.push(
          `  5. launchd に登録する(sudo は付けない): launchctl bootstrap gui/$(id -u) ${shellQuote(plistPath)}`,
        );
        summary.push(`  6. すぐ1回実行して確認: launchctl kickstart -k gui/$(id -u)/${label}`);
        summary.push(
          `  7. ログを確認: tail -f ${shellQuote(stdoutLogPath)} ${shellQuote(stderrLogPath)}`,
        );
        summary.push(`  (定期実行を解除するとき: launchctl bootout gui/$(id -u)/${label})`);
      }
    } else {
      summary.push('Skipped launchd file generation (re-run "note2web init" later to add it).');
      summary.push('');
      summary.push('次に実行するコマンド(上から順に):');
      summary.push(
        `  1. 環境変数を設定する: export <変数名>=<値> (必要な変数: ${requiredEnvNames.join(', ')})`,
      );
      summary.push(`  2. 事前チェック: note2web doctor --config ${shellQuote(targetPath)}`);
      summary.push(`  3. 同期を実行: note2web sync --config ${shellQuote(targetPath)}`);
    }

    return { summary };
  } finally {
    closePrompt?.();
  }
}

/** 既存設定 YAML を読み、緩くパースしてデフォルト値を取り出す。無ければ `undefined`。 */
async function tryLoadExistingDefaults(
  targetPath: string,
  options: {
    fileExistsFn: (path: string) => Promise<boolean>;
    readFileFn: (path: string) => Promise<string>;
    summary: string[];
  },
): Promise<ExistingDefaults | undefined> {
  const { fileExistsFn, readFileFn, summary } = options;
  if (!(await fileExistsFn(targetPath))) {
    return undefined;
  }
  try {
    const raw = await readFileFn(targetPath);
    const parsed: unknown = parseYaml(raw);
    const defaults = extractExistingDefaults(parsed);
    if (defaults === undefined) {
      summary.push(
        `Note: existing config at ${targetPath} did not look like a valid config object; proceeding without defaults.`,
      );
    } else {
      summary.push(`Loaded existing config at ${targetPath} as defaults for this run.`);
    }
    return defaults;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    summary.push(
      `Note: could not parse existing config at ${targetPath} (${detail}); proceeding without defaults.`,
    );
    return undefined;
  }
}
