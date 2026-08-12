import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkDependencies,
  DependencyCheckError,
  type CheckDependenciesOptions,
} from './dependencies.js';
import type { Config } from './config.js';

/** `checkDependencies` が `DependencyCheckError` で reject することを検証しつつ、その値を受け取る。 */
async function expectDependencyError(
  config: Config,
  options?: CheckDependenciesOptions,
): Promise<DependencyCheckError> {
  try {
    await checkDependencies(config, options);
  } catch (error) {
    expect(error).toBeInstanceOf(DependencyCheckError);
    return error as DependencyCheckError;
  }
  throw new Error(
    'unreachable: checkDependencies was expected to reject with DependencyCheckError',
  );
}

/** `checkDependencies` に渡す最小限の検証済み設定。`overrides` でサービス別ブロックを足す。 */
function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    service: 'zenn',
    timezone: 'Asia/Tokyo',
    source: { folders: ['tech'] },
    assets: {
      provider: 'r2',
      bucket: 'blog-assets',
      endpoint: 'https://example-account.r2.cloudflarestorage.com',
      region: 'auto',
      prefix: 'notes/',
      public_base_url: 'https://assets.example.com/notes/',
      access_key_id_env: 'R2_ACCESS_KEY_ID',
      secret_access_key_env: 'R2_SECRET_ACCESS_KEY',
    },
    git: {
      repo_path: '~/src/zenn-content',
      base_branch: 'main',
      output_dir: 'articles',
      auto_merge: true,
    },
    ...overrides,
  };
}

describe('checkDependencies', () => {
  let dir: string;
  let parserPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'note2web-dependencies-test-'));
    parserPath = join(dir, 'parser');
    mkdirSync(parserPath, { recursive: true });
    writeFileSync(join(parserPath, 'notes_cloud_ripper.rb'), '# fixture stub\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes for a git-mode service when ruby/git/gh exist, the parser entry point exists, and GH_TOKEN is set', async () => {
    const commands = new Set(['ruby', 'git', 'gh']);
    await expect(
      checkDependencies(
        buildConfig({ exporter: { parser_path: parserPath, notes_container: '/dev/null' } }),
        {
          commandExistsFn: (command) => Promise.resolve(commands.has(command)),
          env: { GH_TOKEN: 'token-value' },
        },
      ),
    ).resolves.toBeUndefined();
  });

  it('reports every missing common dependency at once (ruby + parser entry point)', async () => {
    const error = await expectDependencyError(
      buildConfig({
        exporter: { parser_path: join(dir, 'missing-parser'), notes_container: '/dev/null' },
      }),
      { commandExistsFn: () => Promise.resolve(false), env: { GH_TOKEN: 'token-value' } },
    );

    expect(error.exitCode).toBe(2);
    const messages = error.problems.map((problem) => problem.message).join('\n');
    expect(messages).toMatch(/"ruby"/);
    expect(messages).toMatch(/apple_cloud_notes_parser entry point not found/);
    // git mode の git/gh も同時に不足として報告される(1件見つけて打ち切らない)。
    expect(error.problems.length).toBeGreaterThanOrEqual(4);
  });

  it('requires git, gh, and GH_TOKEN for git-mode services (zenn/hugo/jekyll) but not for others', async () => {
    const commands = new Set(['ruby']);
    const error = await expectDependencyError(
      buildConfig({ exporter: { parser_path: parserPath, notes_container: '/dev/null' } }),
      { commandExistsFn: (command) => Promise.resolve(commands.has(command)), env: {} },
    );

    const messages = error.problems.map((problem) => problem.message).join('\n');
    expect(messages).toMatch(/"git"/);
    expect(messages).toMatch(/"gh"/);
    expect(messages).toMatch(/GH_TOKEN/);
  });

  it('does not require GH_TOKEN or git/gh for qiita, and instead requires node/npx', async () => {
    const commands = new Set(['ruby']);
    const error = await expectDependencyError(
      buildConfig({
        service: 'qiita',
        git: undefined,
        qiita: { workspace: '~/src/qiita-content', token_env: 'QIITA_TOKEN' },
        exporter: { parser_path: parserPath, notes_container: '/dev/null' },
      }),
      { commandExistsFn: (command) => Promise.resolve(commands.has(command)), env: {} },
    );

    const messages = error.problems.map((problem) => problem.message).join('\n');
    expect(messages).not.toMatch(/"git"/);
    expect(messages).not.toMatch(/"gh"/);
    expect(messages).not.toMatch(/GH_TOKEN/);
    expect(messages).toMatch(/"node"/);
    expect(messages).toMatch(/"npx"/);
  });

  it('reports a problem when @qiita/qiita-cli is not resolvable, without affecting other qiita checks', async () => {
    const commands = new Set(['ruby', 'node', 'npx']);
    const error = await expectDependencyError(
      buildConfig({
        service: 'qiita',
        git: undefined,
        qiita: { workspace: '~/src/qiita-content', token_env: 'QIITA_TOKEN' },
        exporter: { parser_path: parserPath, notes_container: '/dev/null' },
      }),
      {
        commandExistsFn: (command) => Promise.resolve(commands.has(command)),
        env: {},
        qiitaCliResolvableFn: () => false,
        nodeVersionFn: () => 'v22.0.0',
        qiitaCliEnginesFn: () => '>=20.0.0',
      },
    );

    const messages = error.problems.map((problem) => problem.message).join('\n');
    expect(messages).toMatch(/@qiita\/qiita-cli/);
    expect(messages).not.toMatch(/"node"/);
    expect(messages).not.toMatch(/"npx"/);
    expect(messages).not.toMatch(/engine/);
  });

  it('reports a problem via the >=20 fallback when the engines declaration is unavailable', async () => {
    const commands = new Set(['ruby', 'node', 'npx']);
    const error = await expectDependencyError(
      buildConfig({
        service: 'qiita',
        git: undefined,
        qiita: { workspace: '~/src/qiita-content', token_env: 'QIITA_TOKEN' },
        exporter: { parser_path: parserPath, notes_container: '/dev/null' },
      }),
      {
        commandExistsFn: (command) => Promise.resolve(commands.has(command)),
        env: {},
        qiitaCliResolvableFn: () => true,
        nodeVersionFn: () => 'v18.19.0',
        qiitaCliEnginesFn: () => undefined,
      },
    );

    const messages = error.problems.map((problem) => problem.message).join('\n');
    expect(messages).toMatch(/v18\.19\.0/);
    expect(messages).toMatch(/engine/);
  });

  it('rejects a Node.js version below the installed qiita-cli engines declaration (e.g. >=22.22.1)', async () => {
    // v1.10.0 の実際の宣言(>=22.22.1)はメジャー 20 の下限より厳しい。宣言が取得できる
    // 場合はそちらが優先されることを確認する(v22.13.0 はメジャーでは通るが宣言では不足)。
    const commands = new Set(['ruby', 'node', 'npx']);
    const error = await expectDependencyError(
      buildConfig({
        service: 'qiita',
        git: undefined,
        qiita: { workspace: '~/src/qiita-content', token_env: 'QIITA_TOKEN' },
        exporter: { parser_path: parserPath, notes_container: '/dev/null' },
      }),
      {
        commandExistsFn: (command) => Promise.resolve(commands.has(command)),
        env: {},
        qiitaCliResolvableFn: () => true,
        nodeVersionFn: () => 'v22.13.0',
        qiitaCliEnginesFn: () => '>=22.22.1',
      },
    );

    const messages = error.problems.map((problem) => problem.message).join('\n');
    expect(messages).toMatch(/>=22\.22\.1/);
    expect(messages).toMatch(/v22\.13\.0/);
  });

  it('passes the qiita-cli resolvability and Node engine checks when both are satisfied', async () => {
    const commands = new Set(['ruby', 'node', 'npx']);
    await expect(
      checkDependencies(
        buildConfig({
          service: 'qiita',
          git: undefined,
          qiita: { workspace: '~/src/qiita-content', token_env: 'QIITA_TOKEN' },
          exporter: { parser_path: parserPath, notes_container: '/dev/null' },
        }),
        {
          commandExistsFn: (command) => Promise.resolve(commands.has(command)),
          env: {},
          qiitaCliResolvableFn: () => true,
          nodeVersionFn: () => 'v22.22.1',
          qiitaCliEnginesFn: () => '>=22.22.1',
        },
      ),
    ).resolves.toBeUndefined();
  });

  it('requires nothing beyond the common checks for devto (DEVTO_API_KEY is validated by config.ts)', async () => {
    const commands = new Set(['ruby']);
    await expect(
      checkDependencies(
        buildConfig({
          service: 'devto',
          git: undefined,
          devto: { api_key_env: 'DEVTO_API_KEY' },
          exporter: { parser_path: parserPath, notes_container: '/dev/null' },
        }),
        { commandExistsFn: (command) => Promise.resolve(commands.has(command)), env: {} },
      ),
    ).resolves.toBeUndefined();
  });

  it('requires nothing beyond the common checks for hatena (HATENA_API_KEY is validated by config.ts)', async () => {
    const commands = new Set(['ruby']);
    await expect(
      checkDependencies(
        buildConfig({
          service: 'hatena',
          git: undefined,
          hatena: {
            hatena_id: 'example',
            blog_id: 'example.hatenablog.com',
            api_key_env: 'HATENA_API_KEY',
          },
          exporter: { parser_path: parserPath, notes_container: '/dev/null' },
        }),
        { commandExistsFn: (command) => Promise.resolve(commands.has(command)), env: {} },
      ),
    ).resolves.toBeUndefined();
  });

  it('requires the noet command for note', async () => {
    const commands = new Set(['ruby']);
    const error = await expectDependencyError(
      buildConfig({
        service: 'note',
        git: undefined,
        note: { workspace: '~/src/note-content' },
        exporter: { parser_path: parserPath, notes_container: '/dev/null' },
      }),
      { commandExistsFn: (command) => Promise.resolve(commands.has(command)), env: {} },
    );

    expect(error.problems.map((problem) => problem.message).join('\n')).toMatch(/"noet"/);
  });

  it('expands a leading ~ in exporter.parser_path when locating notes_cloud_ripper.rb', async () => {
    // 実ファイルシステムに依存せず、fileExistsFn へ渡された実際のパスを記録して検証する
    // (CodeRabbit review, PR #47: ホスト環境の実在有無に依存させない)。
    const commands = new Set(['ruby', 'git', 'gh']);
    const checkedPaths: string[] = [];
    const error = await expectDependencyError(buildConfig(), {
      commandExistsFn: (command) => Promise.resolve(commands.has(command)),
      fileExistsFn: (path) => {
        checkedPaths.push(path);
        return Promise.resolve(false);
      },
      env: { GH_TOKEN: 'token-value' },
    });

    expect(checkedPaths).toHaveLength(1);
    const checkedPath = checkedPaths[0];
    if (checkedPath === undefined) {
      throw new Error('test setup: fileExistsFn was not called');
    }
    // `~` が展開され、絶対パス(`~/` を含まない)になっていること。
    expect(checkedPath).not.toContain('~/');
    expect(checkedPath).toMatch(/^\//);
    expect(checkedPath.endsWith('notes_cloud_ripper.rb')).toBe(true);

    const message = error.problems.map((problem) => problem.message).join('\n');
    expect(message).not.toContain('~/');
    expect(message).toContain(checkedPath);
  });
});
