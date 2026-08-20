import { describe, expect, it, vi, type Mock } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { NOTE2WEB_EXPORT_SCRIPT_PATH } from './exporter/apple-notes.js';
import { InitError, runInit, type InitPromptFn, type RunInitOptions } from './init.js';

/**
 * `promptFn` の注入テスト用フェイク。質問文に含まれる部分文字列でマッチさせ、対応する
 * 回答を返す(質問の完全一致ではなく部分一致にすることで、`src/init.ts` 側の文言を
 * 多少変えてもテストが壊れにくくする)。マッチする override が無ければ `defaultAnswer`
 * (既定 `''` = 既定値を採用)を返す。値を配列で渡すと、同じキーワードにマッチする質問が
 * 複数回来るたびに1つずつ消費する(再プロンプトのテスト用)。
 */
function makePromptFn(
  overrides: Record<string, string | string[]>,
  defaultAnswer = '',
): Mock<InitPromptFn> {
  const counters = new Map<string, number>();
  return vi.fn<InitPromptFn>(async (question: string) => {
    for (const [key, value] of Object.entries(overrides)) {
      if (question.includes(key)) {
        if (Array.isArray(value)) {
          const index = counters.get(key) ?? 0;
          counters.set(key, index + 1);
          return value[Math.min(index, value.length - 1)] ?? '';
        }
        return value;
      }
    }
    return defaultAnswer;
  });
}

/**
 * インメモリのフェイクファイルシステム。`runInit` が実ホームディレクトリへ触れないようにする。
 * `initialDirs` は「存在するディレクトリ」を模擬する追加のパス集合(`fileExistsFn` が
 * `true` を返す)——rbenv 等の shim ディレクトリの有無をテストするために使う
 * (ディレクトリはファイルとして書き込まれないため、`files` とは別に保持する)。
 */
function createFakeFs(
  initialFiles: Record<string, string> = {},
  initialDirs: readonly string[] = [],
): {
  files: Map<string, string>;
  modes: Map<string, number>;
  fileExistsFn: (path: string) => Promise<boolean>;
  readFileFn: (path: string) => Promise<string>;
  writeFileFn: (path: string, content: string, options?: { mode?: number }) => Promise<void>;
  mkdirFn: (path: string) => Promise<void>;
  chmodFn: (path: string, mode: number) => Promise<void>;
} {
  // FAKE_CLI_ENTRYPOINT / NOTE2WEB_EXPORT_SCRIPT_PATH を既定で「存在するファイル」として
  // 含める(issue #71 レビュー: `runInit` が `resolveCliEntrypointFn()` の返すパスの実在を
  // `fileExistsFn` で確認するようになったため。issue #73 レビュー Fix 5: 同様に
  // `collectDependencyWarnings` が note2web 自身のエクスポートスクリプトの実在も確認する
  // ようになったため、既定では「存在する」ことにしておき、欠如時の警告は専用テストで
  // 個別に検証する)。`initialFiles` は既定エントリの後に展開されるため同じキーの値の
  // 上書きはできるが、キーの削除はできない——存在しないケースを検証したいテストは
  // `fileExistsFn` をラップする等の別の仕組みで実現する(下記専用テスト参照)。
  const files = new Map(
    Object.entries({
      [FAKE_CLI_ENTRYPOINT]: '',
      [NOTE2WEB_EXPORT_SCRIPT_PATH]: '',
      ...initialFiles,
    }),
  );
  const dirs = new Set(initialDirs);
  const modes = new Map<string, number>();
  return {
    files,
    modes,
    fileExistsFn: (path) => Promise.resolve(files.has(path) || dirs.has(path)),
    readFileFn: (path) => {
      const content = files.get(path);
      if (content === undefined) {
        return Promise.reject(new Error(`ENOENT (fake fs): ${path}`));
      }
      return Promise.resolve(content);
    },
    writeFileFn: (path, content, options) => {
      files.set(path, content);
      if (options?.mode !== undefined) {
        modes.set(path, options.mode);
      }
      return Promise.resolve();
    },
    mkdirFn: () => Promise.resolve(),
    chmodFn: (path, mode) => {
      modes.set(path, mode);
      return Promise.resolve();
    },
  };
}

const HOME_DIR = '/home/tester';
const FAKE_NODE_EXEC_PATH = '/fake/node/bin/node';
/**
 * `buildOptions` の既定 `resolveCliEntrypointFn` が返すパス(issue #71 レビュー: `runInit` は
 * このパスの実在を `fileExistsFn` で確認するようになったため、フェイク fs 側にも既定で
 * このファイルを「存在するもの」として含めておく必要がある。個々のテストが独自の
 * `createFakeFs(...)` を呼んでいても既定で拾われるよう、`createFakeFs` 側でマージする)。
 */
const FAKE_CLI_ENTRYPOINT = '/fake/install/dist/cli.js';

/** `runInit` に渡す既定オプション。個々のテストが必要な項目だけ上書きする。 */
function buildOptions(
  overrides: Partial<RunInitOptions> & { promptFn: RunInitOptions['promptFn'] },
): RunInitOptions {
  const fs = createFakeFs();
  return {
    fileExistsFn: fs.fileExistsFn,
    readFileFn: fs.readFileFn,
    writeFileFn: fs.writeFileFn,
    mkdirFn: fs.mkdirFn,
    chmodFn: fs.chmodFn,
    commandExistsFn: () => Promise.resolve(true),
    resolveCliEntrypointFn: () => '/fake/install/dist/cli.js',
    nodeExecPathFn: () => FAKE_NODE_EXEC_PATH,
    env: {},
    homeDir: HOME_DIR,
    ...overrides,
  };
}

/**
 * 各サービスに応じた「必須かつ既定値の無い」項目の回答一式(fresh run 用)。
 * `assets.provider` は既定が `r2`(未指定なら常に r2 が選ばれる)であり、r2 では
 * `endpoint` が必須(`z.superRefine`)のため、どのサービスでも `R2 endpoint` の回答を
 * 用意しておく必要がある。
 */
const SERVICE_ANSWERS: Record<string, Record<string, string>> = {
  zenn: {
    'Select the target service': 'zenn',
    'Bucket name': 'blog-assets',
    'R2 endpoint': 'https://example-account.r2.cloudflarestorage.com',
    'Public base URL': 'https://assets.example.com/notes/',
  },
  hugo: {
    'Select the target service': 'hugo',
    'Bucket name': 'blog-assets-hugo',
    'R2 endpoint': 'https://example-account.r2.cloudflarestorage.com',
    'Public base URL': 'https://assets.example.com/notes/',
  },
  jekyll: {
    'Select the target service': 'jekyll',
    'Bucket name': 'blog-assets-jekyll',
    'R2 endpoint': 'https://example-account.r2.cloudflarestorage.com',
    'Public base URL': 'https://assets.example.com/notes/',
  },
  qiita: {
    'Select the target service': 'qiita',
    'Bucket name': 'blog-assets-qiita',
    'R2 endpoint': 'https://example-account.r2.cloudflarestorage.com',
    'Public base URL': 'https://assets.example.com/notes/',
  },
  devto: {
    'Select the target service': 'devto',
    'Bucket name': 'blog-assets-devto',
    'R2 endpoint': 'https://example-account.r2.cloudflarestorage.com',
    'Public base URL': 'https://assets.example.com/notes/',
  },
  note: {
    'Select the target service': 'note',
    'Bucket name': 'blog-assets-note',
    'R2 endpoint': 'https://example-account.r2.cloudflarestorage.com',
    'Public base URL': 'https://assets.example.com/notes/',
  },
  hatena: {
    'Select the target service': 'hatena',
    'Bucket name': 'blog-assets-hatena',
    'R2 endpoint': 'https://example-account.r2.cloudflarestorage.com',
    'Public base URL': 'https://assets.example.com/notes/',
    'Hatena ID': 'example',
    'Blog ID': 'example.hatenablog.com',
  },
};

describe('runInit', () => {
  describe.each(Object.keys(SERVICE_ANSWERS))('%s service', (service) => {
    it('writes a schema-valid config with the expected structure and never writes raw secret values', async () => {
      const promptFn = makePromptFn(SERVICE_ANSWERS[service]);
      const fs = createFakeFs();
      const result = await runInit({
        fileExistsFn: fs.fileExistsFn,
        readFileFn: fs.readFileFn,
        writeFileFn: fs.writeFileFn,
        mkdirFn: fs.mkdirFn,
        chmodFn: fs.chmodFn,
        commandExistsFn: () => Promise.resolve(true),
        env: {},
        homeDir: HOME_DIR,
        promptFn,
      });

      const expectedPath = `${HOME_DIR}/.config/note2web/${service}.yaml`;
      expect(result.summary.join('\n')).toContain(`Wrote configuration to ${expectedPath}`);

      const written = fs.files.get(expectedPath);
      expect(written).toBeDefined();
      const parsed = parseYaml(written ?? '') as Record<string, unknown>;

      expect(parsed.service).toBe(service);
      expect(parsed.source).toEqual({ folders: ['tech'] });
      const assets = parsed.assets as Record<string, unknown>;
      expect(assets.bucket).toBe(SERVICE_ANSWERS[service]['Bucket name']);
      expect(assets.public_base_url).toBe(SERVICE_ANSWERS[service]['Public base URL']);
      // 秘匿値そのものは絶対に書かない: assets には *_env という名前のキーしか許されない
      // (config.ts の .strict() が保証する契約を、生成側でも独立に確認する)。
      expect(
        Object.keys(assets).every((key) => !key.includes('access_key_id') || key.endsWith('_env')),
      ).toBe(true);
      expect(assets.access_key_id_env).toBeTruthy();
      expect(assets.secret_access_key_env).toBeTruthy();

      if (service === 'zenn' || service === 'hugo' || service === 'jekyll') {
        const git = parsed.git as Record<string, unknown>;
        expect(git.repo_path).toBe(`~/src/${service}-content`);
        expect(git.output_dir).toBe(
          service === 'zenn' ? 'articles' : service === 'jekyll' ? '_posts' : 'content/posts',
        );
        expect(git.auto_merge).toBe(false);
        expect(parsed.qiita).toBeUndefined();
      } else if (service === 'qiita') {
        const qiita = parsed.qiita as Record<string, unknown>;
        expect(qiita.token_env).toBe('QIITA_TOKEN');
        expect(parsed.git).toBeUndefined();
      } else if (service === 'devto') {
        const devto = parsed.devto as Record<string, unknown>;
        expect(devto.api_key_env).toBe('DEVTO_API_KEY');
      } else if (service === 'note') {
        const note = parsed.note as Record<string, unknown>;
        expect(note.workspace).toBe('~/src/note-content');
      } else if (service === 'hatena') {
        const hatena = parsed.hatena as Record<string, unknown>;
        expect(hatena.hatena_id).toBe('example');
        expect(hatena.blog_id).toBe('example.hatenablog.com');
        expect(hatena.api_key_env).toBe('HATENA_API_KEY');
      }

      // 生成物本文のどこにも秘匿値そのもの(env var の値)は含まれない: そもそも
      // 値の入力を一切求めていないため構造的に保証されるが、念のため一般的な
      // シークレットらしき語が literal value として現れていないことも確認する。
      expect(written).not.toMatch(/access_key_id:\s*(?!.*_env)/);
    });
  });

  it('re-prompts until a valid absolute URL is given for the required r2 endpoint', async () => {
    const promptFn = makePromptFn({
      'Select the target service': 'zenn',
      'Bucket name': 'blog-assets',
      'R2 endpoint': ['', 'not-a-url', 'https://example-account.r2.cloudflarestorage.com'],
      'Public base URL': 'https://assets.example.com/notes/',
    });
    const fs = createFakeFs();
    await runInit(
      buildOptions({
        promptFn,
        fileExistsFn: fs.fileExistsFn,
        readFileFn: fs.readFileFn,
        writeFileFn: fs.writeFileFn,
      }),
    );

    const written = fs.files.get(`${HOME_DIR}/.config/note2web/zenn.yaml`);
    const parsed = parseYaml(written ?? '') as { assets: { endpoint: string } };
    expect(parsed.assets.endpoint).toBe('https://example-account.r2.cloudflarestorage.com');
    // 3回(空・不正・正常)呼ばれているはず。
    const endpointCalls = promptFn.mock.calls.filter(([question]) =>
      question.includes('R2 endpoint'),
    );
    expect(endpointCalls.length).toBe(3);
  });

  it('reloads an existing config and accepts its values as defaults on re-run (empty answers everywhere)', async () => {
    const existingYaml = [
      'service: zenn',
      'source:',
      '  folders: [tech, idea]',
      'assets:',
      '  provider: r2',
      '  bucket: blog-assets',
      '  endpoint: https://example-account.r2.cloudflarestorage.com',
      '  region: auto',
      '  prefix: notes/',
      '  public_base_url: https://assets.example.com/notes/',
      '  access_key_id_env: R2_ACCESS_KEY_ID',
      '  secret_access_key_env: R2_SECRET_ACCESS_KEY',
      'git:',
      '  repo_path: ~/src/zenn-content',
      '  base_branch: main',
      '  output_dir: articles',
      '  auto_merge: true',
      '',
    ].join('\n');
    const targetPath = `${HOME_DIR}/.config/note2web/zenn.yaml`;
    const fs = createFakeFs({ [targetPath]: existingYaml });

    // 空文字だけを返す promptFn: 既存値がすべてデフォルトとして提示され、そのまま採用
    // されることを検証する(「必須かつ既定値なし」の項目が既存設定から埋まっている点が
    // このテストの本質)。
    const promptFn = makePromptFn({}, '');

    const result = await runInit(
      buildOptions({
        configPath: targetPath,
        promptFn,
        fileExistsFn: fs.fileExistsFn,
        readFileFn: fs.readFileFn,
        writeFileFn: fs.writeFileFn,
      }),
    );

    expect(result.summary.join('\n')).toContain(`Loaded existing config at ${targetPath}`);

    const written = fs.files.get(targetPath);
    const parsed = parseYaml(written ?? '') as Record<string, unknown>;
    expect(parsed.service).toBe('zenn');
    expect(parsed.source).toEqual({ folders: ['tech', 'idea'] });
    const assets = parsed.assets as Record<string, unknown>;
    expect(assets.bucket).toBe('blog-assets');
    expect(assets.endpoint).toBe('https://example-account.r2.cloudflarestorage.com');
    expect(assets.public_base_url).toBe('https://assets.example.com/notes/');
    const git = parsed.git as Record<string, unknown>;
    expect(git.repo_path).toBe('~/src/zenn-content');
    expect(git.auto_merge).toBe(true);
  });

  it('falls back to the r2 default when an existing config has an unknown assets provider', async () => {
    const existingYaml = [
      'service: zenn',
      'source:',
      '  folders: [tech]',
      'assets:',
      '  provider: gcs',
      '  bucket: blog-assets',
      '  endpoint: https://example-account.r2.cloudflarestorage.com',
      '  public_base_url: https://assets.example.com/notes/',
      '  access_key_id_env: R2_ACCESS_KEY_ID',
      '  secret_access_key_env: R2_SECRET_ACCESS_KEY',
      'git:',
      '  repo_path: ~/src/zenn-content',
      '  output_dir: articles',
      '',
    ].join('\n');
    const targetPath = `${HOME_DIR}/.config/note2web/zenn.yaml`;
    const fs = createFakeFs({ [targetPath]: existingYaml });

    // 既存設定の provider が不正('gcs')でも askChoice の既定値としては採用されず、
    // 空回答で r2 が選ばれる(不正値をそのまま提示すると選択不能な既定になるため)。
    const promptFn = makePromptFn({}, '');

    await runInit(
      buildOptions({
        configPath: targetPath,
        promptFn,
        fileExistsFn: fs.fileExistsFn,
        readFileFn: fs.readFileFn,
        writeFileFn: fs.writeFileFn,
      }),
    );

    const parsed = parseYaml(fs.files.get(targetPath) ?? '') as Record<string, unknown>;
    const assets = parsed.assets as Record<string, unknown>;
    expect(assets.provider).toBe('r2');
  });

  it('offers no default (instead of an unusable one) when an existing config has an unknown service', async () => {
    const existingYaml = ['service: bogus-service', 'source:', '  folders: [tech]', ''].join('\n');
    const targetPath = `${HOME_DIR}/.config/note2web/zenn.yaml`;
    const fs = createFakeFs({ [targetPath]: existingYaml });

    // 既定値が提示されないため、空回答を返し続けるとサービス選択が確定できず、
    // 再試行上限に達して InitError になる(不正な既存値が既定として採用されない証明)。
    const promptFn = makePromptFn({}, '');

    await expect(
      runInit(
        buildOptions({
          configPath: targetPath,
          promptFn,
          fileExistsFn: fs.fileExistsFn,
          readFileFn: fs.readFileFn,
          writeFileFn: fs.writeFileFn,
        }),
      ),
    ).rejects.toThrow(InitError);
  });

  it('throws InitError instead of looping forever when invalid answers keep coming', async () => {
    // すべての質問に無効な回答を返し続ける: 最初のサービス選択(askChoice)が
    // 再試行上限に達した時点で InitError になる。
    const promptFn = makePromptFn({}, 'not-a-valid-choice');
    const fs = createFakeFs();

    await expect(
      runInit(
        buildOptions({
          promptFn,
          fileExistsFn: fs.fileExistsFn,
          readFileFn: fs.readFileFn,
          writeFileFn: fs.writeFileFn,
        }),
      ),
    ).rejects.toThrow(/too many invalid answers/);
  });

  it('warns (but does not fail) about missing dependencies instead of throwing', async () => {
    const promptFn = makePromptFn(SERVICE_ANSWERS.zenn);
    const fs = createFakeFs();
    const result = await runInit(
      buildOptions({
        promptFn,
        fileExistsFn: fs.fileExistsFn,
        readFileFn: fs.readFileFn,
        writeFileFn: fs.writeFileFn,
        commandExistsFn: () => Promise.resolve(false),
        env: {},
      }),
    );

    const summary = result.summary.join('\n');
    expect(summary).toMatch(/Ruby/);
    expect(summary).toMatch(/git/);
    expect(summary).toMatch(/gh/);
    expect(summary).toMatch(/GH_TOKEN/);
  });

  it("warns when note2web's own bundled export script is missing (issue #73 Fix 5, parity with checkDependencies)", async () => {
    // `src/dependencies.ts` の `checkDependencies` は `NOTE2WEB_EXPORT_SCRIPT_PATH` の実在を
    // 既に検証している(`src/dependencies.test.ts` 参照)。`init` の依存案内
    // (`collectDependencyWarnings`)も同じ入力を使って同じチェックを行うべき、というのが
    // このテストの主張(以前は `init` 側だけこのチェックが漏れていた)。
    const promptFn = makePromptFn(SERVICE_ANSWERS.zenn);
    const fs = createFakeFs();
    // NOTE2WEB_EXPORT_SCRIPT_PATH だけを「存在しない」ことにする(createFakeFs は既定で
    // 「存在する」扱いにしているため、このテスト専用に fileExistsFn をラップする)。
    const fileExistsFnWithoutExportScript = (path: string): Promise<boolean> =>
      path === NOTE2WEB_EXPORT_SCRIPT_PATH ? Promise.resolve(false) : fs.fileExistsFn(path);
    const result = await runInit(
      buildOptions({
        promptFn,
        fileExistsFn: fileExistsFnWithoutExportScript,
        readFileFn: fs.readFileFn,
        writeFileFn: fs.writeFileFn,
        env: {},
      }),
    );

    const summary = result.summary.join('\n');
    expect(summary).toContain(NOTE2WEB_EXPORT_SCRIPT_PATH);
    expect(summary).toMatch(/\[依存\]/);
  });

  it('reports the noet dependency instructions for the note service without failing', async () => {
    const promptFn = makePromptFn(SERVICE_ANSWERS.note);
    const fs = createFakeFs();
    const result = await runInit(
      buildOptions({
        promptFn,
        fileExistsFn: fs.fileExistsFn,
        readFileFn: fs.readFileFn,
        writeFileFn: fs.writeFileFn,
        commandExistsFn: (command) => Promise.resolve(command === 'ruby'),
      }),
    );

    expect(result.summary.join('\n')).toMatch(/noet/);
  });

  it('lists unset *_env environment variables as next steps rather than failing', async () => {
    const promptFn = makePromptFn(SERVICE_ANSWERS.zenn);
    const fs = createFakeFs();
    const result = await runInit(
      buildOptions({
        promptFn,
        fileExistsFn: fs.fileExistsFn,
        readFileFn: fs.readFileFn,
        writeFileFn: fs.writeFileFn,
        env: {},
      }),
    );

    const summary = result.summary.join('\n');
    expect(summary).toMatch(/R2_ACCESS_KEY_ID/);
    expect(summary).toMatch(/GH_TOKEN/);
  });

  it('does not list environment variables that are already set in this shell', async () => {
    const promptFn = makePromptFn(SERVICE_ANSWERS.zenn);
    const fs = createFakeFs();
    const result = await runInit(
      buildOptions({
        promptFn,
        fileExistsFn: fs.fileExistsFn,
        readFileFn: fs.readFileFn,
        writeFileFn: fs.writeFileFn,
        env: {
          GH_TOKEN: 'token',
          R2_ACCESS_KEY_ID: 'value',
          R2_SECRET_ACCESS_KEY: 'value',
        },
      }),
    );

    expect(result.summary.join('\n')).not.toMatch(/\[環境変数\]/);
  });

  it('throws InitError (without writing launchd files) when the written config fails schema validation', async () => {
    const promptFn = makePromptFn(SERVICE_ANSWERS.zenn);
    const configPath = `${HOME_DIR}/custom.yaml`;
    const fs = createFakeFs();
    // 書き込み後の読み戻しだけを差し替え、スキーマに反する内容を返す(生成ロジック自体の
    // 不具合を模擬する)。書き込み自体は正常に行われる。
    const readFileFn = (path: string): Promise<string> => {
      if (path === configPath) {
        return Promise.resolve('service: not-a-real-service\n');
      }
      return fs.readFileFn(path);
    };

    try {
      await runInit(
        buildOptions({
          configPath,
          promptFn,
          fileExistsFn: fs.fileExistsFn,
          readFileFn,
          writeFileFn: fs.writeFileFn,
        }),
      );
      expect.unreachable('runInit should have thrown InitError');
    } catch (error) {
      expect(error).toBeInstanceOf(InitError);
      const initError = error as InitError;
      expect(initError.exitCode).toBe(2);
      expect(
        initError.problems.some((problem) => problem.message.includes('schema validation')),
      ).toBe(true);
    }
  });

  describe('launchd file generation', () => {
    const LAUNCHD_ANSWERS = {
      ...SERVICE_ANSWERS.zenn,
      'Generate the launchd': 'y',
    };

    it('creates the env file template (chmod 600) and a plist that runs node directly with a PATH-only EnvironmentVariables', async () => {
      const promptFn = makePromptFn(LAUNCHD_ANSWERS);
      const fs = createFakeFs();
      const result = await runInit(
        buildOptions({
          promptFn,
          fileExistsFn: fs.fileExistsFn,
          readFileFn: fs.readFileFn,
          writeFileFn: fs.writeFileFn,
          mkdirFn: fs.mkdirFn,
          chmodFn: fs.chmodFn,
          env: {},
        }),
      );

      const envPath = `${HOME_DIR}/.config/note2web/env`;
      const oldWrapperPath = `${HOME_DIR}/bin/note2web-sync.sh`;
      const plistPath = `${HOME_DIR}/Library/LaunchAgents/com.note2web.zenn.plist`;
      const expectedConfigPath = `${HOME_DIR}/.config/note2web/zenn.yaml`;

      expect(fs.modes.get(envPath)).toBe(0o600);
      // ラッパースクリプトはもう生成しない(issue #71)。
      expect(fs.files.has(oldWrapperPath)).toBe(false);

      const envContent = fs.files.get(envPath) ?? '';
      expect(envContent).toContain('GH_TOKEN=');
      expect(envContent).toContain('R2_ACCESS_KEY_ID=');
      expect(envContent).toContain('R2_SECRET_ACCESS_KEY=');
      // node / CLI パスの任意上書き変数名(NOTE2WEB_NODE / NOTE2WEB_CLI)はラッパー廃止に伴い
      // テンプレートから消える。
      expect(envContent).not.toContain('NOTE2WEB_NODE');
      expect(envContent).not.toContain('NOTE2WEB_CLI');
      // 値は常に空欄(秘匿値を絶対に書かない)。
      expect(envContent).not.toMatch(/GH_TOKEN=\S/);

      // 新規作成した env ファイルには Ruby 環境のヒント(コメント行のみ、issue #67)を
      // 含める。launchd 実行時の PATH は plist 側に自動的に埋め込まれる点に言及している。
      expect(envContent).toContain('[Ruby 環境のヒント](issue #67)');
      expect(envContent).toContain('issue #71');
      // PATH はもう env ファイルのヒントに例示しない(launchd は plist の
      // EnvironmentVariables の PATH を使う。対話実行はシェルの初期化ファイル、cron は
      // crontab 側の PATH 設定を使う旨を案内するのみ)。
      expect(envContent).not.toContain('PATH=/opt/homebrew/opt/ruby/bin:${PATH}');
      expect(envContent).toContain('~/.zshrc');
      expect(envContent).toContain('GEM_HOME=$HOME/.gem');
      expect(envContent).toContain('BUNDLE_GEMFILE=/path/to/apple_cloud_notes_parser/Gemfile');

      const plistContent = fs.files.get(plistPath) ?? '';
      expect(plistContent).toContain('<key>Label</key>');
      expect(plistContent).toContain('<string>com.note2web.zenn</string>');
      expect(plistContent).toContain('<key>StartInterval</key>');
      expect(plistContent).toContain('<integer>1800</integer>');
      expect(plistContent).toContain('<key>StandardOutPath</key>');
      expect(plistContent).toContain('<key>StandardErrorPath</key>');

      // ProgramArguments: [node実体, cli.js, 'sync', '--config', configPath] のこの順。
      const programArgumentsOrder = [
        `<string>${FAKE_NODE_EXEC_PATH}</string>`,
        '<string>/fake/install/dist/cli.js</string>',
        '<string>sync</string>',
        '<string>--config</string>',
        `<string>${expectedConfigPath}</string>`,
      ].map((needle) => plistContent.indexOf(needle));
      expect(programArgumentsOrder.every((index) => index >= 0)).toBe(true);
      expect([...programArgumentsOrder].sort((a, b) => a - b)).toEqual(programArgumentsOrder);

      // EnvironmentVariables には PATH という1つのキーしか存在しない。
      const environmentVariablesSection =
        plistContent.split('<key>EnvironmentVariables</key>')[1]?.split('</dict>')[0] ?? '';
      const environmentVariableKeys = [
        ...environmentVariablesSection.matchAll(/<key>([^<]+)<\/key>/g),
      ].map((match) => match[1]);
      expect(environmentVariableKeys).toEqual(['PATH']);

      const pathValueMatch = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(
        environmentVariablesSection,
      );
      const pathValue = pathValueMatch?.[1] ?? '';
      expect(pathValue).toContain('/fake/node/bin');
      expect(pathValue).toContain('/opt/homebrew/bin');
      expect(pathValue).toContain('/usr/local/bin');
      expect(pathValue).toContain('/usr/bin');
      expect(pathValue).toContain('/bin');
      expect(pathValue).toContain('/usr/sbin');
      expect(pathValue).toContain('/sbin');

      // 秘匿情報らしき名前は plist のどこにも出現しない(EnvironmentVariables 以外も含め全体)。
      expect(plistContent).not.toMatch(/GH_TOKEN|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY/);

      // 次に実行するコマンドの案内: LaunchAgent はユーザー単位のため sudo なしの
      // `launchctl bootstrap gui/$(id -u)` を案内する(レガシーな `launchctl load` や
      // `sudo launchctl` は案内しない)。パスはシングルクォート済みの形で埋め込まれる。
      // env ファイルの読み込みは CLI 自身が自動で行う(issue #70)ため、
      // 「現在のシェルに読み込む(set -a; . env; set +a)」の手順はもう案内しない。
      const summary = result.summary.join('\n');
      expect(summary).toContain('次に実行するコマンド');
      expect(summary).not.toContain('set -a');
      expect(summary).toContain(`\${EDITOR:-vi} '${envPath}'`);
      expect(summary).toContain(`note2web doctor --config '${expectedConfigPath}'`);
      expect(summary).toContain(`note2web sync --config '${expectedConfigPath}'`);
      expect(summary).toContain('フルディスクアクセス');
      expect(summary).toContain(FAKE_NODE_EXEC_PATH);
      expect(summary).toContain(`launchctl bootstrap gui/$(id -u) '${plistPath}'`);
      expect(summary).toContain('launchctl kickstart -k gui/$(id -u)/com.note2web.zenn');
      expect(summary).toContain(
        `tail -f '${HOME_DIR}/Library/Logs/note2web/zenn.log' '${HOME_DIR}/Library/Logs/note2web/zenn.err.log'`,
      );
      expect(summary).toContain('launchctl bootout gui/$(id -u)/com.note2web.zenn');
      expect(summary).not.toContain('launchctl load');
      expect(summary).not.toContain('sudo launchctl');
      // 手順が「env記入 → doctor → sync → フルディスクアクセス → bootstrap → kickstart →
      // tail」の順で並ぶこと。
      const order = [
        `\${EDITOR:-vi} '${envPath}'`,
        'note2web doctor --config',
        'note2web sync --config',
        'フルディスクアクセス',
        'launchctl bootstrap',
        'launchctl kickstart',
        'tail -f',
      ].map((needle) => summary.indexOf(needle));
      expect(order.every((index) => index >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('includes an existing rbenv shims directory in the plist PATH, and excludes it when absent', async () => {
      const rbenvShims = `${HOME_DIR}/.rbenv/shims`;
      const plistPath = `${HOME_DIR}/Library/LaunchAgents/com.note2web.zenn.plist`;

      const promptFnWithShims = makePromptFn(LAUNCHD_ANSWERS);
      const fsWithShims = createFakeFs({}, [rbenvShims]);
      await runInit(
        buildOptions({
          promptFn: promptFnWithShims,
          fileExistsFn: fsWithShims.fileExistsFn,
          readFileFn: fsWithShims.readFileFn,
          writeFileFn: fsWithShims.writeFileFn,
          mkdirFn: fsWithShims.mkdirFn,
          chmodFn: fsWithShims.chmodFn,
          env: {},
        }),
      );
      expect(fsWithShims.files.get(plistPath) ?? '').toContain(rbenvShims);

      const promptFnWithoutShims = makePromptFn(LAUNCHD_ANSWERS);
      const fsWithoutShims = createFakeFs();
      await runInit(
        buildOptions({
          promptFn: promptFnWithoutShims,
          fileExistsFn: fsWithoutShims.fileExistsFn,
          readFileFn: fsWithoutShims.readFileFn,
          writeFileFn: fsWithoutShims.writeFileFn,
          mkdirFn: fsWithoutShims.mkdirFn,
          chmodFn: fsWithoutShims.chmodFn,
          env: {},
        }),
      );
      expect(fsWithoutShims.files.get(plistPath) ?? '').not.toContain(rbenvShims);
    });

    it('appends only missing variable names to an existing env file without touching existing values', async () => {
      const envPath = `${HOME_DIR}/.config/note2web/env`;
      const promptFn = makePromptFn(LAUNCHD_ANSWERS);
      const fs = createFakeFs({
        [envPath]: '# pre-existing\nGH_TOKEN=already-set-do-not-touch\n',
      });

      await runInit(
        buildOptions({
          promptFn,
          fileExistsFn: fs.fileExistsFn,
          readFileFn: fs.readFileFn,
          writeFileFn: fs.writeFileFn,
          mkdirFn: fs.mkdirFn,
          chmodFn: fs.chmodFn,
          env: {},
        }),
      );

      const envContent = fs.files.get(envPath) ?? '';
      expect(envContent).toContain('GH_TOKEN=already-set-do-not-touch');
      expect(envContent).toContain('R2_ACCESS_KEY_ID=');
      // 既存ファイルへの追記は実在する変数名の行のみ(issue #67 の Ruby ヒントコメントは
      // 新規作成テンプレートにのみ含め、追記対象には含めない)。
      expect(envContent).not.toContain('# [Ruby 環境のヒント]');
      expect(envContent).toContain('R2_SECRET_ACCESS_KEY=');
    });

    it('notes that an old wrapper script left over from a previous version is no longer used, without touching it', async () => {
      const oldWrapperPath = `${HOME_DIR}/bin/note2web-sync.sh`;
      const promptFn = makePromptFn(LAUNCHD_ANSWERS);
      const fs = createFakeFs({
        [oldWrapperPath]: '#!/bin/sh\n# old wrapper from a older version\n',
      });

      const result = await runInit(
        buildOptions({
          promptFn,
          fileExistsFn: fs.fileExistsFn,
          readFileFn: fs.readFileFn,
          writeFileFn: fs.writeFileFn,
          mkdirFn: fs.mkdirFn,
          chmodFn: fs.chmodFn,
          env: {},
        }),
      );

      // 旧ラッパーは自動削除しない。
      expect(fs.files.get(oldWrapperPath)).toBe('#!/bin/sh\n# old wrapper from a older version\n');
      const summary = result.summary.join('\n');
      expect(summary).toContain(oldWrapperPath);
      expect(summary).toMatch(/no longer used/);
    });

    it('XML-escapes paths containing special characters in the generated plist', async () => {
      const configPath = `${HOME_DIR}/cfg & <dir>/zenn.yaml`;
      const promptFn = makePromptFn(LAUNCHD_ANSWERS);
      const fs = createFakeFs();
      await runInit(
        buildOptions({
          configPath,
          promptFn,
          fileExistsFn: fs.fileExistsFn,
          readFileFn: fs.readFileFn,
          writeFileFn: fs.writeFileFn,
          mkdirFn: fs.mkdirFn,
          chmodFn: fs.chmodFn,
          env: {},
        }),
      );

      const plistContent =
        fs.files.get(`${HOME_DIR}/Library/LaunchAgents/com.note2web.zenn.plist`) ?? '';
      expect(plistContent).toContain(
        '<string>/home/tester/cfg &amp; &lt;dir&gt;/zenn.yaml</string>',
      );
      // エスケープ前の生の値が plist を壊す形で残っていないこと。
      expect(plistContent).not.toContain('cfg & <dir>');
    });

    it('skips plist generation (but still writes the env file) with a warning when the CLI entrypoint cannot be resolved', async () => {
      const promptFn = makePromptFn(LAUNCHD_ANSWERS);
      const fs = createFakeFs();
      const result = await runInit(
        buildOptions({
          promptFn,
          fileExistsFn: fs.fileExistsFn,
          readFileFn: fs.readFileFn,
          writeFileFn: fs.writeFileFn,
          mkdirFn: fs.mkdirFn,
          chmodFn: fs.chmodFn,
          resolveCliEntrypointFn: () => undefined,
          env: {},
        }),
      );

      expect(fs.files.has(`${HOME_DIR}/Library/LaunchAgents/com.note2web.zenn.plist`)).toBe(false);
      expect(fs.files.has(`${HOME_DIR}/.config/note2web/env`)).toBe(true);
      const summary = result.summary.join('\n');
      expect(summary).toMatch(/skipping launchd plist generation/i);
      // 未ビルド(dist/cli.js 不在 = note2web コマンドも PATH に無い)状態なので、
      // 復旧手順は PATH 上の `note2web` ではなく、ビルド後の成果物を node で直接
      // 実行する形で案内される。
      expect(summary).toContain('npm run build');
      expect(summary).toContain('node dist/cli.js doctor --config');
      expect(summary).toContain('node dist/cli.js sync --config');
      expect(summary).not.toMatch(/(^|\s)note2web doctor --config/m);
    });

    it('skips plist generation (but still writes the env file) with a warning when the resolved CLI entrypoint path does not exist on disk (e.g. before "npm run build")', async () => {
      const promptFn = makePromptFn(LAUNCHD_ANSWERS);
      const fs = createFakeFs();
      const unbuiltCliPath = '/fake/install/dist/cli.js.not-built-yet';
      const result = await runInit(
        buildOptions({
          promptFn,
          fileExistsFn: fs.fileExistsFn,
          readFileFn: fs.readFileFn,
          writeFileFn: fs.writeFileFn,
          mkdirFn: fs.mkdirFn,
          chmodFn: fs.chmodFn,
          // パスは解決できるが、フェイク fs には存在しない(= 未ビルドのソースチェック
          // アウトから `note2web init` を実行した状態を模擬する)。
          resolveCliEntrypointFn: () => unbuiltCliPath,
          env: {},
        }),
      );

      expect(fs.files.has(`${HOME_DIR}/Library/LaunchAgents/com.note2web.zenn.plist`)).toBe(false);
      expect(fs.files.has(`${HOME_DIR}/.config/note2web/env`)).toBe(true);
      const summary = result.summary.join('\n');
      expect(summary).toMatch(/skipping launchd plist generation/i);
      // 未ビルド(dist/cli.js 不在 = note2web コマンドも PATH に無い)状態なので、
      // 復旧手順は PATH 上の `note2web` ではなく、ビルド後の成果物を node で直接
      // 実行する形で案内される。
      expect(summary).toContain('npm run build');
      expect(summary).toContain('node dist/cli.js doctor --config');
      expect(summary).toContain('node dist/cli.js sync --config');
      expect(summary).not.toMatch(/(^|\s)note2web doctor --config/m);
    });

    it('colocates the generated env file with a custom --config path instead of the default ~/.config/note2web', async () => {
      const configPath = '/custom/dir/myblog.yaml';
      const promptFn = makePromptFn(LAUNCHD_ANSWERS);
      const fs = createFakeFs();
      const result = await runInit(
        buildOptions({
          configPath,
          promptFn,
          fileExistsFn: fs.fileExistsFn,
          readFileFn: fs.readFileFn,
          writeFileFn: fs.writeFileFn,
          mkdirFn: fs.mkdirFn,
          chmodFn: fs.chmodFn,
          env: {},
        }),
      );

      const expectedEnvPath = '/custom/dir/env';
      expect(fs.files.has(expectedEnvPath)).toBe(true);
      // 既定パス(~/.config/note2web/env)には書かれない。
      expect(fs.files.has(`${HOME_DIR}/.config/note2web/env`)).toBe(false);
      const summary = result.summary.join('\n');
      expect(summary).toContain(expectedEnvPath);
    });

    it('falls back to the 1800-second default when StartInterval is not a positive integer', async () => {
      const promptFn = makePromptFn({
        ...LAUNCHD_ANSWERS,
        StartInterval: '1.5',
      });
      const fs = createFakeFs();
      await runInit(
        buildOptions({
          promptFn,
          fileExistsFn: fs.fileExistsFn,
          readFileFn: fs.readFileFn,
          writeFileFn: fs.writeFileFn,
          mkdirFn: fs.mkdirFn,
          chmodFn: fs.chmodFn,
          env: {},
        }),
      );

      const plistContent =
        fs.files.get(`${HOME_DIR}/Library/LaunchAgents/com.note2web.zenn.plist`) ?? '';
      // 小数をそのまま <integer> へ書くと launchctl がロードできないため、既定値へ倒す。
      expect(plistContent).toContain('<integer>1800</integer>');
      expect(plistContent).not.toContain('1.5');
    });

    it('skips launchd file generation entirely when declined (the default)', async () => {
      const promptFn = makePromptFn(SERVICE_ANSWERS.zenn);
      const fs = createFakeFs();
      const result = await runInit(
        buildOptions({
          promptFn,
          fileExistsFn: fs.fileExistsFn,
          readFileFn: fs.readFileFn,
          writeFileFn: fs.writeFileFn,
          mkdirFn: fs.mkdirFn,
          chmodFn: fs.chmodFn,
        }),
      );

      expect(fs.files.has(`${HOME_DIR}/.config/note2web/env`)).toBe(false);
      expect(fs.files.has(`${HOME_DIR}/bin/note2web-sync.sh`)).toBe(false);
      const summary = result.summary.join('\n');
      expect(summary).toContain('Skipped launchd file generation');
      // launchd を生成しない場合も、次に実行するコマンド(env 設定 → doctor → sync)を
      // この順序で案内する。
      expect(summary).toContain('次に実行するコマンド');
      expect(summary).toContain('export <変数名>=<値>');
      expect(summary).toContain('note2web doctor --config');
      expect(summary).toContain('note2web sync --config');
      expect(summary.indexOf('export <変数名>=<値>')).toBeLessThan(
        summary.indexOf('note2web doctor --config'),
      );
      expect(summary.indexOf('note2web doctor --config')).toBeLessThan(
        summary.indexOf('note2web sync --config'),
      );
    });
  });
});
