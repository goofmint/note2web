import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveTarget, DEVTO_TARGET, QIITA_TARGET, resolveStatePath } from './derive.js';
import type { Config } from '../config.js';

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

describe('resolveStatePath', () => {
  it('defaults to "<config file name without extension>.state.json" next to the config file', () => {
    const configPath = join(sep, 'home', 'user', '.config', 'note2web', 'zenn.yaml');
    expect(resolveStatePath(configPath, buildConfig())).toBe(
      join(sep, 'home', 'user', '.config', 'note2web', 'zenn.state.json'),
    );
  });

  it('resolves a configured state_file relative to the config file directory', () => {
    const configPath = join(sep, 'home', 'user', '.config', 'note2web', 'zenn.yaml');
    expect(
      resolveStatePath(configPath, buildConfig({ state_file: './zenn.custom.state.json' })),
    ).toBe(join(sep, 'home', 'user', '.config', 'note2web', 'zenn.custom.state.json'));
  });

  it('honors an absolute state_file as-is', () => {
    const configPath = join(sep, 'home', 'user', '.config', 'note2web', 'zenn.yaml');
    const absolute = join(sep, 'var', 'lib', 'note2web', 'zenn.state.json');
    expect(resolveStatePath(configPath, buildConfig({ state_file: absolute }))).toBe(absolute);
  });
});

describe('deriveTarget', () => {
  it.each(['zenn', 'hugo', 'jekyll'] as const)(
    'uses git.repo_path for git-mode service "%s"',
    (service) => {
      expect(
        deriveTarget(
          buildConfig({
            service,
            git: { repo_path: '/repos/example', base_branch: 'main', output_dir: 'articles' },
          }),
        ),
      ).toBe('/repos/example');
    },
  );

  it('uses a fixed constant for qiita (no user-configured identifier exists in the schema, issue #82)', () => {
    expect(
      deriveTarget(
        buildConfig({
          service: 'qiita',
          git: undefined,
          qiita: { token_env: 'QIITA_TOKEN' },
        }),
      ),
      // リテラルで固定する: QIITA_TARGET 定数自身と比較すると定数値の変更を検知できない
      // (PR #83 CodeRabbit レビュー)。定数と状態ファイル互換性のための値の一致も確認する。
    ).toBe('qiita.com');
    expect(QIITA_TARGET).toBe('qiita.com');
  });

  it('uses note.workspace for note', () => {
    expect(
      deriveTarget(
        buildConfig({ service: 'note', git: undefined, note: { workspace: '/workspaces/note' } }),
      ),
    ).toBe('/workspaces/note');
  });

  it('uses hatena.blog_id for hatena', () => {
    expect(
      deriveTarget(
        buildConfig({
          service: 'hatena',
          git: undefined,
          hatena: {
            hatena_id: 'example',
            blog_id: 'example.hatenablog.com',
            api_key_env: 'HATENA_API_KEY',
          },
        }),
      ),
    ).toBe('example.hatenablog.com');
  });

  it('uses a fixed constant for devto (no user-configured identifier exists in the schema)', () => {
    expect(
      deriveTarget(
        buildConfig({ service: 'devto', git: undefined, devto: { api_key_env: 'DEVTO_API_KEY' } }),
      ),
    ).toBe(DEVTO_TARGET);
  });

  it('throws if the required block is missing (schema should have prevented this)', () => {
    expect(() => deriveTarget(buildConfig({ service: 'zenn', git: undefined }))).toThrow(
      /internal error/,
    );
  });
});
