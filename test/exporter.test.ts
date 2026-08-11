import { cp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NOTES_CONTAINER,
  DEFAULT_PARSER_PATH,
  ExportError,
  exportAppleNotes,
  type SubprocessRunner,
} from '../src/exporter/apple-notes.js';
import type { Config } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import { DEFAULT_TIMEOUTS, type RunSubprocessOptions } from '../src/subprocess.js';

/**
 * T-08(GitHub issue #13)の成果物。読み取り専用として扱い、決してこのディレクトリ配下を
 * 書き換えない(コピー先の一時ディレクトリのみを操作する)。
 */
const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/parser-output/', import.meta.url));

/** `exportAppleNotes` に渡す最小限の検証済み設定(zenn サービス、`exporter` は省略可)。 */
function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    service: 'zenn',
    timezone: 'Asia/Tokyo',
    source: { folders: ['Tech'] },
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

/** `Logger` の全メソッドを `vi.fn()` にしたフェイク(`noteFailed` / `exportDone` を主に検証する)。 */
function createFakeLogger(): Logger {
  return {
    runStart: vi.fn(),
    runEnd: vi.fn(),
    exportDone: vi.fn(),
    notePublished: vi.fn(),
    noteSkipped: vi.fn(),
    noteFailed: vi.fn(),
    assetUploaded: vi.fn(),
    warn: vi.fn(),
  };
}

/**
 * T-05 のランナー契約(`RunSubprocessOptions` → `Promise<RunSubprocessResult>`)を満たす
 * フェイク。呼ばれると `-o` 引数が指す出力先ディレクトリへ T-08 の fixture ツリーを
 * 再帰コピーし(fixture 自体は書き換えない)、成功結果を返す。
 * `afterCopy` を渡すと、コピー完了後・結果を返す前に呼ばれる(HTML 欠落等の変異に使う)。
 */
function makeFixtureRunner(afterCopy?: (outDir: string) => Promise<void>): {
  runner: SubprocessRunner;
  calls: RunSubprocessOptions[];
} {
  const calls: RunSubprocessOptions[] = [];
  const runner: SubprocessRunner = async (options) => {
    calls.push(options);
    const outIndex = options.args.indexOf('-o');
    const outDir = outIndex >= 0 ? options.args[outIndex + 1] : undefined;
    if (outDir === undefined) {
      throw new Error('test fixture runner: -o argument not found in args');
    }
    await cp(FIXTURE_ROOT, outDir, { recursive: true });
    await afterCopy?.(outDir);
    return { status: 'success', exitCode: 0, signal: null, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

describe('exportAppleNotes', () => {
  let workDir: string;

  beforeEach(async () => {
    // `mkdtempFactory` 未指定時の既定挙動(実 mkdtemp)をテストごとに個別ディレクトリで
    // 動かしたいので、ここでは `tmpDirFactory` を注入してテストが管理する一時ディレクトリを
    // 直接返す(cleanup を確実にするため)。
    const { mkdtemp } = await import('node:fs/promises');
    workDir = await mkdtemp(join(tmpdir(), 'note2web-exporter-test-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('sends the documented parser command shape and timeout to the runner', async () => {
    const { runner, calls } = makeFixtureRunner();

    const result = await exportAppleNotes({
      config: buildConfig({
        source: { folders: ['Tech'] },
        exporter: {
          parser_path: '/opt/apple_cloud_notes_parser',
          notes_container: '/mnt/notes-container',
        },
      }),
      runner,
      tmpDirFactory: async () => workDir,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    expect(call?.command).toBe('ruby');
    expect(call?.args).toEqual([
      'notes_cloud_ripper.rb',
      '-m',
      '/mnt/notes-container',
      '-o',
      workDir,
      '--individual-files',
      '--uuid',
    ]);
    expect(call?.cwd).toBe('/opt/apple_cloud_notes_parser');
    expect(call?.timeoutMs).toBe(DEFAULT_TIMEOUTS.parser);
    expect(result.exportDir).toBe(workDir);
  });

  it('expands leading ~ and uses design.md §7 defaults when the exporter block is omitted', async () => {
    const { runner, calls } = makeFixtureRunner();

    await exportAppleNotes({
      config: buildConfig({ source: { folders: ['Tech'] } }),
      runner,
      tmpDirFactory: async () => workDir,
    });

    expect(DEFAULT_PARSER_PATH.startsWith('~/')).toBe(true);
    expect(DEFAULT_NOTES_CONTAINER.startsWith('~/')).toBe(true);

    const call = calls[0];
    expect(call?.cwd).toBe(join(homedir(), DEFAULT_PARSER_PATH.slice(2)));
    const outIndex = call?.args.indexOf('-m') ?? -1;
    expect(outIndex).toBeGreaterThanOrEqual(0);
    expect(call?.args[outIndex + 1]).toBe(join(homedir(), DEFAULT_NOTES_CONTAINER.slice(2)));
  });

  it('resolves individual HTML uniquely for every note in configured folders (incl. symbol-named folder)', async () => {
    const { runner } = makeFixtureRunner();

    const result = await exportAppleNotes({
      config: buildConfig({ source: { folders: ['Tech', 'Dev/Ops: Log'] } }),
      runner,
      tmpDirFactory: async () => workDir,
    });

    expect(result.failed).toEqual([]);
    // Tech(root) 3件 + Tech/Archive(子フォルダ) 1件 + Dev/Ops: Log(記号入りルート) 1件。
    expect(result.notes).toHaveLength(5);

    const byUuid = new Map(result.notes.map((note) => [note.uuid, note]));

    const salesTable = byUuid.get('44444444-4444-4444-8444-444444444444');
    expect(salesTable?.folder).toBe('Tech');
    expect(salesTable?.bodyHtml).toContain('id="note_44444444-4444-4444-8444-444444444444"');
    expect(salesTable?.bodyHtml).toContain('<table>');
    // title / emoji / tags はメタデータ抽出層(T-10)の担当。Exporter は空値のまま。
    expect(salesTable?.title).toBe('');
    expect(salesTable?.emoji).toBeNull();
    expect(salesTable?.tags).toEqual([]);
    expect(salesTable?.createdAt.toISOString()).toBe('2026-01-10T09:15:00.000Z');
    expect(salesTable?.updatedAt.toISOString()).toBe('2026-01-12T18:42:00.000Z');
    expect(salesTable?.attachments).toEqual([]);

    const grocery = byUuid.get('55555555-5555-4555-8555-555555555555');
    expect(grocery?.bodyHtml).toContain('id="note_55555555-5555-4555-8555-555555555555"');
    expect(grocery?.bodyHtml).toContain('class="checklist"');

    const whiteboard = byUuid.get('66666666-6666-4666-8666-666666666666');
    expect(whiteboard?.bodyHtml).toContain('id="note_66666666-6666-4666-8666-666666666666"');
    expect(whiteboard?.attachments).toEqual([
      {
        identifier: '88888888-8888-4888-8888-888888888888',
        path: 'Accounts/11111111-1111-4111-8111-111111111111/FallbackImages/88888888-8888-4888-8888-888888888888/AAAAAAAAAAAAAAAAAAAAAA==/FallbackImage.png',
      },
    ]);

    const launch = byUuid.get('77777777-7777-4777-8777-777777777777');
    expect(launch?.folder).toBe('Archive');
    expect(launch?.bodyHtml).toContain('id="note_77777777-7777-4777-8777-777777777777"');

    const opsLog = byUuid.get('eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee');
    expect(opsLog?.folder).toBe('Dev/Ops: Log');
    expect(opsLog?.bodyHtml).toContain('id="note_eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee"');
  });

  it('applies source.folders as a subtree filter (FR-02) restricted to one root folder', async () => {
    const { runner } = makeFixtureRunner();

    const result = await exportAppleNotes({
      config: buildConfig({ source: { folders: ['Tech'] } }),
      runner,
      tmpDirFactory: async () => workDir,
    });

    const uuids = result.notes.map((note) => note.uuid).sort();
    // Tech ルート3件 + その配下 Archive の1件 = 4件。Dev/Ops: Log 配下は含まれない。
    expect(uuids).toEqual(
      [
        '44444444-4444-4444-8444-444444444444',
        '55555555-5555-4555-8555-555555555555',
        '66666666-6666-4666-8666-666666666666',
        '77777777-7777-4777-8777-777777777777',
      ].sort(),
    );
    expect(result.failed).toEqual([]);
  });

  it('applies source.folders as a subtree filter (FR-02) restricted to a nested child folder', async () => {
    const { runner } = makeFixtureRunner();

    const result = await exportAppleNotes({
      config: buildConfig({ source: { folders: ['Archive'] } }),
      runner,
      tmpDirFactory: async () => workDir,
    });

    expect(result.notes.map((note) => note.uuid)).toEqual(['77777777-7777-4777-8777-777777777777']);
    expect(result.failed).toEqual([]);
  });

  it('excludes notes outside source.folders from both notes and failed', async () => {
    const { runner } = makeFixtureRunner();

    const result = await exportAppleNotes({
      config: buildConfig({ source: { folders: ['Dev/Ops: Log'] } }),
      runner,
      tmpDirFactory: async () => workDir,
    });

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]?.uuid).toBe('eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee');
    expect(result.failed).toEqual([]);
  });

  it('routes a note with an unresolvable individual HTML file to failed, logs noteFailed, and continues', async () => {
    const missingHtmlRelativePath = join(
      'html',
      'note_store1',
      'Sample Notes-Tech',
      '55555555-5555-4555-8555-555555555555 - Grocery Checklist.html',
    );
    const { runner } = makeFixtureRunner(async (outDir) => {
      await rm(join(outDir, missingHtmlRelativePath), { force: true });
    });
    const logger = createFakeLogger();

    const result = await exportAppleNotes({
      config: buildConfig({ source: { folders: ['Tech'] } }),
      runner,
      logger,
      tmpDirFactory: async () => workDir,
    });

    expect(result.failed).toEqual([
      {
        uuid: '55555555-5555-4555-8555-555555555555',
        title: 'Grocery Checklist',
        error: expect.stringContaining('55555555-5555-4555-8555-555555555555'),
      },
    ]);
    // 他の Tech 配下ノート(表・描画・ネストフォルダの絵文字ノート)は影響を受けず成功する。
    expect(result.notes.map((note) => note.uuid).sort()).toEqual(
      [
        '44444444-4444-4444-8444-444444444444',
        '66666666-6666-4666-8666-666666666666',
        '77777777-7777-4777-8777-777777777777',
      ].sort(),
    );

    expect(logger.noteFailed).toHaveBeenCalledTimes(1);
    expect(logger.noteFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'zenn',
        noteUuid: '55555555-5555-4555-8555-555555555555',
        title: 'Grocery Checklist',
        error: expect.any(String),
      }),
    );
    expect(logger.exportDone).toHaveBeenCalledWith({ noteCount: 3 });
  });

  it('throws a typed ExportError with the subprocess failure classification', async () => {
    const runner: SubprocessRunner = async () => ({
      status: 'failure',
      classification: 'exit_code',
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'boom',
    });

    const promise = exportAppleNotes({
      config: buildConfig({ source: { folders: ['Tech'] } }),
      runner,
      tmpDirFactory: async () => workDir,
    });

    await expect(promise).rejects.toBeInstanceOf(ExportError);
    await expect(promise).rejects.toMatchObject({ classification: 'exit_code' });
  });

  it('does not call process.exit and does not mutate the fixture source directory', async () => {
    // このテストは「fixture を書き換えない」という制約の回帰チェック。実行前後で
    // fixture の json ファイルが変わっていないことを確認する。
    const { readFile } = await import('node:fs/promises');
    const before = await readFile(join(FIXTURE_ROOT, 'json', 'all_notes_1.json'), 'utf8');

    const { runner } = makeFixtureRunner();
    await exportAppleNotes({
      config: buildConfig({ source: { folders: ['Tech', 'Dev/Ops: Log'] } }),
      runner,
      tmpDirFactory: async () => workDir,
    });

    const after = await readFile(join(FIXTURE_ROOT, 'json', 'all_notes_1.json'), 'utf8');
    expect(after).toBe(before);
  });
});
