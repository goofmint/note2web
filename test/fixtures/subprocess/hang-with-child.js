// T-05 のテスト用ダミースクリプト。
// 自分の子(runSubprocess から見た「孫」)プロセスを起動したうえで、自身も無限に
// ハングし続ける。起動直後、自分自身と子の PID を argv[2] のファイルへ書き出す
// (改行区切りで1行目が自分、2行目が子)ので、テストは runSubprocess のタイムアウト後に
// 両方とも生存していないことを `process.kill(pid, 0)` で確認できる。
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const pidFile = process.argv[2];

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
  stdio: 'ignore',
});

writeFileSync(pidFile, `${process.pid}\n${child.pid}\n`);

setInterval(() => {}, 1000);
