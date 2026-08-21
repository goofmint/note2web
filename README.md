# note2web

Apple Notes(macOS のメモアプリ)を Single Source of Truth とし、対応するブログ / 記事投稿サービスへ記事を配信する CLI ツールです。cron / launchd から定期実行し、「エクスポート → 変換 → 公開」を対話なしで完遂します。

配信先サービス:

- **Zenn**(Git リポジトリ出力)
- **Hugo**(Git リポジトリ出力)
- **Jekyll**(Git リポジトリ出力)
- **Qiita**(Qiita API v2 を直接呼び出し)
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
- [トラブルシューティング](#トラブルシューティング)
- [ログ](#ログ)
- [既知の制約・実機未確認事項](#既知の制約実機未確認事項)
- [開発](#開発)

## 必要要件

- **macOS**(Apple Notes のデータへローカルアクセスできる環境が前提です)
- **Node.js**: `^20.19.0 || ^22.13.0 || >=24`(`package.json` の `engines` を参照)
- **Ruby**: 3.0 以上(下記 `apple_cloud_notes_parser` の実行に必要)
- **[apple_cloud_notes_parser](https://github.com/threeplanetssoftware/apple_cloud_notes_parser)**(Apple Notes のエクスポート処理が内部で読み込む外部 Ruby ライブラリ。note2web にはソース自体は同梱されないため、別途 clone してセットアップします。**セットアップ方法自体は変わっていません** — 引き続き clone して `bundle install` するだけです)

  ```sh
  git clone https://github.com/threeplanetssoftware/apple_cloud_notes_parser ~/tools/apple_cloud_notes_parser
  cd ~/tools/apple_cloud_notes_parser
  bundle install
  ```

  既定のインストール先は `~/tools/apple_cloud_notes_parser` です(設定 YAML の `exporter.parser_path` で変更可能)。**note2web は upstream の `notes_cloud_ripper.rb` を直接実行しません**——代わりに note2web に同梱される `ruby/note2web_export.rb` を実行し、そこから upstream の `lib/`(=上記 clone の `lib/` ディレクトリ)だけを読み込みます(issue #72)。これにより、設定 `source.folders` で指定した**フォルダのみが JSON 生成・最終出力の対象として採用され**ます。upstream 内部では対象外のフォルダ・ノートも読み取り/一時的な処理の対象になることがありますが(upstream にはフォルダ単位の読み取りフィルタが無いため)、対象外のノートが原因で実行全体が失敗したり、出力に混入したりすることはもうありません(issue #72)。

- **macOS のフルディスクアクセス権限**: Apple Notes のデータ(`~/Library/Group Containers/group.com.apple.notes`)を読み取るため、`note2web` を実行するプロセスに「フルディスクアクセス」を許可する必要があります。**対話シェルから実行する場合はターミナルアプリ(Terminal.app / iTerm2 等)**に、**launchd / cron から無人実行する場合は `node` 実行ファイル自身**に許可してください(詳細・理由は [cron / launchd での定期実行](#cron--launchd-での定期実行)節を参照)。
  1. 「システム設定」→「プライバシーとセキュリティ」→「フルディスクアクセス」を開く
  2. 実行に使うターミナルアプリ、または(launchd 経由の場合)`node` バイナリを許可リストに追加する(`node -e 'console.log(process.execPath)'` で自分の環境の絶対パスを確認できます。Cmd+Shift+G でパス入力してジャンプすると探しやすくなります)
  3. 許可後、ターミナルアプリ(または launchd ジョブ)を再起動する

- **Zenn / Hugo / Jekyll(Git リポジトリ出力モード)を使う場合**: `git` コマンドと [`gh`](https://cli.github.com/)(GitHub CLI)、および `GH_TOKEN` 環境変数(`gh` の認証用)
- **Qiita / dev.to / はてなブログを使う場合**: 追加の外部 CLI は不要です(API を直接呼び出します)。トークンは環境変数で渡します(後述)
- **note.com を使う場合**: [`noet`](https://github.com/kako-jun/noet) バイナリに加えて、**同一マシン上で note.com にログイン済みの実 Chrome ブラウザ + noet 拡張機能が起動していること**が必須です(詳細は [note.com](#notecom) の節を参照)

依存の過不足は `note2web doctor --config <path>` で事前確認できます。

## インストール・実行

`note2web` は現時点では npm に公開されていないため、`npx note2web ...` は使えません(npm レジストリの 404 で失敗します)。将来 npm へ公開されれば `npx note2web ...` がそのまま使えるようになる予定ですが、それまではリポジトリを clone してビルドしたうえで `node dist/cli.js` から起動します:

```sh
git clone https://github.com/goofmint/note2web ~/src/note2web
cd ~/src/note2web
npm install
npm run build
```

```sh
node dist/cli.js sync --config ~/.config/note2web/zenn.yaml
```

```sh
node dist/cli.js doctor --config ~/.config/note2web/zenn.yaml
```

- `sync`: エクスポート → 変換 → 公開を実行するメインコマンドです
- `doctor`: 依存 CLI・環境変数・(Git モードでは)`gh` の認証状態と対象リポジトリへの権限を、実際の配信を行わずに事前チェックします。`sync` も実行冒頭で同じチェックを行い、欠けていれば何も配信せずに失敗します

`--config` は必須です。設定ファイルのパスは任意ですが、`~/.config/note2web/` 配下に置くことを推奨します。

### env ファイルの自動読み込み(`doctor` / `sync` 共通)

`sync` / `doctor` は起動時、**設定ファイルと同じディレクトリの `env` ファイル**(既定パス、例: `~/.config/note2web/qiita.yaml` に対しては `~/.config/note2web/env`)を自動的に読み込み、まだシェルの環境変数として設定されていない名前だけを補います(issue #69)。[cron / launchd での定期実行](#cron--launchd-での定期実行)節が示すとおり、launchd の plist は `EnvironmentVariables` に `PATH` 以外の秘匿情報を一切含めない構成のため、この自動読み込みが launchd 経由の実行でトークン等を `process.env` に載せる唯一の経路になっています。同じ経路を対話シェルからの直接実行(`doctor --config <path>` 等)にも使うことで、「env ファイルには値を書いたのに `doctor` が未設定と報告する」というズレを無くしています。

- 既定のパスを変えたい場合は `--env-file <path>` で明示できます(このとき既定パスの `env` ファイルは無視されます)。明示指定したファイルが存在しない場合は設定エラー(exit 2)になりますが、既定パスが存在しない場合は単に無視され、通常どおり進みます(env ファイルを使わずシェルの `export` だけで環境変数を渡している利用者向け)
- **シェルの環境変数(既に `export` 済みの値)は常に env ファイルの値より優先されます**
- env ファイルのパースは単純な `NAME=value` 形式のみを対象とし、シェルとして評価しません(`$VAR` やコマンド置換は展開されず、リテラルな文字列として扱われます)。値は一切ログに出力しません
- このファイルに書くのはトークン等の秘匿情報だけではありません。`NOET_PATH`(後述の [note.com](#notecom) 参照)のように秘匿情報ではない設定も同じファイルに置きます——`note2web init` は対話で集めた `NOET_PATH` の値をそのままこのファイルへ書き込みます(トークン等の `*_env` が指す名前は値を知る術が無く常に空欄で書かれるのとは対照的です)

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
  folders: [tech, idea]        # 配信対象とする Apple Notes のフォルダ名(このフォルダ以外は生成・出力の対象にしない)
exporter:
  parser_path: ~/tools/apple_cloud_notes_parser        # apple_cloud_notes_parser の clone 先(省略可、既定値どおりなら省略可)
  notes_container: ~/Library/Group Containers/group.com.apple.notes  # Apple Notes のコンテナ(省略可、既定値どおりなら省略可)
  launcher: bundle               # bundle | ruby(省略可、既定 bundle。`bundle exec ruby notes_cloud_ripper.rb ...` として起動する。
                                  # 素の `ruby notes_cloud_ripper.rb ...` で起動したい場合のみ ruby を指定。後述「トラブルシューティング」参照)
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
  token_env: QIITA_TOKEN           # トークンを読む環境変数名(サンプルは同名だが変更可)
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

**`noet` バイナリの解決先(`NOET_PATH`、必須)**: `noet` は `cargo install` で導入されることが多く、その場合 `~/.cargo/bin/noet` に置かれます。launchd 経由の無人実行では、生成される plist の `PATH` が rbenv/asdf/rvm の shim と OS 標準ディレクトリのみを対象にしており `~/.cargo/bin` を含まないため、対話シェルでは通っている PATH でも launchd 環境だけ `noet` が見つからず `required command "noet" was not found on PATH` で失敗することがあります。note2web はこれを PATH 探索ではなく、環境変数 `NOET_PATH` に `noet` バイナリの絶対パスを設定することで解決します(`~` 展開に対応)。`note2web init` が対話で尋ね(既定 `~/.cargo/bin/noet`)、[env ファイル](#env-ファイルの自動読み込みdoctor--sync-共通)へ値入りで書き込みます。**`NOET_PATH` は必須です。未設定・空文字の場合 `doctor`/`sync` は exit 2 で失敗します——`noet` が PATH 上にあってもフォールバックはしません**(対話シェルでは偶然動いて launchd でだけ壊れる、という不可視の環境依存を避けるための意図的な仕様です)。

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
- **credential helper の設定は不要です**: note2web は `git fetch` / `git push` を含む全ての `git` 呼び出しで、それより前に設定されている credential helper(macOS の Git Credential Manager や `osxkeychain` 等)を毎回クリアし、`gh auth git-credential` だけを一時的に使うようコマンドごとに強制します。これにより GUI の認証ポップアップは発生せず、`gh auth setup-git` を実行しておく必要もありません。`gh` に複数の GitHub アカウントを認証済みの環境でも、`GH_TOKEN` 環境変数の値が使われるアカウントを一意に決めるため安全です。万一この仕組みが効かず認証情報が見つからない場合も、`GIT_TERMINAL_PROMPT=0` と空の `GIT_ASKPASS` により、git は端末プロンプトにも GUI の askpass ダイアログにもフォールバックせず即座にエラーで終了します(launchd / cron からの無人実行を維持)
- 実行のたびに `base_branch` から作業ブランチ `note2web/sync-<UTC時刻>` を作成し、変更のあったノートをコミット、`gh pr create` で PR を作成します
- **差分が無ければブランチを破棄し、空コミット・空 PR は作りません**
- **`auto_merge: true` のときのみ** PR のマージ(`gh pr merge --merge --delete-branch`)まで自動実行します。ブランチ保護等でマージできない場合は PR を残したまま実行を失敗として報告します
- **状態確定のタイミング(重要)**: そのノートを「配信済み」として状態ファイルに記録するのは **PR 作成の成功時点** であり、マージの成功・失敗は問いません。したがって:
  - `auto_merge: false`(既定)の運用で、作成された PR を **マージせずにクローズした場合、その内容は再配信されません**(次にそのノートの本文が変更され、コンテンツハッシュが変わるまで)。レビューで却下した記事を再送したい場合は、ノート側を何かしら変更してから再実行してください
  - push や PR 作成そのものに失敗した場合は状態を確定せず、次回実行で自動的に再試行されます

サービス別の差分:

| サービス | 出力パス | frontmatter | 備考 |
|---|---|---|---|
| Zenn | `articles/<uuid を小文字化した slug>.md` | `title` / `emoji` / `type` / `topics` / `published: true` | `type` はノートのフォルダパスを葉から遡り、最初に `tech` / `idea` と完全一致したフォルダ名を採用します。どの祖先フォルダも一致しない場合は設定不正としてそのノートのみ失敗扱いになります(詳細は下記「Zenn」参照)。絵文字が本文1行目に無いノートには既定値 `📝` を使います(Zenn は emoji 必須のため) |
| Hugo | `<output_dir>/<uuid>.md` | `title` / `date` / `lastmod` / `categories: [フォルダ名]` / `tags` | `output_dir` は任意(例 `content/posts`) |
| Jekyll | `_posts/YYYY-MM-DD-<uuid>.md` | `title` / `date` / `categories` / `tags` | 日付は作成日。初回配信時のファイル名を状態ファイルに記録し、以後は作成日が変わっても記録済みのファイル名を使い続けます(URL の安定性を優先) |

#### Zenn

- Zenn との連携は **GitHub リポジトリ連携のみ**を前提にしています。`articles/` にファイルを置いて対象リポジトリへ push すれば Zenn 側が取り込むため、`zenn-cli` のインストール・実行は一切不要です(依存にも含めていません)
- **`type`(tech / idea)はフォルダ構成で決めます**: Apple Notes 側で対象フォルダ(例 `Zenn`)の下に `tech` / `idea` サブフォルダを作り、記事ノートをその下に置いてください。設定では `source.folders: [Zenn]` のように親フォルダだけを指定すれば、サブフォルダ配下のノートも自動的に配信対象へ含まれます(サブツリー全体がエクスポート対象になるため)。判定はノートのフォルダパスを葉(直属フォルダ)から根へ遡り、最初に `tech` / `idea` と完全一致したフォルダ名を採用します——`Zenn/tech` 配下なら `tech`、さらにその下の `Zenn/tech/drafts` のようなネストでも直近の祖先 `tech` が使われます。`tech` / `idea` をパスに含まないノート(親フォルダ直下に置いたノート等)は Zenn では失敗扱いになります。従来どおり `source.folders: [tech, idea]` と `tech`/`idea` フォルダを直接指定する構成もそのまま有効です
- `topics` は Apple Notes のハッシュタグ由来で、Zenn 公式ガイド([zenn-cli-guide](https://zenn.dev/zenn/articles/zenn-cli-guide))の制約に合わせてサニタイズします: 先頭の `#` を除去し、除去後に空になったタグ・半角スペースを含むタグは警告つきで除外し、6個以上残る場合は先頭5個に切り詰めます(公式ガイドが明記する上限)。サニタイズ後に0個になっても失敗にはせず、`topics: []` を出力します(Zenn は `topics` の省略・空配列を許容するため)
- slug(ファイル名)はノート UUID を小文字化した値で、Zenn 公式ガイドの制約(半角英小文字・数字・ハイフン・アンダースコアの12〜50字)に適合していることを検証済みです

### Qiita

Qiita API v2 を直接呼び出します(qiita-cli のような外部 CLI は使いません)。

- 新規作成は `POST /api/v2/items`、更新は `PATCH /api/v2/items/{item_id}` を呼びます
- 認証は `qiita.token_env` が指す環境変数(サンプルは `QIITA_TOKEN`)から読み、リクエストヘッダ `Authorization: Bearer <トークン>` に渡します
- リクエストボディは `{ body, title, tags: [{ name, versions: [] }], private: false }` の形です
- **タグ制約**: Qiita は1〜5個のタグが必須です。半角スペースを含むタグは分割送信による 403 を避けるため除外し、警告ログを出します。除外後に6個以上残っていれば先頭5個に切り詰めます(警告ログ)。除外後に0個になった場合、そのノートは**失敗扱い**になります(タグを付けて再実行してください)

**過去バージョンからの移行(qiita-cli サブプロセス方式の廃止)**: 従来 note2web は `@qiita/qiita-cli` をサブプロセスとして呼び出していましたが、`publish` コマンドが投稿対象の記事に先立って**利用者の Qiita 記事を無条件に全件同期する**(投稿数の多いアカウントで子プロセスタイムアウト・ディスク圧迫を招く)ため、この API 直叩き方式へ移行しました。既存の状態ファイル(`*.state.json`)をお使いの場合は次の点にご注意ください:

- 設定 YAML の `qiita.workspace` は廃止されました。設定ファイルから削除してください(残っていても検証エラーになります)
- 状態ファイルの `target` フィールドは、旧バージョンでは qiita-cli ワークスペースのパス文字列でしたが、新バージョンでは固定値 `"qiita.com"` になりました。この不一致により、既存の状態ファイルをそのまま使うと `target` 検証エラー(exit 2)になります。**既存の `remoteId`(記事 ID)を引き継いで重複記事の作成を避けるには、状態ファイルの `target` を手動で `"qiita.com"` に書き換えてから再実行してください**
- 冪等判定に使うコンテンツハッシュの算出方法が変わったため(旧: frontmatter に記事 ID 等の配信結果を含めていた / 新: タイトル・タグ・本文のみ)、既存ノートは内容が変わっていなくても**次回実行時に1回だけ**更新(PATCH)による再配信が発生します。`remoteId` を引き継いでいれば重複記事は作られません

### dev.to

- Forem API v1(`POST /api/articles` / `PUT /api/articles/{id}`)を直接呼び出します(devto-cli は使いません)
- 認証は `devto.api_key_env` が指す環境変数(サンプルは `DEVTO_API_KEY`)から読み、リクエストヘッダ `api-key` に渡します
- タグは**最大4個**です。超過分は先頭4個に切り詰め、警告ログを出します
- `canonical_base_url` を設定した場合のみ `canonical_url` をリクエストに含めます(省略可)

### note.com

**note.com への配信には他サービスと異なる重大な構造的制約があります。**

- `noet` は note.com 公式・非公式問わず API を直接呼び出しません。現行の `noet`(内部でブラウザ拡張機能と WebSocket 通信する方式に移行済み)は、**同一マシン上でログイン済みの実 Chrome ブラウザと `noet` 拡張機能が起動していること**を前提に、ブラウザ拡張機能側が note.com のページを裏タブで開いて DOM 操作(フォーム入力・投稿ボタンのクリック等)を行うことで記事を作成・更新します
- 環境変数・トークン・cookie を渡して認証する経路は存在しません。したがって **cron / launchd からの完全無人実行では、この前提(ログイン済みブラウザの常時起動)が満たせない場合 `noet` の呼び出し自体が失敗します**。これは note2web の不具合ではなく、`noet` の現行アーキテクチャに起因する構造的な制約です。実行自体は自動で続行され、満たせなかったノートは他ノートと同様に個別に `failed` として扱われ、状態は更新されません(次回実行で再試行されます)。note.com 向けに `sync` を完全無人で回すことは、この前提を満たす環境(ログイン済みブラウザを常駐させる等)を別途用意しない限りできません
- **`noet` コマンド自体の解決には `NOET_PATH` が必須です**(上記「note.com」設定節、実機報告)。`cargo install` された `noet` は `~/.cargo/bin/noet` に置かれることが多く、launchd の最小限の PATH はこのディレクトリを含みません。`noet` は PATH からではなく、環境変数 `NOET_PATH`(絶対パス、`~` 展開に対応)が指すパスから起動します。`note2web init` が対話で尋ね(既定 `~/.cargo/bin/noet`)、env ファイルへ値入りで書き込みます。**`NOET_PATH` が未設定・空文字の場合、`noet` が PATH 上にあっても PATH へはフォールバックせず、`doctor`/`sync` は exit 2 で失敗します**
- **画像を含むノートは note.com 向けでは配信されません**(明示的に失敗扱いになります)。note.com の編集画面(ProseMirror)は Markdown の画像記法 `![]()` を解釈せず、外部 URL(R2 / S3 の公開 URL)をそのまま送るとリテラルなテキストとして表示されてしまうためです。画像入りのノートを note.com へ配信する手段は現時点ではありません
- 記事 ID の特定には `noet list`(`/notes` ページの DOM スクレイピング)によるタイトル一致照合を使いますが、この一覧取得はページネーションに対応していません。一覧が空でないのにタイトル一致が0件、または複数一致した場合は確認不能としてそのノートを失敗扱いにします

### はてなブログ

- はてなブログ AtomPub(`POST <blog>/atom/entry` / `PUT <blog>/atom/entry/<entry_id>`)を直接呼び出します
- 認証は Basic 認証(はてな ID + API キー)です。`hatena.hatena_id` と `hatena.api_key_env` が指す環境変数(サンプルは `HATENA_API_KEY`)を使います。APIキーはマイページの「詳細設定」から発行してください
- **前提条件**: 投稿先ブログの編集モードが **Markdown** であることが必須です(見たままモード等では意図通りに入稿されません)。`content type="text/x-markdown"` で Markdown 本文をそのまま送信する実装のため、編集モードが異なると本文が期待通りに解釈されません
- フォルダ名・ハッシュタグはいずれも `category` 要素としてはてなブログ側へ送信されます
- **実機未確認**: この Markdown 入稿の wire contract は HTTP モックによる検証は完了していますが、実際の `blog.hatena.ne.jp` への入稿確認はまだ行われていません。初回利用時は少数のノートで動作を確認することを推奨します

## cron / launchd での定期実行

1つの設定ファイル = 1つの配信先サービスなので、複数サービスへ配信する場合は設定ファイルの数だけエントリを登録してください。`note2web init` を実行し、最後の確認プロンプトで launchd 用ファイルの生成を選ぶと、以下で説明する **env ファイル**と**plist**の2ファイルが自動生成されます(パスは自動解決済み)。以下は生成される内容の説明と、手動で作成する場合の例です。

### 準備: ログディレクトリ

まずログの出力先ディレクトリを作成します:

```bash
mkdir -p ~/Library/Logs/note2web
```

### env ファイル(秘匿情報。`~/.config/note2web/env`)

秘匿情報は crontab や plist に直書きせず、**権限を絞った環境変数ファイル**経由で渡します。`sync` / `doctor` は起動時にこのファイルを自動的に読み込む(前述の [env ファイルの自動読み込み](#env-ファイルの自動読み込みdoctor--sync-共通)節)ため、launchd / cron からシェルを介さず `node` を直接起動しても値が `process.env` に載ります。

```bash
mkdir -p ~/.config/note2web
```

次の内容を `~/.config/note2web/env` として保存します:

```bash
# ~/.config/note2web/env(chmod 600 で保護)
GH_TOKEN=xxxx
R2_ACCESS_KEY_ID=xxxx
R2_SECRET_ACCESS_KEY=xxxx
```

保存後、権限を絞ります:

```bash
chmod 600 ~/.config/note2web/env
```

### note2web は npm に公開されていない(`npx` は使えない)

`note2web` は npm には公開されていないため、`npx --yes note2web` はレジストリの 404 で必ず失敗します。代わりに、実行中インストールの `dist/cli.js` の絶対パスを `node` で直接指定して起動します(`note2web init` はこのパスと `node` 自身の絶対パス(`process.execPath`)を自動的に解決し、生成する plist の `ProgramArguments` へ埋め込みます)。

### cron の例

```cron
# 30分おきに Zenn へ配信(PATH は cron の最小環境を補うため明示する)
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
*/30 * * * * /opt/homebrew/bin/node /Users/you/src/note2web/dist/cli.js sync --config /Users/you/.config/note2web/zenn.yaml >> /Users/you/Library/Logs/note2web/zenn-cron.log 2>&1

# 1時間おきに Qiita へ配信(設定ファイルを変えるだけで、同じ node 実行ファイルを再利用できる)
0 * * * * /opt/homebrew/bin/node /Users/you/src/note2web/dist/cli.js sync --config /Users/you/.config/note2web/qiita.yaml >> /Users/you/Library/Logs/note2web/qiita-cron.log 2>&1
```

crontab・launchd の plist はいずれも平文で読まれ得るため、トークン類は上記の `chmod 600` した env ファイルにのみ置いてください(より堅牢にするなら macOS キーチェーン + `security find-generic-password` での取得も選択肢です)。cron から起動する `node` バイナリにも「フルディスクアクセス」権限が必要な点に注意してください(次の launchd 節を参照)。

### launchd の例(`~/Library/LaunchAgents/com.note2web.zenn.plist`)

`node` を直接起動し、`EnvironmentVariables` には秘匿情報を含まない `PATH` だけを含めます(トークン等は上記の env ファイルにのみ置き、CLI 自身が自動読み込みします)。以下は説明用の例で、実際のパスは環境ごとに異なります(`note2web init` が実際の絶対パスを埋め込んで生成します)。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.note2web.zenn</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/.nvm/versions/node/v22.0.0/bin/node</string>
    <string>/Users/you/src/note2web/dist/cli.js</string>
    <string>sync</string>
    <string>--config</string>
    <string>/Users/you/.config/note2web/zenn.yaml</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/you/.nvm/versions/node/v22.0.0/bin:/Users/you/.rbenv/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartInterval</key>
  <integer>1800</integer>
  <key>StandardOutPath</key>
  <string>/Users/you/Library/Logs/note2web/zenn.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/Library/Logs/note2web/zenn.err.log</string>
</dict>
</plist>
```

**なぜ `node` を直接起動するのか(以前のバージョンからの変更点)**: 以前のバージョンはシェルラッパー(`~/bin/note2web-sync.sh`)を `ProgramArguments[0]` に置き、そこから `node` を起動していました。しかし macOS の TCC(フルディスクアクセス等のプライバシー制御)は `ProgramArguments[0]` の実行ファイルを「責任のあるプロセス」として扱うため、`/bin/sh` にフルディスクアクセスを許可しても実機で権限が正しく効かないケースがありました。現在のバージョンは `node` 実行ファイル自身を `ProgramArguments[0]` に置くため、**その `node` バイナリへフルディスクアクセスを許可するだけでジョブ全体(`node` が起動する `ruby`/`bundle` を含む)に権限が及びます**。**旧バージョンが生成した `~/bin/note2web-sync.sh` は note2web からはもう使われません**。残っていても実害はありませんが、他の用途で使っていなければ削除して構いません。

サービスごとに `Label` / 設定ファイル / ログパスを変えた plist を用意し、`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.note2web.<service>.plist` で登録します(LaunchAgent はユーザー単位のため **`sudo` は付けません**。`sudo` を付けると LaunchDaemons 扱いになり `Load failed: 5: Input/output error` で失敗します)。すぐ1回実行して動作確認するには `launchctl kickstart -k gui/$(id -u)/com.note2web.<service>`、解除するには `launchctl bootout gui/$(id -u)/com.note2web.<service>` を使います。

**フルディスクアクセスの付与先**: 「システム設定」→「プライバシーとセキュリティ」→「フルディスクアクセス」を開き、**ターミナルアプリではなく上記の `node` 実行ファイル自身**を追加してください(`node -e 'console.log(process.execPath)'` で確認できます。`/bin/sh` や `note2web-sync.sh` を追加しても効果がありません)。

note.com 向けの構成では、上記に加えてログイン済みブラウザと `noet` 拡張機能が常時起動している必要がある点に注意してください(無人の launchd だけでは前提を満たせません)。

## トラブルシューティング

### `apple_cloud_notes_parser (note2web_export.rb) failed`

cron / launchd から `note2web sync` を実行したときに以下のようなログが出て失敗する場合の対処法です。

```text
note2web: apple_cloud_notes_parser (note2web_export.rb) failed (exit_code): exitCode=1, signal=null: <出力の先頭1行>
```

まず**「apple_cloud_notes_parser」は note2web が内部で読み込む外部 Ruby ライブラリのプロジェクト名、「note2web_export.rb」は note2web 自身に同梱されているエクスポートスクリプト**です([threeplanetssoftware/apple_cloud_notes_parser](https://github.com/threeplanetssoftware/apple_cloud_notes_parser)、似た名前の Python 製ライブラリ `apple-notes-parser` とは別物です)。以前(〜issue #71)は upstream の `notes_cloud_ripper.rb` を直接実行していましたが、issue #72 で note2web 自身の `ruby/note2web_export.rb` を実行する方式に変わりました——upstream の `lib/` だけを読み込み、対象フォルダ(`source.folders`)のみを処理する薄いドライバです。upstream 自体は引き続き clone してセットアップするだけで、同梱・再配布はしていません(詳細は `NOTICE`)。

代表的な原因は次のとおりです:

1. **ruby / bundle が cron / launchd の `PATH` に無い**: rbenv / asdf / rvm / Homebrew の Ruby を使っている場合、対話シェルでは `PATH` が通っていても cron / launchd の実行環境(最小限の `PATH`)には反映されないことがよくあります。launchd については `note2web init` が生成する plist の `EnvironmentVariables` にホームディレクトリの rbenv/asdf/rvm の shim ディレクトリを自動的に含めます(issue #71)。それでも解決しない場合は、実行経路ごとに `PATH` の設定場所が異なる点に注意してください: **対話シェルから直接実行する場合**はシェルの初期化ファイル(`~/.zshrc` 等)で `PATH` を設定し、**launchd 経由の場合**は生成済み plist の `EnvironmentVariables` の `PATH` を使い、**cron を使う場合**は crontab 側のエントリに `PATH=...` を明示してください(env ファイルには `PATH` を書きません。`note2web init` が生成する env ファイルのテンプレートにもこの点のヒントコメントが入っています)
2. **gem がインストールされていない**: `apple_cloud_notes_parser` の clone 先で `bundle install` を実行していないと、`bundle exec ruby <note2web_export.rb>` は `Could not find gem 'sqlite3'...` のようなメッセージで失敗します。以下を実行してください:
   ```sh
   cd ~/tools/apple_cloud_notes_parser   # exporter.parser_path と同じパス
   bundle install
   ```
3. **Ruby のバージョンが古い(< 3.0)**: `ruby -v` で確認してください。`note2web doctor` はこのバージョンチェックも行います
4. **フルディスクアクセス権限が無い**: [必要要件](#必要要件)の「macOS のフルディスクアクセス権限」を参照してください。この場合 parser 自体は起動するものの `NoteStore.sqlite` の読み取りで失敗します
5. **`exporter.parser_path` が誤っている**: clone 先のパスと設定ファイルの `exporter.parser_path` が一致しているか確認してください(`<exporter.parser_path>/lib/AppleNoteStore.rb` が存在するはずです)

**ログの読み方**: 上記のエラーメッセージの末尾(`exitCode=... signal=...:` の後ろ)には、parser の stderr(無ければ stdout)の先頭の意味のある1行がそのまま含まれます(parser のコマンドライン自体は秘匿情報を含みうる引数がないため、この出力のみを載せています)。`bundle: command not found` なら原因1、`Could not find gem` なら原因2、というように読み分けられます。

**事前チェック**: `note2web doctor --config <path>` は `ruby` / `bundle` コマンドの存在、Ruby のバージョン(>= 3.0)、`bundle check` による gem の準備状況に加えて、Notes コンテナディレクトリ(`exporter.notes_container`)と `NoteStore.sqlite` の存在・読み取り可否までまとめて確認します(issue #69)。まずこれを実行してください。

**手動デバッグ**: cron / launchd と同じ経路を手元のシェルで再現するには、生成された plist の `ProgramArguments` と同じ `node` / `dist/cli.js` の絶対パスで直接実行します:

```sh
node /Users/you/src/note2web/dist/cli.js sync --config ~/.config/note2web/zenn.yaml
```

env ファイルの読み込みは CLI 自身が自動で行う(前述の [env ファイルの自動読み込み](#env-ファイルの自動読み込みdoctor--sync-共通)節)ため、`set -a; . env; set +a` のような追加のシェル設定は不要です。`PATH` 関連の問題を切り分けたい場合は、生成された plist(`~/Library/LaunchAgents/com.note2web.<service>.plist`)の `EnvironmentVariables` にある `PATH` の値を一時的に `export` してから実行してください。それでも失敗する場合は、`exporter.parser_path` へ `cd` して `bundle exec ruby <note2webのインストール先>/ruby/note2web_export.rb -m <Notesコンテナ> -o /tmp/out --parser-lib <exporter.parser_path>/lib --folder <対象フォルダ名>` を直接実行し、エラーメッセージを確認してください。

**`launcher: ruby` への切り替え**: Bundler を経由せず gem 環境が別の方法(システム全体への gem インストール等)で解決できている場合は、設定 YAML で `exporter.launcher: ruby` を指定すると `bundle exec` を挟まない従来どおりの起動に戻せます。

### `Errno::ENAMETOOLONG`(構造的に解消済み)

以前(issue #72 以前)は、Apple Notes ストア全体(設定 `source.folders` で指定していないフォルダ、および「最近削除した項目」= ゴミ箱を含む)のうちどこか1件でもタイトルが極端に長い/壊れたノート(例: 数千文字の URL がそのままタイトルになっているノート)があると、個別 HTML ファイルの書き込み時にファイル名がタイトル由来になるため `Errno::ENAMETOOLONG` でエクスポート全体が失敗していました。issue #72 以降、note2web 独自のエクスポートスクリプト(`ruby/note2web_export.rb`)は次の2点でこの問題を構造的に解消しています:

- 個別 HTML のファイル名は常に `<uuid>.html`(UUID のみ)で組み立てられ、タイトルは一切ファイル名に使われません
- 設定 `source.folders` で指定したフォルダ(とその配下)のみを JSON 生成・書き込みの対象として採用します。**「最近削除した項目」(ゴミ箱)は、設定でその名前を対象フォルダに指定していても、ゴミ箱フォルダ自身とその配下のサブフォルダごと常に除外されます**——upstream 内部でゴミ箱内のノートが一時的に読み取られることはあっても、それが原因で `sync` の実行が失敗したり、その内容が出力(HTML/JSON)に混ざったりすることはありません

対象フォルダ内で個々のノートのデコード/生成に失敗した場合も、そのノート単体をスキップして処理を継続します(実行全体は中断しません)。

### 暗号化(パスワード保護)ノートはスキップされます

パスワードで保護された(暗号化された)ノートは、note2web が復号を試みることなく自動的にスキップされます。`sync` 実行時のログに `warn` イベント(ノートの UUID・タイトル)が出力されるので、そのノートを公開したい場合は Apple Notes 側でロックを解除してから再実行してください。

### ノート本文にコードブロックを書きたい

ノート本文中に、開始行を ```` ```言語名 ````(言語名は省略可)、終了行を ```` ``` ```` だけの行として書くと、その間の内容を逐語のコードブロックとして Markdown へ変換します(バッククォート・`*`・`#` 等のエスケープは行いません)。次の制約があります:

- フェンス行は**行全体が開始/終了フェンスと完全に一致**している必要があります。同じ行にほかの文字があると(例: ```` ```ruby のコード ````)フェンスとして認識されません
- 認識対象は**本文の最上位の行のみ**です。箇条書きやチェックリスト、引用の内部に書いたフェンスは変換されません
- 開始行に対応する終了行が見つからない場合は変換されず、通常のテキスト(エスケープ済み)のまま出力されます

### `no such table: ZACCOUNT: (SQLite3::SQLException)`

parser 自体は起動できているものの、`NoteStore.sqlite` の読み取り中にこのようなログで失敗する場合の対処法です(issue #69)。

```text
note2web: apple_cloud_notes_parser (note2web_export.rb) failed (exit_code): exitCode=1, signal=null: no such table: ZACCOUNT: (SQLite3::SQLException) ヒント(issue #69): ...
```

代表的な原因は次のとおりです(`note2web` は該当パターンを検出すると、上記のようにエラーメッセージの末尾へ同内容の日本語ヒントを自動的に追記します):

1. **フルディスクアクセス権限が無い**: [必要要件](#必要要件)の「macOS のフルディスクアクセス権限」を参照してください。**ターミナルアプリではなく、実行コンテキスト自体**(launchd / cron から起動する場合は、それらが直接起動する `node` 実行ファイル自身)への付与が必要です。`ProgramArguments[0]` が `node` である場合、TCC の責任のあるプロセスは `node` 自身になります(`/bin/sh` やシェルラッパーへ許可しても効きません)
2. **Notes.app が起動したままで WAL がチェックポイントされていない**: Apple Notes は変更を Write-Ahead Log(WAL)にバッファし、アプリの終了時などにメインの `NoteStore.sqlite` へ反映(チェックポイント)します。Notes.app を起動したまま `sync` を実行すると、テーブルがまだ存在しない・スキーマが不完全な状態の DB を読むことがあります。Notes.app を一度終了してから再実行してください
3. **macOS バージョン間での `NoteStore.sqlite` のスキーマ不一致**: `apple_cloud_notes_parser` が対応していない新しい(または非常に古い)macOS の Notes スキーマだと、想定したテーブルが見つからず失敗します。`apple_cloud_notes_parser` を最新版に更新して再試行してください

**事前チェック**: `note2web doctor --config <path>` は、`exporter.notes_container` が指すディレクトリと `NoteStore.sqlite` の存在・読み取り可否を確認します。フルディスクアクセスが未許可の場合はこの時点で「Apple Notes database not found or not readable」として検出できます(上記の原因1のみ事前検出可能。原因2・3は実際に parser を実行するまで判別できません)。

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
- **Qiita の実トークンでの認証・公開**: Qiita API v2 の wire contract(認証ヘッダ・リクエストボディ形状)は HTTP モックで検証済みですが、実トークンでの実際の投稿成功は未確認です
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

note2web は Apple Notes のエクスポート処理で [apple_cloud_notes_parser](https://github.com/threeplanetssoftware/apple_cloud_notes_parser)(MIT License、Copyright Three Planets Software)を外部ライブラリとして利用します。同梱・再配布はしておらず、利用者が別途 clone してセットアップします(上記「必要要件」参照)。ライセンス全文・参照コミット・利用形態の詳細は [NOTICE](./NOTICE) を参照してください。
