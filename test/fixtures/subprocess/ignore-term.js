// T-05 のテスト用ダミースクリプト。
// SIGTERM を無視し続け(`trap '' TERM` 相当)、SIGKILL でしか終了しない。
// runSubprocess のタイムアウト → SIGTERM → grace 経過 → SIGKILL という
// エスカレーションを検証するために使う。
process.on('SIGTERM', () => {
  // 無視する。
});

setInterval(() => {}, 1000);
