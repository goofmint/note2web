/**
 * Note モデル(design.md §5.3「Note モデルとメタデータ抽出」)。
 *
 * Exporter(`src/exporter/apple-notes.ts`、design.md §5.2)は parser の JSON / 個別 HTML
 * から読み取れる「骨格」フィールド(`uuid` / `folder` / `createdAt` / `updatedAt` /
 * `bodyHtml` / `attachments`)に加え、`tags`(JSON `hashtags` フィールドをそのまま。
 * design.md §5.3「差分」節)も埋めて返す。`title` / `emoji` のみメタデータ抽出層
 * (`src/transform/metadata.ts`。T-10)の担当であり、Exporter は空値(`''` / `null`)で
 * 初期化するだけにとどめる。
 */

/** Apple Notes の1ノートを表すモデル(design.md §5.3)。 */
export interface Note {
  /** Apple Notes の UUID(FR-09)。 */
  uuid: string;
  /** フォルダ名(FR-06)。JSON ノートオブジェクトの `folder` フィールド(葉フォルダ名の文字列)。 */
  folder: string;
  /**
   * ルート(`source.folders` で一致したフォルダ)から葉(ノートが直接属するフォルダ)までの
   * フォルダ名の配列。`folder` は常にこの配列の最終要素と一致する。Zenn の `type` 判別
   * (design.md §5.7、FR-24)に使う。
   */
  folderPath: string[];
  /** 1行目から先頭絵文字を除去したタイトル(FR-04)。メタデータ抽出層(T-10)が埋める。 */
  title: string;
  /** 1行目の先頭 grapheme(絵文字の場合のみ)(FR-05)。メタデータ抽出層(T-10)が埋める。 */
  emoji: string | null;
  /**
   * ノート内ハッシュタグ(FR-07)。Exporter(T-09)が JSON `hashtags` フィールドを
   * そのまま(順序を保った重複排除のみ行い)埋める(design.md §5.3「差分」節)。
   * `#` を含む値をそのまま保持する(FR-07「そのまま」の文言どおり)。
   */
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
