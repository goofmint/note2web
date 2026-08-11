// T-05 のテスト用ダミースクリプト。
// 自分の子(runSubprocess から見た「孫」)を起動し、その孫だけが SIGTERM を無視する。
// 自分自身(runSubprocess から見た直接の子)は SIGTERM を受け取ると即座に終了する。
// これにより「直接の子は `close` するが、孫はプロセスグループへの SIGKILL 到達まで
// 生き残る」状況を決定的に再現できる。起動直後、自分自身と孫の PID を argv[2] の
// ファイルへ書き出す(改行区切りで1行目が自分、2行目が孫)。
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const pidFile = process.argv[2];

// 孫: SIGTERM を無視し続け、SIGKILL でしか終了しない。
const grandchild = spawn(
  process.execPath,
  ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
  { stdio: 'ignore' },
);

writeFileSync(pidFile, `${process.pid}\n${grandchild.pid}\n`);

// 自分(直接の子)は SIGTERM を受け取ったら素直に終了する。
// デフォルトの SIGTERM ハンドラのままなら、プロセスは即座に終了する。
setInterval(() => {}, 1000);
