// T-05 / issue #67 のテスト用ダミースクリプト。
// stdout / stderr の両方へ既知の文字列を書き出してから非ゼロ終了する
// (失敗時の warn ログに含める出力サマリの検証用)。
process.stdout.write('hello from stdout\n');
process.stderr.write('hello from stderr\n');
process.exit(1);
