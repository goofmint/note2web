// T-05 のテスト用ダミースクリプト。
// 自分自身に SIGINT を送って終了する。runSubprocess のタイムアウトが原因ではない
// シグナル終了(`signal` 分類)を、外部から実プロセスへシグナルを送らずとも
// 決定的に再現するために使う。
process.kill(process.pid, 'SIGINT');

// SIGINT の配送・終了処理が完了するまで、念のため生存しておく。
setInterval(() => {}, 1000);
