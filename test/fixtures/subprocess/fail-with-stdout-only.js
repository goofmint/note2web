// issue #67 CodeRabbit フォローアップ用のダミースクリプト。
// stderr は空のまま、stdout に空行・空白のみの行を混ぜたうえで意味のある1行を書き出し、
// 非ゼロ終了する(firstNonEmptyLine が stdout 側にフォールバックしたとき、
// 空行/空白行を正しく読み飛ばして最初の意味のある行を拾うことの検証用)。
process.stdout.write('\n   \n  actual failure reason  \n');
// process.exit(1) だと pending の stdout 書き込みがフラッシュされる前に
// プロセスが終了してしまうことがあるため、exitCode を設定して自然終了させる。
process.exitCode = 1;
