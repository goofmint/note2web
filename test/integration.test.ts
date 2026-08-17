/**
 * 結合(E2E)テスト(design.md §12「結合」、T-26 / issue #31)。
 *
 * design.md §12 の結合テスト方針:
 * 「`test/fixtures/parser-output/`(表・チェックリスト・描画参照・絵文字タイトル+ハッシュタグ+
 * ネストフォルダを含む複数ノートの fixture)でエクスポート以降を通しで検証。JSON の UUID と
 * 個別 HTML(`--individual-files --uuid`)の対応が一意に解決できることをここで検証する。
 * Publisher は外部呼び出し(git / gh / HTTP / CLI)をモック化」。
 *
 * `test/sync.test.ts` は `runSync` の統合そのもの(依存チェック・ロック・状態確定の各分岐)を
 * 記録可能な汎用モック `Publisher` で検証している。本ファイルはそれとは責務が異なり、
 * **7サービス全ての「本物の」`createXPublisher`/`renderXArticle`(`src/publishers/*.ts`。
 * cli.ts が実運用で使うのと同じ関数)を、`src/sync.ts` の `runSync` に本当に結線して**、
 * fixture 全体を1回・2回通す(issue #31 の受け入れ条件)。モック化するのは design.md §12 が
 * 明示する「外部呼び出し」の境界のみ:
 *
 *   - parser サブプロセス: `runSync` の `runner`/`tmpDirFactory` 注入点(既存の seam。
 *     `test/sync.test.ts` の `makeFixtureRunner` と同じパターン)で、fixture ディレクトリを
 *     そのまま `-o` 出力先へコピーするだけのフェイクに差し替える
 *   - git/gh サブプロセス: `createGitRepoPublisher` の `runner` 注入点(zenn/hugo/jekyll)
 *   - qiita-cli サブプロセス: `createQiitaPublisher` の `runner` 注入点
 *   - noet サブプロセス: `createNotePublisher` の `runner` 注入点
 *   - dev.to / はてな HTTP: `createDevtoPublisher`/`createHatenaPublisher` の
 *     `httpClient`/`client` 注入点
 *   - 環境変数(トークン類): 各 `createXPublisher` の `env` 注入点(`process.env` を汚さない)
 *
 * これら以外(メタデータ抽出・BodyTransformer・AssetUploader・Renderer・StateStore・
 * `runSync` 本体)はすべて本物のコードパスを通る。フェイクはいずれも「記録可能・応答を
 * スクリプト可能」な手組みの関数で、`test/publishers/*.test.ts`/`test/sync.test.ts` が
 * 既に採用している設計(vi.fn を使わない)を踏襲する。
 *
 * **各サービス設定は `createXPublisher`/`renderXArticle` を直接呼ぶ**(`src/publishers/
 * factory.ts` の `createPublisher`/`resolveRenderer` のうち、`resolveRenderer` は実運用と
 * 同じ選択ロジックをそのまま使う一方、`createPublisher` は素通しラッパーで `runner`/
 * `httpClient`/`env` の注入点を公開していないため、本物の Publisher 実装関数
 * (`createGitRepoPublisher` 等。`factory.ts` が内部で呼ぶのと同一の関数)を直接呼ぶ。
 * これは新しい seam の追加ではなく、各 Publisher モジュールが単体テスト用に既に公開している
 * 注入点をそのまま使うだけ)。
 *
 * **fixture の folder 名と Zenn の type 制約(design.md §5.7「tech/idea 以外… 失敗扱い」・
 * FR-24)**: fixture のフォルダ名は `Tech`/`Archive`/`Dev/Ops: Log` であり、Zenn が要求する
 * 厳密な `tech`/`idea` と一致しない。`test/sync.test.ts`(「with the real Zenn renderer」
 * ブロック)が確立した手法をそのまま踏襲し、コピー後の fixture JSON の対象ノート1件だけ
 * `folder` フィールドを `"tech"` に書き換える(`folder_key` には触れないため
 * `source.folders` によるノート選択自体は変わらない)。残り4件は実際のフォルダ名のまま
 * (=Zenn的には不正)残し、FR-24 の「不正な type のノートは failed」という実際の Publisher
 * 挙動をそのまま検証材料にする——これは「境界のモック化」ではなく、既存 fixture が
 * Zenn 固有の制約を最初から満たさないことへの最小限の適応であり、HTML・添付・
 * ハッシュタグ等コンテンツ本体は一切改変しない。
 *
 * **Qiita のタグ必須制約(design.md §5.7「除外後0個ならそのノートは失敗扱い」)** と
 * **note.com の画像非対応(design.md §13-6、`NoteImagesUnsupportedError`)** は、
 * 逆に fixture をそのまま使うだけで自然に発生する実際の失敗系列であり、issue #31 の
 * 受け入れ条件(note.com の画像ノート failed / 非画像ノート created)を満たす形で
 * そのままアサーションに使う。
 */

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { PARTIAL_FAILURE, SUCCESS } from '../src/exit-codes.js';
import type { SubprocessRunner } from '../src/exporter/apple-notes.js';
import type { Logger, WarnPayload } from '../src/logger.js';
import type { PutObjectParams, UploaderClient } from '../src/assets/uploader.js';
import { resolveRenderer } from '../src/publishers/factory.js';
import {
  createGitRepoPublisher,
  GIT_CREDENTIAL_ARGS,
  type GitRepoRunner,
} from '../src/publishers/git-repo.js';
import { createQiitaPublisher, type QiitaRunner } from '../src/publishers/qiita.js';
import {
  createDevtoPublisher,
  DEVTO_API_BASE_URL,
  type DevtoHttpClient,
  type DevtoHttpRequest,
} from '../src/publishers/devto.js';
import {
  createHatenaPublisher,
  type HatenaHttpClient,
  type HatenaHttpRequest,
  type HatenaHttpResponse,
} from '../src/publishers/hatena.js';
import { createNotePublisher, type NoteRunner } from '../src/publishers/note.js';
import type { Publisher } from '../src/publishers/types.js';
import type { NoteRenderer } from '../src/publishers/render.js';
import type { StateFile } from '../src/state/store.js';
import { runSync } from '../src/sync.js';
import type { RunSubprocessOptions } from '../src/subprocess.js';

// ---------------------------------------------------------------------------
// fixture 定数(design.md §12、`test/fixtures/parser-output/README.md` のノート一覧と同じ
// UUID を使う。`test/sync.test.ts`/`test/exporter.test.ts` 由来)。
// ---------------------------------------------------------------------------

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/parser-output/', import.meta.url));

/** JSON トップレベル `notes` のキー(UUID ではない)。`rewriteNoteFolder` で使う。 */
const NOTE_KEY = {
  salesTable: '201',
  groceryChecklist: '202',
  whiteboardSketch: '203',
  launchNotes: '204',
  opsLog: '205',
} as const;

// Tech(ルート。タグ無し) — 表。
const SALES_TABLE_UUID = '44444444-4444-4444-8444-444444444444';
// Tech(ルート。タグ無し) — チェックリスト。
const GROCERY_CHECKLIST_UUID = '55555555-5555-4555-8555-555555555555';
// Tech(ルート。タグ無し) — 描画/画像添付を持つ唯一のノート。
const WHITEBOARD_SKETCH_UUID = '66666666-6666-4666-8666-666666666666';
// Tech/Archive(子フォルダ) — 絵文字タイトル + 3ハッシュタグ、画像無し。
const LAUNCH_NOTES_UUID = '77777777-7777-4777-8777-777777777777';
// Dev/Ops: Log(記号入りルートフォルダ) — タグ無し、画像無し。
const OPS_LOG_UUID = 'eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee';

/**
 * `source.folders`(FR-02)。`Tech` はサブツリー一致で `Archive` を自動的に含む
 * (`src/exporter/apple-notes.ts` `resolveIncludedFolderIds`)ため、この2エントリだけで
 * fixture の5ノート全件(表・チェックリスト・描画/画像・絵文字+ハッシュタグ+ネスト
 * フォルダ・記号入りフォルダ名)を選択できる。
 */
const ALL_FOLDERS = ['Tech', 'Dev/Ops: Log'];

/** 5ノート全件の UUID(状態 JSON・イベントログの網羅チェックに使う)。 */
const ALL_UUIDS = [
  SALES_TABLE_UUID,
  GROCERY_CHECKLIST_UUID,
  WHITEBOARD_SKETCH_UUID,
  LAUNCH_NOTES_UUID,
  OPS_LOG_UUID,
];

// ---------------------------------------------------------------------------
// 共有ヘルパー(`test/sync.test.ts`/`test/publishers/*.test.ts` と同じパターンを踏襲。
// vi.fn は使わない)。
// ---------------------------------------------------------------------------

function createFakeLogger(): {
  logger: Logger;
  events: string[];
  warnings: WarnPayload[];
} {
  const events: string[] = [];
  const warnings: WarnPayload[] = [];
  const logger: Logger = {
    runStart: () => {
      events.push('run_start');
    },
    runEnd: (payload) => {
      events.push(
        `run_end:${String(payload.published)}/${String(payload.skipped)}/${String(payload.failed)}`,
      );
    },
    exportDone: (payload) => {
      events.push(`export_done:${String(payload.noteCount)}`);
    },
    notePublished: (payload) => {
      events.push(`note_published:${payload.noteUuid}:${payload.result}`);
    },
    noteSkipped: (payload) => {
      events.push(`note_skipped:${payload.noteUuid}`);
    },
    noteFailed: (payload) => {
      events.push(`note_failed:${payload.noteUuid}`);
    },
    assetUploaded: (payload) => {
      events.push(`asset_uploaded:${payload.assetHash}`);
    },
    warn: (payload) => {
      warnings.push(payload);
      events.push(`warn:${payload.message}`);
    },
  };
  return { logger, events, warnings };
}

function createFakeUploaderClient(): UploaderClient & { putObjectCalls: PutObjectParams[] } {
  const putObjectCalls: PutObjectParams[] = [];
  return {
    putObjectCalls,
    async putObject(params) {
      putObjectCalls.push(params);
    },
  };
}

/**
 * `test/sync.test.ts` の `makeFixtureRunner` と同じパターン: `runSync` の `runner`
 * 注入点(design.md §12 が指定する唯一の「エクスポート境界」のモック)。呼ばれると `-o`
 * 引数の指す出力先へ fixture ツリーをそのままコピーするだけで、実際の
 * `apple_cloud_notes_parser` は一切起動しない。
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

/**
 * コピー済み fixture の `json/all_notes_1.json` を読み、指定した note key(`NOTE_KEY`。
 * UUID ではない)の `folder` フィールドだけを書き換える(`test/sync.test.ts` の
 * `rewriteNoteFolder` と同一パターン)。`folder_key`(フォルダ階層によるフィルタに使われる)
 * には触れないため、`source.folders` による対象ノートの絞り込み結果は変わらない
 * ——このファイル冒頭 JSDoc「fixture の folder 名と Zenn の type 制約」参照。
 */
async function rewriteNoteFolder(outDir: string, noteKey: string, folder: string): Promise<void> {
  const jsonPath = join(outDir, 'json', 'all_notes_1.json');
  const raw = JSON.parse(await readFile(jsonPath, 'utf8')) as {
    notes: Record<string, { folder: string }>;
  };
  const note = raw.notes[noteKey];
  if (note === undefined) {
    throw new Error(`test fixture: note key "${noteKey}" not found in ${jsonPath}`);
  }
  note.folder = folder;
  await writeFile(jsonPath, JSON.stringify(raw), 'utf8');
}

/** Zenn 用: `NOTE_KEY.salesTable` のみ `folder: "tech"` へ書き換える(モジュール冒頭 JSDoc)。 */
function patchForZenn(outDir: string): Promise<void> {
  return rewriteNoteFolder(outDir, NOTE_KEY.salesTable, 'tech');
}

const NOOP_CHECK_DEPENDENCIES = async (): Promise<void> => {
  // このスイートは Publisher/Renderer の実結線を検証する対象であり、`checkDependencies`
  // 自体は `src/dependencies.test.ts` の責務。ホスト環境の実コマンド(ruby/git/gh/qiita-cli/
  // noet 等)の有無に左右されないよう常に成功させる(`test/sync.test.ts` と同じ方針)。
};

const NOOP_CHECK_GIT_AUTH = async (): Promise<void> => {
  // `test/sync.test.ts` と同じ理由(`gh auth status` 等ホスト依存の実チェックを避ける)。
};

const FIXED_NOW = () => new Date('2026-08-11T00:00:00Z');

/**
 * `RunSubprocessOptions` の `args` から、git 呼び出しに一律付与される credential-helper
 * 強制の前置き(`GIT_CREDENTIAL_ARGS`、`src/publishers/git-repo.ts` 参照)を取り除いた
 * 「実質的な」引数列を返す。gh コマンドはそのまま返す(前置きは git 呼び出しにのみ付く)。
 * zenn / hugo / jekyll の `makeGitRunner` いずれからも参照する。
 */
function gitArgs(options: { command: string; args: string[] }): string[] {
  return options.command === 'git' ? options.args.slice(GIT_CREDENTIAL_ARGS.length) : options.args;
}

function readStateFile(statePath: string): StateFile {
  return JSON.parse(readFileSync(statePath, 'utf8')) as StateFile;
}

/** design.md §7 の `assets` ブロック例をそのまま流用する(全サービス共通・r2)。 */
const ASSETS_CONFIG: Config['assets'] = {
  provider: 'r2',
  bucket: 'blog-assets',
  endpoint: 'https://example-account.r2.cloudflarestorage.com',
  region: 'auto',
  prefix: 'notes/',
  public_base_url: 'https://assets.example.com/notes/',
  access_key_id_env: 'R2_ACCESS_KEY_ID',
  secret_access_key_env: 'R2_SECRET_ACCESS_KEY',
};

/** 各サービス共通の `RunSyncOptions` 断片(`test/sync.test.ts` の `baseOptions` と同型)。 */
function baseSyncOptions(overrides: {
  statePath: string;
  runner: SubprocessRunner;
  tmpDirFactory: () => Promise<string>;
  logger: Logger;
  uploaderClient: UploaderClient;
}) {
  return {
    ...overrides,
    now: FIXED_NOW,
    checkDependenciesFn: NOOP_CHECK_DEPENDENCIES,
    checkGitAuthFn: NOOP_CHECK_GIT_AUTH,
  };
}

// ---------------------------------------------------------------------------
// テスト本体。
// ---------------------------------------------------------------------------

describe('integration: full sync pipeline over the multi-note fixture (design.md §12, issue #31)', () => {
  let stateDir: string;
  let statePath: string;
  let exportWorkDir1: string;
  let exportWorkDir2: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'note2web-it-state-'));
    statePath = join(stateDir, 'note2web.state.json');
    exportWorkDir1 = await mkdtemp(join(tmpdir(), 'note2web-it-export1-'));
    exportWorkDir2 = await mkdtemp(join(tmpdir(), 'note2web-it-export2-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(exportWorkDir1, { recursive: true, force: true });
    await rm(exportWorkDir2, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // zenn / hugo / jekyll: GitRepoPublisher 共通基盤 + サービス別 Renderer。
  // -------------------------------------------------------------------------

  describe('zenn (git mode, GitRepoPublisher + renderZennArticle)', () => {
    let repoPath: string;

    beforeEach(async () => {
      repoPath = await mkdtemp(join(tmpdir(), 'note2web-it-zenn-repo-'));
    });
    afterEach(async () => {
      await rm(repoPath, { recursive: true, force: true });
    });

    function buildConfig(): Config {
      return {
        service: 'zenn',
        timezone: 'Asia/Tokyo',
        source: { folders: ALL_FOLDERS },
        assets: ASSETS_CONFIG,
        git: {
          repo_path: repoPath,
          base_branch: 'main',
          output_dir: 'articles',
          auto_merge: true,
        },
      };
    }

    interface GitCall {
      command: string;
      args: string[];
    }

    function makeGitRunner(): { runner: GitRepoRunner; calls: GitCall[] } {
      const calls: GitCall[] = [];
      const runner: GitRepoRunner = async (options: RunSubprocessOptions) => {
        calls.push({ command: options.command, args: options.args });
        if (options.command === 'gh' && options.args[0] === 'pr' && options.args[1] === 'create') {
          return {
            status: 'success',
            exitCode: 0,
            signal: null,
            stdout: 'https://github.com/example/zenn-content/pull/1\n',
            stderr: '',
          };
        }
        if (options.command === 'git' && gitArgs(options)[0] === 'status') {
          // `publish()` が実際にファイルを書き込んでいるため(design.md §5.7 手順2)、
          // `git status --porcelain` は本物の git であれば差分ありを報告する。fake
          // runner はコマンドを実際には実行しないため、finalize() の「差分ゼロなら
          // ブランチ破棄」(FR-22)分岐に誤って入らないよう、常に差分ありを模倣する。
          return {
            status: 'success',
            exitCode: 0,
            signal: null,
            stdout: ' M articles/dummy-change.md\n',
            stderr: '',
          };
        }
        return { status: 'success', exitCode: 0, signal: null, stdout: '', stderr: '' };
      };
      return { runner, calls };
    }

    it('publishes the single "tech"-typed note, isolates the 4 real-folder-name notes as failed (FR-24), then is fully idempotent on re-run', async () => {
      // --- run 1 -------------------------------------------------------------
      const config = buildConfig();
      const parser1 = makeFixtureRunner(patchForZenn);
      const git1 = makeGitRunner();
      const { logger: logger1, events: events1 } = createFakeLogger();
      const publisher1: Publisher = createGitRepoPublisher({
        config,
        runner: git1.runner,
        logger: logger1,
        now: FIXED_NOW,
        env: { GH_TOKEN: 'fake-gh-token' },
      });
      const uploader1 = createFakeUploaderClient();
      const renderNote: NoteRenderer = resolveRenderer('zenn');

      const result1 = await runSync({
        config,
        publisher: publisher1,
        renderNote,
        ...baseSyncOptions({
          statePath,
          runner: parser1.runner,
          tmpDirFactory: async () => exportWorkDir1,
          logger: logger1,
          uploaderClient: uploader1,
        }),
      });

      expect(result1).toMatchObject({
        exitCode: PARTIAL_FAILURE,
        published: 1,
        skipped: 0,
        failed: 4,
      });
      expect(events1).toContain(`note_published:${SALES_TABLE_UUID}:created`);
      for (const uuid of [
        GROCERY_CHECKLIST_UUID,
        WHITEBOARD_SKETCH_UUID,
        LAUNCH_NOTES_UUID,
        OPS_LOG_UUID,
      ]) {
        expect(events1).toContain(`note_failed:${uuid}`);
      }

      // git/gh の呼び出し(design.md §5.7 手順1・3・4): fetch → checkout -b → status →
      // add → commit → push → gh pr create → gh pr merge(auto_merge: true)。
      // `gitArgs()` で git 呼び出しの credential-helper 強制の前置き(GIT_CREDENTIAL_ARGS)を
      // 取り除いてから見る(gh 呼び出しには前置きが付かないのでそのまま)。
      const commands1 = git1.calls.map(
        (call) => `${call.command} ${gitArgs(call).slice(0, 2).join(' ')}`,
      );
      expect(commands1).toContain('git fetch origin');
      expect(commands1.some((c) => c.startsWith('git checkout -b'))).toBe(true);
      expect(commands1.some((c) => c.startsWith('git add'))).toBe(true);
      expect(commands1.some((c) => c.startsWith('git commit'))).toBe(true);
      expect(commands1.some((c) => c.startsWith('git push'))).toBe(true);
      expect(commands1.some((c) => c.startsWith('gh pr'))).toBe(true);
      expect(git1.calls.some((c) => c.command === 'gh' && c.args[1] === 'merge')).toBe(true);

      // 唯一成功したノートが Zenn 規約どおりのパス・frontmatter で書き込まれている。
      const writtenPath = join(repoPath, 'articles', `${SALES_TABLE_UUID.toLowerCase()}.md`);
      const written = await readFile(writtenPath, 'utf8');
      expect(written).toContain('type: "tech"');
      expect(written).toContain('published: true');

      const onDisk1 = readStateFile(statePath);
      expect(onDisk1.notes[SALES_TABLE_UUID]).toMatchObject({
        remoteId: null,
        artifactPath: `articles/${SALES_TABLE_UUID.toLowerCase()}.md`,
      });
      expect(onDisk1.notes[SALES_TABLE_UUID]?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      // FR-24 で failed のノートは状態に一切残らない(NFR-06。次回再試行される)。
      for (const uuid of [
        GROCERY_CHECKLIST_UUID,
        WHITEBOARD_SKETCH_UUID,
        LAUNCH_NOTES_UUID,
        OPS_LOG_UUID,
      ]) {
        expect(onDisk1.notes[uuid]).toBeUndefined();
      }
      // 画像を持つ Whiteboard Sketch のアセットは、そのノート自身は failed でも
      // §5.6 書き込みポイント1どおり確定保存されている。
      expect(Object.keys(onDisk1.assets)).toHaveLength(1);
      expect(uploader1.putObjectCalls).toHaveLength(1);

      const stateBytesAfterRun1 = readFileSync(statePath, 'utf8');

      // --- run 2(冪等性)-------------------------------------------------------
      const parser2 = makeFixtureRunner(patchForZenn);
      const git2 = makeGitRunner();
      const { logger: logger2, events: events2 } = createFakeLogger();
      const publisher2: Publisher = createGitRepoPublisher({
        config,
        runner: git2.runner,
        logger: logger2,
        now: FIXED_NOW,
        env: { GH_TOKEN: 'fake-gh-token' },
      });
      const uploader2 = createFakeUploaderClient();

      const result2 = await runSync({
        config,
        publisher: publisher2,
        renderNote,
        ...baseSyncOptions({
          statePath,
          runner: parser2.runner,
          tmpDirFactory: async () => exportWorkDir2,
          logger: logger2,
          uploaderClient: uploader2,
        }),
      });

      // 同一コンテンツのため唯一の成功ノートは skip、他4件は(状態未確定のため)引き続き
      // failed として再試行される(NFR-06)——issue #31「2回目実行では成功済みノートは
      // すべて skip される」を、この4件については「元々成功していない」ものとして扱う。
      expect(result2).toMatchObject({
        exitCode: PARTIAL_FAILURE,
        published: 0,
        skipped: 1,
        failed: 4,
      });
      expect(events2).toContain(`note_skipped:${SALES_TABLE_UUID}`);

      // publish() が呼ばれていない(=変更が無い)ため、finalize() は差分ゼロとしてブランチを
      // 破棄するのみ。add/commit/push/gh pr create は一切呼ばれない。
      const commands2 = git2.calls.map(
        (call) => `${call.command} ${gitArgs(call).slice(0, 2).join(' ')}`,
      );
      expect(commands2).not.toContain('git add');
      expect(commands2).not.toContain('git commit');
      expect(commands2.some((c) => c.startsWith('git push'))).toBe(false);
      expect(commands2).not.toContain('gh pr');
      expect(commands2.some((c) => c.startsWith('git branch -D'))).toBe(true);

      // アセットも既に状態に記録済みのため再アップロードされない。
      expect(uploader2.putObjectCalls).toHaveLength(0);

      // 状態 JSON は一切書き換わらない(design.md §5.6: finalize persist:false は flush しない)。
      expect(readFileSync(statePath, 'utf8')).toBe(stateBytesAfterRun1);
    });
  });

  describe('hugo (git mode, GitRepoPublisher + renderHugoArticle)', () => {
    let repoPath: string;

    beforeEach(async () => {
      repoPath = await mkdtemp(join(tmpdir(), 'note2web-it-hugo-repo-'));
    });
    afterEach(async () => {
      await rm(repoPath, { recursive: true, force: true });
    });

    function buildConfig(): Config {
      return {
        service: 'hugo',
        timezone: 'Asia/Tokyo',
        source: { folders: ALL_FOLDERS },
        assets: ASSETS_CONFIG,
        git: {
          repo_path: repoPath,
          base_branch: 'main',
          output_dir: 'content/posts',
          auto_merge: false,
        },
      };
    }

    function makeGitRunner(): { runner: GitRepoRunner; calls: RunSubprocessOptions[] } {
      const calls: RunSubprocessOptions[] = [];
      const runner: GitRepoRunner = async (options: RunSubprocessOptions) => {
        calls.push(options);
        if (options.command === 'gh' && options.args[0] === 'pr' && options.args[1] === 'create') {
          return {
            status: 'success',
            exitCode: 0,
            signal: null,
            stdout: 'https://github.com/example/hugo-content/pull/1\n',
            stderr: '',
          };
        }
        if (options.command === 'git' && gitArgs(options)[0] === 'status') {
          // `zenn` の `makeGitRunner` と同じ理由(このファイル冒頭のコメント参照)。
          return {
            status: 'success',
            exitCode: 0,
            signal: null,
            stdout: ' M content/posts/dummy-change.md\n',
            stderr: '',
          };
        }
        return { status: 'success', exitCode: 0, signal: null, stdout: '', stderr: '' };
      };
      return { runner, calls };
    }

    it('publishes all 5 notes (no type constraint), records state for each, then is fully idempotent on re-run (no git writes, no PR)', async () => {
      const config = buildConfig();

      // --- run 1 ---------------------------------------------------------------
      const parser1 = makeFixtureRunner();
      const git1 = makeGitRunner();
      const { logger: logger1, events: events1 } = createFakeLogger();
      const publisher1 = createGitRepoPublisher({ config, runner: git1.runner, now: FIXED_NOW });
      const uploader1 = createFakeUploaderClient();
      const renderNote = resolveRenderer('hugo');

      const result1 = await runSync({
        config,
        publisher: publisher1,
        renderNote,
        ...baseSyncOptions({
          statePath,
          runner: parser1.runner,
          tmpDirFactory: async () => exportWorkDir1,
          logger: logger1,
          uploaderClient: uploader1,
        }),
      });

      expect(result1).toMatchObject({ exitCode: SUCCESS, published: 5, skipped: 0, failed: 0 });
      for (const uuid of ALL_UUIDS) {
        expect(events1).toContain(`note_published:${uuid}:created`);
      }
      expect(git1.calls.some((c) => c.command === 'gh' && c.args[0] === 'pr')).toBe(true);
      // auto_merge: false のため gh pr merge は呼ばれない(design.md §5.7 手順3)。
      expect(git1.calls.some((c) => c.command === 'gh' && c.args[1] === 'merge')).toBe(false);

      const onDisk1 = readStateFile(statePath);
      for (const uuid of ALL_UUIDS) {
        expect(onDisk1.notes[uuid]).toMatchObject({ remoteId: null });
        expect(onDisk1.notes[uuid]?.artifactPath).toBe(`content/posts/${uuid}.md`);
      }
      const written = await readFile(
        join(repoPath, 'content/posts', `${LAUNCH_NOTES_UUID}.md`),
        'utf8',
      );
      // 絵文字タイトル・ハッシュタグ(FR-04〜07)が Hugo の categories/tags に反映されている。
      expect(written).toContain('categories: ["Archive"]');
      expect(written).toContain('planning');

      const stateBytesAfterRun1 = readFileSync(statePath, 'utf8');

      // --- run 2(冪等性)---------------------------------------------------------
      const parser2 = makeFixtureRunner();
      const git2 = makeGitRunner();
      const { logger: logger2, events: events2 } = createFakeLogger();
      const publisher2 = createGitRepoPublisher({ config, runner: git2.runner, now: FIXED_NOW });
      const uploader2 = createFakeUploaderClient();

      const result2 = await runSync({
        config,
        publisher: publisher2,
        renderNote,
        ...baseSyncOptions({
          statePath,
          runner: parser2.runner,
          tmpDirFactory: async () => exportWorkDir2,
          logger: logger2,
          uploaderClient: uploader2,
        }),
      });

      expect(result2).toMatchObject({ exitCode: SUCCESS, published: 0, skipped: 5, failed: 0 });
      for (const uuid of ALL_UUIDS) {
        expect(events2).toContain(`note_skipped:${uuid}`);
      }
      // 変更ノート無し → finalize() は差分ゼロでブランチを破棄するだけ。公開に関わる
      // git 書き込み(add/commit/push)と gh は一切呼ばれない(checkout / branch -D は
      // 後始末として許容)。
      for (const writeOp of ['add', 'commit', 'push']) {
        expect(git2.calls.some((c) => c.command === 'git' && gitArgs(c)[0] === writeOp)).toBe(
          false,
        );
      }
      expect(git2.calls.some((c) => c.command === 'gh')).toBe(false);
      expect(uploader2.putObjectCalls).toHaveLength(0);
      expect(readFileSync(statePath, 'utf8')).toBe(stateBytesAfterRun1);
    });
  });

  describe('jekyll (git mode, GitRepoPublisher + renderJekyllArticle)', () => {
    let repoPath: string;

    beforeEach(async () => {
      repoPath = await mkdtemp(join(tmpdir(), 'note2web-it-jekyll-repo-'));
    });
    afterEach(async () => {
      await rm(repoPath, { recursive: true, force: true });
    });

    function buildConfig(): Config {
      return {
        service: 'jekyll',
        timezone: 'Asia/Tokyo',
        source: { folders: ALL_FOLDERS },
        assets: ASSETS_CONFIG,
        git: {
          repo_path: repoPath,
          base_branch: 'main',
          output_dir: '_posts',
          auto_merge: true,
        },
      };
    }

    function makeGitRunner(): { runner: GitRepoRunner; calls: RunSubprocessOptions[] } {
      const calls: RunSubprocessOptions[] = [];
      const runner: GitRepoRunner = async (options: RunSubprocessOptions) => {
        calls.push(options);
        if (options.command === 'gh' && options.args[0] === 'pr' && options.args[1] === 'create') {
          return {
            status: 'success',
            exitCode: 0,
            signal: null,
            stdout: 'https://github.com/example/jekyll-content/pull/1\n',
            stderr: '',
          };
        }
        if (options.command === 'git' && gitArgs(options)[0] === 'status') {
          // `zenn` の `makeGitRunner` と同じ理由(このファイル冒頭のコメント参照)。
          return {
            status: 'success',
            exitCode: 0,
            signal: null,
            stdout: ' M _posts/dummy-change.md\n',
            stderr: '',
          };
        }
        return { status: 'success', exitCode: 0, signal: null, stdout: '', stderr: '' };
      };
      return { runner, calls };
    }

    it('publishes all 5 notes with date-prefixed filenames, then is fully idempotent (filenames stay fixed across the re-run)', async () => {
      const config = buildConfig();
      const parser1 = makeFixtureRunner();
      const git1 = makeGitRunner();
      const { logger: logger1 } = createFakeLogger();
      const publisher1 = createGitRepoPublisher({ config, runner: git1.runner, now: FIXED_NOW });
      const uploader1 = createFakeUploaderClient();
      const renderNote = resolveRenderer('jekyll');

      const result1 = await runSync({
        config,
        publisher: publisher1,
        renderNote,
        ...baseSyncOptions({
          statePath,
          runner: parser1.runner,
          tmpDirFactory: async () => exportWorkDir1,
          logger: logger1,
          uploaderClient: uploader1,
        }),
      });

      expect(result1).toMatchObject({ exitCode: SUCCESS, published: 5, skipped: 0, failed: 0 });
      const onDisk1 = readStateFile(statePath);
      // design.md §4: `_posts/YYYY-MM-DD-<uuid>.md`(日付は作成日)。
      for (const uuid of ALL_UUIDS) {
        expect(onDisk1.notes[uuid]?.artifactPath).toMatch(
          new RegExp(`^_posts/\\d{4}-\\d{2}-\\d{2}-${uuid}\\.md$`),
        );
      }
      const firstArtifactPath = onDisk1.notes[SALES_TABLE_UUID]?.artifactPath;
      expect(firstArtifactPath).toBeDefined();
      expect(existsSync(join(repoPath, firstArtifactPath as string))).toBe(true);

      // --- run 2(冪等性): ファイル名固定(§4)も含めて完全一致で skip される -------------
      const parser2 = makeFixtureRunner();
      const git2 = makeGitRunner();
      const { logger: logger2, events: events2 } = createFakeLogger();
      const publisher2 = createGitRepoPublisher({ config, runner: git2.runner, now: FIXED_NOW });
      const uploader2 = createFakeUploaderClient();

      const result2 = await runSync({
        config,
        publisher: publisher2,
        renderNote,
        ...baseSyncOptions({
          statePath,
          runner: parser2.runner,
          tmpDirFactory: async () => exportWorkDir2,
          logger: logger2,
          uploaderClient: uploader2,
        }),
      });

      expect(result2).toMatchObject({ exitCode: SUCCESS, published: 0, skipped: 5, failed: 0 });
      for (const uuid of ALL_UUIDS) {
        expect(events2).toContain(`note_skipped:${uuid}`);
      }
      // 公開に関わる git 書き込み(add/commit/push)は再実行では発生しない。
      for (const writeOp of ['add', 'commit', 'push']) {
        expect(git2.calls.some((c) => c.command === 'git' && gitArgs(c)[0] === writeOp)).toBe(
          false,
        );
      }
      expect(git2.calls.some((c) => c.command === 'gh')).toBe(false);
      expect(uploader2.putObjectCalls).toHaveLength(0);
      const onDisk2 = readStateFile(statePath);
      // ファイル名が run1 と完全に同一のまま(§4「記録済みファイル名を使い続ける」)。
      expect(onDisk2.notes[SALES_TABLE_UUID]?.artifactPath).toBe(firstArtifactPath);
    });
  });

  // -------------------------------------------------------------------------
  // qiita: CLI モード(npx --no-install qiita)。
  // -------------------------------------------------------------------------

  describe('qiita (CLI mode via npx --no-install qiita, createQiitaPublisher + renderQiitaArticle)', () => {
    let workspace: string;

    beforeEach(async () => {
      workspace = await mkdtemp(join(tmpdir(), 'note2web-it-qiita-workspace-'));
    });
    afterEach(async () => {
      await rm(workspace, { recursive: true, force: true });
    });

    function buildConfig(): Config {
      return {
        service: 'qiita',
        timezone: 'Asia/Tokyo',
        source: { folders: ALL_FOLDERS },
        assets: ASSETS_CONFIG,
        qiita: { workspace, token_env: 'QIITA_TOKEN' },
      };
    }

    /**
     * qiita-cli の実挙動(design.md §5.7「投稿後に frontmatter へ発行済み ID を書き戻す」)を
     * 模倣する fake runner: `publish` 呼び出しが成功すると、workspace 上のファイルへ
     * `id: "qiita-<uuid>"` を書き戻す(`test/publishers/qiita.test.ts` の
     * `simulateQiitaCliWriteBackId` と同じ発想)。
     */
    function makeQiitaRunner(): { runner: QiitaRunner; calls: RunSubprocessOptions[] } {
      const calls: RunSubprocessOptions[] = [];
      const runner: QiitaRunner = async (options: RunSubprocessOptions) => {
        calls.push(options);
        // 実引数は ['--no-install', 'qiita', 'publish', <uuid>, '--root', workspace]
        // (`src/publishers/qiita.ts` の `createQiitaPublisher`)。uuid は '--root' の
        // 直前の要素。
        const rootIndex = options.args.indexOf('--root');
        const uuid = rootIndex >= 1 ? options.args[rootIndex - 1] : undefined;
        const root = rootIndex >= 0 ? options.args[rootIndex + 1] : undefined;
        if (uuid !== undefined && root !== undefined) {
          const filePath = join(root, 'public', `${uuid}.md`);
          const content = await readFile(filePath, 'utf8');
          const updated = content.replace('id: null', `id: "qiita-${uuid}"`);
          await writeFile(filePath, updated, 'utf8');
        }
        return { status: 'success', exitCode: 0, signal: null, stdout: '', stderr: '' };
      };
      return { runner, calls };
    }

    it('publishes only the tagged note (204), isolates the 4 tagless notes as failed (QiitaNoTagsRemainingError), then is fully idempotent', async () => {
      const config = buildConfig();

      // --- run 1 ---------------------------------------------------------------
      const parser1 = makeFixtureRunner();
      const qiita1 = makeQiitaRunner();
      const { logger: logger1, events: events1, warnings: warnings1 } = createFakeLogger();
      const publisher1 = createQiitaPublisher({
        config,
        runner: qiita1.runner,
        logger: logger1,
        env: { QIITA_TOKEN: 'fake-qiita-token' },
      });
      const uploader1 = createFakeUploaderClient();
      const renderNote = resolveRenderer('qiita');

      const result1 = await runSync({
        config,
        publisher: publisher1,
        renderNote,
        ...baseSyncOptions({
          statePath,
          runner: parser1.runner,
          tmpDirFactory: async () => exportWorkDir1,
          logger: logger1,
          uploaderClient: uploader1,
        }),
      });

      expect(result1).toMatchObject({
        exitCode: PARTIAL_FAILURE,
        published: 1,
        skipped: 0,
        failed: 4,
      });
      expect(events1).toContain(`note_published:${LAUNCH_NOTES_UUID}:created`);
      for (const uuid of [
        SALES_TABLE_UUID,
        GROCERY_CHECKLIST_UUID,
        WHITEBOARD_SKETCH_UUID,
        OPS_LOG_UUID,
      ]) {
        expect(events1).toContain(`note_failed:${uuid}`);
      }
      // renderNote 段で例外(QiitaNoTagsRemainingError)を投げるため、qiita-cli は
      // タグ無しの4件については一切呼ばれない(境界呼び出しが起きていないことの確認)。
      expect(qiita1.calls).toHaveLength(1);
      expect(qiita1.calls[0]?.command).toBe('npx');
      expect(qiita1.calls[0]?.args.slice(0, 3)).toEqual(['--no-install', 'qiita', 'publish']);
      expect(qiita1.calls[0]?.args).toContain(LAUNCH_NOTES_UUID);
      // 5個超の警告は発生しない(タグはハッシュタグ3個のみ)。0個フォールバックの警告も無い
      // ——LAUNCH_NOTES 自体はタグを持つため。
      expect(warnings1.some((w) => w.noteUuid === LAUNCH_NOTES_UUID)).toBe(false);

      const publishedFile = await readFile(
        join(workspace, 'public', `${LAUNCH_NOTES_UUID}.md`),
        'utf8',
      );
      expect(publishedFile).toContain(`id: "qiita-${LAUNCH_NOTES_UUID}"`);

      const onDisk1 = readStateFile(statePath);
      expect(onDisk1.notes[LAUNCH_NOTES_UUID]).toMatchObject({
        remoteId: `qiita-${LAUNCH_NOTES_UUID}`,
        url: `https://qiita.com/items/qiita-${LAUNCH_NOTES_UUID}`,
      });
      for (const uuid of [
        SALES_TABLE_UUID,
        GROCERY_CHECKLIST_UUID,
        WHITEBOARD_SKETCH_UUID,
        OPS_LOG_UUID,
      ]) {
        expect(onDisk1.notes[uuid]).toBeUndefined();
      }

      // --- run 2: 見かけ上の「同一入力」だが、実際には publish() 直後のノート状態
      // (remoteId が既知になった)を反映するため、qiita は**もう1回だけ**publish() を
      // 呼ぶ(下記参照) -----------------------------------------------------------
      //
      // design.md §5.7 QiitaPublisher「id は初回 null、qiita-cli が投稿後に書き戻す
      // ID を読み取って状態 JSON に保存する」——`renderQiitaArticle` は frontmatter に
      // `prev?.remoteId ?? null` をそのまま書く(`src/publishers/qiita.ts`)。run 1 では
      // `prev` が無いため `id: null`、run 2 では `prev.remoteId` が既知になったため
      // `id: "qiita-<uuid>"` が書かれる——**この frontmatter 自体が content_hash の
      // 一部**(design.md §5.6)なので、fixture の内容が一切変わっていなくても
      // run 1 と run 2 では article の直列化結果(ひいてはハッシュ)が異なる。
      // これは note2web のバグではなく、「qiita-cli 自身の重複防止のため id を
      // frontmatter に書き戻す」という design.md 自身の決定(§5.7)から必然的に生じる
      // 挙動: Qiita だけは他6サービスと異なり、「1回の成功配信」の直後ではなく
      // 「remoteId が状態に確定した後の2回目の配信」を経て初めてハッシュが安定する
      // (=真に skip されるようになるのは3回目から)。この収束を run 2/run 3 の
      // 両方で検証する。
      const parser2 = makeFixtureRunner();
      const qiita2 = makeQiitaRunner();
      const { logger: logger2, events: events2 } = createFakeLogger();
      const publisher2 = createQiitaPublisher({
        config,
        runner: qiita2.runner,
        logger: logger2,
        env: { QIITA_TOKEN: 'fake-qiita-token' },
      });
      const uploader2 = createFakeUploaderClient();

      const result2 = await runSync({
        config,
        publisher: publisher2,
        renderNote,
        ...baseSyncOptions({
          statePath,
          runner: parser2.runner,
          tmpDirFactory: async () => exportWorkDir2,
          logger: logger2,
          uploaderClient: uploader2,
        }),
      });

      expect(result2).toMatchObject({
        exitCode: PARTIAL_FAILURE,
        published: 1,
        skipped: 0,
        failed: 4,
      });
      expect(events2).toContain(`note_published:${LAUNCH_NOTES_UUID}:updated`);
      expect(qiita2.calls).toHaveLength(1);
      // アセット(画像)は run 1 で既に確定保存済みのため、run 2 では再アップロードされない。
      expect(uploader2.putObjectCalls).toHaveLength(0);

      // --- run 3: ここでようやく content_hash が安定し、真の意味で idempotent になる ---
      const exportWorkDir3 = await mkdtemp(join(tmpdir(), 'note2web-it-export3-'));
      try {
        const parser3 = makeFixtureRunner();
        const qiita3 = makeQiitaRunner();
        const { logger: logger3, events: events3 } = createFakeLogger();
        const publisher3 = createQiitaPublisher({
          config,
          runner: qiita3.runner,
          logger: logger3,
          env: { QIITA_TOKEN: 'fake-qiita-token' },
        });
        const uploader3 = createFakeUploaderClient();

        const result3 = await runSync({
          config,
          publisher: publisher3,
          renderNote,
          ...baseSyncOptions({
            statePath,
            runner: parser3.runner,
            tmpDirFactory: async () => exportWorkDir3,
            logger: logger3,
            uploaderClient: uploader3,
          }),
        });

        expect(result3).toMatchObject({
          exitCode: PARTIAL_FAILURE,
          published: 0,
          skipped: 1,
          failed: 4,
        });
        expect(events3).toContain(`note_skipped:${LAUNCH_NOTES_UUID}`);
        // 変更が無いため qiita-cli(npx)は一切呼ばれない(境界呼び出しゼロ)。
        expect(qiita3.calls).toHaveLength(0);
        expect(uploader3.putObjectCalls).toHaveLength(0);
      } finally {
        await rm(exportWorkDir3, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // devto: API モード(Forem API v1 直叩き)。
  // -------------------------------------------------------------------------

  describe('devto (API mode via Forem API v1, createDevtoPublisher + renderDevtoArticle)', () => {
    function buildConfig(): Config {
      return {
        service: 'devto',
        timezone: 'Asia/Tokyo',
        source: { folders: ALL_FOLDERS },
        assets: ASSETS_CONFIG,
        devto: {
          api_key_env: 'DEVTO_API_KEY',
          canonical_base_url: 'https://example.com/articles/',
        },
      };
    }

    interface RecordedCall {
      method: DevtoHttpRequest['method'];
      url: string;
      body: string | undefined;
    }

    function makeHttpClient(): { client: DevtoHttpClient; calls: RecordedCall[] } {
      const calls: RecordedCall[] = [];
      let nextId = 1;
      const client: DevtoHttpClient = async (request) => {
        calls.push({ method: request.method, url: request.url, body: request.body });
        if (request.method === 'GET') {
          return { status: 200, body: '[]' };
        }
        const id = nextId;
        nextId += 1;
        return {
          status: request.method === 'POST' ? 201 : 200,
          body: JSON.stringify({ id, url: `https://dev.to/example/article-${String(id)}` }),
        };
      };
      return { client, calls };
    }

    it('publishes all 5 notes via POST (0 title matches), records remoteId/url per note, then is fully idempotent (no HTTP calls at all)', async () => {
      const config = buildConfig();

      // --- run 1 ---------------------------------------------------------------
      const parser1 = makeFixtureRunner();
      const http1 = makeHttpClient();
      const { logger: logger1, events: events1 } = createFakeLogger();
      const publisher1 = createDevtoPublisher({
        config,
        httpClient: http1.client,
        logger: logger1,
        env: { DEVTO_API_KEY: 'fake-devto-key' },
      });
      const uploader1 = createFakeUploaderClient();
      const renderNote = resolveRenderer('devto');

      const result1 = await runSync({
        config,
        publisher: publisher1,
        renderNote,
        ...baseSyncOptions({
          statePath,
          runner: parser1.runner,
          tmpDirFactory: async () => exportWorkDir1,
          logger: logger1,
          uploaderClient: uploader1,
        }),
      });

      expect(result1).toMatchObject({ exitCode: SUCCESS, published: 5, skipped: 0, failed: 0 });
      for (const uuid of ALL_UUIDS) {
        expect(events1).toContain(`note_published:${uuid}:created`);
      }
      // GET /api/articles/me(タイトル一致照合。1回だけ・全ノートで共有キャッシュ)+ POST x5。
      expect(http1.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
      expect(http1.calls.filter((c) => c.method === 'POST')).toHaveLength(5);
      const salesTablePost = http1.calls.find(
        (c) => c.method === 'POST' && c.body?.includes(SALES_TABLE_UUID) === true,
      );
      expect(salesTablePost?.url).toBe(`${DEVTO_API_BASE_URL}/api/articles`);
      const parsedBody = JSON.parse(salesTablePost?.body ?? '{}') as {
        article: { canonical_url?: string; published: boolean };
      };
      expect(parsedBody.article.canonical_url).toBe(
        `https://example.com/articles/${SALES_TABLE_UUID}`,
      );
      expect(parsedBody.article.published).toBe(true);

      const onDisk1 = readStateFile(statePath);
      for (const uuid of ALL_UUIDS) {
        expect(onDisk1.notes[uuid]?.remoteId).toMatch(/^\d+$/);
        expect(onDisk1.notes[uuid]?.url).toMatch(/^https:\/\/dev\.to\//);
      }

      // --- run 2(冪等性)---------------------------------------------------------
      const parser2 = makeFixtureRunner();
      const http2 = makeHttpClient();
      const { logger: logger2, events: events2 } = createFakeLogger();
      const publisher2 = createDevtoPublisher({
        config,
        httpClient: http2.client,
        logger: logger2,
        env: { DEVTO_API_KEY: 'fake-devto-key' },
      });
      const uploader2 = createFakeUploaderClient();

      const result2 = await runSync({
        config,
        publisher: publisher2,
        renderNote,
        ...baseSyncOptions({
          statePath,
          runner: parser2.runner,
          tmpDirFactory: async () => exportWorkDir2,
          logger: logger2,
          uploaderClient: uploader2,
        }),
      });

      expect(result2).toMatchObject({ exitCode: SUCCESS, published: 0, skipped: 5, failed: 0 });
      for (const uuid of ALL_UUIDS) {
        expect(events2).toContain(`note_skipped:${uuid}`);
      }
      // 変更が無いため Forem API へは1リクエストも行われない(GET/POST/PUT いずれも0件)。
      expect(http2.calls).toHaveLength(0);
      expect(uploader2.putObjectCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // hatena: API モード(AtomPub)。
  // -------------------------------------------------------------------------

  describe('hatena (API mode via AtomPub, createHatenaPublisher + renderHatenaArticle)', () => {
    function buildConfig(): Config {
      return {
        service: 'hatena',
        timezone: 'Asia/Tokyo',
        source: { folders: ALL_FOLDERS },
        assets: ASSETS_CONFIG,
        hatena: {
          hatena_id: 'example',
          blog_id: 'example.hatenablog.com',
          api_key_env: 'HATENA_API_KEY',
        },
      };
    }

    interface RecordedCall {
      method: HatenaHttpRequest['method'];
      url: string;
      body: string | undefined;
    }

    function emptyFeed(): string {
      return '<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>';
    }

    function makeHttpClient(): { client: HatenaHttpClient; calls: RecordedCall[] } {
      const calls: RecordedCall[] = [];
      let nextId = 1;
      const client: HatenaHttpClient = async (request): Promise<HatenaHttpResponse> => {
        calls.push({ method: request.method, url: request.url, body: request.body });
        if (request.method === 'GET') {
          return { status: 200, headers: {}, body: emptyFeed() };
        }
        // POST: Location ヘッダから entry_id を抽出させる(モジュール JSDoc「entry_id の抽出」)。
        const id = String(nextId);
        nextId += 1;
        return {
          status: 201,
          headers: {
            location: `https://blog.hatena.ne.jp/example/example.hatenablog.com/atom/entry/${id}`,
          },
          body:
            '<?xml version="1.0" encoding="utf-8"?><entry xmlns="http://www.w3.org/2005/Atom">' +
            `<link rel="alternate" href="https://example.hatenablog.com/entry/${id}"/></entry>`,
        };
      };
      return { client, calls };
    }

    it('publishes all 5 notes via POST (0 title matches), records entry_id/url per note, then is fully idempotent (no HTTP calls at all)', async () => {
      const config = buildConfig();

      // --- run 1 ---------------------------------------------------------------
      const parser1 = makeFixtureRunner();
      const http1 = makeHttpClient();
      const { logger: logger1, events: events1 } = createFakeLogger();
      const publisher1 = createHatenaPublisher({
        config,
        client: http1.client,
        logger: logger1,
        env: { HATENA_API_KEY: 'fake-hatena-key' },
      });
      const uploader1 = createFakeUploaderClient();
      const renderNote = resolveRenderer('hatena');

      const result1 = await runSync({
        config,
        publisher: publisher1,
        renderNote,
        ...baseSyncOptions({
          statePath,
          runner: parser1.runner,
          tmpDirFactory: async () => exportWorkDir1,
          logger: logger1,
          uploaderClient: uploader1,
        }),
      });

      expect(result1).toMatchObject({ exitCode: SUCCESS, published: 5, skipped: 0, failed: 0 });
      for (const uuid of ALL_UUIDS) {
        expect(events1).toContain(`note_published:${uuid}:created`);
      }
      expect(http1.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
      expect(http1.calls.filter((c) => c.method === 'POST')).toHaveLength(5);
      const opsLogPost = http1.calls.find(
        (c) => c.method === 'POST' && c.body?.includes('Ops Log') === true,
      );
      expect(opsLogPost?.body).toContain('<category term="Dev/Ops: Log"/>');
      expect(opsLogPost?.body).toContain('type="text/x-markdown"');

      const onDisk1 = readStateFile(statePath);
      for (const uuid of ALL_UUIDS) {
        expect(onDisk1.notes[uuid]?.remoteId).toMatch(/^\d+$/);
        expect(onDisk1.notes[uuid]?.url).toMatch(/^https:\/\/example\.hatenablog\.com\/entry\//);
      }

      // --- run 2(冪等性)---------------------------------------------------------
      const parser2 = makeFixtureRunner();
      const http2 = makeHttpClient();
      const { logger: logger2, events: events2 } = createFakeLogger();
      const publisher2 = createHatenaPublisher({
        config,
        client: http2.client,
        logger: logger2,
        env: { HATENA_API_KEY: 'fake-hatena-key' },
      });
      const uploader2 = createFakeUploaderClient();

      const result2 = await runSync({
        config,
        publisher: publisher2,
        renderNote,
        ...baseSyncOptions({
          statePath,
          runner: parser2.runner,
          tmpDirFactory: async () => exportWorkDir2,
          logger: logger2,
          uploaderClient: uploader2,
        }),
      });

      expect(result2).toMatchObject({ exitCode: SUCCESS, published: 0, skipped: 5, failed: 0 });
      for (const uuid of ALL_UUIDS) {
        expect(events2).toContain(`note_skipped:${uuid}`);
      }
      expect(http2.calls).toHaveLength(0);
      expect(uploader2.putObjectCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // note.com: CLI モード(noet)。issue #31 の受け入れ条件そのもの(画像ノートは
  // NoteImagesUnsupportedError で failed、非画像ノートは noet 経由で created)。
  // -------------------------------------------------------------------------

  describe('note (CLI mode via noet, createNotePublisher + renderNoteArticle) — design.md §13-6 image split', () => {
    let workspace: string;

    beforeEach(async () => {
      workspace = await mkdtemp(join(tmpdir(), 'note2web-it-note-workspace-'));
    });
    afterEach(async () => {
      await rm(workspace, { recursive: true, force: true });
    });

    function buildConfig(): Config {
      return {
        service: 'note',
        timezone: 'Asia/Tokyo',
        source: { folders: ALL_FOLDERS },
        assets: ASSETS_CONFIG,
        note: { workspace },
      };
    }

    /**
     * `noet list`(空)/`noet create <file>`(note.com 記事 URL を stdout に返す)を模倣する
     * fake runner(モジュール冒頭 JSDoc・`src/publishers/note.ts` の `NOTE_URL_PATTERN` 参照)。
     * `noet update` はこのテストでは呼ばれない(全て初回配信のため)。
     */
    function makeNoetRunner(): { runner: NoteRunner; calls: RunSubprocessOptions[] } {
      const calls: RunSubprocessOptions[] = [];
      const runner: NoteRunner = async (options: RunSubprocessOptions) => {
        calls.push(options);
        if (options.args[0] === 'list') {
          return { status: 'success', exitCode: 0, signal: null, stdout: '', stderr: '' };
        }
        if (options.args[0] === 'create') {
          const filePath = options.args[1] ?? '';
          const key = basename(filePath, '.md');
          return {
            status: 'success',
            exitCode: 0,
            signal: null,
            stdout: `https://note.com/example/n/${String(key)}\n`,
            stderr: '',
          };
        }
        return { status: 'success', exitCode: 0, signal: null, stdout: '', stderr: '' };
      };
      return { runner, calls };
    }

    it('creates the 4 image-free notes via noet, fails the 1 image note with NoteImagesUnsupportedError (exit PARTIAL_FAILURE), then is fully idempotent', async () => {
      const config = buildConfig();

      // --- run 1 ---------------------------------------------------------------
      const parser1 = makeFixtureRunner();
      const noet1 = makeNoetRunner();
      const { logger: logger1, events: events1 } = createFakeLogger();
      const publisher1 = createNotePublisher({ config, runner: noet1.runner, logger: logger1 });
      const uploader1 = createFakeUploaderClient();
      const renderNote = resolveRenderer('note');

      const result1 = await runSync({
        config,
        publisher: publisher1,
        renderNote,
        ...baseSyncOptions({
          statePath,
          runner: parser1.runner,
          tmpDirFactory: async () => exportWorkDir1,
          logger: logger1,
          uploaderClient: uploader1,
        }),
      });

      // issue #31 の受け入れ条件: 画像ノート(Whiteboard Sketch)のみ failed、残り4件は created。
      expect(result1).toMatchObject({
        exitCode: PARTIAL_FAILURE,
        published: 4,
        skipped: 0,
        failed: 1,
      });
      expect(events1).toContain(`note_failed:${WHITEBOARD_SKETCH_UUID}`);
      for (const uuid of [
        SALES_TABLE_UUID,
        GROCERY_CHECKLIST_UUID,
        LAUNCH_NOTES_UUID,
        OPS_LOG_UUID,
      ]) {
        expect(events1).toContain(`note_published:${uuid}:created`);
      }

      // 画像ノートは renderNote 段(NoteImagesUnsupportedError)で落ちるため、noet は
      // このノートに対して一切呼ばれていない(`noet create` の引数一覧を確認)。
      const createCalls = noet1.calls.filter((c) => c.args[0] === 'create');
      expect(createCalls).toHaveLength(4);
      expect(createCalls.some((c) => c.args[1]?.includes(WHITEBOARD_SKETCH_UUID) === true)).toBe(
        false,
      );
      // `noet list`(0件確定)が run 内で1回だけ実行され、以後の照合はキャッシュを使う
      // (`ensureListFetched` の per-run キャッシュ。モジュール冒頭 JSDoc「3. 記事一覧の完全性」)。
      expect(noet1.calls.filter((c) => c.args[0] === 'list')).toHaveLength(1);

      const onDisk1 = readStateFile(statePath);
      for (const uuid of [
        SALES_TABLE_UUID,
        GROCERY_CHECKLIST_UUID,
        LAUNCH_NOTES_UUID,
        OPS_LOG_UUID,
      ]) {
        expect(onDisk1.notes[uuid]?.remoteId).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(onDisk1.notes[uuid]?.url).toMatch(/^https:\/\/note\.com\/example\/n\//);
      }
      expect(onDisk1.notes[WHITEBOARD_SKETCH_UUID]).toBeUndefined();
      // 画像自体はアップロード済み(§5.6 書き込みポイント1。ノート自身の failed とは独立)。
      expect(Object.keys(onDisk1.assets)).toHaveLength(1);

      // --- run 2(冪等性)---------------------------------------------------------
      const parser2 = makeFixtureRunner();
      const noet2 = makeNoetRunner();
      const { logger: logger2, events: events2 } = createFakeLogger();
      const publisher2 = createNotePublisher({ config, runner: noet2.runner, logger: logger2 });
      const uploader2 = createFakeUploaderClient();

      const result2 = await runSync({
        config,
        publisher: publisher2,
        renderNote,
        ...baseSyncOptions({
          statePath,
          runner: parser2.runner,
          tmpDirFactory: async () => exportWorkDir2,
          logger: logger2,
          uploaderClient: uploader2,
        }),
      });

      expect(result2).toMatchObject({
        exitCode: PARTIAL_FAILURE,
        published: 0,
        skipped: 4,
        failed: 1,
      });
      for (const uuid of [
        SALES_TABLE_UUID,
        GROCERY_CHECKLIST_UUID,
        LAUNCH_NOTES_UUID,
        OPS_LOG_UUID,
      ]) {
        expect(events2).toContain(`note_skipped:${uuid}`);
      }
      // 画像ノートは renderNote が毎回例外を投げる設計(NFR-06 により毎回再試行される)ため、
      // 2回目実行でも同じく failed のまま——これは noet 呼び出しには到達すらしないバグ無しの
      // 既知挙動であることを、noet2 の呼び出しが1件も画像ノートに関連しないことで確認する。
      expect(events2).toContain(`note_failed:${WHITEBOARD_SKETCH_UUID}`);
      // 4件は skip されたため noet は一切呼ばれない(境界呼び出しゼロ)。
      expect(noet2.calls).toHaveLength(0);
      expect(uploader2.putObjectCalls).toHaveLength(0);
    });
  });
});
