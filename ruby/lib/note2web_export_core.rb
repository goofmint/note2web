# frozen_string_literal: true

require 'set'

##
# note2web 独自ロジック(design.md §5.2、issue #72)のうち、`apple_cloud_notes_parser`
# (upstream)に一切依存しない純粋な部分だけを集めたモジュール。
#
# `ruby/note2web_export.rb`(薄いエントリポイント)が upstream の `lib/` を requireし、
# upstream のオブジェクト(`AppleNote` / `AppleNotesFolder` 等)からプレーンな
# Hash/String/Integer を取り出したうえで、ここの関数へ渡す——という役割分担にすることで、
# このファイルだけは upstream の clone が無い環境でも `ruby -Iruby/lib
# ruby/test/note2web_export_core_test.rb` として単体テストできる(issue #72 corretion C)。
#
# 対応する note2web 側の実装(参考。同じ考え方を踏襲):
#   - フォルダ対象解決: `src/exporter/apple-notes.ts` の `buildFolderIndex` /
#     `resolveIncludedFolderIds`(FR-02、設定 `source.folders` のサブツリー一致)
module Note2webExportCore
  module_function

  # CloudKit のゴミ箱フォルダ(「最近削除した項目」)のレコード名。ZSERVERRECORDDATA
  # (CloudKit のシリアライズされたレコード)にこの文字列がバイト列として埋め込まれている
  # ことがある(issue #72 corretion A 二次判定)。
  TRASH_CLOUDKIT_RECORD_NAME = 'TrashFolder-CloudKit'
  private_constant :TRASH_CLOUDKIT_RECORD_NAME

  # `ZICCLOUDSYNCINGOBJECT.ZFOLDERTYPE` のうち「ゴミ箱(最近削除した項目)」を表す値
  # (issue #72 corretion A 一次判定)。
  TRASH_FOLDER_TYPE = 1
  private_constant :TRASH_FOLDER_TYPE

  # ---------------------------------------------------------------------
  # フォルダ対象解決(design.md §5.2「対象外フォルダは読み取らない」FR-02)。
  # ---------------------------------------------------------------------

  # `folders` は `{id:, name:, parent_id:}` の Hash の Array(`parent_id` は無ければ
  # `nil`)。`target_names` は設定 `source.folders`(FR-02)の値。
  #
  # `target_names` のいずれかと `name` が一致するフォルダ、および**その配下(サブツリー)
  # 全体**の `id` を Set で返す(一致はツリー中のどの深さでもよい)。
  # `src/exporter/apple-notes.ts` の `resolveIncludedFolderIds` と同一のアルゴリズム
  # (名前一致 → BFS で子孫へ展開)。
  def resolve_target_folder_ids(folders, target_names)
    target_set = target_names.to_set

    children_by_parent = Hash.new { |hash, key| hash[key] = [] }
    folders.each do |folder|
      parent_id = folder[:parent_id]
      children_by_parent[parent_id] << folder[:id] unless parent_id.nil?
    end

    included = Set.new
    queue = folders.select { |folder| target_set.include?(folder[:name]) }.map { |folder| folder[:id] }

    until queue.empty?
      id = queue.shift
      next if included.include?(id)

      included << id
      children_by_parent[id].each { |child_id| queue << child_id }
    end

    included
  end

  # `resolve_target_folder_ids` が返す集合のうち、「一致したサブツリーの根」だけを返す
  # (名前が一致したフォルダ自身の祖先に、同じく名前が一致したフォルダが無いもの)。
  # JSON トップレベルの `folders`(ルートのみを key に持つ、design.md §13-7)を
  # 組み立てる際、一致したフォルダを二重に(親の `child_folders` の中と、トップレベルの
  # 両方に)出さないようにするために使う。
  def matched_subtree_root_ids(folders, target_names)
    target_set = target_names.to_set
    by_id = folders.each_with_object({}) { |folder, hash| hash[folder[:id]] = folder }
    matched_ids = folders.select { |folder| target_set.include?(folder[:name]) }.map { |folder| folder[:id] }.to_set

    matched_ids.select do |id|
      ancestor_id = by_id[id]&.fetch(:parent_id, nil)
      is_root = true
      while ancestor_id
        if matched_ids.include?(ancestor_id)
          is_root = false
          break
        end
        ancestor_id = by_id[ancestor_id]&.fetch(:parent_id, nil)
      end
      is_root
    end.to_set
  end

  # ---------------------------------------------------------------------
  # ゴミ箱判定(design.md §5.2「対象がゴミ箱と名前が一致しても除外」issue #72 corretion A)。
  # ---------------------------------------------------------------------

  # `folder_type` は `ZICCLOUDSYNCINGOBJECT.ZFOLDERTYPE`(取得できない/カラムが存在しない
  # 場合は `nil`)。`server_record_bytes` は `ZSERVERRECORDDATA`(`ZSERVERRECORD`)の生バイト列
  # (`String` または `nil`)。名前がターゲットと一致していても、ゴミ箱と判定されたフォルダは
  # 常に除外する(「トラッシュ excluded even if its name matches a target」)。
  def trash_folder?(folder_type: nil, server_record_bytes: nil)
    return true if folder_type == TRASH_FOLDER_TYPE
    return true if server_record_bytes.is_a?(String) && server_record_bytes.include?(TRASH_CLOUDKIT_RECORD_NAME)

    false
  end

  # ---------------------------------------------------------------------
  # 暗号化(パスワード保護)ノート判定。
  # ---------------------------------------------------------------------

  # `is_password_protected` は `ZICCLOUDSYNCINGOBJECT.ZISPASSWORDPROTECTED` 由来の真偽値
  # (upstream の `AppleNote#is_password_protected`)。復号は一切試みず、この値だけで判定する
  # (design.md §5.2「暗号化ノートは復号せずスキップ」)。
  def encrypted_note?(is_password_protected)
    is_password_protected == true
  end

  # ---------------------------------------------------------------------
  # UUID ベースのファイル名構築(design.md §5.2「ファイル/出力操作は一切タイトル由来の
  # 名前を使わない」issue #72 の根本修正)。
  # ---------------------------------------------------------------------

  # ノート個別 HTML のファイル名を UUID のみから組み立てる。タイトルは一切関与しない
  # (upstream の `AppleNote#title_as_filename` が原因の `Errno::ENAMETOOLONG` を
  # 構造的に排除する。issue #72 根本原因)。
  def note_html_filename(uuid)
    normalized = uuid.to_s.strip
    raise ArgumentError, 'note_html_filename: uuid must not be blank' if normalized.empty?

    "#{normalized}.html"
  end

  # ---------------------------------------------------------------------
  # JSON 組み立てヘルパー(`src/exporter/apple-notes.ts` の `parserJsonSchema` と
  # フィールド名を一致させる。design.md §13-7)。
  # ---------------------------------------------------------------------

  # JSON トップレベル `folders` の1エントリ(またはその子孫)を組み立てる。
  # `child_folders` は呼び出し側が既に組み立てた `{id_string => folder_json}` の Hash。
  def build_folder_json(id:, uuid:, name:, account_id:, account:, parent_folder_id:, child_folders: {})
    {
      'primary_key' => id,
      'uuid' => uuid,
      'name' => name,
      'account_id' => account_id,
      'account' => account,
      'parent_folder_id' => parent_folder_id,
      'child_folders' => child_folders,
    }
  end

  # JSON トップレベル `notes` の1エントリを組み立てる(`src/exporter/apple-notes.ts` の
  # `noteJsonSchema` が要求するフィールドのみ)。`embedded_objects` / `hashtags` は
  # 呼び出し側(エントリポイント)が upstream のオブジェクトから抽出した Array を渡す。
  def build_note_json(uuid:, folder_key:, folder:, title:, creation_time:, modify_time:, embedded_objects:,
                       hashtags:)
    {
      'uuid' => uuid,
      'folder_key' => folder_key,
      'folder' => folder,
      'title' => title,
      'creation_time' => creation_time,
      'modify_time' => modify_time,
      'embedded_objects' => embedded_objects,
      'hashtags' => hashtags,
    }
  end

  # `skipped_encrypted`(JSON トップレベルの追加配列)の1エントリ。
  def build_skipped_encrypted_entry(uuid:, title:)
    { 'uuid' => uuid, 'title' => title }
  end

  # `skipped_errors`(JSON トップレベルの追加配列)の1エントリ。ノート単位の例外
  # (design.md §5.2「対象内ノートの1件のデコード失敗で全体を中断しない」)を記録する。
  def build_skipped_error_entry(uuid:, title:, error:)
    { 'uuid' => uuid, 'title' => title, 'error' => error }
  end
end
