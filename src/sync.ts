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
 * **T-16(issue #21)で追加した前提条件**: Git モード(zenn/hugo/jekyll)では、依存チェック・
 * `validateGitModePublisherContract` の直後、ロック取得より前に `GH_TOKEN` の有効性
 * (`gh auth status`)と対象リポジトリへの push / PR 作成権限を確認する
 * (`src/git-auth.ts` の `checkGitModeAuthAndPermission`。design.md §5.7「`doctor` /
 * `sync` 冒頭で… 確認」)。不備があれば `prepare()`(ブランチ作成等の Git 副作用)は
 * 一切実行せず、StateStore 読み込み・ロック取得も行わずに exit 2 とする。
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
  type DependencyProblem,
} from './dependencies.js';
import { PARTIAL_FAILURE, PRECONDITION_FAILURE, SUCCESS } from './exit-codes.js';
import {
  exportAppleNotes,
  ExportError,
  type ExportResult,
  type SubprocessRunner,
} from './exporter/apple-notes.js';
import { checkGitModeAuthAndPermission } from './git-auth.js';
import { acquireLock, lockPathFor, LockError, releaseLock, type LockHandle } from './lock.js';
import type { Logger } from './logger.js';
import type { Note } from './model/note.js';
import { isGitModeService } from './publishers/mode.js';
import { renderGenericArticle, type NoteRenderer } from './publishers/render.js';
import type {
  FinalizeOutcome,
  Publisher,
  PublishResult,
  RenderedArticle,
} from './publishers/types.js';
import { deriveTarget } from './state/derive.js';
import { StateStore, StateValidationError, type NoteState } from './state/store.js';
import { processNoteBody, type UploaderClient } from './assets/uploader.js';
import { commandExists, runSubprocess } from './subprocess.js';
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
  /**
   * Git モードの `gh auth status` / リポジトリ権限検証の注入点(テスト用)。既定は
   * `src/git-auth.ts` の `checkGitModeAuthAndPermission` を本物の `commandExists` /
   * `runSubprocess` / `process.env` で呼ぶ実装(design.md §5.7、T-16 / issue #21)。
   * Git モードでない場合は何もしない(既定実装・注入実装のいずれも呼び出し側で
   * `isGitModeService` を判定する必要はない)。
   */
  checkGitAuthFn?: (config: Config) => Promise<void>;
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

function runAborted(message: string): RunSyncResult {
  return { exitCode: PARTIAL_FAILURE, published: 0, skipped: 0, failed: 0, error: message };
}

/**
 * `RunSyncOptions.checkGitAuthFn` の既定実装(T-16 / issue #21)。Git モードでなければ
 * 何もしない(`checkGitModeAuthAndPermission` 自身が判定する)。問題が見つかった場合は
 * `DependencyCheckError` として投げ、`runSync` 側の既存の `preconditionFailure` 経路に
 * 乗せる(`checkDependenciesFn` の失敗と同じ扱い)。
 */
async function defaultCheckGitAuth(config: Config): Promise<void> {
  const problems: DependencyProblem[] = [];
  await checkGitModeAuthAndPermission(config, problems, {
    commandExistsFn: commandExists,
    env: process.env,
    runSubprocessFn: runSubprocess,
  });
  if (problems.length > 0) {
    throw new DependencyCheckError(problems);
  }
}

/**
 * `value` が `undefined` であれば内部不変条件違反として例外を投げる。Git モードの
 * `publisher.prepare`/`publisher.finalize` は `runSync` の冒頭
 * (`validateGitModePublisherContract`)で存在を検証済みのはずであり、ここでの
 * `undefined` は「検証をすり抜けた」というバグを示す(CodeRabbit review, PR #47)。
 */
function requireDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(`internal error: ${message}`);
  }
  return value;
}

/**
 * Git モード(design.md §5.7 GitRepoPublisher 系)では `publisher.prepare` /
 * `publisher.finalize` の両方が実装されていることを要求する(`src/publishers/types.ts`
 * の JSDoc 参照。§5.7 のインターフェース自体では両方とも任意)。欠けている場合、
 * ロック取得やエクスポートなど一切の作業を行う前に検出できるよう、`runSync` の冒頭
 * (依存チェックの直後)で呼ぶ。
 */
function validateGitModePublisherContract(
  config: Config,
  publisher: Publisher,
): RunSyncResult | undefined {
  if (!isGitModeService(config.service)) {
    return undefined;
  }
  const missing: string[] = [];
  if (publisher.prepare === undefined) {
    missing.push('prepare');
  }
  if (publisher.finalize === undefined) {
    missing.push('finalize');
  }
  if (missing.length === 0) {
    return undefined;
  }
  return preconditionFailure(
    `git-mode service "${config.service}" requires a Publisher implementing both prepare() and ` +
      `finalize() (design.md §5.7 GitRepoPublisher); missing: ${missing.join(', ')}`,
  );
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
 *
 * **`logger.notePublished` は状態の確定後にのみ発行する**(CodeRabbit review, PR #47):
 * API/CLI モードでは `StateStore.confirmNote` の成功後、Git モードでは(ステージングは
 * メモリ操作のみで実質失敗しないため)`StateStore.stageNote` の直後に発行する。
 * `publisher.publish` は成功したが `confirmNote` が失敗した場合は `note_published` を
 * 一切出さず、`note_failed` のみを発行する。
 *
 * **既知のリスク(重複作成)**: `publisher.publish` の成功後に `confirmNote`(状態保存)が
 * 失敗すると、配信自体は完了しているのに状態 JSON には記録されない。この場合、次回
 * 実行時は `StateStore.getNote(uuid)` が `undefined` を返す(= 初回配信扱い)ため、
 * 汎用の sync フローだけでは「既に配信済みかどうか」を判別できず、Publisher の実装
 * 次第では重複記事を作成してしまう可能性がある。design.md §5.7「応答不明時の重複防止」
 * が定める、サービス固有の `prev`/`remoteId` 照合(dev.to のタイトル一致検索、Qiita の
 * frontmatter 書き戻し等)は個々の Publisher 実装(T-15 以降)の責務であり、本モジュール
 * (sync フロー)はその照合結果をそのまま信頼するだけで、汎用的な重複防止機構は持たない。
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
      attachments: note.attachments,
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

  // design.md §6 手順6d の content_hash 比較、および Jekyll のファイル名固定
  // (design.md §4、`renderJekyllArticle`、T-19 / issue #24)の両方が前回の `NoteState` を
  // 要るため、`renderNote` 呼び出しより前に取得する(CodeRabbit issue plan、issue #24
  // コメント Phase 1 Task 2 と同じ結論)。
  const prev = state.getNote(note.uuid) ?? null;

  let article: RenderedArticle;
  try {
    // `exportDir` は note.com 向け(`renderNoteArticle` が `RenderedArticle.assetSourceDir`
    // へそのまま渡す。`src/publishers/render.ts` の `RenderNoteInput.exportDir` 参照)のみが
    // 使う。他の Renderer は無視する。
    article = renderNote({ note, markdown, config, prev, logger, exportDir });
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
  // logger.notePublished は状態の確定が終わった後にのみ発行する(このモジュール冒頭の
  // JSDoc「logger.notePublished は状態の確定後にのみ発行する」参照)。
  if (gitMode) {
    // stageNote はメモリ上の Map への代入のみで、同期的に例外を投げることは無い
    // (state/store.ts 参照)。API/CLI モードの confirmNote と異なり失敗し得ないため、
    // ここで直接 notePublished を発行してよい。
    state.stageNote(note.uuid, entry);
    logger.notePublished({
      service,
      noteUuid: note.uuid,
      title: note.title,
      result: publishResult.result,
      url: publishResult.url,
    });
    return 'published';
  }

  try {
    await state.confirmNote(note.uuid, entry);
  } catch (error) {
    // 配信自体は成功しているが状態の確定保存に失敗した。NFR-06 の趣旨(状態未更新なら
    // 次回再試行される)に沿い、このノートは failed として扱う——notePublished は
    // 一切発行しない(このモジュール冒頭の JSDoc「既知のリスク(重複作成)」参照)。
    logger.noteFailed({
      service,
      noteUuid: note.uuid,
      title: note.title,
      error: `publish succeeded but failed to persist state: ${errorMessage(error)}`,
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

  // design.md §6 手順5: Git モードなら作業ブランチ作成。`runSync` 冒頭の
  // `validateGitModePublisherContract` が gitMode時の prepare 実在を既に検証済みだが、
  // `requireDefined` はその検証をすり抜けた場合の防御(バグ検出用)として残す。
  if (gitMode) {
    const prepare = requireDefined(
      publisher.prepare,
      'git-mode Publisher.prepare is missing despite validateGitModePublisherContract',
    );
    try {
      await prepare();
    } catch (error) {
      // prepare() 失敗(ブランチ作成不可等)は、以降の手順が前提とするブランチが
      // 存在しないことを意味する。エクスポート・ノート処理を一切行わず実行全体を
      // 失敗として中断する(CodeRabbit review, PR #47)。
      logger.warn({ message: `prepare failed, aborting before export: ${errorMessage(error)}` });
      return runAborted(`Publisher.prepare() failed: ${errorMessage(error)}`);
    }
  }

  // design.md §6 手順3・4: Exporter 実行(フォルダフィルタは Exporter 内部で適用済み)。
  let exportResult: ExportResult;
  try {
    exportResult = await exportAppleNotes({ config, logger, runner, tmpDirFactory });
  } catch (error) {
    if (error instanceof ExportError) {
      // design.md §10「parser の実行失敗 → 実行全体を中断、exit 1」。
      return runAborted(error.message);
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

    // design.md §6 手順7: Git モードの finalize()。gitMode時の実在は `runSync` 冒頭の
    // `validateGitModePublisherContract` で検証済み(`requireDefined` は防御的な保険)。
    //
    // T-16(issue #21)で `FinalizeOutcome`(`src/publishers/types.ts`)を導入し、
    // 「確定するか」「実行を失敗として報告するか」の独立した2軸を扱えるようにした
    // (同ファイル冒頭の JSDoc 参照)。`finalize()` が例外を投げた場合(push / PR 作成失敗)は
    // 従来どおり確定させず(`flush` を呼ばず)失敗として扱う。
    if (gitMode) {
      const finalize = requireDefined(
        publisher.finalize,
        'git-mode Publisher.finalize is missing despite validateGitModePublisherContract',
      );
      try {
        const finalizeOutcome: FinalizeOutcome = await finalize();
        if (finalizeOutcome.persist) {
          // PR 作成成功後に保留分を一括保存する(design.md §5.6 書き込みポイント2、
          // §5.7 手順4「確定基準は PR 作成成功」)。
          await state.flush();
        }
        if (finalizeOutcome.failed === true) {
          // design.md §10「`gh pr merge` 失敗… PR は残し、実行は失敗として報告」。
          // `persist: true` と同時に成立しうる(状態は保存済みのまま失敗扱い)。
          logger.warn({
            message: `finalize reported failure (state ${finalizeOutcome.persist ? 'was' : 'was not'} persisted): ${finalizeOutcome.reason ?? 'unknown reason'}`,
          });
          finalizeFailed = true;
        }
      } catch (error) {
        // design.md §5.7 手順4 / §10: finalize が例外を投げた場合(push / gh pr create の
        // 失敗)は保留分を確定させない(何も確定しない。全ノートが次回実行で再試行される)。
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
    checkGitAuthFn = defaultCheckGitAuth,
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

  // T-14 で追加した前提条件チェック(`src/publishers/types.ts` の JSDoc 参照):
  // Git モードは Publisher.prepare/finalize の両方を要求する。ロック取得・エクスポート
  // 等、一切の作業を行う前にここで検出する(CodeRabbit review, PR #47)。
  const gitModePublisherProblem = validateGitModePublisherContract(config, publisher);
  if (gitModePublisherProblem !== undefined) {
    return gitModePublisherProblem;
  }

  // T-16(issue #21)で追加した前提条件チェック: Git モードの GH_TOKEN 有効性
  // (`gh auth status`)・対象リポジトリへの push / PR 作成権限(design.md §5.7)。
  // ロック取得・StateStore 読み込み・`prepare()`(ブランチ作成)等、一切の Git / gh
  // 副作用を起こす前にここで検出する(このファイル冒頭 JSDoc 参照)。
  try {
    await checkGitAuthFn(config);
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
