/**
 * Exporter(design.md §5.2)。`apple_cloud_notes_parser` をサブプロセスとして実行し、
 * 一時ディレクトリに出力させたうえで、JSON / 個別 HTML / files から `Note` モデルの
 * 骨格(skeleton)一覧を組み立てる。`title` / `emoji` の実値抽出は
 * メタデータ抽出層(`src/transform/metadata.ts`、T-10)の担当であり、ここでは
 * 空値で初期化するだけにとどめる(design.md §5.3 冒頭のコンポーネント分割どおり)。
 *
 * `tags` のみ例外で、ここ(Exporter)が JSON ノートオブジェクトの `hashtags`
 * フィールド(parser が抽出済み)をそのまま(順序を保った重複排除のみ行い)詰める
 * (design.md §5.3「差分」節。本文 HTML の正規表現走査ではなく JSON `hashtags` を
 * 唯一の情報源とする、という更新後の設計に合わせたもの)。メタデータ抽出層は
 * この `tags` を再加工せず、正規化(重複排除)のみ行う。
 *
 * 毎回フルエクスポートする(design.md §5.2)。差分判定は変換後のコンテンツハッシュで
 * 行うため、エクスポート自体の増分化は行わない。一時ディレクトリの削除は呼び出し側の
 * 責務(`ExportResult.exportDir` を返すのみ)。
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { expandHome } from '../paths.js';
import {
  DEFAULT_TIMEOUTS,
  firstNonEmptyLine,
  runSubprocess,
  type RunSubprocessOptions,
  type RunSubprocessResult,
  type SubprocessClassification,
} from '../subprocess.js';
import type { Attachment, Note } from '../model/note.js';
import { dedupeTags } from '../transform/metadata.js';

/** design.md §7 のサンプル値をそのまま既定値として用いる(`exporter` ブロック省略時)。 */
export const DEFAULT_PARSER_PATH = '~/tools/apple_cloud_notes_parser';
/** design.md §7 のサンプル値をそのまま既定値として用いる(`exporter` ブロック省略時)。 */
export const DEFAULT_NOTES_CONTAINER = '~/Library/Group Containers/group.com.apple.notes';

/** 一時出力ディレクトリの `mkdtemp` プレフィックス。 */
const TMP_DIR_PREFIX = 'note2web-export-';

/**
 * サブプロセス実行を差し替えるための最小限の関数シグネチャ。T-05 の `runSubprocess`
 * (`RunSubprocessOptions` → `Promise<RunSubprocessResult>`)とちょうど同じ形にすることで、
 * 本番では `runSubprocess` をそのまま既定値として渡せ、テストでは差し替えられるようにする。
 */
export type SubprocessRunner = (options: RunSubprocessOptions) => Promise<RunSubprocessResult>;

/** `exportAppleNotes` のオプション。 */
export interface ExportAppleNotesOptions {
  /** 検証済み設定(`exporter` / `source.folders` / `service` を参照する)。 */
  config: Config;
  /** 指定時、`export_done` / `note_failed` イベントを発行する(design.md §9)。 */
  logger?: Logger;
  /** サブプロセス実行の注入点。既定は本物の `runSubprocess`(T-05)。 */
  runner?: SubprocessRunner;
  /**
   * 一時出力ディレクトリを作成して返す注入点。既定は
   * `mkdtemp(join(tmpdir(), 'note2web-export-'))`。
   */
  tmpDirFactory?: () => Promise<string>;
}

/** UUID → 個別 HTML の解決に失敗した等の理由で処理から外れたノート(design.md §5.2)。 */
export interface FailedNote {
  uuid: string;
  title: string;
  error: string;
}

/** `exportAppleNotes` の戻り値。 */
export interface ExportResult {
  /** `source.folders` 配下(FR-02)で、個別 HTML の解決にも成功したノートの骨格一覧。 */
  notes: Note[];
  /** `source.folders` 配下だが、個別 HTML の解決に失敗し処理から外れたノート。 */
  failed: FailedNote[];
  /** parser が出力した一時ディレクトリの絶対パス。削除は呼び出し側の責務。 */
  exportDir: string;
}

/**
 * サブプロセス実行の失敗(`apple_cloud_notes_parser` が非ゼロ終了・シグナル終了・
 * タイムアウトした)を表す。design.md §10「parser の実行失敗」に対応し、呼び出し側
 * (cli.ts)はこれを実行全体の中断(exit 1)として扱う。
 */
export class ExportError extends Error {
  /** T-05 の失敗分類(`timeout` / `exit_code` / `signal`)。判別できない場合のみ `undefined`。 */
  readonly classification?: SubprocessClassification;

  constructor(
    message: string,
    options?: { cause?: unknown; classification?: SubprocessClassification },
  ) {
    super(message, options !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ExportError';
    this.classification = options?.classification;
  }
}

// ---------------------------------------------------------------------------
// parser JSON のスキーマ(design.md §13-7 で確定したフィールドのうち note2web が使うもの)。
// 外部ツールの出力であり、note2web の設定ファイルとは異なり未知フィールドは許容する
// (`.strict()` にはしない。将来 parser にフィールドが増えても壊れないようにするため)。
// ---------------------------------------------------------------------------

/** JSON `folders` の1エントリ(design.md §13-7・§5.2「フォルダ名を辿ってノートファイルを探す」の入力)。 */
interface FolderJson {
  primary_key: number;
  name: string;
  account: string;
  parent_folder_id: number | null;
  child_folders: Record<string, FolderJson>;
}

const folderJsonSchema: z.ZodType<FolderJson> = z.lazy(() =>
  z
    .object({
      primary_key: z.number(),
      name: z.string(),
      account: z.string(),
      parent_folder_id: z.number().nullable(),
      child_folders: z.record(z.string(), folderJsonSchema),
    })
    .passthrough(),
);

const embeddedObjectJsonSchema = z
  .object({
    uuid: z.string(),
    filepath: z.string().optional(),
    backup_location: z.string().optional(),
  })
  .passthrough();

const noteJsonSchema = z
  .object({
    uuid: z.string(),
    // 数値、または整数として解釈できる文字列のみ受け付ける。"invalid" 等が
    // NaN に化けてフォルダフィルタで黙って除外される事故を防ぎ、スキーマ検証の
    // 段階で ExportError(parser JSON 不正)として顕在化させる。
    folder_key: z.union([z.number().int(), z.string().regex(/^-?\d+$/)]),
    folder: z.string(),
    title: z.string(),
    creation_time: z.string(),
    modify_time: z.string(),
    embedded_objects: z.array(embeddedObjectJsonSchema),
    hashtags: z.array(z.string()),
  })
  .passthrough();

const parserJsonSchema = z
  .object({
    folders: z.record(z.string(), folderJsonSchema),
    notes: z.record(z.string(), noteJsonSchema),
  })
  .passthrough();

type ParserJson = z.infer<typeof parserJsonSchema>;

// ---------------------------------------------------------------------------
// フォルダパス再構築(design.md §5.2 の具体的な対応規則)。
// ---------------------------------------------------------------------------

/** parser の `clean_name`(`lib/AppleNotesAccount.rb` / `lib/AppleNotesFolder.rb`)を再現する。 */
function cleanName(name: string): string {
  return name.replace(/[/:\\]/g, '_');
}

/** フォルダインデックスの1エントリ。`path` は個別 HTML の格納ディレクトリ名を再構築したもの。 */
interface FolderIndexEntry {
  id: number;
  name: string;
  parentId: number | null;
  /** `html/note_store<N>/` からの相対ディレクトリパス(design.md §5.2)。 */
  path: string;
}

/**
 * JSON トップレベルの `folders`(ルートのみを key に持ち、子は `child_folders` に
 * 再帰的に格納される。design.md §13-7)を再帰的に辿り、`primary_key` をキーとした
 * フラットなインデックスへ変換する。ルートフォルダの `path` は
 * `<clean(account)>-<clean(name)>`、子フォルダは `<親の path>/<clean(name)>`
 * (アカウント名を繰り返さない。design.md §5.2)。
 */
function buildFolderIndex(foldersJson: Record<string, FolderJson>): Map<number, FolderIndexEntry> {
  const index = new Map<number, FolderIndexEntry>();

  function walk(folder: FolderJson, parentPath: string | undefined, parentId: number | null): void {
    const path =
      parentPath === undefined
        ? `${cleanName(folder.account)}-${cleanName(folder.name)}`
        : `${parentPath}/${cleanName(folder.name)}`;
    index.set(folder.primary_key, { id: folder.primary_key, name: folder.name, parentId, path });
    for (const child of Object.values(folder.child_folders)) {
      walk(child, path, folder.primary_key);
    }
  }

  for (const root of Object.values(foldersJson)) {
    walk(root, undefined, null);
  }

  return index;
}

/**
 * `folderNames`(設定 `source.folders`、FR-02)のいずれかと名前が一致するフォルダ、
 * および**その配下(サブツリー)全体**の `primary_key` 集合を返す(FR-02「指定した
 * フォルダ配下のノートのみ」)。一致するフォルダはツリー中のどの深さにあってもよい。
 */
function resolveIncludedFolderIds(
  folderIndex: Map<number, FolderIndexEntry>,
  folderNames: readonly string[],
): Set<number> {
  const targetNames = new Set(folderNames);

  const childrenByParent = new Map<number, number[]>();
  for (const entry of folderIndex.values()) {
    if (entry.parentId !== null) {
      const siblings = childrenByParent.get(entry.parentId) ?? [];
      siblings.push(entry.id);
      childrenByParent.set(entry.parentId, siblings);
    }
  }

  const included = new Set<number>();
  const queue: number[] = [];
  for (const entry of folderIndex.values()) {
    if (targetNames.has(entry.name)) {
      queue.push(entry.id);
    }
  }

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || included.has(id)) {
      continue;
    }
    included.add(id);
    for (const childId of childrenByParent.get(id) ?? []) {
      queue.push(childId);
    }
  }

  return included;
}

// ---------------------------------------------------------------------------
// UUID → 個別 HTML の解決(design.md §5.2)。
// ---------------------------------------------------------------------------

/**
 * `folderDir` 直下で `<uuid> - *.html` に前方一致するファイルを探し、生の HTML を
 * 未加工のまま返す(design.md §5.2。JSON の `html` フィールドは使わない)。
 * 一致が0件・複数件のいずれの場合も呼び出し側で failed 扱いにできるよう例外を投げる。
 *
 * 同じフォルダに属するノートごとに `readdir` を繰り返さないよう、ディレクトリ一覧は
 * `dirCache`(フォルダパス → エントリ一覧)で1回だけ読んで使い回す。UUID の重複
 * (複数件一致)検出はキャッシュ後も一覧全体に対して行うため、挙動は変わらない。
 */
async function resolveNoteHtml(
  folderDir: string,
  uuid: string,
  dirCache: Map<string, string[]>,
): Promise<string> {
  let entries = dirCache.get(folderDir);
  if (entries === undefined) {
    try {
      entries = await readdir(folderDir);
    } catch (error) {
      throw new Error(`folder directory not found for HTML resolution: ${folderDir}`, {
        cause: error,
      });
    }
    dirCache.set(folderDir, entries);
  }

  const prefix = `${uuid} - `;
  const matches = entries.filter((name) => name.startsWith(prefix) && name.endsWith('.html'));

  if (matches.length === 0) {
    throw new Error(`no individual HTML file found for uuid "${uuid}" under: ${folderDir}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `multiple individual HTML files matched uuid "${uuid}" under ${folderDir}: ${matches.join(', ')}`,
    );
  }

  const matchedName = matches[0];
  if (matchedName === undefined) {
    // matches.length === 1 を確認済みのため到達しない。noUncheckedIndexedAccess 相当の
    // 保守的なガード。
    throw new Error(`unexpected empty match for uuid "${uuid}" under: ${folderDir}`);
  }
  return readFile(join(folderDir, matchedName), 'utf8');
}

// ---------------------------------------------------------------------------
// 日時解決(design.md §5.3。`"YYYY-MM-DD HH:MM:SS +0000"` の固定書式)。
// ---------------------------------------------------------------------------

const APPLE_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{2})(\d{2})$/;

/**
 * `creation_time` / `modify_time` の固定書式(`"YYYY-MM-DD HH:MM:SS +0000"`)を解析する。
 * 固定書式のため専用パーサ不要(design.md §5.3)というのは「複雑な書式解析が要らない」
 * という意味であり、実装としては ISO 8601 へ機械的に組み替えて `Date` に渡す。
 */
function parseAppleTimestamp(value: string): Date {
  const match = APPLE_TIMESTAMP_PATTERN.exec(value);
  if (match === null) {
    throw new Error(`unrecognized parser timestamp format: "${value}"`);
  }
  const [, year, month, day, hour, minute, second, offsetHours, offsetMinutes] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${offsetHours}:${offsetMinutes}`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid parser timestamp: "${value}"`);
  }
  return date;
}

// ---------------------------------------------------------------------------
// 添付(design.md §5.2「files/: 添付・描画の実体」)。
// ---------------------------------------------------------------------------

/**
 * ノートの `embedded_objects` のうち、`filepath` または `backup_location` を持つもの
 * (添付・描画の実体を指すもの。ハッシュタグ等のインラインオブジェクトは持たない)を
 * `Attachment` へ変換する。
 */
function extractAttachments(
  embeddedObjects: readonly z.infer<typeof embeddedObjectJsonSchema>[],
): Attachment[] {
  const attachments: Attachment[] = [];
  for (const embedded of embeddedObjects) {
    const path = embedded.filepath ?? embedded.backup_location;
    if (path === undefined) {
      continue;
    }
    attachments.push({ identifier: embedded.uuid, path });
  }
  return attachments;
}

// ---------------------------------------------------------------------------
// パス・コマンド組み立て。
// ---------------------------------------------------------------------------
// `expandHome` は汎用ユーティリティとして `src/paths.ts` へ移した(CodeRabbit review,
// PR #48)。Exporter・依存チェック(`src/dependencies.ts`)・doctor(`src/doctor.ts`)が
// 共通で使うため。

async function defaultTmpDirFactory(): Promise<string> {
  return mkdtemp(join(tmpdir(), TMP_DIR_PREFIX));
}

/** `json/all_notes_<N>.json` を探し、パスと `<N>`(`html/note_store<N>/` の解決に使う)を返す。 */
async function locateNotesJsonFile(
  exportDir: string,
): Promise<{ path: string; noteStoreNumber: string }> {
  const jsonDir = join(exportDir, 'json');
  let entries: string[];
  try {
    entries = await readdir(jsonDir);
  } catch (error) {
    throw new ExportError(`parser output is missing the "json" directory: ${jsonDir}`, {
      cause: error,
    });
  }

  const pattern = /^all_notes_(\d+)\.json$/;
  for (const name of entries) {
    const match = pattern.exec(name);
    if (match !== null) {
      const noteStoreNumber = match[1];
      if (noteStoreNumber !== undefined) {
        return { path: join(jsonDir, name), noteStoreNumber };
      }
    }
  }

  throw new ExportError(`no "all_notes_<N>.json" file found under: ${jsonDir}`);
}

// ---------------------------------------------------------------------------
// エントリ関数。
// ---------------------------------------------------------------------------

/**
 * `apple_cloud_notes_parser` をサブプロセスで実行し、`Note` モデルの骨格一覧を
 * 組み立てる(design.md §5.2)。
 *
 * 1. `exporter.parser_path` / `exporter.notes_container`(既定値あり、design.md §7)を
 *    `~` 展開したうえで、`notes_cloud_ripper.rb -m <container> -o <tmpdir>
 *    --individual-files --uuid` を `cwd: parser_path` で実行する(タイムアウトは
 *    `DEFAULT_TIMEOUTS.parser` = 15分、T-05)。起動コマンドは `exporter.launcher`
 *    (既定 `'bundle'`)で選ぶ——既定は `bundle exec ruby notes_cloud_ripper.rb ...`
 *    (Gemfile の `sqlite3`/`nokogiri` 等を Bundler 経由で解決する。launchd の最小限の
 *    環境では素の `ruby` だけでは gem が解決できず `LoadError` になりがちなため。
 *    issue #67)。`'ruby'` を指定すると `ruby notes_cloud_ripper.rb ...`(Bundler を
 *    経由しない旧来の直接起動)にフォールバックできる。
 * 2. 非成功終了は `ExportError`(分類つき)を投げる。実行全体を中断させる想定
 *    (design.md §10「parser の実行失敗」→ 呼び出し側で exit 1)であり、ここでは
 *    `process.exit` は呼ばない。stderr/stdout に `no such table` / `SQLite3::SQLException`
 *    が含まれる場合(issue #69 問題2。フルディスクアクセス未許可・Notes.app 起動中で WAL
 *    未チェックポイント・macOS 間のスキーマ不一致等が典型的な原因)は、考えられる原因を
 *    案内する短い日本語のヒントをメッセージ末尾に追記する(`classification`・exitCode・
 *    signal の各部分は変更しない)。
 * 3. `json/all_notes_<N>.json` を読み、`source.folders`(FR-02、配下=サブツリー
 *    マッチ)でノートを絞り込む。
 * 4. 各ノートについて、JSON の `folders` 階層からフォルダディレクトリパスを再構築し、
 *    `html/note_store<N>/<パス>/` 配下で `<uuid> - *.html` を前方一致で探して本文を
 *    読み込む。解決できなかったノートのみ `failed` へ回し、`logger.noteFailed` を
 *    発行して処理を続行する(design.md §5.2)。
 *
 * 成功時、一時出力ディレクトリは削除しない(`ExportResult.exportDir` として返すのみ。
 * 削除は呼び出し側=sync フロー(T-14)の責務)。一方、失敗して例外を投げる場合は
 * 呼び出し側がパスを知り得ないため、ベストエフォートで削除してから元のエラーを再送出する。
 */
export async function exportAppleNotes(options: ExportAppleNotesOptions): Promise<ExportResult> {
  const { config, logger, runner = runSubprocess, tmpDirFactory = defaultTmpDirFactory } = options;

  const parserPath = expandHome(config.exporter?.parser_path ?? DEFAULT_PARSER_PATH);
  const notesContainer = expandHome(config.exporter?.notes_container ?? DEFAULT_NOTES_CONTAINER);

  const exportDir = await tmpDirFactory();
  try {
    return await runExport({ config, logger, runner, parserPath, notesContainer, exportDir });
  } catch (error) {
    // 失敗時は exportDir が呼び出し側に渡らないため、ここで後始末する。
    // 後始末自体の失敗で元のエラーを隠さない。
    await rm(exportDir, { recursive: true, force: true }).catch(() => {
      // 意図的に無視。
    });
    throw error;
  }
}

/** `exportAppleNotes` の本体(一時ディレクトリ確保後の処理)。 */
async function runExport(params: {
  config: Config;
  logger: Logger | undefined;
  runner: SubprocessRunner;
  parserPath: string;
  notesContainer: string;
  exportDir: string;
}): Promise<ExportResult> {
  const { config, logger, runner, parserPath, notesContainer, exportDir } = params;

  // 起動コマンドの組み立て(design.md §5.2、issue #67)。既定 'bundle' は Gemfile の
  // gem(sqlite3/nokogiri 等)を Bundler 経由で解決する — launchd の最小限の PATH/GEM_HOME
  // では素の ruby だけでは解決できず LoadError になりがちなため、こちらを既定にする。
  const rubyScriptArgs = [
    'notes_cloud_ripper.rb',
    '-m',
    notesContainer,
    '-o',
    exportDir,
    '--individual-files',
    '--uuid',
  ];
  const launcher = config.exporter?.launcher ?? 'bundle';
  const { command, args } =
    launcher === 'ruby'
      ? { command: 'ruby', args: rubyScriptArgs }
      : { command: 'bundle', args: ['exec', 'ruby', ...rubyScriptArgs] };

  const subprocessResult = await runner({
    command,
    args,
    cwd: parserPath,
    timeoutMs: DEFAULT_TIMEOUTS.parser,
    logger,
  });

  if (subprocessResult.status !== 'success') {
    // stderr/stdout の先頭1行を含める(issue #67: launchd 環境では標準エラーが
    // 単純な exitCode/signal のみに丸められ、原因(gem 未解決の LoadError 等)が
    // 分からなかったため)。parser の argv(コマンドライン)には秘匿情報を一切含まない
    // ため、出力内容を含めても FR-30 には抵触しない。
    const detail =
      firstNonEmptyLine(subprocessResult.stderr) ??
      firstNonEmptyLine(subprocessResult.stdout) ??
      'unknown error';
    // issue #69 問題2: `no such table: ZACCOUNT: (SQLite3::SQLException)` のような
    // NoteStore.sqlite のスキーマ関連エラーは、原因の当たりが付けにくい(単なる
    // exitCode/signal からは分からない)。stderr/stdout 全体(先頭1行だけでなく)を
    // 走査し、その種のエラーだと判別できた場合のみ、考えられる原因を案内する短い
    // ヒントをメッセージ末尾に追記する。`classification` / exitCode / signal 部分は
    // 変更しない(呼び出し側の判定ロジックに影響を与えないため)。
    const combinedOutput = `${subprocessResult.stderr}\n${subprocessResult.stdout}`;
    const looksLikeSqliteSchemaFailure =
      /no such table/i.test(combinedOutput) || combinedOutput.includes('SQLite3::SQLException');
    const hint = looksLikeSqliteSchemaFailure
      ? ' ヒント(issue #69): NoteStore.sqlite のスキーマに関するエラーです。考えられる原因: ' +
        '(1) フルディスクアクセス(macOS の「システム設定」→「プライバシーとセキュリティ」→' +
        '「フルディスクアクセス」)が実行コンテキストに付与されていない(launchd/cron 実行時は' +
        'ターミナルアプリではなく、その実行コンテキスト自体への付与が必要)、' +
        '(2) Notes.app が起動したままで WAL チェックポイントが発生していない' +
        '(Notes.app を一度終了してから再実行してください)、' +
        '(3) macOS バージョン間での NoteStore.sqlite スキーマの不一致。' +
        '詳細は README のトラブルシューティングを参照してください。'
      : '';
    throw new ExportError(
      `apple_cloud_notes_parser (notes_cloud_ripper.rb) failed ` +
        `(${subprocessResult.classification ?? 'unknown'}): ` +
        `exitCode=${String(subprocessResult.exitCode)}, signal=${String(subprocessResult.signal)}: ${detail}${hint}`,
      { classification: subprocessResult.classification },
    );
  }

  const { path: jsonPath, noteStoreNumber } = await locateNotesJsonFile(exportDir);

  let rawJson: string;
  try {
    rawJson = await readFile(jsonPath, 'utf8');
  } catch (error) {
    throw new ExportError(`failed to read parser JSON output: ${jsonPath}`, { cause: error });
  }

  let parsed: ParserJson;
  try {
    parsed = parserJsonSchema.parse(JSON.parse(rawJson));
  } catch (error) {
    throw new ExportError(`failed to parse parser JSON output: ${jsonPath}`, { cause: error });
  }

  const folderIndex = buildFolderIndex(parsed.folders);
  const includedFolderIds = resolveIncludedFolderIds(folderIndex, config.source.folders);
  const htmlRoot = join(exportDir, 'html', `note_store${noteStoreNumber}`);

  const notes: Note[] = [];
  const failed: FailedNote[] = [];
  // フォルダごとの readdir 結果のキャッシュ(同一フォルダの全ノートで使い回す)。
  const dirCache = new Map<string, string[]>();

  for (const noteJson of Object.values(parsed.notes)) {
    const folderId =
      typeof noteJson.folder_key === 'number' ? noteJson.folder_key : Number(noteJson.folder_key);

    if (!includedFolderIds.has(folderId)) {
      // source.folders(FR-02)の配下ではない。HTML 解決も添付収集も行わず、
      // notes / failed のいずれにも含めない(設計「対象外フォルダは一切処理しない」)。
      continue;
    }

    const folderEntry = folderIndex.get(folderId);
    if (folderEntry === undefined) {
      const error = `note references unknown folder_key ${String(noteJson.folder_key)}`;
      failed.push({ uuid: noteJson.uuid, title: noteJson.title, error });
      logger?.noteFailed({
        service: config.service,
        noteUuid: noteJson.uuid,
        title: noteJson.title,
        error,
      });
      continue;
    }

    let bodyHtml: string;
    try {
      bodyHtml = await resolveNoteHtml(join(htmlRoot, folderEntry.path), noteJson.uuid, dirCache);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ uuid: noteJson.uuid, title: noteJson.title, error: message });
      logger?.noteFailed({
        service: config.service,
        noteUuid: noteJson.uuid,
        title: noteJson.title,
        error: message,
      });
      continue;
    }

    notes.push({
      uuid: noteJson.uuid,
      folder: noteJson.folder,
      // title / emoji はメタデータ抽出層(T-10)の担当(design.md §5.3)。
      title: '',
      emoji: null,
      // tags は JSON hashtags をそのまま情報源とする(design.md §5.3「差分」節)。
      tags: dedupeTags(noteJson.hashtags),
      createdAt: parseAppleTimestamp(noteJson.creation_time),
      updatedAt: parseAppleTimestamp(noteJson.modify_time),
      bodyHtml,
      attachments: extractAttachments(noteJson.embedded_objects),
    });
  }

  logger?.exportDone({ noteCount: notes.length });

  return { notes, failed, exportDir };
}
