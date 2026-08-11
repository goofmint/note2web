// T-05 のテスト用ダミースクリプト。
// `runSubprocess` の `env` オプションが `process.env` とマージされ(`env` の値が優先)、
// 呼び出し元プロセスの環境(例: PATH)を失っていないことを検証するために使う。
// argv[2] の値を X= として、PATH が空でないかを PATH_PRESENT= として出力する。
process.stdout.write(`X=${process.env.X ?? ''}\n`);
process.stdout.write(`PATH_PRESENT=${(process.env.PATH ?? '').length > 0 ? '1' : '0'}\n`);
