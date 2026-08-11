/**
 * sync フロー統合(design.md §6「処理フロー」、§10「エラーハンドリング」、T-14 / issue #19)。
 *
 * design.md §6 の8手順を、既存の各コンポーネント(T-02〜T-13)を結線して実装する:
 *
 * ```text
 * 1. 設定 YAML 読み込み・検証        … 呼び出し側(cli.ts、T-04)が実施済み。ここでは受け取るだけ
 * 2. 依存チェック                    … src/dependencies.ts(本タスクで新規)
 * 3. Exporter 実行 → 一時ディレクトリ … src/exporter/apple-notes.ts(T-09)
 * 4. フォルダフィルタ                … Exporter 内で実施済み(config.source.folders)
 * 5. Git モードなら作業ブランチ作成  … Publisher.prepare()(定義時のみ。src/publishers/types.ts)
 * 6. 各ノート(1件ずつ、失敗は隔離)  … processNote(本モジュール内部)
 * 7. Git モード: finalize()          … Publisher.finalize() → 成功後 StateStore.flush()
 * 8. 後片付け・サマリログ・終了コード … 本モジュール
 * ```
 *
 * ロック(design.md §6「多重起動防止」)は依存チェックの後・StateStore 読み込みの前に
 * 取得し、`finally` で必ず解放する(T-06)。
 *
 * **エラーハンドリングの方針**: `runCli`(`src/cli.ts`)が `ConfigValidationError` を
 * 自身で catch して `CliResult` に変換する既存の非 throw 型パターンに合わせ、`runSync`
 * も前提条件不成立(依存欠如・多重起動・状態検証失敗・parser 実行失敗)を型付きエラーの
 * `instanceof` で判定し、`RunSyncResult`(exitCode 付き)として返す——呼び出し側
 * (cli.ts・テスト)が毎回 try/catch する必要がないようにするため。ノート単位の失敗
 * (NFR-06)は `processNote` 内部で隔離し、決して例外として外へは投げない。
 *
 * **前提条件不成立時のログ**: `logger.runStart()` は常に最初に発行するが、依存欠如・
 * 多重起動・状態検証失敗・parser 実行失敗のいずれでも `logger.runEnd()` は発行しない
 * ——「何も配信せず exit 2」(design.md §10)の精神どおり、パイプラインが実質的に
 * 始まっていない(published/skipped/failed のいずれも意味を持たない)ため。
 */

import { rm } from 'node:fs/promises';
import type { Config } from './config.js';
import {
  checkDependencies,
  DependencyCheckError,
  type CheckDependenciesOptions,
} from './dependencies.js';
import { PARTIAL_FAILURE, PRECONDITION_FAILURE, SUCCESS } from './exit-codes.js';
import {
  exportAppleNotes,
  ExportError,
  type ExportResult,
  type SubprocessRunner,
} from './exporter/apple-notes.js';
import { acquireLock, lockPathFor, LockError, releaseLock, type LockHandle } from './lock.js';
import type { Logger } from './logger.js';
import type { Note } from './model/note.js';
import { isGitModeService } from './publishers/mode.js';
import { renderGenericArticle, type NoteRenderer } from './publishers/render.js';
import type { Publisher, PublishResult, RenderedArticle } from './publishers/types.js';
import { deriveTarget } from './state/derive.js';
import { StateStore, StateValidationError, type NoteState } from './state/store.js';
import { processNoteBody, type UploaderClient } from './assets/uploader.js';
import { completeNoteMetadata } from './transform/metadata.js';
import { transformBody } from './transform/body.js';
import { formatTimestamp } from './transform/normalize.js';

// ---------------------------------------------------------------------------
// 入力・出力契約。
// ---------------------------------------------------------------------------

/** `runSync` のオプション。実運用の依存に加え、テスト用の注入点を持つ。 */
export interface RunSyncOptions {
  /** 検証済み設定(cli.ts が `loadConfig` で検証済みのものをそのまま渡す想定)。 */
  config: Config;
  /** 状態 JSON のパス(`src/state/derive.ts` の `resolveStatePath` で導出したもの)。 */
  statePath: string;
  logger: Logger;
  /** 配信先 Publisher(design.md §5.7)。T-14 時点ではモック/T-16 以降で実装が揃う。 */
  publisher: Publisher;
  /** アセットアップロード先クライアント(`src/assets/client.ts`、T-13)。 */
  uploaderClient: UploaderClient;
  /**
   * ノートのレンダリング(design.md §6 手順6c)。既定は `renderGenericArticle`
   * (`src/publishers/render.ts`)。サービス別 Renderer(T-17 以降)が揃うまでの
   * 暫定実装であり、呼び出し側が差し替えられるようにしてある。
   */
  renderNote?: NoteRenderer;
  /** Exporter へ渡すサブプロセス実行の注入点(テスト用。既定は本物の `runSubprocess`)。 */
  runner?: SubprocessRunner;
  /** Exporter の一時ディレクトリ作成の注入点(テスト用)。 */
  tmpDirFactory?: () => Promise<string>;
  /** 時刻注入点(テスト用)。既定は `() => new Date()`。 */
  now?: () => Date;
  /** ロック取得の注入点(テスト用)。既定は `src/lock.ts` の `acquireLock`。 */
  acquireLockFn?: typeof acquireLock;
  /** ロック解放の注入点(テスト用)。既定は `src/lock.ts` の `releaseLock`。 */
  releaseLockFn?: typeof releaseLock;
  /** 依存チェックの注入点(テスト用)。既定は `src/dependencies.ts` の `checkDependencies`。 */
  checkDependenciesFn?: (config: Config, options?: CheckDependenciesOptions) => Promise<void>;
}

/** `runSync` の戻り値。 */
export interface RunSyncResult {
  /** design.md §5.1/§10 の終了コード規約(0/1/2)。 */
  exitCode: number;
  published: number;
  skipped: number;
  failed: number;
  /**
   * 前提条件不成立で処理を開始・継続できなかった場合の理由(cli.ts が stderr に出す用)。
   * ノート単位の失敗は `logger.noteFailed` に記録されるのみで、ここには含めない。
   */
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preconditionFailure(message: string): RunSyncResult {
  return { exitCode: PRECONDITION_FAILURE, published: 0, skipped: 0, failed: 0, error: message };
}

// ---------------------------------------------------------------------------
// ノート単位処理(design.md §6 手順6。失敗はここで隔離し、決して外へ投げない)。
// ---------------------------------------------------------------------------

type NoteOutcome = 'published' | 'skipped' | 'failed';

interface ProcessNoteParams {
  note: Note;
  config: Config;
  state: StateStore;
  publisher: Publisher;
  uploaderClient: UploaderClient;
  renderNote: NoteRenderer;
  logger: Logger;
  exportDir: string;
  gitMode: boolean;
  now: () => Date;
}

/**
 * 1ノートを「メタデータ抽出 → 本文変換 → アセット解決 → レンダリング → ハッシュ判定 →
 * 配信 → 状態確定」まで処理する(design.md §6 手順6)。
 *
 * いずれかの段で例外が発生した場合、状態 JSON を一切更新せず `logger.noteFailed` を
 * 発行して `'failed'` を返す(NFR-06「失敗したノートは状態を更新せず、次回実行で
 * 自動的に再試行される」)。ただし、アセットアップロードの成功分(`StateStore.saveAsset`
 * 経由)は `processNoteBody` が既に即時保存済みであり、ここでの失敗によって取り消され
 * ない(design.md §5.6 書き込みポイント1)。
 */
async function processNote(params: ProcessNoteParams): Promise<NoteOutcome> {
  const {
    note: rawNote,
    config,
    state,
    publisher,
    uploaderClient,
    renderNote,
    logger,
    exportDir,
    gitMode,
    now,
  } = params;
  const service = config.service;

  let note: Note;
  let markdown: string;
  try {
    note = completeNoteMetadata(rawNote);
    const transformed = transformBody({
      bodyHtml: note.bodyHtml,
      logger,
      noteUuid: note.uuid,
      title: note.title,
    });
    const resolved = await processNoteBody({
      markdown: transformed.markdown,
      attachments: note.attachments,
      exportDir,
      noteUuid: note.uuid,
      service,
      assets: config.assets,
      state,
      client: uploaderClient,
      logger,
      timezone: config.timezone,
      now,
    });
    markdown = resolved.markdown;
  } catch (error) {
    logger.noteFailed({
      service,
      noteUuid: rawNote.uuid,
      title: rawNote.title !== '' ? rawNote.title : rawNote.uuid,
      error: errorMessage(error),
    });
    return 'failed';
  }

  let article: RenderedArticle;
  try {
    article = renderNote({ note, markdown, config });
  } catch (error) {
    logger.noteFailed({
      service,
      noteUuid: note.uuid,
      title: note.title,
      error: errorMessage(error),
    });
    return 'failed';
  }

  // design.md §6 手順6d: StateStore の content_hash と一致すれば skip。
  const prev = state.getNote(note.uuid) ?? null;
  if (prev !== null && prev.contentHash === article.contentHash) {
    logger.noteSkipped({ service, noteUuid: note.uuid, title: note.title });
    return 'skipped';
  }

  // design.md §6 手順6e: 不一致 → Publisher.publish()。
  let publishResult: PublishResult;
  try {
    publishResult = await publisher.publish(article, prev);
  } catch (error) {
    logger.noteFailed({
      service,
      noteUuid: note.uuid,
      title: note.title,
      error: errorMessage(error),
    });
    return 'failed';
  }

  logger.notePublished({
    service,
    noteUuid: note.uuid,
    title: note.title,
    result: publishResult.result,
    url: publishResult.url,
  });

  const timestamp = formatTimestamp(now(), config.timezone);
  const entry: NoteState = {
    contentHash: article.contentHash,
    remoteId: publishResult.remoteId,
    url: publishResult.url,
    artifactPath: article.artifactPath,
    // firstPublishedAt は初回配信時刻を保持し続ける(design.md §8)。更新時は既存値を引き継ぐ。
    firstPublishedAt: prev?.firstPublishedAt ?? timestamp,
    lastPublishedAt: timestamp,
  };

  // design.md §6 手順6f / §5.6 書き込みポイント2:
  // API/CLI モードは publish() 成功ごとに即時確定、Git モードは finalize() まで保留。
  if (gitMode) {
    state.stageNote(note.uuid, entry);
    return 'published';
  }

  try {
    await state.confirmNote(note.uuid, entry);
  } catch (error) {
    // 配信自体は成功しているが状態の確定保存に失敗した。NFR-06 の趣旨(状態未更新なら
    // 次回再試行される)に沿い、このノートは failed として扱う。
    logger.noteFailed({
      service,
      noteUuid: note.uuid,
      title: note.title,
      error: `publish succeeded but failed to persist state: ${errorMessage(error)}`,
    });
    return 'failed';
  }
  return 'published';
}

// ---------------------------------------------------------------------------
// ロック取得後の本体(design.md §6 手順4〜8)。
// ---------------------------------------------------------------------------

interface RunLockedSyncParams {
  config: Config;
  statePath: string;
  logger: Logger;
  publisher: Publisher;
  uploaderClient: UploaderClient;
  renderNote: NoteRenderer;
  runner: SubprocessRunner | undefined;
  tmpDirFactory: (() => Promise<string>) | undefined;
  now: () => Date;
}

async function runLockedSync(params: RunLockedSyncParams): Promise<RunSyncResult> {
  const {
    config,
    statePath,
    logger,
    publisher,
    uploaderClient,
    renderNote,
    runner,
    tmpDirFactory,
    now,
  } = params;

  // design.md §6: StateStore は実行開始時に1回だけ読み込む(T-07)。
  let state: StateStore;
  try {
    const target = deriveTarget(config);
    state = await StateStore.load({ statePath, service: config.service, target });
  } catch (error) {
    if (error instanceof StateValidationError) {
      return preconditionFailure(error.message);
    }
    throw error;
  }

  const gitMode = isGitModeService(config.service);

  // design.md §6 手順5: Git モードなら作業ブランチ作成(Publisher 実装が定義していれば)。
  if (gitMode && publisher.prepare) {
    await publisher.prepare();
  }

  // design.md §6 手順3・4: Exporter 実行(フォルダフィルタは Exporter 内部で適用済み)。
  let exportResult: ExportResult;
  try {
    exportResult = await exportAppleNotes({ config, logger, runner, tmpDirFactory });
  } catch (error) {
    if (error instanceof ExportError) {
      // design.md §10「parser の実行失敗 → 実行全体を中断、exit 1」。
      return {
        exitCode: PARTIAL_FAILURE,
        published: 0,
        skipped: 0,
        failed: 0,
        error: error.message,
      };
    }
    throw error;
  }

  const counts = { published: 0, skipped: 0, failed: 0 };
  let finalizeFailed = false;

  try {
    // Exporter 自身が HTML 解決に失敗させた分も、実行全体のサマリに含める(NFR-06)。
    counts.failed += exportResult.failed.length;

    // design.md §6 手順6: 各ノートを1件ずつ処理(失敗は隔離)。
    for (const note of exportResult.notes) {
      const outcome = await processNote({
        note,
        config,
        state,
        publisher,
        uploaderClient,
        renderNote,
        logger,
        exportDir: exportResult.exportDir,
        gitMode,
        now,
      });
      counts[outcome] += 1;
    }

    // design.md §6 手順7: Git モードの finalize()。
    if (gitMode && publisher.finalize) {
      try {
        await publisher.finalize();
        // PR 作成成功後に保留分を一括保存する(design.md §5.6 書き込みポイント2)。
        await state.flush();
      } catch (error) {
        // design.md §5.7 手順4 / §10: finalize 失敗時は保留分を確定させない
        // (flush 済みでなければ何も確定しない。flush 自体が失敗した場合も同様に扱う)。
        // 実行全体を失敗として報告する。
        logger.warn({
          message: `finalize failed, staged notes were not persisted: ${errorMessage(error)}`,
        });
        finalizeFailed = true;
      }
    }
  } finally {
    // design.md §6「サブプロセス実行の共通規約」: 正常・異常いずれの経路でも
    // 一時ディレクトリの削除を必ず実施する。削除自体の失敗で本来の結果を隠さない。
    await rm(exportResult.exportDir, { recursive: true, force: true }).catch(() => {
      // 意図的に無視。
    });
  }

  logger.runEnd(counts);

  const exitCode = finalizeFailed || counts.failed > 0 ? PARTIAL_FAILURE : SUCCESS;
  return { exitCode, ...counts };
}

// ---------------------------------------------------------------------------
// エントリ関数。
// ---------------------------------------------------------------------------

/**
 * design.md §6 の8手順を実行する(T-14 / issue #19)。
 *
 * 前提条件不成立(依存欠如・多重起動・状態検証失敗・parser 実行失敗)は例外を投げず
 * `RunSyncResult`(該当する exitCode 付き)として返す。個別ノートの失敗
 * (`ExportResult.failed` や `processNote` の失敗)は実行全体を継続したうえで
 * `run_end` のサマリに含める(NFR-06)。
 */
export async function runSync(options: RunSyncOptions): Promise<RunSyncResult> {
  const {
    config,
    statePath,
    logger,
    publisher,
    uploaderClient,
    renderNote = renderGenericArticle,
    runner,
    tmpDirFactory,
    now = () => new Date(),
    acquireLockFn = acquireLock,
    releaseLockFn = releaseLock,
    checkDependenciesFn = checkDependencies,
  } = options;

  logger.runStart();

  // design.md §6 手順2: 依存チェック。
  try {
    await checkDependenciesFn(config);
  } catch (error) {
    if (error instanceof DependencyCheckError) {
      return preconditionFailure(error.message);
    }
    throw error;
  }

  // design.md §6「多重起動防止」: 依存チェックの後・StateStore 読み込みの前に取得する。
  const lockPath = lockPathFor(statePath);
  let lockHandle: LockHandle;
  try {
    lockHandle = acquireLockFn(lockPath);
  } catch (error) {
    if (error instanceof LockError) {
      return preconditionFailure(error.message);
    }
    throw error;
  }

  try {
    return await runLockedSync({
      config,
      statePath,
      logger,
      publisher,
      uploaderClient,
      renderNote,
      runner,
      tmpDirFactory,
      now,
    });
  } finally {
    releaseLockFn(lockHandle);
  }
}
