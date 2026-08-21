/**
 * NotePublisher(design.md §5.7「NotePublisher」、§13-4/§13-6、FR-30、T-25 / issue #30)。
 *
 * design.md §5.7 の NotePublisher 節は T-24 のスパイク調査(§13-4/§13-6)の結論として、
 * note.com が他の Publisher(Git 系・Qiita・dev.to・はてな)と**構造的に異なる**ことを述べ、
 * 「推奨対応」として2つの選択肢を挙げていた。本タスク(T-25)はそのうち次の選択を確定し、
 * design.md §5.7 自身をこの内容へ更新した(本ファイルはその更新後の契約に従う):
 *
 * **1. 実行モード: 自動実行(issue #30 の受け入れ条件どおり、`noet create`/`update` を実際に
 * 呼び出す)**。design.md §13-4 が明らかにした前提——`noet` は note.com への認証を一切
 * 自分で管理せず、「同一マシン上でログイン済みの実 Chrome ブラウザ + noet 拡張機能が
 * 稼働している」ことそのものが認証状態である——は変えられない(サーバー上で完結する
 * 認証手段が存在しない)。したがって **無人(unattended / cron)実行環境ではこの前提が
 * 満たせず、`noet create`/`update` の呼び出し自体が(拡張機能への WebSocket 接続待ちの
 * 末に)失敗する**。これは NotePublisher 自身のバグではなく、design.md §1「失敗の局所化」
 * (NFR-06)により当該ノートのみが `'failed'` として隔離され、次回実行で再試行される
 * ——という「文書化された仕様」として扱う(design.md §6 依存表の note 行、および
 * `src/dependencies.ts` の `case 'note'` コメント参照)。note.com 向けに `sync` を
 * 完全無人(cron/launchd)で回すこと自体が構造的に不可能である点は README 相当の
 * ドキュメント(design.md §4・§6)に明記済み。
 *
 * **2. 画像: (a) noet 自身の画像アップロード機能を、ローカルファイル参照で使う**(利用者
 * 決定 2026-08-21。旧 §13-6 の2択のうち、当初採用していた (b)(画像を含むノートを
 * note.com 向けでは明示的に failed とする)から方針転換した)。noet(kako-jun/noet, commit
 * `e3a8562`)は `noet create`/`update` の実行時、本文 Markdown 中の画像参照
 * (`extract_image_references`、正規表現 `!\[([^\]]*)\]\(([^)]+)\)`)を自動検出し、参照が
 * `http://`/`https://` で始まらない場合(= ローカルファイルパス)は Markdown ファイルの
 * 親ディレクトリ基準で実ファイルを解決し、note.com へ自前でアップロードしたうえで本文中の
 * 参照を `st-note.com` の URL に置換してくれる(`apps/cli/src/commands/extension.rs` →
 * `image_handler.rs::process_images`。alt テキストがそのまま note.com 側のキャプションに
 * なる)。逆に `http(s)://` で始まる参照(R2/S3 の公開 URL 等)は**スキップ**され
 * アップロードされない——note.com の ProseMirror エディタはそもそも `![]()` を画像として
 * 解釈せずリテラルテキスト表示するため(§13-6 の調査結果は変わらず有効)、R2/S3 の URL を
 * そのまま送る経路には意味が無い。したがって note.com 向けの画像添付は
 * `assets/uploader.ts` の `processNoteBody` が(`service === 'note'` かつ画像の場合)R2/S3
 * ではなく `<config.note.workspace>/images/<identifier><ext>` へのローカルコピーへ差し替え、
 * `renderNoteArticle` に渡る本文には最初から `![alt](./images/<identifier><ext>)` という
 * 相対パス参照だけが現れる(`renderNoteArticle` 自身は画像を検出・拒否しない——検証は
 * アセット解決段階(`assets/uploader.ts`)で完結している)。**サポートされる画像形式は
 * jpg/jpeg/png/gif/webp のみ**(noet の `read_image_as_base64`)で、それ以外の拡張子は
 * アセット解決段階で `AssetUploadError` として弾かれ、当該ノートのみ `'failed'` になる。
 * この noet の画像アップロード経路自体は upstream で「実装完了(コンパイル済み)、
 * 統合テスト未実施」(`docs/IMAGE_FEATURE_STATUS.md`)のままであり、note2web 側でも
 * 実機検証はできていない(§12 参照)——失敗した場合は他の失敗と同様にそのノートのみが
 * `'failed'` として隔離され、次回実行で再試行される。また画像を多数含む記事では、
 * 拡張機能側の1コマンドあたり60秒タイムアウト(`extension_client.rs` `COMMAND_TIMEOUT`)に
 * 接近しうる点も変わらない(§5.7 レート制御の記述参照)。
 *
 * **3. 記事一覧の完全性(design.md §5.7・§13-4「照合の安全条件」)**: `noet list` は
 * `/notes` ページの DOM スクレイプであり、ページング処理を持たず初期表示分のみを対象と
 * する(§13-4)。そのため一般に「一覧が完全である」ことを実行時に確認する手段が無い。
 * 本実装は次の**唯一、構造的に正当化できる**特殊ケースのみを「完全性が確認できた」と
 * みなす: **`noet list` の出力がまったくの空(記事が1件も無い)場合**。0件の一覧には
 * ページングで隠れうる後続ページがそもそも存在しない(0件を分割する2ページ目は無い)ため、
 * これは DOM スクレイプの限界とは無関係に論理的に真である。それ以外(1件以上を含む出力)
 * は、対象タイトルの一致がまさにその表示範囲内で見つかった場合(ちょうど1件・複数件)を
 * 除き、「0件 = 未作成」と断定できない——design.md §5.7「取得範囲が不明・不完全な場合は
 * 当該ノートを failed とし状態を更新しない」をそのまま適用し、`NoteListIncompleteError`
 * を投げる(手動で `noet` を実行して対応関係を確立するか、状態 JSON へ直接 `remoteId` を
 * 設定することを促す、actionable なメッセージにする)。
 *
 * この「完全性が確認された」という性質は実行(run)単位でキャッシュする一覧
 * (`listRows`/`listAbsenceTrusted`)にも保持される: 一覧取得時点で完全性が確認できた
 * (=空だった)場合、以後その run 内で NotePublisher 自身が `create` した記事だけを
 * キャッシュへ追記していく——run 内で他に記事を追加する主体が無い前提のもとでは、
 * 「キャッシュの内容が実際の note.com 上の全記事と一致する」という不変条件は run の
 * 終わりまで保たれる(design.md §5.7「応答不明時の重複防止」がタイトル一致照合を
 * 求める dev.to/はてなと同じ、per-run キャッシュ + `publishChain` 直列化のパターン。
 * `src/publishers/devto.ts`/`src/publishers/hatena.ts` を参照)。
 *
 * **コマンド体系(design.md §5.7・§13-4)**: 新規 `noet create <file>`、更新
 * `noet update <key> <file>`(`--draft` を付けない = 公開。本実装は常に公開する——
 * design.md §5.7 の frontmatter に下書き制御フィールドは無く、issue #30 も下書き運用を
 * 要求していない)。`<file>` はワークスペース内に書き出した記事ファイルの絶対パスを渡す
 * (§13-4「任意パスの Markdown ファイルを引数で渡す」——noet 自身には Hugo の `content/`
 * のような固定コンテンツディレクトリ規約が無い)。`cwd` はワークスペースルート
 * (`config.note.workspace`)に固定する(`.noet/` 配下のテンプレート等、noet 自身が
 * カレントディレクトリからの相対解決に依存する可能性への備え。design.md に明記は無い
 * 実装判断)。
 *
 * **記事 ID(key)の取得(design.md §5.7・§13-4)**: `noet create` の成功時、公開直後の
 * リダイレクト先 URL(`https://note.com/<user>/n/<key>`)が標準出力に含まれる前提で、
 * 正規表現でそこから `key` を抽出する。抽出できない場合は `remoteId: null` のまま
 * 「成功」を記録してしまうと次回実行が重複作成しかねないため、あえて例外を投げてこの
 * ノートを failed 扱いにする(`src/publishers/qiita.ts` の「id の書き戻しが無い」ケースと
 * 同じ方針)。`update` はこの抽出に失敗しても(通常は既に `remoteId` を知っているため)
 * 致命的ではなく、抽出できればそれを・できなければ `prev?.url` を、それも無ければ
 * `undefined` を `url` として返す(design.md に明記の無い実装判断——`update` の標準出力が
 * URL を含む保証は無いため、既知の URL があれば引き継ぐ)。
 *
 * **frontmatter(design.md §5.7・§13-4「frontmatter は `title`/`tags`… の3項目のみが実際に
 * 読まれる」)**: noet の `parse_markdown_file` が実際に読むキーは `title`/`tags`/
 * `header_image` の3つのみで、`header_image`(見出し画像)は本タスクの範囲外(issue #30 は
 * 見出し画像機能を要求していない)。したがって `renderNoteArticle` は `title`/`tags` の
 * 2キーのみを書く——`src/publishers/render.ts` の `renderGenericArticle` と同じ最小限の
 * frontmatter だが、直列化(`serializeFrontmatter`)は design.md §5.6 の決定的規約に従う
 * 専用の Renderer として独立させる(`NOTE_FRONTMATTER_KEY_ORDER`、`src/transform/frontmatter.ts`)。
 * タグ先頭の `#` は他サービス(Zenn/Qiita/dev.to)と同じ理由で1つだけ除去する
 * (`src/publishers/zenn.ts` の `stripLeadingHash` と同じ規約。design.md はタグの文字種
 * 変換に触れていないが、既存 Renderer 群との一貫性を優先する)。
 *
 * **`noet` コマンドの解決先(`NOET_PATH`、実機報告)**: `noet` は
 * `cargo install` で導入されることが多く、その場合 `~/.cargo/bin/noet` に置かれる。
 * launchd が生成する plist の `PATH`(`buildLaunchdPath`、`src/init.ts`)は rbenv/asdf/rvm の
 * shim と OS 標準ディレクトリのみを対象にしており、`~/.cargo/bin` を含まない——対話シェルの
 * `.zshrc` 等が PATH へ `~/.cargo/bin` を追加していても launchd 環境には反映されないため、
 * 無人(launchd)実行では `required command "noet" was not found on PATH` で失敗する
 * (実機報告)。本実装はこれを PATH 探索の拡張ではなく、環境変数 `NOET_PATH` に `noet`
 * バイナリの絶対パスを持たせる方式で解決する(`resolveNoetCommand`)。`NOET_PATH` は
 * `note2web init` が対話で尋ねて(既定 `~/.cargo/bin/noet`)env ファイルへ値入りで書き込む
 * (`src/init.ts`)。**PATH へのフォールバックは意図的に行わない**——`NOET_PATH` が
 * 未設定/空のまま `noet` の実行を試みてしまうと、対話シェルでは PATH が通っていて偶然
 * 動いてしまい、launchd 環境でだけ壊れるという不可視の環境依存を再生産しかねないため、
 * 未設定を早期に明確なエラーとして扱う(`src/dependencies.ts` の `case 'note'` が
 * `doctor`/`sync` 冒頭で同じ理由により事前検出する)。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
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
  NOTE_FRONTMATTER_KEY_ORDER,
  type FrontmatterEntry,
} from '../transform/frontmatter.js';

// ---------------------------------------------------------------------------
// Renderer 本体(モジュール冒頭 JSDoc「frontmatter」参照)。
// ---------------------------------------------------------------------------

/**
 * タグ先頭の `#` を1つだけ除去する(`src/publishers/zenn.ts`/`src/publishers/qiita.ts`/
 * `src/publishers/devto.ts` の `stripLeadingHash` と同じ規約をミラーする)。
 */
function stripLeadingHash(tag: string): string {
  return tag.startsWith('#') ? tag.slice(1) : tag;
}

/**
 * `findExternalImageUrl` 用の Markdown パーサ(`remark-parse` + `remark-gfm`。
 * `src/transform/body.ts` のプロセッサと同様、ステートレスなのでモジュールスコープで
 * 使い回す)。正規表現ではなく構文解析で画像ノードだけを検査する——正規表現だと
 * コードフェンス・インラインコード中のリテラルな `![alt](https://…)` に誤反応して
 * 画像ではない本文でノートを失敗させ、逆に参照形式(`![alt][ref]`)の画像は見逃す
 * (PR #85 CodeRabbit レビュー)。
 */
const noteMarkdownParser = unified().use(remarkParse).use(remarkGfm).freeze();

/** mdast ノードの再帰走査(`src/transform/body.ts` の `unwrapAutolinks` と同じ軽量パターン)。 */
function visitMdastNodes(node: unknown, visit: (node: { type?: unknown }) => void): void {
  if (typeof node !== 'object' || node === null) {
    return;
  }
  visit(node as { type?: unknown });
  const children = (node as { children?: unknown }).children;
  if (Array.isArray(children)) {
    for (const child of children) {
      visitMdastNodes(child, visit);
    }
  }
}

/**
 * 本文 Markdown を構文解析し、外部 URL(`http(s)://`)を指す**画像ノード**
 * (インライン `![alt](URL)`・参照形式 `![alt][ref]` + 定義のいずれも)を探して
 * 最初に見つかった URL を返す。コードブロック・インラインコード・エスケープ済みの
 * 画像構文は画像ノードにならないため対象外(`renderNoteArticle` の JSDoc 参照)。
 * 添付経由の画像は `processNoteBody` が `./images/...` のローカル相対パスへ解決済み
 * なので、ここに掛かるのは添付を伴わない `<img src="外部URL">` 由来の参照だけ。
 */
function findExternalImageUrl(markdown: string): string | undefined {
  const tree = noteMarkdownParser.parse(markdown);
  const isExternal = (url: string): boolean => /^https?:\/\//i.test(url);

  const definitionUrls = new Map<string, string>();
  visitMdastNodes(tree, (node) => {
    if (node.type === 'definition') {
      const definition = node as { identifier: string; url: string };
      definitionUrls.set(definition.identifier, definition.url);
    }
  });

  let found: string | undefined;
  visitMdastNodes(tree, (node) => {
    if (found !== undefined) {
      return;
    }
    if (node.type === 'image') {
      const image = node as { url: string };
      if (isExternal(image.url)) {
        found = image.url;
      }
      return;
    }
    if (node.type === 'imageReference') {
      const reference = node as { identifier: string };
      const url = definitionUrls.get(reference.identifier);
      if (url !== undefined && isExternal(url)) {
        found = url;
      }
    }
  });
  return found;
}

/**
 * 本文に外部 URL の画像参照が含まれていることを表す(note.com の ProseMirror は外部 URL の
 * 画像記法を画像として解釈せず、noet も `http(s)://` 参照をアップロード対象からスキップする
 * ため、公開するとリテラルなテキストとして表示されてしまう。design.md §5.7「画像」節、
 * PR #85 CodeRabbit レビュー)。`src/sync.ts` の `processNote` がこの例外を捕捉し、
 * 当該ノートのみ `'failed'` として隔離する(NFR-06)。
 */
export class NoteExternalImageError extends Error {
  /** 検証に失敗したノートの UUID。 */
  readonly noteUuid: string;
  /** 検出された外部 URL(問題の画像を特定しやすくするため)。 */
  readonly imageUrl: string;

  constructor(noteUuid: string, imageUrl: string) {
    super(
      `note.com cannot render images referenced by external URL (design.md §5.7): note.com's ` +
        `ProseMirror editor shows markdown image syntax with an http(s) URL as literal text, and ` +
        `noet skips http(s) references when uploading images; note "${noteUuid}" contains an ` +
        `external-URL image reference (${imageUrl}, likely an <img src="…"> without an Apple ` +
        'Notes attachment) — remove the image, or publish this note to a different service instead',
    );
    this.name = 'NoteExternalImageError';
    this.noteUuid = noteUuid;
    this.imageUrl = imageUrl;
  }
}

/**
 * note.com 向け `NoteRenderer`(design.md §5.7 NotePublisher 節、§13-4、T-25)。
 * `config` は参照しない——note.com のファイルパスは常に `<uuid>.md`(Publisher が
 * `config.note.workspace` からの相対パスとして解決する)固定で、frontmatter の内容も
 * `Note`/`prev` のみから決まるため(`renderQiitaArticle` と同じ方針)。`prev` も参照
 * しない——note.com の frontmatter は ID の書き戻し欄を持たない(モジュール冒頭 JSDoc
 * 「記事 ID(key)の取得」参照。ID の追跡は Publisher 側の状態 JSON `remoteId` のみで行う)。
 *
 * 画像について(モジュール冒頭 JSDoc「2. 画像」参照): `markdown` は `assets/uploader.ts` の
 * `processNoteBody` を経由済みで、note.com 向けの添付画像参照は既に
 * `./images/<identifier>-<内容ハッシュ><ext>` というローカル相対パスに解決されている
 * (未対応の拡張子はその段階で `AssetUploadError` として弾かれている)。ここで追加検証
 * するのは**外部 URL(`http(s)://`)の画像参照**のみ——添付経由ではない `<img src="外部URL">`
 * が本文にあった場合、変換パイプラインはそれを `![](https://…)` として素通しするが、noet の
 * `extract_image_references` は `http(s)://` 参照をアップロード対象からスキップするため、
 * note.com 上ではリテラルなテキストとして表示されてしまう(design.md §5.7「画像」節)。
 * 静かに壊れた記事を公開しないよう、`NoteExternalImageError` として当該ノートを失敗させる
 * (PR #85 CodeRabbit レビュー)。
 */
export const renderNoteArticle: NoteRenderer = ({
  note,
  markdown,
}: RenderNoteInput): RenderedArticle => {
  const externalImageUrl = findExternalImageUrl(markdown);
  if (externalImageUrl !== undefined) {
    throw new NoteExternalImageError(note.uuid, externalImageUrl);
  }

  const entries: FrontmatterEntry[] = [
    [NOTE_FRONTMATTER_KEY_ORDER[0], note.title],
    [NOTE_FRONTMATTER_KEY_ORDER[1], note.tags.map(stripLeadingHash)],
  ];

  const artifact = renderArtifact(entries, markdown);
  const contentHash = computeContentHash(artifact);
  const artifactPath = `${note.uuid}.md`;

  return { noteUuid: note.uuid, title: note.title, artifact, contentHash, artifactPath };
};

// ---------------------------------------------------------------------------
// Publisher 本体。
// ---------------------------------------------------------------------------

/** `noet` コマンド実行の注入点(テスト用)。既定は本物の `runSubprocess`。 */
export type NoteRunner = (options: RunSubprocessOptions) => Promise<RunSubprocessResult>;

/** `createNotePublisher` のオプション。 */
export interface CreateNotePublisherOptions {
  /** 検証済み設定。`config.note` が必須(`src/config.ts` の `noteSchema` 参照)。 */
  config: Config;
  /** `noet` コマンド実行の注入点(テスト用)。既定は本物の `runSubprocess`。 */
  runner?: NoteRunner;
  /** ログ出力先(任意)。複数一致時の警告に使う(`createDevtoPublisher` と同じ用途)。 */
  logger?: Logger;
  /**
   * 環境変数の参照元(テスト用)。既定は `process.env`。design.md §13-4 が明らかにした
   * とおり、note.com は認証をサーバー側の環境変数で受け渡す手段を持たない
   * (`src/config.ts` の `noteSchema` にも `*_env` は無い)ため認証には使わないが、
   * `noet` コマンド自体の解決に `NOET_PATH` を読む(`resolveNoetCommand` 参照。
   * 実機報告 / launchd の PATH に `~/.cargo/bin` が無い問題への対応)。
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * 実行する `noet` コマンドを解決する。`NOET_PATH`(絶対パス、`~` 展開に対応)が
 * 非空で設定されていればそれを使う——`cargo install` された `noet` は `~/.cargo/bin/noet`
 * に置かれることが多く、`note2web init` が生成する launchd の plist の PATH
 * (`buildLaunchdPath`、`src/init.ts`)はこのディレクトリを含まないため、無人実行では
 * PATH 上の `noet` を素朴に探すと見つからない(実機報告)。
 *
 * `NOET_PATH` が未設定・空文字の場合は **PATH へフォールバックせず、例外を投げる**。
 * PATH 経由で解決してしまうと対話シェル(PATH に `~/.cargo/bin` が通っている)では
 * 偶然動作し、launchd 環境でだけ壊れるという不可視の環境依存を再生産しかねないため、
 * 未設定を早期に明確なエラーとして扱う(`src/dependencies.ts` の `case 'note'` が
 * `doctor`/`sync` 冒頭で同じ理由により事前検出する)。
 */
function resolveNoetCommand(env: NodeJS.ProcessEnv): string {
  const raw = env.NOET_PATH;
  if (raw === undefined || raw === '') {
    throw new Error(
      'NotePublisher: environment variable "NOET_PATH" is not set; set it in the env file ' +
        '(~/.config/note2web/env, written by "note2web init"; default ~/.cargo/bin/noet). ' +
        'Falling back to PATH lookup is intentionally not supported (design.md §5.7)',
    );
  }
  const resolved = expandHome(raw);
  if (!isAbsolute(resolved)) {
    // 相対パスは cwd に依存し、対話シェルと launchd で解決先が変わる——PATH フォール
    // バックを廃止したのと同じ理由で暗黙の環境依存を持ち込まないよう拒否する
    // (PR #84 CodeRabbit レビュー。`src/dependencies.ts` の `case 'note'` と同じ規則)。
    throw new Error(
      `NotePublisher: NOET_PATH="${raw}" is not an absolute path; a relative value would ` +
        'resolve against the current working directory. Set NOET_PATH to the absolute path of ' +
        'the noet binary (e.g. ~/.cargo/bin/noet, design.md §5.7)',
    );
  }
  return resolved;
}

/** design.md §7 の `note` ブロック(`workspace` のみ)。 */
type NoteConfig = NonNullable<Config['note']>;

/**
 * `config.note` の存在を検証して返す(`src/publishers/qiita.ts` の `requireQiitaConfig` と
 * 同じ防御パターン)。
 */
function requireNoteConfig(config: Config): NoteConfig {
  if (config.note === undefined) {
    throw new Error(
      `internal error: createNotePublisher requires config.note (service "${config.service}" has none)`,
    );
  }
  return config.note;
}

/**
 * `absolutePath` が `root` の配下(`root` 自身を含む)かどうかを判定する
 * (`src/publishers/qiita.ts`/`src/publishers/git-repo.ts` と同じ防御パターン)。
 */
function isPathWithinRoot(root: string, absolutePath: string): boolean {
  const rel = relative(root, absolutePath);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * `noet` の実行結果を検証し、失敗ならコマンドライン自体は含めない(design.md §5.7・FR-30。
 * `--images`/`--draft` 等の引数は秘匿情報を含まないが、`src/publishers/qiita.ts` の
 * `assertSuccess` 相当パターンをそのまま踏襲する)説明的なエラーを投げる。
 */
function assertNoetSuccess(
  result: RunSubprocessResult,
  description: string,
  context: { noteUuid: string } | { operation: string },
): void {
  if (result.status === 'success') {
    return;
  }
  const detail =
    firstNonEmptyLine(result.stderr) ?? firstNonEmptyLine(result.stdout) ?? 'unknown error';
  const subject =
    'noteUuid' in context ? `for note "${context.noteUuid}"` : `during ${context.operation}`;
  throw new Error(
    `"noet ${description}" failed ${subject} ` +
      `(exitCode=${String(result.exitCode)}, signal=${String(result.signal)}): ${detail}`,
  );
}

/**
 * `noet create`/`noet update` の成功応答から note.com の記事 URL
 * (`https://note.com/<user>/n/<key>`)を抽出する(design.md §13-4「`url` は公開後に
 * リダイレクトした実際のページ URL」)。`key` は英数字・`_`・`-` のみ(`noet list` の
 * `key` 列と同じ文字集合、`NOTE_LIST_KEY_PATTERN` 参照)。
 */
const NOTE_URL_PATTERN = /https:\/\/note\.com\/[^\s/]+\/n\/([A-Za-z0-9_-]+)/;

function extractNoteUrl(stdout: string): { url: string; key: string } | undefined {
  const match = NOTE_URL_PATTERN.exec(stdout);
  if (match === null || match[1] === undefined) {
    return undefined;
  }
  return { url: match[0], key: match[1] };
}

// ---------------------------------------------------------------------------
// `noet list` の出力解析(モジュール冒頭 JSDoc「3. 記事一覧の完全性」参照)。
// ---------------------------------------------------------------------------

/** `noet list` の1行分(タイトル・key・ステータス)。design.md §13-4「タイトル・key・status」。 */
interface NoteListRow {
  title: string;
  key: string;
  status: string;
}

/** `noet list` の1行における `key` 列の許容文字集合(URL 抽出時と同じ、`NOTE_URL_PATTERN` 参照)。 */
const NOTE_LIST_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * `noet list` の標準出力を解析する。実際の `noet list` の出力書式は本タスクの環境
 * (egress 遮断・GUI 無し)では確認できない(design.md §12「実機確認」note.com 節)ため、
 * 本実装は「1行 = タブ区切りの `title\tkey\tstatus` 3列」という形式を暫定的に採用し
 * (design.md §13-4 が述べる「タイトル・key・status からなる一覧」を素直にタブ区切りへ
 * 落とした形)、**寛容(tolerant)**に解析する:
 *
 * - 出力が空(空白のみを含む)ならアカウント全体に記事が0件と確定できる
 *   (`confirmedEmptyAccount: true`。モジュール冒頭 JSDoc「3. 記事一覧の完全性」参照)
 * - 1行でも上記の3列形式・`key` の文字集合(`NOTE_LIST_KEY_PATTERN`)に一致しなければ、
 *   出力全体を解析不能とみなし `{ rows: [], confirmedEmptyAccount: false }` を返す——
 *   一部の行だけを信頼して残りを無視する(部分的成功)ことはしない。実際の出力書式が
 *   異なると判明した場合、この関数だけを差し替えればよいように設計を閉じ込める
 */
function parseNoteList(stdout: string): { rows: NoteListRow[]; confirmedEmptyAccount: boolean } {
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { rows: [], confirmedEmptyAccount: true };
  }

  const rows: NoteListRow[] = [];
  for (const line of lines) {
    const parts = line.split('\t');
    const [title, key, status] = parts;
    if (
      parts.length !== 3 ||
      title === undefined ||
      key === undefined ||
      status === undefined ||
      !NOTE_LIST_KEY_PATTERN.test(key) ||
      status.trim().length === 0
    ) {
      // 解析不能な行が1つでもあれば全体を信頼しない(モジュール冒頭 JSDoc「3.」参照)。
      return { rows: [], confirmedEmptyAccount: false };
    }
    // title も trim する: noet list が列を空白で整形して出力する場合に、前後の空白で
    // タイトル完全一致が外れて既存記事を見落とす(=重複作成につながる)のを防ぐ。
    rows.push({ title: title.trim(), key, status: status.trim() });
  }
  return { rows, confirmedEmptyAccount: false };
}

/**
 * 複数一致(応答不明時の重複防止の照合で2件以上ヒット)を表す(design.md §5.7「複数一致の
 * 場合は…そのノートを failed とし状態を更新しない」)。`DevtoAmbiguousTitleMatchError`/
 * `HatenaAmbiguousTitleMatchError` と同じパターン。
 */
export class NoteAmbiguousTitleMatchError extends Error {
  /** 検証に失敗したノートの UUID。 */
  readonly noteUuid: string;
  /** 一致した note.com 記事の件数(常に2以上)。 */
  readonly matchCount: number;

  constructor(noteUuid: string, title: string, matchCount: number) {
    super(
      `NotePublisher.publish: found ${String(matchCount)} existing note.com articles (via "noet ` +
        `list") with a title exactly matching note "${noteUuid}" (${JSON.stringify(title)}); ` +
        'refusing to guess which one corresponds to this note (design.md §5.7 "応答不明時の重複' +
        '防止": 複数一致は failed とし状態を更新しない — resolve manually, e.g. by setting ' +
        'remoteId in the state JSON)',
    );
    this.name = 'NoteAmbiguousTitleMatchError';
    this.noteUuid = noteUuid;
    this.matchCount = matchCount;
  }
}

/**
 * design.md §5.7 NotePublisher を実装する `Publisher` を作る(T-25 / issue #30)。
 * API/CLI モードのため `prepare`/`finalize` は実装しない(`src/publishers/types.ts` 冒頭
 * JSDoc「API/CLI 系 Publisher はこの2メソッドを実装しなくてよい」)。
 *
 * **前提(モジュール冒頭 JSDoc「1. 実行モード」)**: 呼び出し側(利用者)の実行環境で、
 * note.com にログイン済みの実 Chrome ブラウザ + noet 拡張機能が同一マシン上で稼働して
 * いる必要がある。満たされていない場合(cron/launchd での無人実行を含む)、`runner` の
 * `noet` 呼び出しが失敗し、`assertNoetSuccess` が例外を投げる——このノートは `'failed'`
 * として隔離され(NFR-06)、次回実行で再試行される。これはバグではなく design.md §5.7・
 * §6 依存表に明記された仕様である。
 */
export function createNotePublisher(options: CreateNotePublisherOptions): Publisher {
  const { config, runner = runSubprocess, logger, env = process.env } = options;
  const noteConfig = requireNoteConfig(config);
  const workspaceRoot = expandHome(noteConfig.workspace);

  // `noet list` の per-run キャッシュ(モジュール冒頭 JSDoc「3. 記事一覧の完全性」参照)。
  // `listRows === null` は「この run ではまだ取得していない」を表す。
  let listRows: NoteListRow[] | null = null;
  // 取得した一覧が「アカウント全体で0件と確定できた」場合のみ true になる。true の間は、
  // その後 NotePublisher 自身が `create` した行を `listRows` へ追記していく限り、
  // 「0件一致 = 未作成」という判定を run の終わりまで信頼してよい(同 JSDoc 参照)。
  let listAbsenceTrusted = false;

  // publish() の直列化チェーン(`createDevtoPublisher`/`createHatenaPublisher` と同じ
  // パターン)。一覧キャッシュの未初期化・未反映を複数ノートが同時に観測して同名記事を
  // 二重 `create` する競合を防ぐため、全 publish を構造的に直列化する。
  let publishChain: Promise<unknown> = Promise.resolve();

  function publish(article: RenderedArticle, prev: NoteState | null): Promise<PublishResult> {
    const run = publishChain.then(() => publishOnce(article, prev));
    publishChain = run.catch(() => undefined);
    return run;
  }

  async function ensureListFetched(noetCommand: string): Promise<void> {
    if (listRows !== null) {
      return;
    }
    const result = await runner({
      command: noetCommand,
      args: ['list'],
      cwd: workspaceRoot,
      timeoutMs: DEFAULT_TIMEOUTS.default,
    });
    assertNoetSuccess(result, 'list', {
      operation: 'recovery-path listing (design.md §5.7)',
    });
    const parsed = parseNoteList(result.stdout);
    listRows = parsed.rows;
    listAbsenceTrusted = parsed.confirmedEmptyAccount;
  }

  async function publishOnce(
    article: RenderedArticle,
    prev: NoteState | null,
  ): Promise<PublishResult> {
    // `noet` コマンド自体の解決は publish 実行のたびに行う(`src/publishers/qiita.ts` の
    // `env[qiitaConfig.token_env]` 未設定チェックと同じく publish() 時点でのチェックとする
    // ——`NOET_PATH` 未設定は依存チェック(`src/dependencies.ts`)でも事前検出されるが、
    // 依存チェックをバイパスした呼び出し経路への防御として Publisher 側でも検証する)。
    const noetCommand = resolveNoetCommand(env);

    if (article.artifactPath === undefined) {
      throw new Error(
        `NotePublisher.publish: note "${article.noteUuid}" has no artifactPath ` +
          '(renderNoteArticle must set one; design.md §5.7)',
      );
    }

    // `resolve`(`join` ではなく)を使う理由は `src/publishers/qiita.ts` の `publish()` と
    // 同じ(絶対パスの引数をそのまま採用させ、直後の `isPathWithinRoot` 検査で確実に検出する)。
    const absolutePath = resolve(workspaceRoot, article.artifactPath);
    if (!isPathWithinRoot(workspaceRoot, absolutePath)) {
      throw new Error(
        `NotePublisher.publish: note "${article.noteUuid}" has an artifactPath that escapes the ` +
          `note.com workspace (traversal or absolute path rejected): "${article.artifactPath}"`,
      );
    }

    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, article.artifact, 'utf8');

    // design.md §5.7「`remoteId` の無いノートを新規作成する前に、既存記事の照合を行う」——
    // 逆に言えば `remoteId` があれば照合(`noet list`)不要でそのまま更新してよい
    // (モジュール冒頭 JSDoc「コマンド体系」参照)。
    if (prev !== null && prev.remoteId !== null) {
      const remoteId = prev.remoteId;
      const result = await runner({
        command: noetCommand,
        args: ['update', remoteId, absolutePath],
        cwd: workspaceRoot,
        timeoutMs: DEFAULT_TIMEOUTS.default,
      });
      assertNoetSuccess(result, `update ${remoteId}`, { noteUuid: article.noteUuid });
      const extracted = extractNoteUrl(result.stdout);
      return { result: 'updated', remoteId, url: extracted?.url ?? prev.url };
    }

    await ensureListFetched(noetCommand);
    const rows = listRows ?? [];
    const matches = rows.filter((row) => row.title === article.title.trim());

    if (matches.length >= 2) {
      logger?.warn({
        service: 'note',
        noteUuid: article.noteUuid,
        title: article.title,
        message:
          `found ${String(matches.length)} existing note.com articles ("noet list") with a title ` +
          'exactly matching this note; refusing to guess which one corresponds to this note — ' +
          'resolve manually (design.md §5.7 "応答不明時の重複防止")',
      });
      throw new NoteAmbiguousTitleMatchError(article.noteUuid, article.title, matches.length);
    }

    if (matches.length === 1) {
      const match = matches[0];
      if (match === undefined) {
        throw new Error('internal error: matches.length === 1 but matches[0] is undefined');
      }
      const result = await runner({
        command: noetCommand,
        args: ['update', match.key, absolutePath],
        cwd: workspaceRoot,
        timeoutMs: DEFAULT_TIMEOUTS.default,
      });
      assertNoetSuccess(result, `update ${match.key}`, { noteUuid: article.noteUuid });
      const extracted = extractNoteUrl(result.stdout);
      return { result: 'updated', remoteId: match.key, url: extracted?.url ?? prev?.url };
    }

    // matches.length === 0: design.md §5.7「一覧の完全性…が確認できた場合のみ適用する。
    // 取得範囲が不明・不完全な場合は当該ノートを failed とし状態を更新しない」
    // (モジュール冒頭 JSDoc「3. 記事一覧の完全性」参照)。
    if (!listAbsenceTrusted) {
      throw new Error(
        `NotePublisher.publish: could not confirm from "noet list" that note "${article.noteUuid}" ` +
          `(title ${JSON.stringify(article.title)}) does not already exist on note.com — "noet ` +
          'list" scrapes the "/notes" page without pagination (design.md §13-4), so an empty ' +
          'title-match within a non-empty listing cannot be trusted as "not created" (design.md ' +
          '§5.7 recovery-path safety condition). Resolve manually: run `noet list`/`noet create` ' +
          "yourself to find or create the article, then set this note's remoteId directly in the " +
          'state JSON so future runs can update() without relying on this listing.',
      );
    }

    const result = await runner({
      command: noetCommand,
      args: ['create', absolutePath],
      cwd: workspaceRoot,
      timeoutMs: DEFAULT_TIMEOUTS.default,
    });
    assertNoetSuccess(result, 'create', { noteUuid: article.noteUuid });
    const extracted = extractNoteUrl(result.stdout);
    if (extracted === undefined) {
      // モジュール冒頭 JSDoc「記事 ID(key)の取得」参照: id 不明のまま「成功」を記録すると
      // 次回実行で重複作成しかねないため、あえて failed 扱いにする(状態は確定保存しない)。
      throw new Error(
        `NotePublisher.publish: "noet create" succeeded for note "${article.noteUuid}" but no ` +
          'note.com article URL ("https://note.com/<user>/n/<key>") could be extracted from its ' +
          'output; cannot confirm the remoteId (design.md §5.7 "応答不明時の重複防止" と同じ理由' +
          'で、確認できない成功を記録しないほうを選ぶ) — treating as failed so the note is ' +
          'retried next run instead of being recorded with an unconfirmed remoteId',
      );
    }

    // 作成成功を per-run キャッシュへ反映し、同一実行内の後続ノート(同一タイトルの
    // 二重処理を含む)の照合で「既に作成済み」と判定できるようにする(重複作成防止。
    // モジュール冒頭 JSDoc「3. 記事一覧の完全性」参照)。`rows` は `ensureListFetched` 後の
    // `listRows`(非 null)と同一の配列参照であるため、これへの push は `listRows` 自身にも
    // 反映される。
    rows.push({ title: article.title, key: extracted.key, status: 'published' });

    return { result: 'created', remoteId: extracted.key, url: extracted.url };
  }

  return { publish };
}
