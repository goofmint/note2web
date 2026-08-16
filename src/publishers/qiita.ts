/**
 * QiitaPublisher(design.md §5.7「QiitaPublisher」、FR-25/FR-30、T-21 / issue #26)。
 *
 * design.md §5.7 QiitaPublisher 節、および本タスクの前提となった T-20 スパイク調査
 * (design.md §13-3)に基づく実装。CodeRabbit issue plan は当初「認証情報ファイル
 * (credentials.json)を生成し `--credential` で渡す」想定だったが、design.md §13-3 の
 * 調査(`qiita-cli` の `Credential.load` 実装読解 + ローカル実行での確認)により
 * **その想定は誤りと判明し、design.md 自身が更新されている**。design.md を CodeRabbit
 * plan より優先する(本ファイルは design.md §13-3 更新後の内容に従う):
 *
 *   - `qiita-cli` は認証情報ファイルを読む**前に** `process.env.QIITA_TOKEN` の有無を
 *     確認し、設定されていればファイルを一切読まずにそれをアクセストークンとして使う。
 *   - したがって QiitaPublisher は認証情報ファイルを生成する必要が無い。設定
 *     `qiita.token_env` が指す環境変数からトークン値を読み、子プロセスには**常に
 *     `QIITA_TOKEN` という固定名**で渡すだけでよい(qiita-cli 側が参照する名前は
 *     `QIITA_TOKEN` 固定のため。`token_env` はあくまで note2web 側の「取得元」の指定)。
 *
 * **CLI 呼び出しのセキュリティ制約(design.md §5.7・§6 依存表)**: `@qiita/qiita-cli` は
 * `package.json` の `dependencies` に**固定バージョン**(`^`/`~` 無し)で追加し、
 * `npm install` で lockfile にも固定する。呼び出しは必ず **`npx --no-install qiita`**
 * (`bin.qiita` = `dist/main.js`)に限定し、素の `npx qiita` は使わない —— ローカル未導入時に
 * npm レジストリの **`qiita`という別パッケージ**(公式 CLI ではない)を取得しに行き、その
 * プロセスにトークン入りの環境変数が渡ってしまうため禁止(design.md §5.7)。未導入・Node
 * engine 不足は `src/dependencies.ts` の `checkDependencies`(exit 2)が事前に弾く。
 *
 * **`npx --no-install` の cwd(design.md に明記の無い実装判断)**: `npx --no-install` は
 * ローカルの `node_modules/.bin` をカレントディレクトリから遡って探す。`@qiita/qiita-cli` は
 * note2web 自身の依存であり、設定 `qiita.workspace`(qiita-cli が実際に読み書きする対象
 * ディレクトリ。`--root` で明示的に渡す)とは無関係の場所にインストールされる。`workspace`
 * を cwd にして `npx --no-install` を呼ぶと、`workspace` 側に `node_modules` が無い限り
 * 解決に失敗しうる。そのため cwd は常に note2web パッケージ自身のルート
 * (`NOTE2WEB_PACKAGE_ROOT`。本ファイルの `import.meta.url` から算出)に固定し、
 * `--root <workspace>` フラグだけで対象ディレクトリを qiita-cli へ伝える(`--root` は
 * まさにこの「cwd と操作対象を分離する」ためのフラグ。design.md §5.7)。
 *
 * **frontmatter の `slide: false`(design.md §5.7 の差分注記、§13-3)**: qiita-cli の
 * frontmatter 型チェック(`dist/lib/check-frontmatter-type.js` `checkSlide`)は `slide` が
 * 真偽値であることを要求し、フィールド自体が無い(`undefined`)場合は型エラーとして
 * `publish` が失敗する。そのため `QIITA_FRONTMATTER_KEY_ORDER`
 * (`src/transform/frontmatter.ts`)に `slide` を追加済みで、本 Renderer は常に
 * `slide: false` を書き出す。
 *
 * **タグ制約(design.md §5.7)**: 1〜5個必須・スペース不可。`resolveQiitaTags` が
 * (1) 先頭の `#` を1つ除去(Zenn の `stripLeadingHash` と同じ規約) → (2) 半角スペースを
 * 含むタグを除外して警告 → (3) 除外後 6個以上なら先頭5個へ切り詰めて警告 → (4) 除外後 0個
 * なら `QiitaNoTagsRemainingError` を投げる、の順に処理する。(4) はレンダリング段で投げる
 * ため、`src/sync.ts` の `processNote` が当該ノートのみを `'failed'` として隔離し、他ノートの
 * 処理は継続する(NFR-06。`renderZennArticle` の `InvalidZennTypeError` と同じ扱い)。
 *
 * **`id` の書き戻し(design.md §5.7「応答不明時の重複防止」)**: qiita-cli は `publish`
 * 成功後、ワークスペースのファイル自体の frontmatter に発行された記事 ID を書き戻す。
 * QiitaPublisher は独自の照合ロジックを持たず、この CLI 側の機構をそのまま利用する
 * ——`publish()` は CLI 実行後にファイルを再読込し、`yaml` パッケージで frontmatter を
 * 解析して `id` を取り出す。CLI が成功終了したのに `id` が書き戻されていない(想定外の
 * 状態)場合は、状態 JSON に `remoteId: null` のまま「配信成功」を記録してしまうと次回実行が
 * 重複作成しかねないため、あえて例外を投げてこのノートを failed 扱いにする(状態は確定
 * 保存されず、次回再試行される。design.md §6 手順6f「失敗 → ノート状態は触らず failed」)。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { expandHome } from '../paths.js';
import { DEFAULT_TIMEOUTS, firstNonEmptyLine, runSubprocess } from '../subprocess.js';
import type { RunSubprocessOptions, RunSubprocessResult } from '../subprocess.js';
import type { NoteState } from '../state/store.js';
import type { RenderNoteInput, NoteRenderer } from './render.js';
import type { Publisher, PublishResult, RenderedArticle } from './types.js';
import {
  computeContentHash,
  renderArtifact,
  QIITA_FRONTMATTER_KEY_ORDER,
  type FrontmatterEntry,
} from '../transform/frontmatter.js';

// ---------------------------------------------------------------------------
// Renderer: タグ制約とエラー型。
// ---------------------------------------------------------------------------

/** Qiita が許可するタグの最大数(design.md §5.7「1〜5個必須」)。 */
const QIITA_MAX_TAGS = 5;

/**
 * タグを除外・切り詰めた結果、0個になったことを表す(design.md §5.7「除外後0個ならそのノートは
 * 失敗扱い(エラーログ。タグを付けて再実行してもらう)」)。`src/sync.ts` の `processNote` が
 * `renderNote` 呼び出しを囲む try/catch で捕捉し、当該ノートのみを `'failed'` として隔離する
 * (`InvalidZennTypeError` と同じパターン)。
 */
export class QiitaNoTagsRemainingError extends Error {
  /** 検証に失敗したノートの UUID(ログでどのノートかを特定するため)。 */
  readonly noteUuid: string;

  constructor(noteUuid: string) {
    super(
      'Qiita requires at least 1 tag (1-5, no half-width spaces) after removing tags that ' +
        `contain a half-width space (design.md §5.7 QiitaPublisher); note "${noteUuid}" has ` +
        'none remaining — add at least one space-free tag and re-run',
    );
    this.name = 'QiitaNoTagsRemainingError';
    this.noteUuid = noteUuid;
  }
}

/**
 * タグ先頭の `#` を1つだけ除去する(`src/publishers/zenn.ts` の `stripLeadingHash` と同じ
 * 規約をミラーする。design.md §5.7 はタグの `#` 除去そのものには触れていないが、Qiita の
 * タグはハッシュタグ記法ではなくプレーンな語であるべきという判断は Zenn の `topics` と同じ
 * ——`Note#tags` は先頭 `#` を含めたまま保持される、design.md §5.3「差分」節、FR-07)。
 */
function stripLeadingHash(tag: string): string {
  return tag.startsWith('#') ? tag.slice(1) : tag;
}

interface ResolveQiitaTagsParams {
  noteUuid: string;
  title: string;
  tags: readonly string[];
  logger: Logger | undefined;
}

/**
 * design.md §5.7 のタグ制約を順に適用する:
 * (1) 先頭の `#` を除去(除去後に空になったタグは除外して警告)
 * → (2) 半角スペースを含むタグを除外して警告
 * → (3) 除外後6個以上なら先頭5個に切り詰めて警告 → (4) 除外後0個なら
 * `QiitaNoTagsRemainingError`。警告は `service`/`noteUuid`/`title` を伴う `logger.warn`
 * イベントとして発行する(`src/logger.ts` `WarnPayload`)。
 */
function resolveQiitaTags(params: ResolveQiitaTagsParams): string[] {
  const { noteUuid, title, tags, logger } = params;
  const stripped = tags.map(stripLeadingHash);

  // `#` 除去後に空文字列となるタグ(元が `#` のみ等)は Qiita のタグとして成立しないため、
  // スペース含みタグと同様に除外して警告する。
  const empty = stripped.filter((tag) => tag.length === 0);
  if (empty.length > 0) {
    logger?.warn({
      service: 'qiita',
      noteUuid,
      title,
      message:
        `dropped ${String(empty.length)} tag(s) that became empty after stripping the ` +
        'leading "#" (design.md §5.7)',
    });
  }
  const nonEmpty = stripped.filter((tag) => tag.length > 0);

  const spaced = nonEmpty.filter((tag) => tag.includes(' '));
  let remaining = nonEmpty.filter((tag) => !tag.includes(' '));
  if (spaced.length > 0) {
    logger?.warn({
      service: 'qiita',
      noteUuid,
      title,
      message:
        `dropped ${String(spaced.length)} tag(s) containing a half-width space ` +
        `(Qiita rejects tags with spaces, design.md §5.7): ${spaced.map((tag) => JSON.stringify(tag)).join(', ')}`,
    });
  }

  if (remaining.length > QIITA_MAX_TAGS) {
    const kept = remaining.slice(0, QIITA_MAX_TAGS);
    logger?.warn({
      service: 'qiita',
      noteUuid,
      title,
      message:
        `truncated tags from ${String(remaining.length)} to Qiita's limit of ` +
        `${String(QIITA_MAX_TAGS)} (design.md §5.7): kept ${kept.map((tag) => JSON.stringify(tag)).join(', ')}`,
    });
    remaining = kept;
  }

  if (remaining.length === 0) {
    throw new QiitaNoTagsRemainingError(noteUuid);
  }

  return remaining;
}

// ---------------------------------------------------------------------------
// Renderer 本体。
// ---------------------------------------------------------------------------

/** Qiita のファイルパスは常にこの固定ディレクトリ(design.md §5.7「`<itemsRootDir>/public/<basename>.md`」)。 */
const QIITA_PUBLIC_DIR = 'public';

/**
 * Qiita 向け `NoteRenderer`(design.md §5.7 QiitaPublisher 行、FR-25、T-21)。`config` は
 * 参照しない——Qiita のファイルパスは常に `public/` 固定(qiita-cli 自身の規約、
 * `dist/lib/file-system-repo.js` `getRootPath`/`getFilePath`)で、frontmatter の内容も
 * `Note`/`prev` のみから決まるため(`renderZennArticle`/`renderHugoArticle` と同じ方針)。
 *
 * frontmatter のキー順は `QIITA_FRONTMATTER_KEY_ORDER`(`title`/`tags`/`private`/`slide`/`id`)
 * のとおり組み立てる。`id` は初回配信時(`prev` が `null`、または `prev.remoteId` が
 * `null`)は `null`、既配信なら前回の `remoteId` をそのまま書く——qiita-cli は
 * frontmatter の `id` の有無で新規作成/更新を判断するため、既知の ID を渡さないと
 * 意図せず新規記事が作られてしまう(design.md §5.7「`id` は初回 `null`、qiita-cli が
 * 投稿後に書き戻す ID を読み取って状態 JSON に保存」)。
 */
export const renderQiitaArticle: NoteRenderer = ({
  note,
  markdown,
  prev,
  logger,
}: RenderNoteInput): RenderedArticle => {
  const tags = resolveQiitaTags({
    noteUuid: note.uuid,
    title: note.title,
    tags: note.tags,
    logger,
  });

  // QIITA_FRONTMATTER_KEY_ORDER の並び(title/tags/private/slide/id)どおりに組み立てる。
  const entries: FrontmatterEntry[] = [
    [QIITA_FRONTMATTER_KEY_ORDER[0], note.title],
    [QIITA_FRONTMATTER_KEY_ORDER[1], tags],
    [QIITA_FRONTMATTER_KEY_ORDER[2], false],
    [QIITA_FRONTMATTER_KEY_ORDER[3], false],
    [QIITA_FRONTMATTER_KEY_ORDER[4], prev?.remoteId ?? null],
  ];

  const artifact = renderArtifact(entries, markdown);
  const contentHash = computeContentHash(artifact);
  const artifactPath = `${QIITA_PUBLIC_DIR}/${note.uuid}.md`;

  return { noteUuid: note.uuid, title: note.title, artifact, contentHash, artifactPath };
};

// ---------------------------------------------------------------------------
// Publisher 本体。
// ---------------------------------------------------------------------------

/** qiita-cli コマンド実行の注入点(テスト用)。既定は本物の `runSubprocess`。 */
export type QiitaRunner = (options: RunSubprocessOptions) => Promise<RunSubprocessResult>;

/** `createQiitaPublisher` のオプション。 */
export interface CreateQiitaPublisherOptions {
  /** 検証済み設定。`config.qiita` が必須(`src/config.ts` の `qiitaSchema` 参照)。 */
  config: Config;
  /** qiita-cli コマンド実行の注入点(テスト用)。既定は本物の `runSubprocess`。 */
  runner?: QiitaRunner;
  /** ログ出力先(任意)。タグ切り詰め等の警告は Renderer 側(`renderQiitaArticle`)が使う。 */
  logger?: Logger;
  /** 環境変数の参照元(`qiita.token_env` の解決元、テスト用)。既定は `process.env`。 */
  env?: NodeJS.ProcessEnv;
}

/** design.md §7 の `qiita` ブロック(`workspace`/`token_env`)。 */
type QiitaConfig = NonNullable<Config['qiita']>;

/**
 * `config.qiita` の存在を検証して返す(`src/publishers/git-repo.ts` の `requireGitConfig` と
 * 同じ防御パターン。`src/publishers/factory.ts` が `config.service === 'qiita'` かつ
 * `config.qiita !== undefined` を確認してから呼ぶ想定だが、念のため検証する)。
 */
function requireQiitaConfig(config: Config): QiitaConfig {
  if (config.qiita === undefined) {
    throw new Error(
      `internal error: createQiitaPublisher requires config.qiita (service "${config.service}" has none)`,
    );
  }
  return config.qiita;
}

/**
 * `absolutePath` が `root` の配下(`root` 自身を含む)かどうかを判定する
 * (`src/publishers/git-repo.ts`・`src/assets/uploader.ts` と同じ防御パターンをミラーする)。
 * `article.artifactPath` は本モジュールの `renderQiitaArticle` が組み立てる内部値だが、
 * `mkdir`/`writeFile` の前にワークスペース外への書き込みを防ぐ多重防御として検証する。
 */
function isPathWithinRoot(root: string, absolutePath: string): boolean {
  const rel = relative(root, absolutePath);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * note2web パッケージ自身のルートディレクトリ(このファイルの `import.meta.url` から算出)。
 * `npx --no-install qiita` の cwd に使う(本ファイル冒頭 JSDoc「`npx --no-install` の cwd」
 * 参照)。`src/publishers/qiita.ts`(開発時)・`dist/publishers/qiita.js`(ビルド後)の
 * いずれからも2階層上がパッケージルートになる(`tsconfig.json` の `rootDir: "src"` /
 * `outDir: "dist"` によりディレクトリ構造が一致するため)。
 */
const NOTE2WEB_PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * qiita-cli が書き戻した公開後のファイルから frontmatter の `id` を取り出す
 * (design.md §5.7「応答不明時の重複防止」、`Qiita: qiita-cli が投稿後に frontmatter へ
 * 書き戻す id をワークスペースのファイルから読む`)。`---` で区切られた frontmatter
 * ブロックを `yaml` パッケージで解析する(自前の決定的 serializer は書き込み専用であり、
 * 読み取りには汎用 YAML パーサを使う——qiita-cli 自身がどう直列化するかは note2web の
 * 関知するところではないため)。`id` が無い/`null` なら `null` を返す(未書き戻し)。
 */
function extractQiitaId(fileContent: string, noteUuid: string): string | null {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(fileContent);
  if (match === null) {
    throw new Error(
      `QiitaPublisher.publish: could not find a "---"-delimited frontmatter block in the ` +
        `published file for note "${noteUuid}" (qiita-cli may have rewritten the file unexpectedly)`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? '');
  } catch (error) {
    throw new Error(
      `QiitaPublisher.publish: failed to parse the published frontmatter for note "${noteUuid}": ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const id = (parsed as Record<string, unknown>).id;
  if (id === undefined || id === null) {
    return null;
  }
  if (typeof id !== 'string') {
    throw new Error(
      `QiitaPublisher.publish: unexpected non-string "id" (${JSON.stringify(id)}) in the ` +
        `published frontmatter for note "${noteUuid}"`,
    );
  }
  return id;
}

/**
 * design.md §5.7 QiitaPublisher を実装する `Publisher` を作る(T-21 / issue #26)。
 * API/CLI モードのため `prepare`/`finalize` は実装しない(`src/publishers/types.ts` 冒頭
 * JSDoc「API/CLI 系 Publisher はこの2メソッドを実装しなくてよい」)。
 *
 * `config.qiita` が未定義の場合は即座に例外を投げる(呼び出し側 = `src/publishers/factory.ts`
 * が事前に確認してから呼ぶ想定だが、防御的に検証する。`createGitRepoPublisher` と同じ方針)。
 */
export function createQiitaPublisher(options: CreateQiitaPublisherOptions): Publisher {
  // `options.logger` は本 Publisher 自体では使わない(`publish()` は診断的な `warn` を
  // 発行しない——`src/publishers/git-repo.ts` の差分ゼロ警告のような相当物が無い)。
  // タグ切り詰め等の警告は Renderer 側(`renderQiitaArticle`)が `RenderNoteInput.logger`
  // 経由で発行する(モジュール冒頭 JSDoc 参照)。`CreatePublisherOptions`
  // (`src/publishers/factory.ts`)と同じ形で受け取れるようにするためオプションとしては
  // 残すが、ここでは束縛しない。
  const { config, runner = runSubprocess, env = process.env } = options;
  const qiitaConfig = requireQiitaConfig(config);
  const workspaceRoot = expandHome(qiitaConfig.workspace);

  async function publish(article: RenderedArticle, prev: NoteState | null): Promise<PublishResult> {
    if (article.artifactPath === undefined) {
      throw new Error(
        `QiitaPublisher.publish: note "${article.noteUuid}" has no artifactPath ` +
          '(renderQiitaArticle must set one; design.md §5.7)',
      );
    }

    // `resolve`(`join` ではなく)を使う理由は `src/publishers/git-repo.ts` の `publish()` と
    // 同じ(絶対パスの引数をそのまま採用させ、直後の `isPathWithinRoot` 検査で確実に検出する)。
    const absolutePath = resolve(workspaceRoot, article.artifactPath);
    if (!isPathWithinRoot(workspaceRoot, absolutePath)) {
      throw new Error(
        `QiitaPublisher.publish: note "${article.noteUuid}" has an artifactPath that escapes the ` +
          `qiita-cli workspace (traversal or absolute path rejected): "${article.artifactPath}"`,
      );
    }

    // design.md §5.7「設定 qiita.token_env が指す環境変数からトークンを読む」。値そのものは
    // ログに出さない(FR-30)。`src/config.ts` の `loadConfig` が既に(実 `process.env` に
    // 対して)存在確認済みのはずだが、`env` は注入可能なためここでも防御的に確認する。
    const tokenValue = env[qiitaConfig.token_env];
    if (tokenValue === undefined || tokenValue === '') {
      throw new Error(
        `QiitaPublisher.publish: environment variable "${qiitaConfig.token_env}" ` +
          '(qiita.token_env) is not set; cannot authenticate with qiita-cli (design.md §5.7, FR-30)',
      );
    }

    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, article.artifact, 'utf8');

    // design.md §5.7 セキュリティ制約: `npx --no-install qiita`(bin.qiita = dist/main.js)
    // に限定する。素の `npx qiita` は禁止(冒頭 JSDoc 参照)。コマンドライン引数にトークンは
    // 一切含めない——認証は子プロセス環境変数 `QIITA_TOKEN`(qiita-cli 側の固定参照名)
    // 経由のみで渡す。cwd は note2web パッケージ自身のルート(冒頭 JSDoc「npx --no-install
    // の cwd」参照)。
    const result = await runner({
      command: 'npx',
      args: ['--no-install', 'qiita', 'publish', article.noteUuid, '--root', workspaceRoot],
      cwd: NOTE2WEB_PACKAGE_ROOT,
      env: { QIITA_TOKEN: tokenValue },
      timeoutMs: DEFAULT_TIMEOUTS.default,
    });

    if (result.status !== 'success') {
      // コマンドライン(トークンを含みうる env は元々渡していないが、念のため args/command の
      // 生の並びは出さない)は出さず分類のみを含めて例外を投げる(`assertSuccess` パターン、
      // `src/publishers/git-repo.ts` と同じ方針)。
      const detail =
        firstNonEmptyLine(result.stderr) ?? firstNonEmptyLine(result.stdout) ?? 'unknown error';
      throw new Error(
        `"npx --no-install qiita publish" failed for note "${article.noteUuid}" ` +
          `(exitCode=${String(result.exitCode)}, signal=${String(result.signal)}): ${detail}`,
      );
    }

    const written = await readFile(absolutePath, 'utf8');
    const remoteId = extractQiitaId(written, article.noteUuid);
    if (remoteId === null) {
      // 冒頭 JSDoc「id の書き戻し」参照:CLI は成功したが id が書き戻されていない想定外の
      // 状態。ここを成功扱いにすると次回実行時に `remoteId: null` のまま再配信され、Qiita
      // 側で重複記事が作られかねないため、あえて failed 扱いにする(状態は確定保存しない)。
      throw new Error(
        'QiitaPublisher.publish: qiita-cli exited successfully but did not write back an "id" ' +
          `for note "${article.noteUuid}" (design.md §5.7 "応答不明時の重複防止"; treating as ` +
          'a failure so the note is retried next run instead of being recorded as confirmed)',
      );
    }

    return {
      result: prev === null || prev.remoteId === null ? 'created' : 'updated',
      remoteId,
      // design.md §5.7 に明記は無いが、`PublishResult.url`/`NoteState.url` は「取得できる
      // 場合のみ」の任意フィールドとして型が既に許容している(`src/publishers/types.ts`)。
      // Qiita の記事 URL は `id` から機械的に導出できるため設定する。
      url: `https://qiita.com/items/${remoteId}`,
    };
  }

  return { publish };
}
