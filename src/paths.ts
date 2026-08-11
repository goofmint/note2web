/**
 * 汎用パスユーティリティ。
 *
 * `expandHome` はもともと `src/exporter/apple-notes.ts` に定義されていたが、
 * `src/dependencies.ts`(T-14)・`src/doctor.ts`(T-15)からも Exporter とは無関係に
 * 参照されるようになったため、Exporter 固有のモジュールから切り離して汎用モジュールへ
 * 移した(CodeRabbit review, PR #48 nitpick)。挙動は変更していない。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 先頭の `~` を `os.homedir()` へ展開する(`~/foo` および `~` 単体のみ。`~user` 形式は非対応)。
 */
export function expandHome(inputPath: string): string {
  if (inputPath === '~') {
    return homedir();
  }
  if (inputPath.startsWith('~/')) {
    return join(homedir(), inputPath.slice(2));
  }
  return inputPath;
}
