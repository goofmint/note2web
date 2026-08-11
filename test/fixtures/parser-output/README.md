# parser-output フィクスチャ

`apple_cloud_notes_parser` を `--individual-files --uuid` 付きで実行した際に生成される出力(`json/` + `html/` + `files/`)を模したテスト用フィクスチャ。T-08(GitHub issue #13, SPIKE)の成果物であり、design.md §5.2 / §5.3 / §5.4 / §13-1 / §13-2 / §13-7 の根拠データ。

## 確認方法(重要な前提)

**実施環境には macOS も実機の Apple Notes データベースもない。** そのため要件の「実機確認」はこのタスクでは実施できない。代わりに以下の方法で事実確認を行った(design.md §13 に同じ注記あり):

1. **パーサ実装の実行**: `apple_cloud_notes_parser` を clone し(コミット `4754a2b62686570cca46690d101079e80cf6ae66`, 2026-07-25)、`bundle install` 済みの環境で、同梱の `spec/data/exported_blobs/*.bin`(実際の Apple Notes からエクスポートされた実データの gzip 化 protobuf)を `spec/base_classes/apple_note.rb` のテスト用セットアップ(`AppleNote.new` → `process_note` → `generate_html(individual_files:, use_uuid:)`)と同じ手順で読み込み、**パーサの実コードを実行**して HTML を得た。表(テーブル)については `spec/embedded_objects/tables.rb` と同じ手順で `AppleNotesEmbeddedTable` を直接実行した(ダミーの SQLite DB を用意して依存クエリを満たした)
2. **ソースコード読解**: 実行だけでは確認できない箇所(チェックリストの HTML 生成ルール本体、描画ファイルの保存パス規約、JSON シリアライズの実装、個別 HTML ファイルの命名規則)は `lib/` 以下のソースを直接読んで確認した
3. **公式ドキュメント**: `JSON.md`(パーサ同梱)を参照し、ソースの `prepare_json` 実装と突き合わせて整合を確認した

**実施していないこと**: macOS 実機で `NoteStore.sqlite` を用意し、パーサをエンドツーエンドで実行して出力を得ることは行っていない。したがって「実データベース由来の未知のエッジケース」(例: iOS バージョンごとの差異、暗号化ノート、共有ノートなど)が本フィクスチャに反映されていない可能性がある。

## ディレクトリ構成の根拠

`notes_cloud_ripper.rb`(該当パーサのエントリポイント)を読むと、`--individual-files` 指定時の出力は次の構成になる(`notes_cloud_ripper.rb:241-275` 付近):

```
<output_dir>/
  csv/                                  # 本フィクスチャには含めない(note2web は使用しない)
  html/
    note_store<N>/
      index.html                        # アカウント一覧
      <アカウント名>-<ルートフォルダ名>/
        index.html                       # フォルダ一覧
        <UUID または DB ID> - <サニタイズ済みタイトル>.html   # ノート単位の個別 HTML
        <子フォルダ名>/                   # 子フォルダは親のディレクトリ配下(アカウント名は付かない)
          index.html
          <UUID> - <タイトル>.html
  json/
    all_notes_<N>.json
  files/
    Accounts/<アカウント ZIDENTIFIER>/...  # 添付・描画の実体。フォルダの見た目上のパスとは無関係で、端末上のパス(Accounts/<uuid>/...)をそのまま踏襲する
```

`--uuid` はファイル名・アンカー ID を `ZIDENTIFIER`(UUID)にする(`--uuid` 無しの場合は DB のローカル ID になる)。ソース根拠:

- `lib/AppleNoteStore.rb` `write_individual_html`: `note_file_name = note.title_as_filename('.html', use_uuid: use_uuid)`。ノートのパスは `backup_dir.join(note.folder.to_path, note_file_name)`
- `lib/AppleNote.rb` `title_as_filename`: `"#{unique_id(use_uuid)} - #{file_title}#{ext}"`(`file_title` は `title.tr('[\\/*"<>?|:]\'', '_')` でサニタイズ)
- `lib/AppleNotesFolder.rb` `to_path`: ルートフォルダは `"#{account.clean_name}-#{clean_name}"`、子フォルダは `parent.to_path.join(clean_name)`(アカウント名を繰り返さない)
- `lib/AppleBackup.rb` `back_up_file`: 添付・描画の実体は `<output_dir>/files/<端末上のパスの親ディレクトリ>/<ファイル名>` にコピーされ、戻り値の相対パスが HTML から参照される
- `lib/AppleNotesFolder.rb` `to_relative_root`: 個別 HTML から `files/` への相対パスの `../` の数は、ルートフォルダのノートで `../../../`(3階層)、子フォルダのノートはネストの深さ分 `../` が1つ増える

**既知の実装上の癖(ソースで確認・そのままフィクスチャに反映)**: ノート個別 HTML 内の「Account:」リンクは `@folder.to_account_root`(**引数無しで呼ばれるため常に `individual_files=false` 扱いになる**)を使っており、フォルダの深さに関わらず常に `../index.html` になる(`lib/AppleNote.rb:470`)。素直に実装すると深さに応じて `../../index.html` 等になりそうだが、実際のソースはそうなっていない。本フィクスチャの note HTML はこの実挙動どおりに `../index.html` を使っている

## フィクスチャの内容

1 アカウント(`Sample Notes`)、2 フォルダ(`Tech` がルート、`Archive` が `Tech` の子フォルダ)、4 ノート。UUID・時刻・本文はすべて架空のダミー値(実データは一切含まれない)。

| ノート | UUID | フォルダ | 検証対象 | 確認区分 |
|---|---|---|---|---|
| Q3 Sales Table | `44444444-…` | Tech(ルート) | `<table>` の実出力構造(FR-11) | **実行検証**: `AppleNotesEmbeddedTable#generate_html` を実データ blob (`table_gzipped.bin`) で直接実行し、出力された `<table><tr><td>…` の構造をセル内容だけ差し替えて使用 |
| Grocery Checklist | `55555555-…` | Tech(ルート) | チェックリストの HTML 表現(§13-1, FR-12) | **実行検証**: `list_indents_gzipped.bin`(実データ)を `AppleNote#generate_html` で実行し、`<ul class="checklist" data-apple-notes-indent-amount="N"><li class="checked">` / `<li class="unchecked">` のネスト構造を実出力のまま流用(テキストのみ差し替え) |
| Whiteboard Sketch | `66666666-…` | Tech(ルート) | 描画(drawing)の抽出・参照形式(§13-2, FR-13) | **ソース確認 + 経路推論**: `AppleNotesEmbeddedDrawing`(`lib/AppleNotesEmbeddedDrawing.rb`)のファイル配置規約と `generate_html_with_images`(`lib/AppleNotesEmbeddedObject.rb`)の `<a><img></a>` 生成コードを読解して構成。フォールバック画像そのもの(実データの手書き protobuf)は exported_blobs に含まれていないため、この部分は実行検証ではない |
| 🚀 Launch Notes | `77777777-…` | Tech/Archive(子フォルダ) | 絵文字タイトル・ハッシュタグ・ネストフォルダ(FR-04〜07) | **ソース確認**: `AppleNotesEmbeddedInlineHashtag#to_s` がプレーンテキストの `#タグ` をそのまま返す(ラップ用タグなし)ことをソースで確認。絵文字タイトル自体は emoji_formatting 系 blob の実行結果(本文中の絵文字保持)と整合 |
| (JSON トップレベル) | — | — | JSON スキーマ全体(§13-7) | **ソース確認 + 公式ドキュメント**: `JSON.md` と `lib/AppleNoteStore.rb#prepare_json` / `AppleNote#prepare_json` / `AppleNotesFolder#prepare_json` / `AppleNotesAccount#prepare_json` / `AppleNotesEmbeddedObject#prepare_json` / `AppleNotesEmbeddedTable#prepare_json` を直接読解し、フィールド名・入れ子構造をそのまま採用。時刻書式 (`"YYYY-MM-DD HH:MM:SS +0000"`) は実行時に `Time#to_s` 相当の実出力で確認 |
| (フォルダ階層 index.html) | — | — | フォルダ / アカウントの一覧ページ | **ソース確認のみ(未実行)**: `AppleNotesAccount#generate_html` / `AppleNotesFolder#generate_html` はデータベース接続を要求するため、このタスクの実行環境(実 SQLite 無し)では実行できなかった。構造はソースコードの `Nokogiri::HTML::Builder` 呼び出しを読んで組み立てた近似であり、実行検証ではない |

### JSON との対応関係の注意

`json/all_notes_1.json` の各ノートオブジェクトが持つ `"html"` フィールドは、`note.generate_html()` を**引数省略(`individual_files: false, use_uuid: false`)で呼んだ結果**であり、`html/note_store1/…` 以下の個別 HTML ファイル(`individual_files: true, use_uuid: true` で生成)とは **リンクの形式が異なる**(JSON 側はローカル DB ID のアンカー `#note_201` 等を使い、個別 HTML 側は UUID アンカー `#note_44444444-…` を使う。`files/` への相対パスの `../` の数も異なる)。note2web の設計(§5.2)が「本文取得は JSON の `html` ではなく個別 HTML ファイルを UUID で解決する」としているのは、この不一致を踏まえた設計判断であり、本フィクスチャはその根拠を示すために両方を収録している

### 省略した実データ

- `note_proto`(protobuf のデコード結果)フィールドは実際の出力には各ノートに含まれるが、非常に大きく、note2web の設計でも未使用のため本フィクスチャからは省略した(`lib/AppleNote.rb` の `prepare_json` では `@note_proto` が常にセットされる限り出力される)
- `csv/` 配下の出力(`--individual-files` の有無に関わらず生成される)は note2web が使用しないため省略した
- JSON トップレベルの `"html"`(全ノート結合 HTML)は個々のノートの `"html"` を連結した構造と同一のため、サイズ削減のためプレースホルダ文字列に置き換えた

## 匿名化方針

- UUID はすべて `xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx` 形式の固定ダミー値(`4`/`8` 桁目は UUID v4 の形式に寄せた見た目上のダミーで、実際のバージョンビットではない)
- 本文・タイトル・時刻はすべて架空
- `files/` 配下の画像は 1x1 の透明 PNG(実データではない)
- ディレクトリ・ファイル名の記号サニタイズ規則(`tr('[\\/*"<>?|:]\'', '_')`)はソースどおり反映しているが、値そのものはダミー
