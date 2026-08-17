#!/usr/bin/env ruby
# frozen_string_literal: true

##
# note2web 独自の Apple Notes エクスポートスクリプト(design.md §5.2、issue #72)。
#
# == なぜこのファイルが存在するか
#
# 従来 note2web は upstream の `apple_cloud_notes_parser` の `notes_cloud_ripper.rb`
# をそのままサブプロセス実行していたが、upstream にはフォルダ単位のフィルタが無く
# (`AppleNoteStore#rip_notes` は Notes ストア全体を無条件に読む。下記「早期フィルタの
# 到達レベル」参照)、`--individual-files` の個別ファイル書き出し
# (`AppleNoteStore#write_individual_html` → `AppleNote#title_as_filename`)がタイトル由来の
# ファイル名を組み立てる際、`@notes.each` ループに `rescue` が無いため、**ストア中のどこか
# 1件でも**タイトルが極端に長い/壊れたノート(例: 数千文字の URL がそのままタイトルに
# なっているノート。「最近削除した項目」= ゴミ箱の中であっても)があると
# `Errno::ENAMETOOLONG` でプロセス全体が落ちる(issue #72 根本原因)。
#
# 本スクリプトはこの問題を、**upstream のこの書き込みメソッドを一切呼ばない**ことで
# 構造的に解消する: ノート本文の取得(`AppleNote#generate_html`)・JSON 化
# (`AppleNote#prepare_json` 等)は upstream のメソッドを使うが、実際のファイル書き込みは
# 本スクリプト自身が UUID のみをファイル名にして行う(`Note2webExportCore#note_html_filename`)。
# 加えて、対象外フォルダ(設定 `source.folders`、FR-02)・ゴミ箱・暗号化ノートは
# 生成/書き込みの対象から外し、対象内ノート1件のデコード失敗も `begin/rescue` で
# 隔離してプロセス全体を継続させる。
#
# == 早期フィルタの到達レベル(issue #72 correction A への回答)
#
# 「対象外フォルダは読み取らない」という要件に対し、理想的には NoteStore.sqlite への
# クエリ自体を対象フォルダに限定したかった。しかし `AppleNoteStore#rip_notes` の
# ノート選択クエリは iOS/macOS のバージョンごとに **9通り**の SQL 分岐
# (`ZACCOUNT2`〜`ZACCOUNT7`・`ZCREATIONDATE1`/`3`・legacy の `ZNOTE`/`ZSTORE` 等。
# `lib/AppleNoteStore.rb` `rip_note` 参照)を持ち、これを note2web 側で安全に再実装/
# 上書き(monkey patch)するには実機の各バージョンの NoteStore.sqlite でテストできる
# 環境が要る(本タスクの実行環境には無い)。誤ったクエリで一部バージョンのノートを
# 静かに読み落とすリスクの方が、本 issue の根本原因(書き込み時のタイトル由来ファイル名)
# より重大な回帰になり得ると判断し、**フォールバック水準**を採用した:
#
#   1. フォルダ(`AppleNoteStore#rip_folders`)は upstream にそのまま読ませる
#      (フォルダ数はノート数よりずっと少なく、読み取り自体の risk は低い)。
#   2. ノート本体(`AppleNoteStore#rip_notes`)も upstream にそのまま読ませる——
#      これは呼び出し必須(上記の理由)だが、**upstream 自身がここを1ノートずつ
#      `begin/rescue` している**(`rip_notes` 内の `rescue StandardError`)ため、
#      デコード自体は元から個別ノートの失敗がストア全体を巻き込まない設計になっている。
#      つまり実際に issue #72 を引き起こしていたのは「読み取り」ではなく「書き込み」段階
#      (`write_individual_html`)であり、そこを丸ごと自前実装に置き換えることが根本修正になる。
#   3. **生成・書き込み**(`generate_html` の実行・JSON への採用・ファイル書き込み)は、
#      対象フォルダのサブツリー(`Note2webExportCore.resolve_target_folder_ids`)に属し、
#      ゴミ箱でなく、暗号化されていないノートに限定する。対象外・ゴミ箱のノートは
#      generate_html を一度も呼ばず、ファイルも一切書かない(hard guarantee (1)(2))。
#      対象内ノートのデコード/生成失敗はここでさらに `begin/rescue` し、
#      `skipped_errors` に記録して処理を継続する(hard guarantee (3))。
#
# 既知の残存効果とその抑止(issue #73 CodeRabbit review Fix 6 で解消): 埋め込みオブジェクト
# (`AppleNotesEmbeddedDrawing`/`AppleNotesEmbeddedThumbnail` 等)は upstream の
# デコード(`rip_notes`)の**オブジェクト生成時点**で、最終的に `AppleBackup#back_up_file`
# 経由で `files/` へコピーされる。以前(issue #72 時点)はこれをノートの対象内/対象外を
# 問わず発生する「実害の無い残存効果」として許容していた(コピー自体はクラッシュを起こさず、
# 対象外ノートの `files/` エントリは note2web 側の JSON にも登場しないため参照されない
# =公開されない。単に一時エクスポートディレクトリ内に無害な余剰ファイルが残るだけだった)。
#
# issue #73 では、`Note2webAttachmentScopeGuard`(下記。`Module#prepend` による
# `AppleNotesEmbeddedObject#note=` / `AppleBackup#back_up_file` への差し込み)でこの残存
# コピーを構造的に抑止するようにした——ノートのフォルダが対象外(またはゴミ箱の
# サブツリー)だと判定できた場合のみ実ファイルコピーをスキップし、判定不能な場合は
# 常にコピーを許可する(フェイルオープン)。詳細は下記ガード定義のコメントを参照。
#
# == 起動方法
#
#   bundle exec ruby /path/to/note2web/ruby/note2web_export.rb \
#     -m <Notesコンテナディレクトリ> \
#     -o <出力ディレクトリ> \
#     --parser-lib <apple_cloud_notes_parser のクローン>/lib \
#     --folder "Tech" --folder "Dev/Ops: Log"
#
# `cwd` は `--parser-lib` の親(= upstream のクローンのルート、Gemfile がある場所)を
# 想定する(`bundle exec` が Gemfile を見つけられるようにするため。
# `src/exporter/apple-notes.ts` が `cwd: parser_path` で起動する)。
#
# == upstream ソース・ライセンス
#
# upstream: `apple_cloud_notes_parser`
# (https://github.com/threeplanetssoftware/apple_cloud_notes_parser, MIT License,
# Copyright Three Planets Software)。本スクリプトが requireする upstream ファイル自体は
# note2web に同梱しない(利用者が `--parser-lib` で指す外部クローンをそのまま使う)。
# 参照した upstream のコミット・詳細は `NOTICE`(リポジトリルート)を参照。
#
# == 出力(design.md §13-7 のスキーマを踏襲。`src/exporter/apple-notes.ts`
#    `parserJsonSchema` と厳密に一致させること)
#
#   <out_dir>/
#     html/<uuid>.html      # ノートごとの個別 HTML。フォルダ階層は作らない(フラット)
#     json/all_notes_1.json # { folders, notes, skipped_encrypted, skipped_errors, ... }
#     files/...             # 添付・描画の実体(upstream がそのまま書き出す。UUID 由来パス。
#                           # 対象外ノート分は下記の添付コピー抑止ガードで書き出しを抑止する)

require 'fileutils'
require 'json'
require 'optparse'
require 'pathname'

require_relative 'lib/note2web_export_core'

# ---------------------------------------------------------------------------
# 引数パース。
# ---------------------------------------------------------------------------

options = {
  notes_container: nil,
  output_dir: nil,
  parser_lib: nil,
  folders: [],
}

option_parser = OptionParser.new do |opts|
  opts.banner = 'Usage: note2web_export.rb -m DIR -o DIR --parser-lib DIR --folder NAME [--folder NAME ...]'

  opts.on('-m', '--mac DIRECTORY', 'Root directory of the Apple Notes container ' \
                                    '(i.e. group.com.apple.notes)') do |dir|
    options[:notes_container] = dir
  end

  opts.on('-o', '--output-dir DIRECTORY', 'Output directory') do |dir|
    options[:output_dir] = dir
  end

  opts.on('--parser-lib DIRECTORY', 'Path to the apple_cloud_notes_parser lib/ directory') do |dir|
    options[:parser_lib] = dir
  end

  opts.on('--folder NAME', 'Target folder name (repeatable, FR-02); ' \
                            'matches this folder and its full subtree') do |name|
    options[:folders] << name
  end
end

begin
  option_parser.parse!(ARGV)
rescue OptionParser::ParseError => e
  warn "note2web_export: invalid arguments: #{e.message}"
  exit 2
end

if options[:notes_container].nil? || options[:output_dir].nil? || options[:parser_lib].nil?
  warn 'note2web_export: -m, -o, and --parser-lib are all required'
  warn option_parser.to_s
  exit 2
end

if options[:folders].empty?
  warn 'note2web_export: at least one --folder is required (FR-02)'
  exit 2
end

notes_container = Pathname.new(options[:notes_container])
output_dir = Pathname.new(options[:output_dir])
parser_lib_dir = Pathname.new(options[:parser_lib])

# ---------------------------------------------------------------------------
# 事前条件の確認(致命的な前提。ここで失敗したら exit 非ゼロ・stderr 1行目が意味を持つ
# ようにする。design.md §10 相当のコントラクトを Ruby 側でも守る)。
# ---------------------------------------------------------------------------

unless (notes_container + 'NoteStore.sqlite').file?
  warn "note2web_export: NoteStore.sqlite not found under: #{notes_container}"
  exit 1
end

unless parser_lib_dir.directory?
  warn "note2web_export: --parser-lib directory not found: #{parser_lib_dir}"
  exit 1
end

%w[AppleBackup.rb AppleBackupMac.rb AppleNote.rb AppleNoteStore.rb AppleDecrypter.rb
   KeyedArchive.rb].each do |required_file|
  unless (parser_lib_dir + required_file).file?
    warn "note2web_export: expected upstream file not found: #{parser_lib_dir + required_file}"
    exit 1
  end
end

begin
  FileUtils.mkdir_p(output_dir)
  FileUtils.mkdir_p(output_dir + 'html')
  FileUtils.mkdir_p(output_dir + 'json')
rescue StandardError => e
  warn "note2web_export: failed to create output directory #{output_dir}: #{e.message}"
  exit 1
end

# ---------------------------------------------------------------------------
# upstream の require(§ 冒頭コメント参照。require_relative は各ファイル自身の位置基準で
# 解決されるため、ここでは絶対パスで各エントリだけを require すればよい)。
# ---------------------------------------------------------------------------

require (parser_lib_dir + 'KeyedArchive.rb').to_s
require (parser_lib_dir + 'AppleDecrypter.rb').to_s
require (parser_lib_dir + 'AppleBackup.rb').to_s
require (parser_lib_dir + 'AppleBackupMac.rb').to_s
require (parser_lib_dir + 'AppleNote.rb').to_s
require (parser_lib_dir + 'AppleNoteStore.rb').to_s

# ---------------------------------------------------------------------------
# 添付・描画コピー抑止ガード(design.md §5.2「既知の残存効果」、issue #73 CodeRabbit
# review Fix 6)。
#
# upstream は埋め込みオブジェクト(lib/AppleNotesEmbedded*.rb。Thumbnail/Drawing/
# PublicObject/PublicJpeg/… の10クラス以上)の**オブジェクト生成時点**
# (=ノートのデコード時点、後述の `note_store.rip_notes` 実行中)で、いずれも最終的に
# `AppleBackup#back_up_file`(lib/AppleBackup.rb。`FileUtils.cp` で実コピーを行う唯一の
# 箇所)を呼び出し、添付・描画の実体を `files/` へコピーする。この呼び出しはノートの
# 対象内/対象外を問わず発生する——note2web 側の対象フォルダ絞り込みは生成・書き込み
# 段階(下記 notes_json 組み立てループ)でしか効かないため(§ 冒頭「早期フィルタの
# 到達レベル」参照)。以前(issue #72)はこれを「実害の無い残存効果」として許容していた
# (対象外ノートの files/ エントリは JSON にも登場せず参照されないため公開はされない)が、
# 一時エクスポートディレクトリに無駄なファイルが残ること自体は避けられるなら避けたい。
#
# 実装方針(upstream commit 4754a2b62686570cca46690d101079e80cf6ae66 の
# lib/AppleNotesEmbeddedThumbnail.rb・lib/AppleNotesEmbeddedObject.rb・
# lib/AppleBackup.rb を実際に読んで検証済み。フェイルオープンを最優先する):
#   1. 全埋め込みオブジェクトの共通基底クラス AppleNotesEmbeddedObject#note=
#      (setter)を Module#prepend で差し込み、直近に設定された note のフォルダ id を
#      本モジュール自身に退避しておく。各埋め込みオブジェクトの initialize は
#      super(...) 経由でこの note= を「実ファイルコピーより先に」必ず呼ぶ
#      (全サブクラスのソースを確認済み)。
#   2. AppleBackup#back_up_file(実際に FileUtils.cp を行う唯一の箇所であり、全埋め込み
#      オブジェクトのクラスが最終的にここを呼ぶ)を Module#prepend で差し込み、直前に
#      退避しておいたフォルダ id がスコープ外だと判定できた場合のみ、コピーを行わず
#      nil を返す(upstream 自身もファイル不在等の理由でコピーをスキップする際は nil を
#      返すだけなので、戻り値の契約は変えていない)。
#   3. フォルダ id が特定できない(note が nil・folder が nil・想定外の例外)場合は
#      「判定不能」として必ずコピーを許可する(フェイルオープン)。対象内ノートの添付を
#      誤って壊すことは、対象外ノートの添付コピーが残ることより悪い。
#   4. スコープ(in_scope_folder_ids)は note_store ごとに異なり得るため、
#      `note_store.rip_notes` を呼ぶ直前にその store 用のスコープへ差し替える
#      (処理は note_store ごとに逐次実行されるため競合しない。埋め込みオブジェクトの
#      生成もノート単位で逐次実行され、スレッドや Fiber をまたがないため、
#      この退避場所を単純なモジュール変数にしても安全)。
module Note2webAttachmentScopeGuard
  class << self
    # 現在処理中の note_store のスコープ(`Set<Integer>`)。nil の間は判定不能として
    # 常にコピーを許可する(フェイルオープン。ガード未インストール相当・rip_notes 呼び出し
    # 前の状態に対応)。
    attr_accessor :in_scope_folder_ids
    # 直近に AppleNotesEmbeddedObject#note= で設定された note のフォルダ id。
    attr_accessor :current_folder_id
  end

  module NoteSetter
    def note=(note)
      result = super
      begin
        Note2webAttachmentScopeGuard.current_folder_id = note&.folder&.primary_key
      rescue StandardError
        # フェイルオープン: フォルダ id の取得に失敗しても note= 自体は成功させ、
        # 後続の back_up_file 側の判定を「判定不能」に倒す。
        Note2webAttachmentScopeGuard.current_folder_id = nil
      end
      result
    end
  end

  module BackupFileGuard
    def back_up_file(*args)
      in_scope_ids = Note2webAttachmentScopeGuard.in_scope_folder_ids
      folder_id = Note2webAttachmentScopeGuard.current_folder_id
      if in_scope_ids && !folder_id.nil? && !Note2webExportCore.folder_in_scope?(folder_id, in_scope_ids)
        return nil # 対象外ノートの添付: コピーをスキップする(フェイルクローズはここだけ)。
      end

      super
    end
  end
end

AppleNotesEmbeddedObject.prepend(Note2webAttachmentScopeGuard::NoteSetter)
AppleBackup.prepend(Note2webAttachmentScopeGuard::BackupFileGuard)

# ---------------------------------------------------------------------------
# upstream を使ってフォルダ・ノートを読み取る(§ 冒頭「早期フィルタの到達レベル」参照)。
# ---------------------------------------------------------------------------

decrypter = AppleDecrypter.new

begin
  apple_backup = AppleBackupMac.new(notes_container, output_dir, decrypter)
rescue StandardError => e
  warn "note2web_export: failed to open Apple Notes container: #{e.message}"
  exit 1
end

unless apple_backup.valid?
  warn "note2web_export: not a valid Apple Notes container (Mac backup): #{notes_container}"
  exit 1
end

unless apple_backup.note_stores.first&.valid_notes?
  warn "note2web_export: NoteStore.sqlite does not look like a valid Notes database: #{notes_container}"
  exit 1
end

# フォルダ・アカウントだけを先に読む(issue #73 Fix 6: 添付コピー抑止ガードのスコープを
# `note_store.rip_notes`(ノート本体のデコード。埋め込みオブジェクト生成・添付コピーは
# ここで発生する)より前に確定させる必要があるため、以前の `apple_backup.rip_notes`
# 一括呼び出し(内部で accounts/folders/notes をまとめて読む `rip_all_objects`)を、
# フォルダ・アカウント読み取りとノート本体読み取りの2段階に分けた)。
begin
  apple_backup.note_stores.each do |note_store|
    note_store.retain_order = apple_backup.retain_order
    note_store.open
    note_store.rip_accounts
    note_store.rip_folders
  end
rescue StandardError => e
  warn "note2web_export: failed to read Apple Notes folders: #{e.message}"
  exit 1
end

skipped_encrypted = []
skipped_errors = []
note_count = 0
backup_number = 0

apple_backup.note_stores.each do |note_store|
  backup_number += 1

  # ---------------------------------------------------------------------
  # フォルダ対象解決(design.md §5.2、FR-02)。upstream がロード済みの @folders から
  # プレーンな Hash を作り、`Note2webExportCore` の純粋関数へ渡す。
  # ---------------------------------------------------------------------
  plain_folders = note_store.folders.map do |folder_id, folder|
    { id: folder_id, name: folder.name, parent_id: folder.parent_id }
  end

  target_ids = Note2webExportCore.resolve_target_folder_ids(plain_folders, options[:folders])

  # ゴミ箱判定(issue #72 correction A: ZFOLDERTYPE 一次判定 + CloudKit レコード名二次判定)。
  # ZFOLDERTYPE は upstream の rip_folder クエリでは選択されないため、対象候補フォルダに
  # 限定した補助クエリを同じ DB ハンドル(note_store.database)で実行する。カラムが
  # 存在しない(古いスキーマ)場合は例外を rescue し、二次判定のみにフォールバックする。
  folder_types_by_id = {}
  if target_ids.any?
    begin
      placeholders = (['?'] * target_ids.size).join(',')
      note_store.database.execute(
        "SELECT Z_PK, ZFOLDERTYPE FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK IN (#{placeholders})",
        target_ids.to_a,
      ) do |row|
        folder_types_by_id[row['Z_PK']] = row['ZFOLDERTYPE']
      end
    rescue StandardError => e
      warn "note2web_export: warning: could not query ZFOLDERTYPE (falling back to CloudKit-only " \
           "trash detection): #{e.message}"
    end
  end

  # issue #73 CodeRabbit review Fix 4: 以前はここで「ゴミ箱フォルダ自身」だけを
  # 除外集合に入れていたため、ゴミ箱の中にさらに子フォルダがあった場合、その子フォルダに
  # 属するノートが除外対象から漏れる可能性があった。`trash_folder?` で判定した根
  # (trash_root_ids)に加え、その配下(サブツリー)全体を `expand_trash_descendant_ids`
  # で展開してから除外する。
  trash_root_ids = target_ids.select do |id|
    folder = note_store.folders[id]
    Note2webExportCore.trash_folder?(
      folder_type: folder_types_by_id[id],
      server_record_bytes: folder&.server_record_data,
    )
  end.to_set
  trash_ids = Note2webExportCore.expand_trash_descendant_ids(plain_folders, trash_root_ids)

  in_scope_folder_ids = target_ids - trash_ids

  # issue #73 CodeRabbit review Fix 6: このストアのノート本体(rip_notes)を読む前に
  # 添付コピー抑止ガードへスコープを反映する——rip_notes の実行中に埋め込みオブジェクトが
  # 生成され、そのタイミングで upstream が添付・描画の実コピーを行うため(§ 冒頭コメント
  # 参照)、ここで先に確定させておかないとガードが機能しない。
  Note2webAttachmentScopeGuard.in_scope_folder_ids = in_scope_folder_ids

  begin
    note_store.rip_notes
  rescue StandardError => e
    warn "note2web_export: failed to read notes for note store #{backup_number}: #{e.message}"
    exit 1
  end

  # ---------------------------------------------------------------------
  # JSON `folders`(トップレベル。design.md §13-7)。一致したサブツリーの根のみを
  # トップレベルに置き、その配下は再帰的に子として組み立てる。
  # ---------------------------------------------------------------------
  root_ids = Note2webExportCore.matched_subtree_root_ids(plain_folders, options[:folders]) - trash_ids
  children_by_parent = Hash.new { |hash, key| hash[key] = [] }
  plain_folders.each do |folder|
    children_by_parent[folder[:parent_id]] << folder[:id] unless folder[:parent_id].nil?
  end

  build_folder_tree = lambda do |folder_id|
    folder = note_store.folders[folder_id]
    child_json = {}
    children_by_parent[folder_id].each do |child_id|
      next unless in_scope_folder_ids.include?(child_id)

      child_json[child_id.to_s] = build_folder_tree.call(child_id)
    end
    Note2webExportCore.build_folder_json(
      id: folder.primary_key,
      uuid: folder.uuid,
      name: folder.name,
      account_id: folder.account.primary_key,
      account: folder.account.name,
      parent_folder_id: folder.parent_id,
      child_folders: child_json,
    )
  end

  folders_json = {}
  root_ids.each do |root_id|
    folders_json[root_id.to_s] = build_folder_tree.call(root_id)
  end

  # ---------------------------------------------------------------------
  # ノートの生成・書き込み(in_scope_folder_ids に属するノートのみ)。
  # ---------------------------------------------------------------------
  notes_json = {}
  html_dir = output_dir + 'html'

  note_store.notes.each do |note_id, note|
    folder = note.folder
    next if folder.nil? || !in_scope_folder_ids.include?(folder.primary_key)

    if Note2webExportCore.encrypted_note?(note.is_password_protected)
      skipped_encrypted << Note2webExportCore.build_skipped_encrypted_entry(uuid: note.uuid, title: note.title.to_s)
      next
    end

    begin
      embedded_objects_json = note.all_embedded_objects.map(&:prepare_json)
      hashtags = note.all_embedded_objects
                     .select { |embedded| embedded.is_a?(AppleNotesEmbeddedInlineHashtag) }
                     .map(&:to_s)

      note_json = Note2webExportCore.build_note_json(
        uuid: note.uuid,
        folder_key: folder.primary_key,
        folder: folder.name,
        title: note.title.to_s,
        creation_time: note.creation_time.to_s,
        modify_time: note.modify_time.to_s,
        embedded_objects: embedded_objects_json,
        hashtags: hashtags,
      )

      # 個別 HTML: upstream の `write_individual_html`/`title_as_filename` は一切呼ばない
      # (issue #72 根本原因)。ファイル名は UUID のみから構築する。
      filename = Note2webExportCore.note_html_filename(note.uuid)
      note_fragment = note.generate_html(individual_files: true, use_uuid: true)
      File.write((html_dir + filename).to_s, "<!doctype html>\n<html><body>#{note_fragment}</body></html>\n")

      notes_json[note_id.to_s] = note_json
      note_count += 1
    rescue StandardError => e
      skipped_errors << Note2webExportCore.build_skipped_error_entry(
        uuid: note.uuid,
        title: note.title.to_s,
        error: e.message,
      )
    end
  end

  json_payload = {
    'version' => note_store.version,
    'file_path' => (notes_container + 'NoteStore.sqlite').to_s,
    'folders' => folders_json,
    'notes' => notes_json,
    'skipped_encrypted' => skipped_encrypted,
    'skipped_errors' => skipped_errors,
  }

  File.write((output_dir + 'json' + "all_notes_#{backup_number}.json").to_s, JSON.generate(json_payload))
end

puts "note2web_export: wrote #{note_count} note(s), skipped #{skipped_encrypted.size} encrypted, " \
     "#{skipped_errors.size} error(s)"
exit 0
