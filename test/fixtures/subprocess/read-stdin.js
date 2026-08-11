// T-05 のテスト用ダミースクリプト。
// stdin を EOF まで読み切り、読み取ったバイト数を `stdin-eof:<len>` として stdout へ
// 書き出してから正常終了する。runSubprocess が stdio[0] を 'ignore' に固定していれば、
// 子プロセス側の stdin は即座に EOF となり、このスクリプトはハングせず len=0 で終わる。
let len = 0;
process.stdin.on('data', (chunk) => {
  len += chunk.length;
});
process.stdin.on('end', () => {
  process.stdout.write(`stdin-eof:${len}\n`);
  process.exit(0);
});
process.stdin.resume();
