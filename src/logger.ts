/**
 * JSON Lines ロガー(design.md §9)。
 * 1行1イベントの JSON を常に標準出力へ書き、`file` オプション指定時のみ同じ行を
 * ファイルへ追記する。イベント別メソッド経由でのみ発行させることで、
 * 「何を(noteUuid/title)・いつ(ts)・どこへ(service)・成否(event/result/error)」が
 * 型で揃った状態を保証する。
 */

import { appendFileSync, closeSync, openSync, readSync, statSync } from 'node:fs';

/** ログレベル。`warn` イベント以外は常に `info`。 */
export type LogLevel = 'info' | 'warn';

/** 全イベント共通フィールド。 */
interface BaseLogEvent {
  /** `formatTimestamp` で整形した秒精度 ISO-8601(固定オフセット)。 */
  ts: string;
  level: LogLevel;
}

/** 実行開始。 */
export interface RunStartEvent extends BaseLogEvent {
  event: 'run_start';
}

/** 実行終了。成功・スキップ・失敗の件数サマリを伴う。 */
export interface RunEndEvent extends BaseLogEvent {
  event: 'run_end';
  published: number;
  skipped: number;
  failed: number;
}

/** エクスポート完了。 */
export interface ExportDoneEvent extends BaseLogEvent {
  event: 'export_done';
  noteCount: number;
}

/** ノート配信成功。 */
export interface NotePublishedEvent extends BaseLogEvent {
  event: 'note_published';
  service: string;
  noteUuid: string;
  title: string;
  result: 'created' | 'updated';
  url?: string;
}

/** ハッシュ一致により配信をスキップ。 */
export interface NoteSkippedEvent extends BaseLogEvent {
  event: 'note_skipped';
  service: string;
  noteUuid: string;
  title: string;
}

/** ノート配信失敗。 */
export interface NoteFailedEvent extends BaseLogEvent {
  event: 'note_failed';
  service: string;
  noteUuid: string;
  title: string;
  error: string;
}

/** アセットアップロード成功。 */
export interface AssetUploadedEvent extends BaseLogEvent {
  event: 'asset_uploaded';
  service: string;
  assetHash: string;
  key: string;
  url?: string;
}

/** タグ切り詰め・未対応要素のテキスト化等の警告。 */
export interface WarnEvent extends BaseLogEvent {
  event: 'warn';
  message: string;
  service?: string;
  noteUuid?: string;
  title?: string;
}

/** ロガーが発行しうる全イベントの判別可能ユニオン。 */
export type LogEvent =
  | RunStartEvent
  | RunEndEvent
  | ExportDoneEvent
  | NotePublishedEvent
  | NoteSkippedEvent
  | NoteFailedEvent
  | AssetUploadedEvent
  | WarnEvent;

const DEFAULT_TIMEZONE = 'Asia/Tokyo';

/**
 * `date` を指定 IANA タイムゾーン(既定 `Asia/Tokyo`)における秒精度 ISO-8601、
 * 固定オフセット付きの文字列に整形する(design.md §9 / §5.6)。
 * 実行マシンの TZ・ロケールに依存しない純粋関数。DST を持つタイムゾーンでも
 * 与えられた日時時点の正しいオフセットを返す。
 */
export function formatTimestamp(date: Date, timezone: string = DEFAULT_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'longOffset',
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) {
      throw new Error(`formatTimestamp: missing "${type}" part for timezone "${timezone}"`);
    }
    return part.value;
  };

  // Node の `longOffset` は "GMT+09:00" / "GMT-04:00" / "GMT" (UTC 相当時のみ) の形で返る。
  const rawOffset = get('timeZoneName').replace(/^GMT/, '');
  const offset = rawOffset === '' ? '+00:00' : rawOffset;

  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
}

/** イベント別メソッドに渡すペイロード(`ts` / `level` / `event` はロガー側が付与)。 */
export interface NotePublishedPayload {
  service: string;
  noteUuid: string;
  title: string;
  result: 'created' | 'updated';
  url?: string;
}

export interface NoteSkippedPayload {
  service: string;
  noteUuid: string;
  title: string;
}

export interface NoteFailedPayload {
  service: string;
  noteUuid: string;
  title: string;
  error: string;
}

export interface AssetUploadedPayload {
  service: string;
  assetHash: string;
  key: string;
  url?: string;
}

export interface WarnPayload {
  message: string;
  service?: string;
  noteUuid?: string;
  title?: string;
}

export interface RunEndPayload {
  published: number;
  skipped: number;
  failed: number;
}

export interface ExportDonePayload {
  noteCount: number;
}

/** `createLogger` のオプション。 */
export interface CreateLoggerOptions {
  /** 指定時のみ同じ JSON Lines をこのパスへ追記する(追記モード、既存内容保持)。未指定ならファイルを開かない・作らない。 */
  file?: string;
  /** `formatTimestamp` に渡す IANA タイムゾーン名。既定 `Asia/Tokyo`。 */
  timezone?: string;
  /** テスト用の時刻注入点。既定は `() => new Date()`。 */
  now?: () => Date;
}

/** イベント別メソッドを備えたロガー。 */
export interface Logger {
  runStart(): void;
  runEnd(payload: RunEndPayload): void;
  exportDone(payload: ExportDonePayload): void;
  notePublished(payload: NotePublishedPayload): void;
  noteSkipped(payload: NoteSkippedPayload): void;
  noteFailed(payload: NoteFailedPayload): void;
  assetUploaded(payload: AssetUploadedPayload): void;
  warn(payload: WarnPayload): void;
}

/**
 * JSON Lines ロガーを生成する(design.md §9)。
 * 全イベントは常に `process.stdout.write` へ、`file` 指定時のみ同じ行を
 * 追記モードでファイルへも書き込む。
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const { file, timezone, now = () => new Date() } = options;

  function emit(event: LogEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    process.stdout.write(line);
    if (file !== undefined) {
      // 既存ファイルが末尾改行なしで終わっている場合でも
      // 1行1JSON(JSON Lines)を維持するため、改行を1つ補ってから追記する。
      let needsLeadingNewline = false;
      try {
        const stat = statSync(file);
        if (stat.size > 0) {
          const fd = openSync(file, 'r');
          try {
            const lastByte = Buffer.alloc(1);
            readSync(fd, lastByte, 0, 1, stat.size - 1);
            needsLeadingNewline = lastByte[0] !== 0x0a;
          } finally {
            closeSync(fd);
          }
        }
      } catch {
        needsLeadingNewline = false;
      }
      appendFileSync(file, needsLeadingNewline ? `\n${line}` : line);
    }
  }

  function withTs<TLevel extends LogLevel>(level: TLevel): { ts: string; level: TLevel } {
    return { ts: formatTimestamp(now(), timezone), level };
  }

  return {
    runStart() {
      emit({ ...withTs('info'), event: 'run_start' });
    },
    runEnd(payload) {
      emit({ ...payload, ...withTs('info'), event: 'run_end' });
    },
    exportDone(payload) {
      emit({ ...payload, ...withTs('info'), event: 'export_done' });
    },
    notePublished(payload) {
      emit({ ...payload, ...withTs('info'), event: 'note_published' });
    },
    noteSkipped(payload) {
      emit({ ...payload, ...withTs('info'), event: 'note_skipped' });
    },
    noteFailed(payload) {
      emit({ ...payload, ...withTs('info'), event: 'note_failed' });
    },
    assetUploaded(payload) {
      emit({ ...payload, ...withTs('info'), event: 'asset_uploaded' });
    },
    warn(payload) {
      emit({ ...payload, ...withTs('warn'), event: 'warn' });
    },
  };
}
