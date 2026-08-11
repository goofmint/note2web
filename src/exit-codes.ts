/**
 * CLI 終了コードの定数(design.md §5.1, §10)。
 * マジックナンバーとして埋め込まず、必ずこれらの named export を参照すること。
 */

/**
 * 全ノート成功(スキップ含む)。
 * design.md §5.1: 「全ノート成功(スキップ含む)= 0」
 */
export const SUCCESS = 0;

/**
 * 1件でもノートの変換・配信に失敗した場合。
 * design.md §5.1: 「1件でも失敗 = 1」
 * design.md §10: parser 実行失敗など、実行全体を中断する場合もこのコードを用いる。
 */
export const PARTIAL_FAILURE = 1;

/**
 * 実行前提が不成立(設定不正・依存 CLI 欠如・多重起動検出など)。
 * design.md §5.1: 「実行前提の不成立(設定不正・依存欠如)= 2」
 * design.md §10: 設定不正・環境変数未設定・依存 CLI 欠如・多重起動は、何も配信せず exit 2。
 */
export const PRECONDITION_FAILURE = 2;
