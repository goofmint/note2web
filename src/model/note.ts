/**
 * Note モデル(design.md §5.3「Note モデルとメタデータ抽出」)。
 *
 * Exporter(`src/exporter/apple-notes.ts`、design.md §5.2)は parser の JSON / 個別 HTML
 * から読み取れる「骨格」フィールド(`uuid` / `folder` / `createdAt` / `updatedAt` /
 * `bodyHtml` / `attachments`)のみを埋めて返す。`title` / `emoji` / `tags` は
 * メタデータ抽出層(`src/transform/metadata.ts`。T-10)の担当であり、Exporter は
 * 空値(`''` / `null` / `[]`)で初期化するだけにとどめる。
 */

/** Apple Notes の1ノートを表すモデル(design.md §5.3)。 */
export interface Note {
  /** Apple Notes の UUID(FR-09)。 */
  uuid: string;
  /** フォルダ名(FR-06)。JSON ノートオブジェクトの `folder` フィールド(葉フォルダ名の文字列)。 */
  folder: string;
  /** 1行目から先頭絵文字を除去したタイトル(FR-04)。メタデータ抽出層(T-10)が埋める。 */
  title: string;
  /** 1行目の先頭 grapheme(絵文字の場合のみ)(FR-05)。メタデータ抽出層(T-10)が埋める。 */
  emoji: string | null;
  /** ノート内ハッシュタグ(FR-07)。メタデータ抽出層(T-10)が埋める。 */
  tags: string[];
  /** 作成日時(FR-08)。JSON の `creation_time` を解決したもの。 */
  createdAt: Date;
  /** 更新日時(FR-08)。JSON の `modify_time` を解決したもの。 */
  updatedAt: Date;
  /** parser が出力した当該ノートの個別 HTML(UUID で解決。design.md §5.2)。未加工のまま保持する。 */
  bodyHtml: string;
  /** `files/` 配下の添付・描画の実体への参照。 */
  attachments: Attachment[];
}

/**
 * `files/` 配下の添付・描画ファイルへの最小限の参照。
 * ハッシュ計算・アップロード先 URL 等は AssetUploader(§5.5, T-13)の責務であり、
 * ここでは実体を特定するための情報のみを持つ。
 */
export interface Attachment {
  /** 埋め込みオブジェクトの UUID(JSON `embedded_objects[].uuid`)。 */
  identifier: string;
  /**
   * エクスポート出力ディレクトリの `files/` からの相対パス
   * (JSON `embedded_objects[].filepath` または `backup_location` をそのまま使用)。
   */
  path: string;
}
