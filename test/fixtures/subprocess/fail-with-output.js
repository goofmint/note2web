// T-05 / issue #67 のテスト用ダミースクリプト。
// stdout / stderr の両方へ既知の文字列を書き出してから非ゼロ終了する
// (失敗時の warn ログに含める出力サマリの検証用)。
process.stdout.write('hello from stdout\n');
process.stderr.write('hello from stderr\n');
// process.exit(1) だと pending の stdout/stderr 書き込みがフラッシュされる前に
// プロセスが終了してしまうことがあるため、exitCode を設定して自然終了させる。
process.exitCode = 1;
