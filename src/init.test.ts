import { describe, expect, it, vi, type Mock } from 'vitest';
import { parse as parseYaml } from 'yaml';
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

/** インメモリのフェイクファイルシステム。`runInit` が実ホームディレクトリへ触れないようにする。 */
function createFakeFs(initialFiles: Record<string, string> = {}): {
  files: Map<string, string>;
  modes: Map<string, number>;
  fileExistsFn: (path: string) => Promise<boolean>;
  readFileFn: (path: string) => Promise<string>;
  writeFileFn: (path: string, content: string, options?: { mode?: number }) => Promise<void>;
  mkdirFn: (path: string) => Promise<void>;
  chmodFn: (path: string, mode: number) => Promise<void>;
} {
  const files = new Map(Object.entries(initialFiles));
  const modes = new Map<string, number>();
  return {
    files,
    modes,
    fileExistsFn: (path) => Promise.resolve(files.has(path)),
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
    qiitaCliResolvableFn: () => true,
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
        qiitaCliResolvableFn: () => true,
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
        expect(qiita.workspace).toBe('~/src/qiita-content');
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

    it('creates the env file template (chmod 600), wrapper script (chmod 700), and plist with no secrets', async () => {
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
      const wrapperPath = `${HOME_DIR}/bin/note2web-sync.sh`;
      const plistPath = `${HOME_DIR}/Library/LaunchAgents/com.note2web.zenn.plist`;
      const expectedConfigPath = `${HOME_DIR}/.config/note2web/zenn.yaml`;

      expect(fs.modes.get(envPath)).toBe(0o600);
      expect(fs.modes.get(wrapperPath)).toBe(0o700);

      const envContent = fs.files.get(envPath) ?? '';
      expect(envContent).toContain('GH_TOKEN=');
      expect(envContent).toContain('R2_ACCESS_KEY_ID=');
      expect(envContent).toContain('R2_SECRET_ACCESS_KEY=');
      // 値は常に空欄(秘匿値を絶対に書かない)。
      expect(envContent).not.toMatch(/GH_TOKEN=\S/);

      const wrapperContent = fs.files.get(wrapperPath) ?? '';
      expect(wrapperContent).toContain('#!/bin/sh');
      expect(wrapperContent).toContain('set -a');
      expect(wrapperContent).toContain('. "$HOME/.config/note2web/env"');
      expect(wrapperContent).toMatch(
        /exec "\$NPX" --yes note2web@\d+\.\d+\.\d+ sync --config "\$1"/,
      );

      const plistContent = fs.files.get(plistPath) ?? '';
      expect(plistContent).not.toContain('EnvironmentVariables');
      expect(plistContent).toContain('<key>Label</key>');
      expect(plistContent).toContain('<string>com.note2web.zenn</string>');
      expect(plistContent).toContain(`<string>${wrapperPath}</string>`);
      expect(plistContent).toContain('<key>StartInterval</key>');
      expect(plistContent).toContain('<integer>1800</integer>');
      expect(plistContent).toContain('<key>StandardOutPath</key>');
      expect(plistContent).toContain('<key>StandardErrorPath</key>');
      // env の値そのものは plist のどこにも出現しない。
      expect(plistContent).not.toMatch(/GH_TOKEN|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY/);

      // 次に実行するコマンドの案内: LaunchAgent はユーザー単位のため sudo なしの
      // `launchctl bootstrap gui/$(id -u)` を案内する(レガシーな `launchctl load` や
      // `sudo launchctl` は案内しない)。パスはシングルクォート済みの形で埋め込まれる。
      const summary = result.summary.join('\n');
      expect(summary).toContain('次に実行するコマンド');
      expect(summary).toContain(`\${EDITOR:-vi} '${envPath}'`);
      expect(summary).toContain(`set -a; . '${envPath}'; set +a`);
      expect(summary).toContain(`note2web doctor --config '${expectedConfigPath}'`);
      expect(summary).toContain(`note2web sync --config '${expectedConfigPath}'`);
      expect(summary).toContain(`launchctl bootstrap gui/$(id -u) '${plistPath}'`);
      expect(summary).toContain('launchctl kickstart -k gui/$(id -u)/com.note2web.zenn');
      expect(summary).toContain(
        `tail -f '${HOME_DIR}/Library/Logs/note2web/zenn.log' '${HOME_DIR}/Library/Logs/note2web/zenn.err.log'`,
      );
      expect(summary).toContain('launchctl bootout gui/$(id -u)/com.note2web.zenn');
      expect(summary).not.toContain('launchctl load');
      expect(summary).not.toContain('sudo launchctl');
      // 手順が「env 読み込み → doctor → sync → bootstrap → kickstart → tail」の順で並ぶこと。
      const order = [
        'set -a; .',
        'note2web doctor --config',
        'note2web sync --config',
        'launchctl bootstrap',
        'launchctl kickstart',
        'tail -f',
      ].map((needle) => summary.indexOf(needle));
      expect(order.every((index) => index >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
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
      expect(envContent).toContain('R2_SECRET_ACCESS_KEY=');
    });

    it('keeps an existing wrapper script unchanged by default (declines overwrite)', async () => {
      const wrapperPath = `${HOME_DIR}/bin/note2web-sync.sh`;
      const promptFn = makePromptFn(LAUNCHD_ANSWERS);
      const fs = createFakeFs({ [wrapperPath]: '#!/bin/sh\n# custom wrapper, keep me\n' });

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

      expect(fs.files.get(wrapperPath)).toBe('#!/bin/sh\n# custom wrapper, keep me\n');
      expect(result.summary.join('\n')).toContain('Kept existing wrapper script unchanged');
    });

    it('overwrites an existing wrapper script when the user confirms', async () => {
      const wrapperPath = `${HOME_DIR}/bin/note2web-sync.sh`;
      const promptFn = makePromptFn({
        ...LAUNCHD_ANSWERS,
        'Overwrite it': 'y',
      });
      const fs = createFakeFs({ [wrapperPath]: '#!/bin/sh\n# stale wrapper\n' });

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

      expect(fs.files.get(wrapperPath)).toContain('exec "$NPX"');
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

    it('generates an unpinned wrapper with a warning when the package version cannot be determined', async () => {
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
          readPackageVersionFn: () => undefined,
          env: {},
        }),
      );

      const wrapperContent = fs.files.get(`${HOME_DIR}/bin/note2web-sync.sh`) ?? '';
      // バージョン不明時は `note2web@0.0.0` のような偽ピンではなく、ピンなしで生成する。
      expect(wrapperContent).toContain('exec "$NPX" --yes note2web sync --config "$1"');
      expect(wrapperContent).not.toContain('note2web@');
      expect(result.summary.join('\n')).toMatch(/could not determine the note2web package version/);
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
