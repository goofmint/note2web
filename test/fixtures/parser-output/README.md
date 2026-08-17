# parser-output フィクスチャ

note2web 独自の Ruby エクスポートスクリプト(`ruby/note2web_export.rb`。upstream の
`apple_cloud_notes_parser` の `lib/` を薄くラップする。issue #72、design.md §5.2)が
生成する出力(`json/` + `html/` + `files/`)を模したテスト用フィクスチャ。
T-08(GitHub issue #13, SPIKE)の成果物を土台に、issue #72(`notes_cloud_ripper.rb` の
直接実行から note2web 独自スクリプトへの置き換え)で構造を更新した。design.md §5.2 /
§5.3 / §5.4 / §13-1 / §13-2 / §13-7 の根拠データ。

## issue #72 での変更点(重要)

以前(T-08)はこの fixture は `apple_cloud_notes_parser` の `notes_cloud_ripper.rb` を
`--individual-files --uuid` 付きでそのまま実行した際の生の出力をほぼそのまま模していた
(Notes ストア全体を無条件にエクスポートし、TS 側がフォルダ・UUID で絞り込む設計だった)。
issue #72 で note2web は自前の `ruby/note2web_export.rb` を実行するようになり、
**対象フォルダ(`source.folders`、FR-02)のみを生成・書き込みする**設計に変わったため、
この fixture も「note2web 独自スクリプトの出力」を模す形に更新した:

- **`html/` がフラットになった**: 以前の `html/note_store<N>/<アカウント名>-<フォルダ名>/...`
  という入れ子構造(`AppleNoteStore#write_individual_html` 由来)ではなく、
  `html/<uuid>.html` の直下フラット配置になった(根拠は `ruby/note2web_export.rb` 冒頭
  コメント参照。upstream のこのメソッドはタイトル由来のファイル名を組み立てるため
  `Errno::ENAMETOOLONG` の原因になり得ることが issue #72 の根本問題であり、note2web は
  このメソッドを一切呼ばない)。各ファイルの中身は upstream の `AppleNote#generate_html
  (individual_files: true, use_uuid: true)` が返すフラグメントをそのまま
  `<!doctype html><html><body>…</body></html>` で包んだもの(以前の `note-card` 外枠 div や
  `<head>`/`<style>`/`<title>` は note2web 独自スクリプトが省略しているため含まない)
- **JSON からノートの `"html"`(結合 HTML)・トップレベルの `"html"`/`"accounts"`/
  `"cloudkit_participants"` フィールドを省略した**: note2web は使わないため
  (`ruby/note2web_export.rb` は JSON を upstream の `note_store.prepare_json`
  丸ごとではなく、`Note2webExportCore` の組み立てヘルパーで独自に構築するため、
  もともとこれらのフィールドは生成されない)
- **`skipped_encrypted[]` / `skipped_errors[]` が新設された**: パスワード保護ノート
  (復号を試みずスキップ)・対象内ノート1件のデコード/生成失敗(処理は継続)を、
  それぞれ記録する(`src/exporter/apple-notes.ts` が `logger.warn` に変換する)
- 個別 HTML 内の添付・描画へのリンク(`<a href>`/`<img src>` の相対パス。例:
  `../../../files/Accounts/…`)は upstream の `to_relative_root`(フォルダの深さに
  応じた `../` の数)をそのまま引き継いでいるため、**新しいフラット配置(`html/<uuid>.html`
  → `../files/…` が正しい)とは物理的に一致しない**。これは意図的に直していない:
  `src/transform/body.ts`(BodyTransformer)はこの href/src の文字列を信頼せず、
  同じタグが持つ `data-apple-notes-zidentifier`(UUID)属性で `attachments[]` と
  突き合わせて解決するため、実害が無い(design.md §13-2)。詳細根拠は
  `ruby/note2web_export.rb` 冒頭コメント「早期フィルタの到達レベル」を参照

## upstream ソースの確認状況

`git ls-remote https://github.com/threeplanetssoftware/apple_cloud_notes_parser.git master`
で確認した限り、本タスク実施時点(2026-08-17)の master の HEAD は
`4754a2b62686570cca46690d101079e80cf6ae66` であり、T-08 SPIKE 時点で固定していた
コミットと **同一**(upstream に新しいコミットは無かった)。したがって以下の「確認方法」
節(T-08 由来)の内容は現行 master に対しても引き続き有効。issue #72 の Ruby 実装
(`ruby/note2web_export.rb`)は加えて `lib/AppleBackup.rb` / `lib/AppleBackupMac.rb` /
`lib/AppleNoteStore.rb` / `lib/AppleNote.rb` / `lib/AppleNotesFolder.rb` /
`lib/AppleNotesAccount.rb` / `lib/AppleCloudKitRecord.rb` を同じコミットから読解し、
`back_up_file`(添付コピー)・`rip_notes`/`rip_folders`(SQL クエリ)・
`write_individual_html`/`title_as_filename`(根本原因の所在)・`prepare_json` 系
メソッドの実装を確認した(ライセンス・詳細な参照箇所は `NOTICE` を参照)。

## 確認方法(重要な前提)

**実施環境には macOS も実機の Apple Notes データベースもない。** そのため要件の「実機確認」はこのタスクでは実施できない。代わりに以下の方法で事実確認を行った(design.md §13 に同じ注記あり):

1. **パーサ実装の実行**: `apple_cloud_notes_parser` を clone し(コミット `4754a2b62686570cca46690d101079e80cf6ae66`, 2026-07-25)、`bundle install` 済みの環境で、同梱の `spec/data/exported_blobs/*.bin`(実際の Apple Notes からエクスポートされた実データの gzip 化 protobuf)を `spec/base_classes/apple_note.rb` のテスト用セットアップ(`AppleNote.new` → `process_note` → `generate_html(individual_files:, use_uuid:)`)と同じ手順で読み込み、**パーサの実コードを実行**して HTML を得た。表(テーブル)については `spec/embedded_objects/tables.rb` と同じ手順で `AppleNotesEmbeddedTable` を直接実行した(ダミーの SQLite DB を用意して依存クエリを満たした)
2. **ソースコード読解**: 実行だけでは確認できない箇所(チェックリストの HTML 生成ルール本体、描画ファイルの保存パス規約、JSON シリアライズの実装、個別 HTML ファイルの命名規則)は `lib/` 以下のソースを直接読んで確認した
3. **公式ドキュメント**: `JSON.md`(パーサ同梱)を参照し、ソースの `prepare_json` 実装と突き合わせて整合を確認した

**実施していないこと**: macOS 実機で `NoteStore.sqlite` を用意し、パーサをエンドツーエンドで実行して出力を得ることは行っていない。したがって「実データベース由来の未知のエッジケース」(例: iOS バージョンごとの差異、暗号化ノート、共有ノートなど)が本フィクスチャに反映されていない可能性がある。

## ディレクトリ構成の根拠

`ruby/note2web_export.rb`(note2web 独自スクリプト)を読むと、出力は次の構成になる:

```text
<output_dir>/
  html/
    <uuid>.html                         # ノート単位の個別 HTML(フラット。issue #72)
  json/
    all_notes_<N>.json
  files/
    Accounts/<アカウント ZIDENTIFIER>/...  # 添付・描画の実体。upstream がそのまま書き出す
                                            # (端末上のパス Accounts/<uuid>/... を踏襲)。
                                            # note2web 独自スクリプトはここには関与しない
```

`<uuid>.html` のファイル名は `Note2webExportCore.note_html_filename(uuid)` が
`"#{uuid}.html"` として組み立てる(タイトルは一切関与しない。issue #72 根本修正、
`ruby/lib/note2web_export_core.rb` 参照)。ファイルの中身自体
(`<div><h1><a id="note_<uuid>">…` 以下)は upstream の
`AppleNote#generate_html(individual_files: true, use_uuid: true)` の出力をそのまま
使っており、この部分の HTML 生成ロジック自体は T-08 SPIKE 時点の確認(以下「確認方法」
節)がそのまま根拠になる。添付・描画の実体(`files/`)のコピーは upstream の
`AppleNotesEmbeddedThumbnail`/`AppleNotesEmbeddedDrawing` 等が**オブジェクト生成時点
(=ノートのデコード時点)**で行う(`lib/AppleBackup.rb` `back_up_file`)ため、
note2web 独自スクリプトの対象フォルダ絞り込みとは無関係にコピーされる
(`ruby/note2web_export.rb` 冒頭コメント「既知の残存効果」参照)。

- `lib/AppleNote.rb` `title_as_filename`: `"#{unique_id(use_uuid)} - #{file_title}#{ext}"`
  (`file_title` は `title.tr('[\\/*"<>?|:]\'', '_')` でサニタイズ)——**note2web 独自
  スクリプトはこのメソッドを一切呼ばない**(issue #72 根本修正)
- `lib/AppleNotesFolder.rb` `to_relative_root`: 個別 HTML から `files/` への相対パスの
  `../` の数は、ルートフォルダのノートで `../../../`(3階層)、子フォルダのノートは
  ネストの深さ分 `../` が1つ増える——upstream の `generate_html` がこの計算をそのまま
  使うため、フラット配置になった現在の物理的な位置とは一致しない(上記「issue #72 での
  変更点」参照。実害はない)

**既知の実装上の癖(ソースで確認・そのままフィクスチャに反映)**: ノート個別 HTML 内の「Account:」リンクは `@folder.to_account_root`(**引数無しで呼ばれるため常に `individual_files=false` 扱いになる**)を使っており、フォルダの深さに関わらず常に `../index.html` になる(`lib/AppleNote.rb:470`)。素直に実装すると深さに応じて `../../index.html` 等になりそうだが、実際のソースはそうなっていない。本フィクスチャの note HTML はこの実挙動どおりに `../index.html` を使っている(これも同様に実害はない — `index.html` 自体を note2web 独自スクリプトは生成しない)

## フィクスチャの内容

1 アカウント(`Sample Notes`)、3 フォルダ(`Tech` がルート、`Archive` が `Tech` の子フォルダ、`Dev/Ops: Log` が記号を含むルートフォルダ)、5 ノート + `skipped_encrypted`/`skipped_errors` に1件ずつ(いずれも `html/`/`files/` に実体を持たない、JSON のみのエントリ)。UUID・時刻・本文はすべて架空のダミー値(実データは一切含まれない)。

| ノート | UUID | フォルダ | 検証対象 | 確認区分 |
|---|---|---|---|---|
| Q3 Sales Table | `44444444-…` | Tech(ルート) | `<table>` の実出力構造(FR-11) | **実行検証**: `AppleNotesEmbeddedTable#generate_html` を実データ blob (`table_gzipped.bin`) で直接実行し、出力された `<table><tr><td>…` の構造をセル内容だけ差し替えて使用 |
| Grocery Checklist | `55555555-…` | Tech(ルート) | チェックリストの HTML 表現(§13-1, FR-12) | **実行検証**: `list_indents_gzipped.bin`(実データ)を `AppleNote#generate_html` で実行し、`<ul class="checklist" data-apple-notes-indent-amount="N"><li class="checked">` / `<li class="unchecked">` のネスト構造を実出力のまま流用(テキストのみ差し替え) |
| Whiteboard Sketch | `66666666-…` | Tech(ルート) | 描画(drawing)の抽出・参照形式(§13-2, FR-13) | **ソース確認 + 経路推論**: `AppleNotesEmbeddedDrawing`(`lib/AppleNotesEmbeddedDrawing.rb`)のファイル配置規約と `generate_html_with_images`(`lib/AppleNotesEmbeddedObject.rb`)の `<a><img></a>` 生成コードを読解して構成。フォールバック画像そのもの(実データの手書き protobuf)は exported_blobs に含まれていないため、この部分は実行検証ではない |
| 🚀 Launch Notes | `77777777-…` | Tech/Archive(子フォルダ) | 絵文字タイトル・ハッシュタグ・ネストフォルダ(FR-04〜07) | **ソース確認**: `AppleNotesEmbeddedInlineHashtag#to_s` がプレーンテキストの `#タグ` をそのまま返す(ラップ用タグなし)ことをソースで確認。絵文字タイトル自体は emoji_formatting 系 blob の実行結果(本文中の絵文字保持)と整合 |
| Ops Log | `eeeeeeee-…` | Dev/Ops: Log(記号入りルート) | フォルダ名にスラッシュ・コロンを含む場合でも JSON の `folder`/`folders` は非サニタイズの生の名前を保つこと(§5.2) | **ソース確認**: `AppleNotesFolder#name` はそのままの文字列(サニタイズ無し)を返すことをソースで確認。`Note2webExportCore.build_folder_json`(issue #72)はこれをそのまま JSON へ通す |
| Vault Passwords(`skipped_encrypted[0]`) | `ffffffff-…` | (該当フォルダに存在するが対象外に生成されない) | 暗号化(パスワード保護)ノートのスキップ(issue #72、design.md §5.2) | **ソース確認 + 単体テスト**: `AppleNote#is_password_protected`(`ZICCLOUDSYNCINGOBJECT.ZISPASSWORDPROTECTED` 由来)を読解し判定に採用。`ruby/test/note2web_export_core_test.rb` の `encrypted_note?` 系テストで検証 |
| Corrupted Note(`skipped_errors[0]`) | `12121212-…` | (対象内だがデコード/生成に失敗した想定) | 対象内ノート1件の失敗が全体を中断しないこと(issue #72、design.md §5.2) | **設計に基づく合成**: `ruby/note2web_export.rb` のノート単位 `begin/rescue` が捕捉する例外を模したダミー値(実際にこのメッセージを出す実データ・実行結果ではない) |
| (JSON トップレベル `folders`/`notes`) | — | — | JSON スキーマ(§13-7、issue #72で `skipped_encrypted`/`skipped_errors` 追加) | **ソース確認 + 公式ドキュメント + 単体テスト**: `JSON.md` と `lib/AppleNoteStore.rb#prepare_json` / `AppleNote#prepare_json` / `AppleNotesFolder#prepare_json` を直接読解し、フィールド名をそのまま採用(ただし組み立て自体は `Note2webExportCore` が独自に行う。upstream の `prepare_json` を丸ごとは呼ばない)。時刻書式 (`"YYYY-MM-DD HH:MM:SS +0000"`) は `Time#to_s` の実出力(T-08 SPIKE 時点で実行確認済み)。`skipped_encrypted`/`skipped_errors` の形は `ruby/test/note2web_export_core_test.rb` の `build_skipped_*_entry` テストで検証 |

### JSON との対応関係の注意

note2web 独自スクリプト(issue #72)は、upstream の `note_store.prepare_json`(ノートの
`"html"` フィールドや、フォルダ/アカウント一覧の結合 HTML を含む結果)を丸ごとは使わず、
`Note2webExportCore` の組み立てヘルパーで JSON を独自に構築する。そのため本フィクスチャの
JSON にはノートの `"html"` フィールドやトップレベルの `"html"`/`"accounts"`/
`"cloudkit_participants"` は**そもそも存在しない**(T-08 SPIKE 時点のフィクスチャには
あったが、issue #72 で不要になったため削除した)。本文取得は常に `html/<uuid>.html`
(個別 HTML ファイル)を UUID で直接解決する(design.md §5.2)。

### 省略した実データ

- `note_proto`(protobuf のデコード結果)は upstream の `AppleNote#prepare_json` には
  含まれるが、`Note2webExportCore` の JSON 組み立てはこれを使わないため、そもそも
  本フィクスチャの JSON には含まれない
- `csv/` 配下の出力は note2web 独自スクリプトが生成しないため含まれない(upstream の
  `notes_cloud_ripper.rb` は生成するが、`ruby/note2web_export.rb` はそれを呼ばない)

## 匿名化方針

- UUID はすべて `xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx` 形式の固定ダミー値(`4`/`8` 桁目は UUID v4 の形式に寄せた見た目上のダミーで、実際のバージョンビットではない)
- 本文・タイトル・時刻はすべて架空
- `files/` 配下の画像は 1x1 の透明 PNG(実データではない)
- ノート個別 HTML のファイル名(`html/<uuid>.html`)はタイトルを一切含まない
  (`Note2webExportCore.note_html_filename`。issue #72 根本修正)ため、以前あった
  タイトルのファイル名サニタイズ規則(`title.tr('[\\/*"<>?|:]\'', '_')`)は
  もはや本フィクスチャの対象ではない
