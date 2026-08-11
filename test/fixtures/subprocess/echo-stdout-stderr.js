// T-05 のテスト用ダミースクリプト。
// stdout / stderr の両方へ既知の文字列を書き出してから正常終了する
// (stdout / stderr の別々のキャプチャを検証するために使う)。
process.stdout.write('hello from stdout\n');
process.stderr.write('hello from stderr\n');
process.exit(0);
