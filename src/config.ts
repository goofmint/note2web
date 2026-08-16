/**
 * 設定 YAML ローダー(design.md §7)。
 * YAML を読み込み、zod スキーマで検証したうえで、`*_env` が指す環境変数の
 * 存在確認まで行う。秘匿情報の直書きはスキーマの `.strict()` により
 * 「未知キー」として拒否される(FR-30)。
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/**
 * `timezone` 省略時の既定値(design.md §7)。`src/init.ts`(T-29)がテンプレート生成時に
 * 再利用できるよう export する。
 */
export const DEFAULT_TIMEZONE = 'Asia/Tokyo';

/**
 * design.md §7 で列挙されている配信先サービス。`src/init.ts`(T-29、issue #61)が
 * サービス選択の選択肢一覧としてそのまま再利用するため export する。
 */
export const SERVICES = ['zenn', 'hugo', 'jekyll', 'qiita', 'devto', 'note', 'hatena'] as const;
export type ServiceName = (typeof SERVICES)[number];

const sourceSchema = z
  .object({
    folders: z.array(z.string().min(1)).min(1),
  })
  .strict();

const exporterSchema = z
  .object({
    parser_path: z.string().min(1).optional(),
    notes_container: z.string().min(1).optional(),
  })
  .strict();

const logSchema = z
  .object({
    file: z.string().min(1).optional(),
  })
  .strict();

const assetsSchema = z
  .object({
    provider: z.enum(['r2', 's3']),
    bucket: z.string().min(1),
    endpoint: z.url().optional(),
    region: z.string().min(1).optional(),
    prefix: z.string().min(1).optional(),
    public_base_url: z.url(),
    access_key_id_env: z.string().min(1),
    secret_access_key_env: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.provider === 'r2' && (value.endpoint === undefined || value.endpoint === '')) {
      ctx.addIssue({
        code: 'custom',
        message: 'assets.endpoint is required when assets.provider is "r2"',
        path: ['endpoint'],
      });
    }
  });

const gitSchema = z
  .object({
    repo_path: z.string().min(1),
    base_branch: z.string().min(1),
    output_dir: z.string().min(1),
    auto_merge: z.boolean().optional(),
  })
  .strict();

const qiitaSchema = z
  .object({
    workspace: z.string().min(1),
    token_env: z.string().min(1),
  })
  .strict();

const devtoSchema = z
  .object({
    api_key_env: z.string().min(1),
    canonical_base_url: z.url().optional(),
  })
  .strict();

const noteSchema = z
  .object({
    workspace: z.string().min(1),
  })
  .strict();

const hatenaSchema = z
  .object({
    hatena_id: z.string().min(1),
    blog_id: z.string().min(1),
    api_key_env: z.string().min(1),
  })
  .strict();

const baseConfigSchema = z
  .object({
    service: z.enum(SERVICES),
    timezone: z.string().min(1).default(DEFAULT_TIMEZONE),
    source: sourceSchema,
    exporter: exporterSchema.optional(),
    state_file: z.string().min(1).optional(),
    log: logSchema.optional(),
    assets: assetsSchema,
    git: gitSchema.optional(),
    qiita: qiitaSchema.optional(),
    devto: devtoSchema.optional(),
    note: noteSchema.optional(),
    hatena: hatenaSchema.optional(),
  })
  .strict();

/**
 * `service` の値に応じて必須となるブロックを強制する(design.md §7)。
 * zenn|hugo|jekyll は `git`、qiita|devto|note|hatena は対応するサービス
 * 固有ブロックが必須。
 */
const configSchema = baseConfigSchema.superRefine((value, ctx) => {
  const requireBlock = (blockKey: string, isPresent: boolean): void => {
    if (!isPresent) {
      ctx.addIssue({
        code: 'custom',
        message: `${blockKey} is required when service is "${value.service}"`,
        path: [blockKey],
      });
    }
  };

  switch (value.service) {
    case 'zenn':
    case 'hugo':
    case 'jekyll':
      requireBlock('git', value.git !== undefined);
      break;
    case 'qiita':
      requireBlock('qiita', value.qiita !== undefined);
      break;
    case 'devto':
      requireBlock('devto', value.devto !== undefined);
      break;
    case 'note':
      requireBlock('note', value.note !== undefined);
      break;
    case 'hatena':
      requireBlock('hatena', value.hatena !== undefined);
      break;
  }
});

/** 検証済み設定オブジェクトの型。 */
export type Config = z.infer<typeof configSchema>;

/** 検証で見つかった1件の問題(問題キーのパスとメッセージ)。 */
export interface ConfigProblem {
  /** 問題のあったキーのドット連結パス。ファイル自体の問題(不存在・YAML 構文エラー)は空文字。 */
  path: string;
  message: string;
}

/**
 * 設定 YAML の読み込み・検証に失敗したことを表すエラー。
 * ZodError の issues をキー別の `problems` に変換して保持する。
 */
export class ConfigValidationError extends Error {
  readonly problems: ConfigProblem[];

  constructor(problems: ConfigProblem[]) {
    const message = problems
      .map((problem) =>
        problem.path === '' ? problem.message : `${problem.path}: ${problem.message}`,
      )
      .join('; ');
    super(message);
    this.name = 'ConfigValidationError';
    this.problems = problems;
  }
}

/**
 * 設定オブジェクトを `configSchema` のみで検証する(`*_env` が指す環境変数の存在確認は
 * 行わない)。`note2web init`(T-29、issue #61)が、生成した YAML を書き出した直後に使う:
 * 利用者はまだ env ファイルへ値を書き込んでいない段階のため、`loadConfig` と違って
 * 環境変数未設定を問題として報告してはならない(CORRECTION C)。スキーマ自体に反する場合は
 * init 側の生成ロジックの不具合であり、`InitError` として報告させる。
 * `loadConfig` と同じ `configSchema` / `zodErrorToProblems` を再利用し、ロジックの重複を避ける。
 */
export function validateConfigObject(parsed: unknown): ConfigProblem[] {
  const result = configSchema.safeParse(parsed);
  return result.success ? [] : zodErrorToProblems(result.error);
}

/**
 * 検証済み `Config` を設定 YAML 文字列へ直列化する(`note2web init` が生成した設定を
 * 書き出す際に使う)。`loadConfig` の逆変換に相当し、キーの並び順は `Config` オブジェクトの
 * プロパティ順そのまま(呼び出し側が意図した順序で組み立てること)。
 */
export function serializeConfig(config: Config): string {
  return stringifyYaml(config);
}

/** ZodError の issues を `ConfigProblem[]` へ変換する。 */
function zodErrorToProblems(error: z.ZodError): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const unknownKey of issue.keys) {
        problems.push({
          path: [...issue.path, unknownKey].join('.'),
          message: `unknown key "${unknownKey}" (secret values must be provided via a "*_env" environment variable name, not written directly; FR-30)`,
        });
      }
      continue;
    }
    problems.push({ path: issue.path.join('.'), message: issue.message });
  }
  return problems;
}

/** `*_env` で終わるキーとその値(環境変数名)を、パスを付けて再帰的に収集する。 */
function collectEnvVarRefs(
  value: unknown,
  prefix: readonly string[] = [],
): Array<{ path: string; envName: string }> {
  if (value === null || typeof value !== 'object') {
    return [];
  }
  const results: Array<{ path: string; envName: string }> = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = [...prefix, key];
    if (key.endsWith('_env') && typeof child === 'string') {
      results.push({ path: path.join('.'), envName: child });
    } else if (typeof child === 'object' && child !== null) {
      results.push(...collectEnvVarRefs(child, path));
    }
  }
  return results;
}

/**
 * 設定 YAML ファイルを読み込み、検証済みの `Config` を返す(design.md §7)。
 * 失敗時(ファイル不存在・YAML 構文エラー・スキーマ不正・`*_env` 参照先の
 * 環境変数未設定)は必ず `ConfigValidationError` を投げる。
 */
export function loadConfig(path: string): Config {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigValidationError([
      { path: '', message: `config file not found or not a regular file: ${path}` },
    ]);
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError([
      { path: '', message: `failed to parse YAML (${path}): ${detail}` },
    ]);
  }

  const result = configSchema.safeParse(parsedYaml);
  if (!result.success) {
    throw new ConfigValidationError(zodErrorToProblems(result.error));
  }
  const config = result.data;

  const envProblems = collectEnvVarRefs(config)
    .filter(({ envName }) => process.env[envName] === undefined)
    .map(({ path: keyPath, envName }) => ({
      path: keyPath,
      message: `environment variable "${envName}" is not set`,
    }));
  if (envProblems.length > 0) {
    throw new ConfigValidationError(envProblems);
  }

  return config;
}
