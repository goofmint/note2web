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
  NOTE2WEB_EXPORT_SCRIPT_PATH,
  type SubprocessRunner,
} from '../src/exporter/apple-notes.js';
import type { Config } from '../src/config.js';
import type { Logger, WarnPayload } from '../src/logger.js';
import { DEFAULT_TIMEOUTS, type RunSubprocessOptions } from '../src/subprocess.js';

/**
 * T-08(GitHub issue #13)の成果物、issue #72 で note2web 独自スクリプト
 * (`ruby/note2web_export.rb`)の出力契約に合わせて構造更新。読み取り専用として扱い、
 * 決してこのディレクトリ配下を書き換えない(コピー先の一時ディレクトリのみを操作する)。
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

/** `Logger` の全メソッドを `vi.fn()` にしたフェイク(`noteFailed` / `exportDone` / `warn` を主に検証する)。 */
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
 * フェイク。呼ばれると `-o` 引数が指す出力先ディレクトリへ T-08/issue #72 の fixture
 * ツリーを再帰コピーし(fixture 自体は書き換えない)、成功結果を返す。
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

  it('sends the documented note2web_export.rb command shape (bundle exec ruby, the default launcher) and timeout to the runner', async () => {
    const { runner, calls } = makeFixtureRunner();

    const result = await exportAppleNotes({
      config: buildConfig({
        source: { folders: ['Tech', 'Dev/Ops: Log'] },
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
    expect(call?.command).toBe('bundle');
    expect(call?.args).toEqual([
      'exec',
      'ruby',
      NOTE2WEB_EXPORT_SCRIPT_PATH,
      '-m',
      '/mnt/notes-container',
      '-o',
      workDir,
      '--parser-lib',
      join('/opt/apple_cloud_notes_parser', 'lib'),
      '--folder',
      'Tech',
      '--folder',
      'Dev/Ops: Log',
    ]);
    expect(call?.cwd).toBe('/opt/apple_cloud_notes_parser');
    expect(call?.timeoutMs).toBe(DEFAULT_TIMEOUTS.parser);
    expect(result.exportDir).toBe(workDir);
  });

  it('falls back to a plain "ruby" launch when exporter.launcher is "ruby"', async () => {
    const { runner, calls } = makeFixtureRunner();

    await exportAppleNotes({
      config: buildConfig({
        source: { folders: ['Tech'] },
        exporter: {
          parser_path: '/opt/apple_cloud_notes_parser',
          notes_container: '/mnt/notes-container',
          launcher: 'ruby',
        },
      }),
      runner,
      tmpDirFactory: async () => workDir,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.command).toBe('ruby');
    expect(call?.args).toEqual([
      NOTE2WEB_EXPORT_SCRIPT_PATH,
      '-m',
      '/mnt/notes-container',
      '-o',
      workDir,
      '--parser-lib',
      join('/opt/apple_cloud_notes_parser', 'lib'),
      '--folder',
      'Tech',
    ]);
    expect(call?.cwd).toBe('/opt/apple_cloud_notes_parser');
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

  it('resolves individual HTML directly by uuid (html/<uuid>.html, no folder-path resolution) for every note in configured folders', async () => {
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
    // title / emoji はメタデータ抽出層(T-10)の担当。Exporter は空値のまま。
    // tags は JSON hashtags をそのまま詰める(design.md §5.3「差分」節)。
    // このノートの JSON hashtags は空配列のため、tags も空のまま。
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
    // JSON hashtags(design.md §5.3「差分」節)をそのまま tags に詰める。
    expect(launch?.tags).toEqual(['#planning', '#launch', '#productivity']);

    const opsLog = byUuid.get('eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee');
    expect(opsLog?.folder).toBe('Dev/Ops: Log');
    expect(opsLog?.bodyHtml).toContain('id="note_eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee"');
  });

  it('populates folderPath with the ancestor chain from the matched root folder to the leaf (Note#folderPath, FR-24)', async () => {
    const { runner } = makeFixtureRunner();

    const result = await exportAppleNotes({
      config: buildConfig({ source: { folders: ['Tech', 'Dev/Ops: Log'] } }),
      runner,
      tmpDirFactory: async () => workDir,
    });

    const byUuid = new Map(result.notes.map((note) => [note.uuid, note]));

    // Tech(primary_key 10、ルート)直下のノート → folderPath は葉のみの単一要素。
    const salesTable = byUuid.get('44444444-4444-4444-8444-444444444444');
    expect(salesTable?.folderPath).toEqual(['Tech']);

    // Tech/Archive(primary_key 11、Tech の子)配下のノート → folderPath は根から葉まで。
    const launch = byUuid.get('77777777-7777-4777-8777-777777777777');
    expect(launch?.folderPath).toEqual(['Tech', 'Archive']);

    // `folder`(葉フォルダ名)は常に folderPath の最終要素と一致する。
    expect(salesTable?.folderPath.at(-1)).toBe(salesTable?.folder);
    expect(launch?.folderPath.at(-1)).toBe(launch?.folder);
  });

  it('applies source.folders as a subtree filter (FR-02, defense-in-depth) restricted to one root folder', async () => {
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

  it('applies source.folders as a subtree filter (FR-02, defense-in-depth) restricted to a nested child folder', async () => {
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
    const missingHtmlRelativePath = join('html', '55555555-5555-4555-8555-555555555555.html');
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

  it('a long-title note resolves fine as long as its uuid-named HTML file exists (title only ever appears in JSON, never in the filename)', async () => {
    const longTitle = 'x'.repeat(5000);
    const { runner } = makeFixtureRunner(async (outDir) => {
      const jsonPath = join(outDir, 'json', 'all_notes_1.json');
      const { readFile: read, writeFile } = await import('node:fs/promises');
      const data = JSON.parse(await read(jsonPath, 'utf8')) as {
        notes: Record<string, { title: string }>;
      };
      const note = data.notes['201'];
      if (note === undefined) {
        throw new Error('test setup: fixture note 201 not found');
      }
      note.title = longTitle;
      await writeFile(jsonPath, JSON.stringify(data));
    });

    const result = await exportAppleNotes({
      config: buildConfig({ source: { folders: ['Tech'] } }),
      runner,
      tmpDirFactory: async () => workDir,
    });

    expect(result.failed).toEqual([]);
    const salesTable = result.notes.find(
      (note) => note.uuid === '44444444-4444-4444-8444-444444444444',
    );
    expect(salesTable).toBeDefined();
  });

  it('reports skipped_encrypted entries via logger.warn without adding them to notes or failed', async () => {
    const logger = createFakeLogger();
    const { runner } = makeFixtureRunner();

    const result = await exportAppleNotes({
      config: buildConfig({ source: { folders: ['Tech', 'Dev/Ops: Log'] } }),
      runner,
      logger,
      tmpDirFactory: async () => workDir,
    });

    expect(result.notes.some((note) => note.uuid === 'ffffffff-6666-4fff-8fff-ffffffffffff')).toBe(
      false,
    );
    expect(result.failed.some((note) => note.uuid === 'ffffffff-6666-4fff-8fff-ffffffffffff')).toBe(
      false,
    );

    const warnCalls = vi.mocked(logger.warn).mock.calls.map(([payload]) => payload as WarnPayload);
    const encryptedWarning = warnCalls.find(
      (payload) => payload.noteUuid === 'ffffffff-6666-4fff-8fff-ffffffffffff',
    );
    expect(encryptedWarning).toBeDefined();
    expect(encryptedWarning?.message).toMatch(/encrypt/i);
    expect(encryptedWarning?.service).toBe('zenn');
  });

  it('reports skipped_errors entries via logger.warn without adding them to notes or failed', async () => {
    const logger = createFakeLogger();
    const { runner } = makeFixtureRunner();

    const result = await exportAppleNotes({
      config: buildConfig({ source: { folders: ['Tech', 'Dev/Ops: Log'] } }),
      runner,
      logger,
      tmpDirFactory: async () => workDir,
    });

    expect(result.notes.some((note) => note.uuid === '12121212-7777-4121-8121-121212121212')).toBe(
      false,
    );
    expect(result.failed.some((note) => note.uuid === '12121212-7777-4121-8121-121212121212')).toBe(
      false,
    );

    const warnCalls = vi.mocked(logger.warn).mock.calls.map(([payload]) => payload as WarnPayload);
    const errorWarning = warnCalls.find(
      (payload) => payload.noteUuid === '12121212-7777-4121-8121-121212121212',
    );
    expect(errorWarning).toBeDefined();
    expect(errorWarning?.service).toBe('zenn');
  });

  it('truncates long titles/errors to ~80 chars in the skipped_encrypted/skipped_errors warn message text', async () => {
    const longTitle = 'A'.repeat(500);
    const { runner } = makeFixtureRunner(async (outDir) => {
      const jsonPath = join(outDir, 'json', 'all_notes_1.json');
      const { readFile: read, writeFile } = await import('node:fs/promises');
      const data = JSON.parse(await read(jsonPath, 'utf8')) as {
        skipped_encrypted: { uuid: string; title: string }[];
      };
      const entry = data.skipped_encrypted[0];
      if (entry === undefined) {
        throw new Error('test setup: fixture skipped_encrypted[0] not found');
      }
      entry.title = longTitle;
      await writeFile(jsonPath, JSON.stringify(data));
    });
    const logger = createFakeLogger();

    await exportAppleNotes({
      config: buildConfig({ source: { folders: ['Tech', 'Dev/Ops: Log'] } }),
      runner,
      logger,
      tmpDirFactory: async () => workDir,
    });

    const warnCalls = vi.mocked(logger.warn).mock.calls.map(([payload]) => payload as WarnPayload);
    const encryptedWarning = warnCalls.find(
      (payload) => payload.noteUuid === 'ffffffff-6666-4fff-8fff-ffffffffffff',
    );
    expect(encryptedWarning).toBeDefined();
    // メッセージ本文中は切り詰められる(JSON の title 自体は切り詰めない。payload.title 参照)。
    expect(encryptedWarning?.message.length).toBeLessThan(longTitle.length);
    expect(encryptedWarning?.title).toBe(longTitle);
  });

  it('throws a typed ExportError with the subprocess failure classification and the stderr first line (issue #67)', async () => {
    const runner: SubprocessRunner = async () => ({
      status: 'failure',
      classification: 'exit_code',
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'boom\ncannot load such file -- sqlite3 (LoadError)',
    });

    const promise = exportAppleNotes({
      config: buildConfig({ source: { folders: ['Tech'] } }),
      runner,
      tmpDirFactory: async () => workDir,
    });

    await expect(promise).rejects.toBeInstanceOf(ExportError);
    await expect(promise).rejects.toMatchObject({ classification: 'exit_code' });
    // stderr の先頭意味のある1行(issue #67: launchd 環境での原因調査のため)と、
    // parser のプロジェクト名・スクリプト名の両方がメッセージに含まれること。
    await expect(promise).rejects.toThrow(/boom/);
    await expect(promise).rejects.toThrow(
      /apple_cloud_notes_parser \(note2web_export\.rb\) failed/,
    );
  });

  it('appends a Full Disk Access / WAL / schema hint when the failure output looks like a SQLite schema error (issue #69)', async () => {
    const runner: SubprocessRunner = async () => ({
      status: 'failure',
      classification: 'exit_code',
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'no such table: ZACCOUNT: (SQLite3::SQLException)',
    });

    const promise = exportAppleNotes({
      config: buildConfig({ source: { folders: ['Tech'] } }),
      runner,
      tmpDirFactory: async () => workDir,
    });

    await expect(promise).rejects.toBeInstanceOf(ExportError);
    // classification/exitCode/signal 部分は変更されない。
    await expect(promise).rejects.toMatchObject({ classification: 'exit_code' });
    await expect(promise).rejects.toThrow(/exitCode=1, signal=null/);
    // 元のエラー本文(stderr の先頭行)はそのまま含まれる。
    await expect(promise).rejects.toThrow(/no such table: ZACCOUNT/);
    // フルディスクアクセス / WAL / スキーマ不一致のヒントが追記される。
    await expect(promise).rejects.toThrow(/フルディスクアクセス/);
    await expect(promise).rejects.toThrow(/WAL/);
    await expect(promise).rejects.toThrow(/スキーマの不一致/);
  });

  it('appends the SQLite hint when stderr is empty and only stdout contains "SQLite3::SQLException"', async () => {
    const runner: SubprocessRunner = async () => ({
      status: 'failure',
      classification: 'exit_code',
      exitCode: 1,
      signal: null,
      stdout: 'query failed: (SQLite3::SQLException)',
      stderr: '',
    });

    const promise = exportAppleNotes({
      config: buildConfig({ source: { folders: ['Tech'] } }),
      runner,
      tmpDirFactory: async () => workDir,
    });

    await expect(promise).rejects.toBeInstanceOf(ExportError);
    await expect(promise).rejects.toThrow(/フルディスクアクセス/);
    await expect(promise).rejects.toThrow(/WAL/);
    await expect(promise).rejects.toThrow(/スキーマの不一致/);
  });

  it('appends the SQLite hint when the failure is signaled via "SQLite3::SQLException" without "no such table"', async () => {
    const runner: SubprocessRunner = async () => ({
      status: 'failure',
      classification: 'exit_code',
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'some wrapping error (SQLite3::SQLException)',
    });

    const promise = exportAppleNotes({
      config: buildConfig({ source: { folders: ['Tech'] } }),
      runner,
      tmpDirFactory: async () => workDir,
    });

    await expect(promise).rejects.toBeInstanceOf(ExportError);
    await expect(promise).rejects.toThrow(/フルディスクアクセス/);
  });

  it('does not append the SQLite hint for unrelated failures (e.g. a LoadError)', async () => {
    const runner: SubprocessRunner = async () => ({
      status: 'failure',
      classification: 'exit_code',
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'boom\ncannot load such file -- sqlite3 (LoadError)',
    });

    const promise = exportAppleNotes({
      config: buildConfig({ source: { folders: ['Tech'] } }),
      runner,
      tmpDirFactory: async () => workDir,
    });

    await expect(promise).rejects.toBeInstanceOf(ExportError);
    await expect(promise).rejects.not.toThrow(/フルディスクアクセス/);
  });

  it('cleans up the temporary export directory when the run fails (runner failure)', async () => {
    const { mkdir } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    // 失敗経路の後始末を検証するため、テストが場所を知っている専用ディレクトリを注入する。
    const doomedDir = join(workDir, 'doomed-export');
    await mkdir(doomedDir, { recursive: true });

    const runner: SubprocessRunner = async () => ({
      status: 'failure',
      classification: 'timeout',
      exitCode: null,
      signal: 'SIGKILL',
      stdout: '',
      stderr: '',
    });

    await expect(
      exportAppleNotes({
        config: buildConfig({ source: { folders: ['Tech'] } }),
        runner,
        tmpDirFactory: async () => doomedDir,
      }),
    ).rejects.toBeInstanceOf(ExportError);

    // 失敗時は exportDir が呼び出し側へ渡らないため、Exporter 自身が後始末する。
    expect(existsSync(doomedDir)).toBe(false);
  });

  it('rejects a non-numeric folder_key as ExportError instead of silently dropping the note', async () => {
    const { readFile: read, writeFile } = await import('node:fs/promises');
    const { runner } = makeFixtureRunner(async (outDir) => {
      const jsonPath = join(outDir, 'json', 'all_notes_1.json');
      const data = JSON.parse(await read(jsonPath, 'utf8')) as {
        notes: Record<string, { folder_key: unknown }>;
      };
      const firstNote = Object.values(data.notes)[0];
      if (firstNote === undefined) {
        throw new Error('test setup: fixture has no notes');
      }
      firstNote.folder_key = 'invalid';
      await writeFile(jsonPath, JSON.stringify(data));
    });

    await expect(
      exportAppleNotes({
        config: buildConfig({ source: { folders: ['Tech'] } }),
        runner,
        tmpDirFactory: async () => workDir,
      }),
    ).rejects.toBeInstanceOf(ExportError);
  });

  it('rejects a note uuid containing "../" as ExportError instead of joining it into the html/ path (issue #73, path traversal defense-in-depth)', async () => {
    const { readFile: read, writeFile } = await import('node:fs/promises');
    const { runner } = makeFixtureRunner(async (outDir) => {
      const jsonPath = join(outDir, 'json', 'all_notes_1.json');
      const data = JSON.parse(await read(jsonPath, 'utf8')) as {
        notes: Record<string, { uuid: unknown }>;
      };
      const firstNote = Object.values(data.notes)[0];
      if (firstNote === undefined) {
        throw new Error('test setup: fixture has no notes');
      }
      firstNote.uuid = '../../../../etc/passwd';
      await writeFile(jsonPath, JSON.stringify(data));
    });

    await expect(
      exportAppleNotes({
        config: buildConfig({ source: { folders: ['Tech'] } }),
        runner,
        tmpDirFactory: async () => workDir,
      }),
    ).rejects.toBeInstanceOf(ExportError);
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
