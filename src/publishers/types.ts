/**
 * Publisher インターフェース(design.md §5.7)。
 *
 * design.md §5.7 が定める契約は次の2メソッドのみ:
 *
 * ```ts
 * interface Publisher {
 *   // 変更のあったノートを配信し、サービス側の識別子等を返す
 *   publish(a: RenderedArticle, prev: NoteState | null): Promise<PublishResult>;
 *   // Git モードのみ: 全ノート処理後のコミット・PR 作成
 *   finalize?(): Promise<void>;
 * }
 * ```
 *
 * 本モジュールはこれをそのまま TypeScript 化する。**レンダリング(frontmatter 生成)は
 * Publisher のメソッドにしない** ——design.md §5.7 の `publish` は既にレンダリング済みの
 * `RenderedArticle` を受け取る形で定義されており、Publisher 自身が変換済みノートから
 * `RenderedArticle` を作る `render()` のようなメソッドは §5.7 に存在しない。
 *
 * (CodeRabbit issue plan の Design Choice 2 は `Publisher.render()` を提案しているが、
 * design.md §5.7 の実際のインターフェース定義と矛盾するため採用しない。design.md を
 * CodeRabbit plan より優先する。代わりに、レンダリングは sync フロー側が
 * `NoteRenderer`(`./render.ts`)として注入する — design.md §6 手順6c「frontmatter + 本文を
 * レンダリング → SHA-256」は Publisher の外側の汎用ステップとして書かれており、
 * この構造とも整合する。)
 *
 * **`prepare?()` は design.md §5.7 に無い拡張**: design.md §6 手順5「Git モードなら
 * 作業ブランチ作成」を sync フロー(`src/sync.ts`)側から呼び出せるようにするための
 * 任意フック。§5.7 の GitRepoPublisher 節は「実行開始時に…作業ブランチを作成」と
 * 書いており、ブランチ作成のタイミングを Publisher 実装(T-16)に閉じ込めたまま、
 * sync フローは「いつ呼ぶか」だけを制御できるようにする(CodeRabbit issue plan の
 * Design Choice 3 と同じ結論)。`publish`/`finalize` のシグネチャは変更しないため、
 * design.md §5.7 の契約そのものを壊さない追加である。
 *
 * **`prepare?`/`finalize?` はインターフェース上は任意のまま**: API/CLI 系 Publisher
 * (Qiita/dev.to/note.com/はてな)はブランチ・PR という概念を持たず、この2メソッドを
 * 実装しなくてよい。§5.7 の `finalize?()` の任意性をそのまま踏襲し、`prepare?` にも
 * 同じ任意性を与える。
 *
 * **ただし Git モードでは両方の実装が必須という契約を sync フロー側が強制する**
 * (`src/sync.ts` の `runSync`。CodeRabbit review, PR #47): `isGitModeService(config.service)`
 * が真のとき、`publisher.prepare`/`publisher.finalize` のいずれかが欠けていると、
 * ロック取得やエクスポートなど一切の作業を行う前に前提条件不成立(exit 2)として
 * 打ち切る。理由は、Git モードで `prepare`(ブランチ作成)や `finalize`
 * (コミット・PR 作成 → 状態確定)が欠けたまま実行すると、`stageNote` で保留された
 * ノートが `flush()` されずに黙って失われる(design.md §5.6 書き込みポイント2が
 * 機能しない)という、検出しにくい静かな不整合を招くため。TypeScript の型としては
 * 両方任意のままにする——この制約は「型」ではなく「Git モード時の実行時契約」であり、
 * 型を必須にしてしまうと API/CLI 系のモック/実装がわざわざダミーの `prepare`/
 * `finalize` を書く必要が生じてしまう。
 */

import type { NoteState } from '../state/store.js';

/**
 * レンダリング済みの最終成果物(design.md §5.6「Renderer と冪等判定」)。
 * frontmatter + 変換済み Markdown 本文を連結した文字列(`artifact`)と、そのコンテンツ
 * ハッシュ(FR-15)を持つ。`artifactPath` は Git モードでのファイルパス(Jekyll の
 * ファイル名固定など、design.md §8 `NoteState.artifactPath` と同じ情報)。
 */
export interface RenderedArticle {
  /** Apple Notes の UUID(FR-09)。 */
  noteUuid: string;
  /** ノートのタイトル(ログ出力用。design.md §9 の `title` フィールド)。 */
  title: string;
  /** frontmatter + 本文を連結した最終成果物の文字列(design.md §5.6)。 */
  artifact: string;
  /** `artifact` の SHA-256(`sha256:` + 16進、design.md §5.6/§8)。 */
  contentHash: string;
  /** Git モードでの配信先ファイルパス(design.md §8 `NoteState.artifactPath` と同じ)。 */
  artifactPath?: string;
}

/** `Publisher.publish` の戻り値(design.md §5.7)。 */
export interface PublishResult {
  /** 新規作成か更新か(design.md §9 `note_published` ログの `result` と同じ語彙)。 */
  result: 'created' | 'updated';
  /** サービス側の識別子(design.md §8 `NoteState.remoteId`)。Git モードでは常に `null`。 */
  remoteId: string | null;
  /** サービス側 URL(取得できる場合のみ、design.md §8 `NoteState.url`)。 */
  url?: string;
}

/**
 * Publisher インターフェース(design.md §5.7 に厳密に準拠。`prepare?` のみ拡張、上記 JSDoc 参照)。
 */
export interface Publisher {
  /**
   * 変更のあったノートを配信し、サービス側の識別子等を返す(design.md §5.7)。
   * `prev` は状態 JSON の既存エントリ(`StateStore.getNote(uuid)`)。初回配信時は `null`。
   */
  publish(article: RenderedArticle, prev: NoteState | null): Promise<PublishResult>;
  /**
   * design.md §5.7 に無い拡張(このファイル冒頭の JSDoc 参照)。Git モードの作業ブランチ作成
   * (design.md §6 手順5)を行うための任意フック。定義されていれば、sync フローが
   * Exporter 実行前に一度だけ呼ぶ。
   */
  prepare?(): Promise<void>;
  /** Git モードのみ: 全ノート処理後のコミット・PR 作成(design.md §5.7)。 */
  finalize?(): Promise<void>;
}
