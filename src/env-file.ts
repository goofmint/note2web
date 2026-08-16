/**
 * env ファイル(`~/.config/note2web/env` 等)のパーサ・ローダー(issue #69)。
 *
 * `note2web init` が生成するラッパースクリプト(`~/bin/note2web-sync.sh`、`src/init.ts`
 * `buildWrapperScript`)は `set -a; . "$HOME/.config/note2web/env"; set +a` で env
 * ファイルをシェルとして評価してから `note2web sync` を起動するため、launchd/cron 経由で
 * `sync` を実行した場合は env ファイルの値が既に `process.env` に載っている。しかし
 * `note2web doctor` / `note2web sync` を対話シェルから直接実行した場合、CLI 自身は
 * このファイルを一切読んでいなかった——結果、env ファイルにしか値を書いていない利用者に対し、
 * `doctor` が `environment variable "R2_ACCESS_KEY_ID" is not set` のような偽陽性を報告して
 * いた(issue #69 の問題1: doctor の検証環境が sync-under-launchd の実行環境と一致しない)。
 * `src/cli.ts` は本モジュールを使って doctor / sync 冒頭で同じ既定パスの env ファイルを
 * 読み込み、まだ `process.env` に無い名前だけを補うことで両者の検証環境を揃える。
 *
 * **ラッパースクリプトの `set -a; . env; set +a` との違い**: 本モジュールはシェルとして
 * 評価しない。`$VAR` や `` `cmd` `` のようなシェル構文(コマンド置換・変数展開・
 * エスケープシーケンス解釈)は一切行わず、`=` の右辺をリテラルな文字列としてそのまま扱う
 * (前後の空白の除去、および一致するクォート1組の除去のみ行う)。したがって、シェル的な
 * 値の組み立てに依存する env ファイルは、ラッパースクリプト実行時と本モジュールの読み取り時
 * とで解釈結果が異なり得る——単純な `NAME=value` 形式のみを対象とする、という割り切った
 * 実装であることに注意。
 *
 * 値を一切ログに出力しない(秘匿情報を扱うため。呼び出し側もこれに倣うこと)。
 */

import { readFile as fsReadFile } from 'node:fs/promises';

/** 変数名として許可するパターン(`src/init.ts` の `ensureEnvFile` 追記ロジックと同じ)。 */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 1行分の `NAME=value` を解析する正規表現。先頭の空白、および任意の `export ` プレフィックス
 * (シェルの `export NAME=value` 形式)を許容する。
 */
const LINE_PATTERN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * 値の前後の空白を取り除いたうえで、一致するシングル/ダブルクォート1組だけを剥がす。
 * シェルの引用処理そのものではないため、クォート内のエスケープシーケンスは一切解釈しない
 * (例: `"a\"b"` のような入力は非対応。単純な `"value"` / `'value'` の1組のみを想定)。
 */
function unquote(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * env ファイルの内容を `NAME=value` の対応表としてパースする。
 *
 * - 空行、および行頭(前置空白を除く)が `#` の行(コメント)は無視する
 * - 先頭の空白・任意の `export ` プレフィックスは許容する(`src/init.ts` の追記ロジックが
 *   受理する形式と揃える)
 * - 値の前後の空白は除去し、値全体を一致するシングル/ダブルクォート1組で囲んでいれば
 *   それを剥がす(クォート内のエスケープシーケンスは解釈しない。冒頭の JSDoc 参照)
 * - `$VAR` や `` `cmd` `` のようなシェル構文は展開せず、リテラルな文字列としてそのまま
 *   値に残す
 * - `NAME=value` の形を取らない行(`=` を含まない等)は黙って無視する——env ファイルは
 *   利用者が手で編集するものであり、書式ゆれ1つで CLI 全体を落とすのは過剰なため
 * - 同じ変数名が複数回現れた場合は最後に現れた行の値を採用する(シェルの
 *   `set -a; . file; set +a` と同じ「後勝ち」の挙動)
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const match = LINE_PATTERN.exec(line);
    if (match === null) {
      continue;
    }
    const [, name, rawValue] = match;
    if (name === undefined || rawValue === undefined || !NAME_PATTERN.test(name)) {
      continue;
    }
    result[name] = unquote(rawValue);
  }
  return result;
}

/** `loadEnvFile` の挙動を差し替えるためのオプション(テスト用の注入点)。 */
export interface LoadEnvFileOptions {
  /** ファイル読み込みの注入点(UTF-8)。既定は `fs/promises` の `readFile`。 */
  readFileFn?: (path: string) => Promise<string>;
}

async function defaultReadFile(path: string): Promise<string> {
  return fsReadFile(path, 'utf8');
}

/** `error` が Node.js の `ENOENT`(ファイル不存在)エラーかどうかを判定する。 */
function isEnoentError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * env ファイルを読み込み `parseEnvFile` でパースする。
 *
 * ファイルが存在しない場合(`ENOENT`)は空の結果を返す——env ファイルを使わず、シェルの
 * `export` だけで環境変数を渡している利用者にとってこれは正常な状態であり、エラーにしては
 * ならない(「デフォルトの env ファイルパスが存在しない」は `src/cli.ts` 側で許容する)。
 * それ以外の読み取りエラー(権限不足の `EACCES` 等)はそのまま呼び出し側へ伝播させる——
 * `--env-file` で明示指定されたファイルが読めない、という異常な状況を「単に無かった」もの
 * として握りつぶさないため。存在確認そのもの(「明示指定されたのに存在しない」を設定エラー
 * として扱うかどうか)は呼び出し側の方針に委ねる(本関数は ENOENT を常に空結果にする)。
 *
 * 値を一切ログに出力しない。
 */
export async function loadEnvFile(
  path: string,
  options: LoadEnvFileOptions = {},
): Promise<Record<string, string>> {
  const { readFileFn = defaultReadFile } = options;
  let content: string;
  try {
    content = await readFileFn(path);
  } catch (error) {
    if (isEnoentError(error)) {
      return {};
    }
    throw error;
  }
  return parseEnvFile(content);
}
