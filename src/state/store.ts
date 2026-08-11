/**
 * 状態 JSON の読み書き層(design.md §5.6「Renderer と冪等判定」, §8「状態 JSON スキーマ」)。
 *
 * ディスクからの読み取りは `StateStore.load` の1回に限定し、以後の全段は
 * 「その内容 + 自身の書き込みを即時反映したメモリ上のビュー」だけを参照する
 * (read-your-writes)。書き込みポイントは design.md §5.6 が定める次の2つに限定する
 * (途中クラッシュで成功済み分が失われないよう、いずれも都度アトミックに保存する):
 *
 *   1. `saveAsset`: アセットアップロード成功時。`assets` エントリのみ即時保存する
 *      (FR-17。同一実行内で複数ノートが同じアセットを参照しても再アップロードしない)
 *   2. `confirmNote`(API / CLI モード。`publish()` 成功ごと)/ `flush`
 *      (Git モード。`finalize()` の PR 作成成功後に一括)
 *
 * Git モードでは `stageNote` でメモリ上の `notes` のみを更新し(ディスクへは書かない)、
 * `finalize()` の PR 作成成功を確認した呼び出し側が `flush()` を呼んで一括保存する。
 *
 * FR-18 により、ノートの削除・移動時もエントリを消すメソッドは存在しない
 * (単に参照されなくなるだけで、状態 JSON 上は残り続ける)。
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { PRECONDITION_FAILURE } from '../exit-codes.js';

/** design.md §8 が定める状態 JSON の現行バージョン。 */
export const CURRENT_STATE_VERSION = 1;

const noteStateSchema = z
  .object({
    contentHash: z.string().min(1),
    /** qiita の記事ID / dev.to の id / はてなの entry_id。Git モードでは null。 */
    remoteId: z.string().nullable(),
    /** サービス側 URL(取得できる場合のみ)。 */
    url: z.string().min(1).optional(),
    /** `articles/<uuid>.md` 等(Git モード)。Jekyll のファイル名固定にも使用。 */
    artifactPath: z.string().min(1).optional(),
    firstPublishedAt: z.string().min(1),
    lastPublishedAt: z.string().min(1),
  })
  .strict();

/** 状態 JSON の `notes.<uuid>` エントリ(design.md §8)。 */
export type NoteState = z.infer<typeof noteStateSchema>;

const assetStateSchema = z
  .object({
    /** アップロード先のオブジェクトキー(`notes/ab/ab12cd….png` 等)。 */
    key: z.string().min(1),
    url: z.string().min(1),
    uploadedAt: z.string().min(1),
  })
  .strict();

/** 状態 JSON の `assets.<contentHash>` エントリ(design.md §8)。 */
export type AssetState = z.infer<typeof assetStateSchema>;

const stateFileSchema = z
  .object({
    version: z.number().int(),
    service: z.string().min(1),
    /** 配信先の識別子。Git モード: repo_path、qiita/note: workspace、はてな: blog_id、devto: API ホスト。 */
    target: z.string().min(1),
    notes: z.record(z.string(), noteStateSchema),
    assets: z.record(z.string(), assetStateSchema),
  })
  .strict();

/** 状態 JSON ファイルの構造全体(design.md §8)。 */
export type StateFile = z.infer<typeof stateFileSchema>;

/** `StateStore.load` に渡す引数。 */
export interface LoadStateOptions {
  /** 状態 JSON ファイルのパス(設定ファイルごとに独立、FR-16)。 */
  statePath: string;
  /** 現在の設定の `service`。既存ファイルとの不一致検出に使う。 */
  service: string;
  /** 現在の設定から導出した配信先識別子。既存ファイルとの不一致検出に使う。 */
  target: string;
}

/**
 * 状態 JSON の読み込み・検証に失敗したことを表すエラー(design.md §8, §10)。
 * 次のいずれかで送出される。いずれも「実行前提の不成立」として exit 2 として扱う:
 *   - ファイルは存在するが読み取れない(権限不足等)
 *   - JSON パース失敗
 *   - zod スキーマ不一致
 *   - `version` が現行バージョンと不一致(未知バージョン)
 *   - `service` / `target` が呼び出し側(現在の設定)の値と不一致
 *     (状態ファイルの流用によって、別の配信先の `contentHash` で skip したり
 *     別サービスの `remoteId` で更新したりする事故を防ぐ)
 *
 * `process.exit` は呼ばない。終了コードへの反映は呼び出し側(cli.ts)の責務。
 */
export class StateValidationError extends Error {
  readonly exitCode = PRECONDITION_FAILURE;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StateValidationError';
  }
}

/** Node の `NodeJS.ErrnoException`(`code` を持つ)かどうかの型ガード。 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function freshState(service: string, target: string): StateFile {
  return {
    version: CURRENT_STATE_VERSION,
    service,
    target,
    notes: {},
    assets: {},
  };
}

/**
 * 状態 JSON(design.md §8)の読み書き層。
 *
 * `StateStore.load` でディスクから1回だけ読み込み、以後は本クラスの各メソッド経由
 * (readers はメモリのみ参照、writers は design.md §5.6 の2つの書き込みポイントでのみ
 * ディスクへ反映)で状態を扱う。
 */
export class StateStore {
  private readonly statePath: string;
  private readonly state: StateFile;

  private constructor(statePath: string, state: StateFile) {
    this.statePath = statePath;
    this.state = state;
  }

  /**
   * 状態 JSON を読み込む(design.md §5.6「ディスクからの読み取りは実行開始時の1回」)。
   *
   * ファイルが存在しない(`ENOENT`)場合は、現在の設定から `version` / `service` /
   * `target` を記録した新規の状態をメモリ上に作るだけで、ディスクへは書き込まない
   * (FR-16。実際の書き込みは design.md §5.6 の2つの書き込みポイントで行う)。
   *
   * ファイルが存在する場合は、パース・スキーマ検証・`version` / `service` / `target`
   * の一致を確認し、検証済みの内容をメモリに保持する。いずれかに失敗した場合は
   * `StateValidationError` を投げる。
   */
  static async load(options: LoadStateOptions): Promise<StateStore> {
    const { statePath, service, target } = options;

    let raw: string;
    try {
      raw = await readFile(statePath, 'utf8');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return new StateStore(statePath, freshState(service, target));
      }
      throw new StateValidationError(`failed to read state file: ${statePath}`, { cause: error });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new StateValidationError(`failed to parse state file JSON: ${statePath}`, {
        cause: error,
      });
    }

    const result = stateFileSchema.safeParse(parsed);
    if (!result.success) {
      throw new StateValidationError(
        `state file failed schema validation: ${statePath}: ${result.error.message}`,
        { cause: result.error },
      );
    }
    const state = result.data;

    if (state.version !== CURRENT_STATE_VERSION) {
      throw new StateValidationError(
        `state file version ${String(state.version)} does not match the supported version ${String(CURRENT_STATE_VERSION)}: ${statePath}`,
      );
    }
    if (state.service !== service) {
      throw new StateValidationError(
        `state file service "${state.service}" does not match the configured service "${service}": ${statePath}`,
      );
    }
    if (state.target !== target) {
      throw new StateValidationError(
        `state file target "${state.target}" does not match the configured target "${target}": ${statePath}`,
      );
    }

    return new StateStore(statePath, state);
  }

  /** メモリ上の `notes.<uuid>` を返す(ディスクは再読み込みしない)。無ければ `undefined`。 */
  getNote(uuid: string): NoteState | undefined {
    return this.state.notes[uuid];
  }

  /** メモリ上の `assets.<contentHash>` を返す(ディスクは再読み込みしない)。無ければ `undefined`。 */
  getAsset(contentHash: string): AssetState | undefined {
    return this.state.assets[contentHash];
  }

  /** `contentHash` のアセットが既にアップロード済み(状態に記録済み)かどうか(FR-17)。 */
  hasAsset(contentHash: string): boolean {
    return contentHash in this.state.assets;
  }

  /**
   * アセットアップロード成功時の書き込みポイント(design.md §5.6 の1)。
   * メモリの `assets` を更新した上で、直ちにアトミック保存する。後段でそのノートの
   * 配信が失敗しても本エントリは維持され、次回実行で再アップロードしない(FR-17)。
   */
  async saveAsset(contentHash: string, entry: AssetState): Promise<void> {
    this.state.assets[contentHash] = entry;
    await this.persist();
  }

  /**
   * ノート配信の確定時の書き込みポイント(design.md §5.6 の2)。API / CLI モードで
   * `publish()` が成功するたびに呼び、メモリの `notes` を更新した上で直ちにアトミック
   * 保存する。
   */
  async confirmNote(uuid: string, entry: NoteState): Promise<void> {
    this.state.notes[uuid] = entry;
    await this.persist();
  }

  /**
   * Git モードでの保留(ステージング)。メモリの `notes` のみを更新し、ディスクへは
   * 書き込まない。`finalize()` の PR 作成成功を確認した呼び出し側が `flush()` を
   * 呼ぶまで、ディスク上の状態は変化しない。
   */
  stageNote(uuid: string, entry: NoteState): void {
    this.state.notes[uuid] = entry;
  }

  /**
   * `stageNote` で保留した内容を含む状態全体を一括でアトミック保存する
   * (design.md §5.6 の2、Git モード。`finalize()` の PR 作成成功後に呼ぶ)。
   */
  async flush(): Promise<void> {
    await this.persist();
  }

  /**
   * 状態 JSON 全体を一時ファイルへ書いてから `rename` するアトミック更新。
   * 一時ファイルは状態ファイルと同じディレクトリに `<statePath>.tmp-<pid>-<random>`
   * として作成する。`rename` 前にクラッシュ・失敗しても既存の状態ファイルは無傷のまま
   * 残る(rename は単一のファイルシステム操作としてアトミックに行われるため)。
   */
  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });

    const tempPath = `${this.statePath}.tmp-${String(process.pid)}-${randomBytes(6).toString('hex')}`;
    const json = `${JSON.stringify(this.state, null, 2)}\n`;

    await writeFile(tempPath, json, 'utf8');
    try {
      await rename(tempPath, this.statePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {
        // 一時ファイルの後始末に失敗しても、本来投げるべきエラー(rename 失敗)を隠さない。
      });
      throw error;
    }
  }
}
