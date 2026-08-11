// T-05 のテスト用ダミースクリプト。
// argv[2] で指定された非ゼロ終了コードで即座に終了する(`exit_code` 分類の検証用)。
const code = Number(process.argv[2] ?? '1');
process.exit(code);
