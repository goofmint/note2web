# note2web

Apple Notes(macOS のメモアプリ)を Single Source of Truth とし、対応するブログ / 記事投稿サービスへ記事を配信する CLI ツールです。cron / launchd から定期実行し、「エクスポート → 変換 → 公開」を対話なしで完遂します。

配信先サービス:

- **Zenn**(Git リポジトリ出力)
- **Hugo**(Git リポジトリ出力)
- **Jekyll**(Git リポジトリ出力)
- **Qiita**(外部 CLI `@qiita/qiita-cli`)
- **dev.to**(Forem API v1 を直接呼び出し)
- **note.com**(外部 CLI [`noet`](https://github.com/kako-jun/noet)。※後述の重大な制約あり)
- **はてなブログ**(はてなブログ AtomPub)

1つの設定ファイル(YAML)が1つの配信先サービスに対応します。複数サービスへ配信する場合は、サービスごとに設定ファイルを用意し、cron / launchd にその数だけエントリを登録してください。配信は Apple Notes → サービスの片方向のみで、サービス側で編集してもApple Notes には反映されません。

詳細な設計・要件は [`requirements.md`](https://github.com/goofmint/note2web/blob/main/requirements.md) / [`design.md`](https://github.com/goofmint/note2web/blob/main/design.md) を参照してください。

## 目次

- [必要要件](#必要要件)
- [インストール・実行](#インストール実行)
- [終了コード](#終了コード)
- [設定ファイル](#設定ファイル)
- [サービス別セットアップ](#サービス別セットアップ)
- [cron / launchd での定期実行](#cron--launchd-での定期実行)
- [ログ](#ログ)
- [既知の制約・実機未確認事項](#既知の制約実機未確認事項)
- [開発](#開発)

## 必要要件

- **macOS**(Apple Notes のデータへローカルアクセスできる環境が前提です)
- **Node.js**: `^20.19.0 || ^22.13.0 || >=24`(`package.json` の `engines` を参照)
- **Ruby**(下記 `apple_cloud_notes_parser` の実行に必要)
- **[apple_cloud_notes_parser](https://github.com/threeplanetssoftware/apple_cloud_notes_parser)**(Apple Notes のエクスポートに使う外部 Ruby ツール。note2web には同梱されないため、別途 clone してセットアップします)

  ```sh
  git clone https://github.com/threeplanetssoftware/apple_cloud_notes_parser ~/tools/apple_cloud_notes_parser
  cd ~/tools/apple_cloud_notes_parser
  bundle install
  ```

  既定のインストール先は `~/tools/apple_cloud_notes_parser` です(設定 YAML の `exporter.parser_path` で変更可能)。

- **macOS のフルディスクアクセス権限**: Apple Notes のデータ(`~/Library/Group Containers/group.com.apple.notes`)を読み取るため、`note2web` を実行するプロセス(ターミナルアプリ、または cron / launchd から起動する場合はそのシェル/実行ファイル)に「フルディスクアクセス」を許可する必要があります。
  1. 「システム設定」→「プライバシーとセキュリティ」→「フルディスクアクセス」を開く
  2. 実行に使うターミナルアプリ(Terminal.app / iTerm2 等)、または `node` バイナリ / cron を許可リストに追加する
  3. 許可後、ターミナルアプリを再起動する

- **Zenn / Hugo / Jekyll(Git リポジトリ出力モード)を使う場合**: `git` コマンドと [`gh`](https://cli.github.com/)(GitHub CLI)、および `GH_TOKEN` 環境変数(`gh` の認証用)
- **Qiita を使う場合**: `@qiita/qiita-cli` は note2web の `dependencies` に固定バージョンで同梱されているため追加インストールは不要です。トークンは環境変数で渡します(後述)
- **dev.to / はてなブログを使う場合**: 追加の外部 CLI は不要です(API を直接呼び出します)
- **note.com を使う場合**: [`noet`](https://github.com/kako-jun/noet) バイナリに加えて、**同一マシン上で note.com にログイン済みの実 Chrome ブラウザ + noet 拡張機能が起動していること**が必須です(詳細は [note.com](#notecom) の節を参照)

依存の過不足は `note2web doctor --config <path>` で事前確認できます。

## インストール・実行

インストール不要で `npx` から直接実行できます。

```sh
npx note2web sync --config ~/.config/note2web/zenn.yaml
```

```sh
npx note2web doctor --config ~/.config/note2web/zenn.yaml
```

- `sync`: エクスポート → 変換 → 公開を実行するメインコマンドです
- `doctor`: 依存 CLI・環境変数・(Git モードでは)`gh` の認証状態と対象リポジトリへの権限を、実際の配信を行わずに事前チェックします。`sync` も実行冒頭で同じチェックを行い、欠けていれば何も配信せずに失敗します

`--config` は必須です。設定ファイルのパスは任意ですが、`~/.config/note2web/` 配下に置くことを推奨します。

## 終了コード

| 終了コード | 意味 |
|---|---|
| `0` | 全ノート成功(スキップ含む) |
| `1` | 1件以上のノートの変換・配信に失敗(状態は未更新のため次回再試行される)、または `apple_cloud_notes_parser` の実行自体が失敗 |
| `2` | 実行前提の不成立(設定不正・環境変数未設定・依存 CLI 欠如・多重起動検出など)。この場合は一切配信を行わない |

## 設定ファイル

1つの YAML ファイルが1つの配信先サービスに対応します。**API キー等の秘匿情報を YAML に直書きすることはできません**——すべて `*_env` というキー名で「値を読む環境変数の名前」を指定する形式のみが許可されます(値そのものを書くとスキーマ検証で拒否されます)。

### 状態ファイル

配信済みノートのコンテンツハッシュや記事 ID を保持する JSON ファイルです。設定ファイルごとに独立します。

- 既定の配置場所: 設定ファイルと同じディレクトリの `<設定ファイル名(拡張子を除く)>.state.json`
- `state_file` キーで変更可能(設定ファイルからの相対パス、または絶対パス)
- 状態ファイルは `service` と配信先の識別子(`target`)を記録しており、別サービス・別配信先の状態ファイルを誤って使い回すと `sync` は exit 2 で拒否します

### 共通項目

```yaml
service: zenn                  # zenn | hugo | jekyll | qiita | devto | note | hatena
timezone: Asia/Tokyo           # frontmatter の日時に使う固定オフセット(既定 Asia/Tokyo。冪等性のため実行環境の TZ には依存しない)
source:
  folders: [tech, idea]        # 配信対象とする Apple Notes のフォルダ名(このフォルダ以外は一切処理しない)
exporter:
  parser_path: ~/tools/apple_cloud_notes_parser        # apple_cloud_notes_parser の clone 先(省略可、既定値どおりなら省略可)
  notes_container: ~/Library/Group Containers/group.com.apple.notes  # Apple Notes のコンテナ(省略可、既定値どおりなら省略可)
state_file: ./zenn.state.json  # 省略時: <設定ファイル名>.state.json
log:
  file: ~/Library/Logs/note2web/zenn.log   # 省略可。標準出力へは常に JSON Lines を出す
assets:
  provider: r2                 # r2 | s3
  bucket: blog-assets
  endpoint: https://<account>.r2.cloudflarestorage.com   # r2 のとき必須(s3 では省略可)
  region: auto
  prefix: notes/
  public_base_url: https://assets.example.com/notes/
  access_key_id_env: R2_ACCESS_KEY_ID       # 環境変数名を書く。値は書かない
  secret_access_key_env: R2_SECRET_ACCESS_KEY
```

添付画像・手書き描画は R2 / S3(いずれも S3 互換 API)へアップロードし、本文中の参照を `public_base_url` + キーの URL に差し替えます。

### Zenn / Hugo / Jekyll(Git リポジトリ出力モード)

```yaml
git:
  repo_path: ~/src/zenn-content   # 出力先 Git リポジトリのローカルパス(あらかじめ clone・gh 認証済みであること)
  base_branch: main
  output_dir: articles            # hugo/jekyll で使用。zenn は articles 固定
  auto_merge: true                # true なら PR 作成後に自動マージまで行う
```

完全な例は [`test/fixtures/configs/zenn.yaml`](./test/fixtures/configs/zenn.yaml) / [`hugo.yaml`](./test/fixtures/configs/hugo.yaml) / [`jekyll.yaml`](./test/fixtures/configs/jekyll.yaml) を参照してください。

### Qiita

```yaml
qiita:
  workspace: ~/src/qiita-content   # qiita-cli のワークスペース(public/<uuid>.md を書き出す)
  token_env: QIITA_TOKEN           # QIITA_TOKEN を読む環境変数名(サンプルは同名だが変更可)
```

### dev.to

```yaml
devto:
  api_key_env: DEVTO_API_KEY
  canonical_base_url: https://example.com/articles/   # 省略可。指定時のみ canonical_url を付与
```

### note.com

```yaml
note:
  workspace: ~/src/note-content   # <uuid>.md を書き出す作業ディレクトリ(noet コマンドの cwd)
```

note.com は現行の `noet` の実装上、環境変数や設定ファイルによる認証を受け付けません(後述)。`note:` ブロックに認証用のキーは存在しません。

### はてなブログ

```yaml
hatena:
  hatena_id: example
  blog_id: example.hatenablog.com
  api_key_env: HATENA_API_KEY
```

## サービス別セットアップ

### Zenn / Hugo / Jekyll(Git 共通)

- 出力先 Git リポジトリをあらかじめ clone してあること。認証は環境変数 `GH_TOKEN` で行います(`gh` は `GH_TOKEN` が設定されていれば対話ログイン不要。`sync` / `doctor` の冒頭で `gh auth status` と対象リポジトリへの権限が確認されます)
- 認証は `GH_TOKEN` 環境変数(`gh` の認証。対話ログインには依存しません)
- 実行のたびに `base_branch` から作業ブランチ `note2web/sync-<UTC時刻>` を作成し、変更のあったノートをコミット、`gh pr create` で PR を作成します
- **差分が無ければブランチを破棄し、空コミット・空 PR は作りません**
- **`auto_merge: true` のときのみ** PR のマージ(`gh pr merge --merge --delete-branch`)まで自動実行します。ブランチ保護等でマージできない場合は PR を残したまま実行を失敗として報告します
- **状態確定のタイミング(重要)**: そのノートを「配信済み」として状態ファイルに記録するのは **PR 作成の成功時点** であり、マージの成功・失敗は問いません。したがって:
  - `auto_merge: false`(既定)の運用で、作成された PR を **マージせずにクローズした場合、その内容は再配信されません**(次にそのノートの本文が変更され、コンテンツハッシュが変わるまで)。レビューで却下した記事を再送したい場合は、ノート側を何かしら変更してから再実行してください
  - push や PR 作成そのものに失敗した場合は状態を確定せず、次回実行で自動的に再試行されます

サービス別の差分:

| サービス | 出力パス | frontmatter | 備考 |
|---|---|---|---|
| Zenn | `articles/<uuid を小文字化した slug>.md` | `title` / `emoji` / `type` / `topics` / `published: true` | `type` はフォルダ名。`tech` / `idea` 以外のフォルダのノートは設定不正としてそのノートのみ失敗扱いになります。絵文字が本文1行目に無いノートには既定値 `📝` を使います(Zenn は emoji 必須のため) |
| Hugo | `<output_dir>/<uuid>.md` | `title` / `date` / `lastmod` / `categories: [フォルダ名]` / `tags` | `output_dir` は任意(例 `content/posts`) |
| Jekyll | `_posts/YYYY-MM-DD-<uuid>.md` | `title` / `date` / `categories` / `tags` | 日付は作成日。初回配信時のファイル名を状態ファイルに記録し、以後は作成日が変わっても記録済みのファイル名を使い続けます(URL の安定性を優先) |

### Qiita

- 認証は `qiita.token_env` が指す環境変数(サンプルは `QIITA_TOKEN`)から読み、`@qiita/qiita-cli` の子プロセスへは **常に `QIITA_TOKEN` という固定名**で渡します(qiita-cli 自身がこの名前でしか環境変数を見ないため)
- `@qiita/qiita-cli` は note2web の `dependencies` に固定バージョンで同梱されており、実行は `npx --no-install qiita` に限定しています(素の `npx qiita` は npm レジストリの無関係な別パッケージ `qiita` を取得してしまい、トークンが漏れる恐れがあるため使用しません)。パッケージが未導入(≒ `npm install` していない状態で `dist/cli.js` だけをコピーした等)の場合は `doctor` / `sync` の依存チェックで exit 2 になります
- frontmatter には `title` / `tags` / `private: false` / `id`(初回は `null`。qiita-cli が投稿後に書き戻す ID を状態ファイルへ保存)/ `slide: false` を出力します
- **タグ制約**: Qiita は1〜5個のタグが必須です。半角スペースを含むタグは分割送信による 403 を避けるため除外し、警告ログを出します。除外後に6個以上残っていれば先頭5個に切り詰めます(警告ログ)。除外後に0個になった場合、そのノートは**失敗扱い**になります(タグを付けて再実行してください)

### dev.to

- Forem API v1(`POST /api/articles` / `PUT /api/articles/{id}`)を直接呼び出します(devto-cli は使いません)
- 認証は `devto.api_key_env` が指す環境変数(サンプルは `DEVTO_API_KEY`)から読み、リクエストヘッダ `api-key` に渡します
- タグは**最大4個**です。超過分は先頭4個に切り詰め、警告ログを出します
- `canonical_base_url` を設定した場合のみ `canonical_url` をリクエストに含めます(省略可)

### note.com

**note.com への配信には他サービスと異なる重大な構造的制約があります。**

- `noet` は note.com 公式・非公式問わず API を直接呼び出しません。現行の `noet`(内部でブラウザ拡張機能と WebSocket 通信する方式に移行済み)は、**同一マシン上でログイン済みの実 Chrome ブラウザと `noet` 拡張機能が起動していること**を前提に、ブラウザ拡張機能側が note.com のページを裏タブで開いて DOM 操作(フォーム入力・投稿ボタンのクリック等)を行うことで記事を作成・更新します
- 環境変数・トークン・cookie を渡して認証する経路は存在しません。したがって **cron / launchd からの完全無人実行では、この前提(ログイン済みブラウザの常時起動)が満たせない場合 `noet` の呼び出し自体が失敗します**。これは note2web の不具合ではなく、`noet` の現行アーキテクチャに起因する構造的な制約です。実行自体は自動で続行され、満たせなかったノートは他ノートと同様に個別に `failed` として扱われ、状態は更新されません(次回実行で再試行されます)。note.com 向けに `sync` を完全無人で回すことは、この前提を満たす環境(ログイン済みブラウザを常駐させる等)を別途用意しない限りできません
- **画像を含むノートは note.com 向けでは配信されません**(明示的に失敗扱いになります)。note.com の編集画面(ProseMirror)は Markdown の画像記法 `![]()` を解釈せず、外部 URL(R2 / S3 の公開 URL)をそのまま送るとリテラルなテキストとして表示されてしまうためです。画像入りのノートを note.com へ配信する手段は現時点ではありません
- 記事 ID の特定には `noet list`(`/notes` ページの DOM スクレイピング)によるタイトル一致照合を使いますが、この一覧取得はページネーションに対応していません。一覧が空でないのにタイトル一致が0件、または複数一致した場合は確認不能としてそのノートを失敗扱いにします

### はてなブログ

- はてなブログ AtomPub(`POST <blog>/atom/entry` / `PUT <blog>/atom/entry/<entry_id>`)を直接呼び出します
- 認証は Basic 認証(はてな ID + API キー)です。`hatena.hatena_id` と `hatena.api_key_env` が指す環境変数(サンプルは `HATENA_API_KEY`)を使います。APIキーはマイページの「詳細設定」から発行してください
- **前提条件**: 投稿先ブログの編集モードが **Markdown** であることが必須です(見たままモード等では意図通りに入稿されません)。`content type="text/x-markdown"` で Markdown 本文をそのまま送信する実装のため、編集モードが異なると本文が期待通りに解釈されません
- フォルダ名・ハッシュタグはいずれも `category` 要素としてはてなブログ側へ送信されます
- **実機未確認**: この Markdown 入稿の wire contract は HTTP モックによる検証は完了していますが、実際の `blog.hatena.ne.jp` への入稿確認はまだ行われていません。初回利用時は少数のノートで動作を確認することを推奨します

## cron / launchd での定期実行

1つの設定ファイル = 1つの配信先サービスなので、複数サービスへ配信する場合は設定ファイルの数だけエントリを登録してください。

### 準備: ログディレクトリと実行スクリプト

まずログの出力先ディレクトリを作成します(cron / launchd 共通):

```bash
mkdir -p ~/Library/Logs/note2web
```

秘匿情報は crontab や plist に直書きせず、**権限を絞った環境変数ファイル + ラッパースクリプト**経由で渡します。`note2web` は npm には公開されていないため、`npx` 経由では起動できません(`npx --yes note2web` はレジストリの 404 で必ず失敗します)。代わりに、実行中インストールの `dist/cli.js` の絶対パスを `node` で直接起動します。`node` のパスは環境により異なり(Homebrew の Node では `/opt/homebrew/bin/node`、nvm では `~/.nvm/versions/node/<ver>/bin/node` 等)、cron / launchd の `PATH` は最小構成のため、ラッパースクリプト内で PATH を補ってから解決します。`note2web init` を実行すると、この CLI パスは自動的に解決されてラッパースクリプトへ埋め込まれます(以下は手動で作成する場合の例です)。

まず配置先ディレクトリを作成します:

```bash
mkdir -p ~/.config/note2web ~/bin
```

次の内容を `~/.config/note2web/env` として保存します:

```bash
# ~/.config/note2web/env(chmod 600 で保護)
GH_TOKEN=xxxx
R2_ACCESS_KEY_ID=xxxx
R2_SECRET_ACCESS_KEY=xxxx
# node の絶対パスを明示したい場合は指定(未指定なら下記ラッパーが PATH から解決)
# NOTE2WEB_NODE=/opt/homebrew/bin/node
# note2web の dist/cli.js の絶対パスを明示したい場合は指定
# (note2web init が自動的に埋め込むため、通常は不要)
# NOTE2WEB_CLI=/Users/you/src/note2web/dist/cli.js
```

次の内容を `~/bin/note2web-sync.sh` として保存します:

```bash
#!/bin/sh
# ~/bin/note2web-sync.sh(chmod 700 で保護)
# 使い方: note2web-sync.sh <config.yaml>
set -eu
set -a
. "$HOME/.config/note2web/env"
set +a
# cron / launchd の PATH は最小構成のため、一般的な Node.js の bin ディレクトリを補う
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE="${NOTE2WEB_NODE:-$(command -v node || true)}"
# インストール先の dist/cli.js を絶対パスで指定する(note2web init が自動的に埋め込む値の例)
CLI="${NOTE2WEB_CLI:-}"
if [ -z "$CLI" ]; then
  CLI="/Users/you/src/note2web/dist/cli.js"
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "note2web-sync.sh: node not found (set NOTE2WEB_NODE in ~/.config/note2web/env)" >&2
  exit 2
fi
if [ -z "$CLI" ] || [ ! -f "$CLI" ]; then
  echo "note2web-sync.sh: note2web CLI not found (set NOTE2WEB_CLI in ~/.config/note2web/env)" >&2
  exit 2
fi
exec "$NODE" "$CLI" sync --config "$1"
```

保存後、権限を絞ります:

```bash
chmod 600 ~/.config/note2web/env
chmod 700 ~/bin/note2web-sync.sh
```

登録前に一度、手元のシェルから `~/bin/note2web-sync.sh <config.yaml>` を実行し、cron / launchd と同じ経路で動作することを確認してください。

### cron の例

```cron
# 30分おきに Zenn へ配信
*/30 * * * * /Users/you/bin/note2web-sync.sh /Users/you/.config/note2web/zenn.yaml >> /Users/you/Library/Logs/note2web/zenn-cron.log 2>&1

# 1時間おきに Qiita へ配信(env ファイル・設定を分ける場合はラッパーを複製)
0 * * * * /Users/you/bin/note2web-sync.sh /Users/you/.config/note2web/qiita.yaml >> /Users/you/Library/Logs/note2web/qiita-cron.log 2>&1
```

crontab・launchd の plist はいずれも平文で読まれ得るため、トークン類は上記の `chmod 600` した env ファイルにのみ置いてください(より堅牢にするなら macOS キーチェーン + `security find-generic-password` での取得も選択肢です)。cron から起動するシェル/`node` バイナリにも「フルディスクアクセス」権限が必要な点に注意してください。

### launchd の例(`~/Library/LaunchAgents/com.note2web.zenn.plist`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.note2web.zenn</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/bin/note2web-sync.sh</string>
    <string>/Users/you/.config/note2web/zenn.yaml</string>
  </array>
  <key>StartInterval</key>
  <integer>1800</integer>
  <key>StandardOutPath</key>
  <string>/Users/you/Library/Logs/note2web/zenn.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/Library/Logs/note2web/zenn.err.log</string>
</dict>
</plist>
```

サービスごとに `Label` / 設定ファイル / ログパスを変えた plist を用意し、`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.note2web.<service>.plist` で登録します(LaunchAgent はユーザー単位のため **`sudo` は付けません**。`sudo` を付けると LaunchDaemons 扱いになり `Load failed: 5: Input/output error` で失敗します)。すぐ1回実行して動作確認するには `launchctl kickstart -k gui/$(id -u)/com.note2web.<service>`、解除するには `launchctl bootout gui/$(id -u)/com.note2web.<service>` を使います。トークンは plist の `EnvironmentVariables` ではなく、上記ラッパースクリプトが読む env ファイルに置きます。note.com 向けの構成では、上記に加えてログイン済みブラウザと `noet` 拡張機能が常時起動している必要がある点に注意してください(無人の launchd だけでは前提を満たせません)。

## ログ

標準出力へ常に JSON Lines(1行1イベント)を出力します。`log.file` を設定するとファイルにも追記されます。

```json
{"ts":"2026-08-11T09:00:00+09:00","level":"info","event":"note_published","service":"zenn","noteUuid":"5c1c…","title":"…","result":"updated","url":"…"}
```

主なイベント:

| event | 意味 |
|---|---|
| `run_start` / `run_end` | 実行の開始 / 終了(`run_end` に成功・スキップ・失敗の件数サマリ) |
| `export_done` | エクスポート完了(ノート件数) |
| `note_published` | 配信成功(`result`: `created` / `updated`) |
| `note_skipped` | コンテンツハッシュ一致により配信不要(スキップ) |
| `note_failed` | 配信失敗(`error` にメッセージ) |
| `asset_uploaded` | アセットアップロード |
| `warn` 系 | タグの切り詰め、表現できない要素のテキスト化等の警告 |

## 既知の制約・実機未確認事項

本プロジェクトの開発環境には macOS 実機・GUI ブラウザ・各サービスの実アカウントが無いため、以下は**ソースコード読解およびモック/ローカル実行による検証のみ**で、実機での最終確認はまだ行われていません。利用開始時は小規模な検証運用を推奨します。

- **`apple_cloud_notes_parser` のエンドツーエンド実行**: 実際の macOS 上の `NoteStore.sqlite` に対するパーサの実行自体は未実施です(パーサ同梱のテスト用データ・ソースコード読解による確認のみ)
- **note.com への実際の投稿**: `noet` を介した note.com への実際の記事作成・更新・画像アップロードは未確認です(§13-4/§13-6 参照)。また前述のとおり、認証はログイン済みの実ブラウザに依存するため、cron 等の完全無人実行では認証前提そのものが構造的に満たせない場合があります
- **はてなブログへの実際の入稿**: `text/x-markdown` での入稿という wire contract の実装・HTTP モックでの検証は完了していますが、実際の `blog.hatena.ne.jp` への入稿確認は未実施です。編集モードが Markdown であることが前提条件です
- **Qiita の実トークンでの認証・公開**: `QIITA_TOKEN` 環境変数だけで無人実行できることはパッケージ実装の読解・ローカル実行で確認済みですが、実トークンでの実際の投稿成功は未確認です
- **Apple Notes の UUID の安定性**: アカウント間の移動や DB 復元をまたいで UUID が安定するかは保証されません。変わった場合、旧記事はサービス側に残り、新 UUID で新規記事として配信されます
- **孤児記事の扱い**: 配信後にノートが削除・移動されても、サービス側の記事はそのまま残ります(孤児エントリの検出・削除は行いません。設計上の非対応)

これらの詳細な調査過程・根拠は [`design.md`](https://github.com/goofmint/note2web/blob/main/design.md) の §12(テスト方針)・§13(実装時に確認が必要な残課題)を参照してください。

## 開発

このリポジトリの設計方針・データ設計・処理フローは [`design.md`](https://github.com/goofmint/note2web/blob/main/design.md)、機能要件・非機能要件は [`requirements.md`](https://github.com/goofmint/note2web/blob/main/requirements.md) にまとめられています。実装に変更を加える場合は、まずこれらを参照してください。

```sh
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

## ライセンス

[MIT](./LICENSE)
