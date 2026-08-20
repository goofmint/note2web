/**
 * 状態 JSON のパス・`target` 導出(design.md §7「`state_file`」、§8「`target`」)。
 *
 * `StateStore.load`(`src/state/store.ts`、T-07)自体はパス・`target` の決定方法を
 * 知らない(呼び出し側から渡される)。sync フロー(`src/sync.ts`、T-14)が実行の都度
 * 導出できるよう、その計算を独立したモジュールに切り出す。
 */

import { basename, dirname, extname, resolve } from 'node:path';
import type { Config } from '../config.js';

/**
 * 状態 JSON のパスを導出する(design.md §7)。
 * `state_file` 指定時はそれを設定ファイルのディレクトリからの相対パスとして解決し
 * (cron / launchd 実行時に作業ディレクトリが不定でも安定させるため)、未指定時は
 * 「設定ファイルと同じディレクトリの `<設定ファイル名(拡張子を除く)>.state.json`」
 * (design.md §4 未決事項表「設定・状態の配置場所」)とする。
 */
export function resolveStatePath(configPath: string, config: Config): string {
  const configDir = dirname(configPath);
  if (config.state_file !== undefined) {
    return resolve(configDir, config.state_file);
  }
  const base = basename(configPath, extname(configPath));
  return resolve(configDir, `${base}.state.json`);
}

/**
 * dev.to の `target`(design.md §8「devto: API ホスト」)。dev.to は設定に配信先を
 * 識別するフィールドを持たない(Forem API v1 を直接叩く固定のホスト、design.md §5.7
 * DevtoPublisher)ため、サービス共通の固定値とする。
 */
export const DEVTO_TARGET = 'dev.to';

/**
 * Qiita の `target`(design.md §8「qiita: API ホスト」、issue #82)。qiita-cli サブプロセス
 * 廃止により `qiita.workspace` 設定自体が無くなった(Qiita API v2 を直接叩く固定ホスト、
 * `src/publishers/qiita.ts`)ため、`DEVTO_TARGET` と同じ理由でサービス共通の固定値とする。
 */
export const QIITA_TARGET = 'qiita.com';

/** `value` が `undefined` であれば内部不変条件違反として例外を投げる(スキーマが保証するはずの値)。 */
function requireConfigBlock<T>(value: T | undefined, blockKey: string, service: string): T {
  if (value === undefined) {
    throw new Error(
      `internal error: config.${blockKey} is required for service "${service}" but was undefined ` +
        '(config schema (src/config.ts) should already enforce this via superRefine)',
    );
  }
  return value;
}

/**
 * 状態 JSON の `target`(design.md §8)を現在の設定から導出する。
 * 「配信先の識別子。Git モード: repo_path、note: workspace、はてな: blog_id、
 * qiita/devto: API ホスト」(design.md §8。issue #82 で qiita は workspace → API ホスト
 * 固定値へ変更)。
 */
export function deriveTarget(config: Config): string {
  switch (config.service) {
    case 'zenn':
    case 'hugo':
    case 'jekyll':
      return requireConfigBlock(config.git, 'git', config.service).repo_path;
    case 'qiita':
      requireConfigBlock(config.qiita, 'qiita', config.service);
      return QIITA_TARGET;
    case 'note':
      return requireConfigBlock(config.note, 'note', config.service).workspace;
    case 'hatena':
      return requireConfigBlock(config.hatena, 'hatena', config.service).blog_id;
    case 'devto':
      return DEVTO_TARGET;
  }
}
