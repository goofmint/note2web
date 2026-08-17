# frozen_string_literal: true

# `Note2webExportCore` の単体テスト(issue #72 correction C)。upstream
# (`apple_cloud_notes_parser`)の clone を一切必要とせず、このファイル単体で完結する。
#
# 実行方法: `ruby -Iruby/lib ruby/test/note2web_export_core_test.rb`
# (npm script `test:ruby` が `ruby/test/*_test.rb` を全件この形で実行する)

require 'minitest/autorun'
require 'note2web_export_core'

class Note2webExportCoreTest < Minitest::Test
  # ---------------------------------------------------------------------
  # resolve_target_folder_ids
  # ---------------------------------------------------------------------

  def folders_fixture
    [
      { id: 10, name: 'Tech', parent_id: nil },
      { id: 11, name: 'Archive', parent_id: 10 },
      { id: 12, name: 'Dev/Ops: Log', parent_id: nil },
      { id: 13, name: 'Personal', parent_id: nil },
      { id: 14, name: 'Recently Deleted', parent_id: nil },
    ]
  end

  def test_resolve_target_folder_ids_matches_root_and_subtree
    included = Note2webExportCore.resolve_target_folder_ids(folders_fixture, ['Tech'])
    assert_equal Set[10, 11], included
  end

  def test_resolve_target_folder_ids_matches_nested_child_directly
    included = Note2webExportCore.resolve_target_folder_ids(folders_fixture, ['Archive'])
    assert_equal Set[11], included
  end

  def test_resolve_target_folder_ids_supports_multiple_names
    included = Note2webExportCore.resolve_target_folder_ids(folders_fixture, ['Tech', 'Dev/Ops: Log'])
    assert_equal Set[10, 11, 12], included
  end

  def test_resolve_target_folder_ids_excludes_unmatched_folders
    included = Note2webExportCore.resolve_target_folder_ids(folders_fixture, ['Personal'])
    assert_equal Set[13], included
    refute included.include?(10)
    refute included.include?(14)
  end

  def test_resolve_target_folder_ids_returns_empty_set_for_no_match
    included = Note2webExportCore.resolve_target_folder_ids(folders_fixture, ['Does Not Exist'])
    assert_empty included
  end

  def test_resolve_target_folder_ids_deep_nesting
    deep = [
      { id: 1, name: 'A', parent_id: nil },
      { id: 2, name: 'B', parent_id: 1 },
      { id: 3, name: 'C', parent_id: 2 },
      { id: 4, name: 'D', parent_id: 3 },
    ]
    included = Note2webExportCore.resolve_target_folder_ids(deep, ['B'])
    assert_equal Set[2, 3, 4], included
  end

  # ---------------------------------------------------------------------
  # matched_subtree_root_ids
  # ---------------------------------------------------------------------

  def test_matched_subtree_root_ids_dedupes_ancestor_and_descendant_match
    # Tech と Archive(Tech の子)の両方が対象名として指定された場合、JSON の
    # トップレベルに二重で出さないよう、根である Tech のみを返す。
    roots = Note2webExportCore.matched_subtree_root_ids(folders_fixture, ['Tech', 'Archive'])
    assert_equal Set[10], roots
  end

  def test_matched_subtree_root_ids_returns_each_independent_match
    roots = Note2webExportCore.matched_subtree_root_ids(folders_fixture, ['Tech', 'Dev/Ops: Log'])
    assert_equal Set[10, 12], roots
  end

  def test_matched_subtree_root_ids_returns_nested_folder_when_ancestor_not_matched
    roots = Note2webExportCore.matched_subtree_root_ids(folders_fixture, ['Archive'])
    assert_equal Set[11], roots
  end

  # ---------------------------------------------------------------------
  # trash_folder?
  # ---------------------------------------------------------------------

  def test_trash_folder_true_for_folder_type_1
    assert Note2webExportCore.trash_folder?(folder_type: 1)
  end

  def test_trash_folder_false_for_other_folder_types
    refute Note2webExportCore.trash_folder?(folder_type: 0)
    refute Note2webExportCore.trash_folder?(folder_type: nil)
  end

  def test_trash_folder_true_when_cloudkit_record_bytes_contain_marker
    bytes = "\x00\x01bplist00TrashFolder-CloudKit\xFF"
    assert Note2webExportCore.trash_folder?(folder_type: nil, server_record_bytes: bytes)
  end

  def test_trash_folder_false_when_neither_signal_present
    refute Note2webExportCore.trash_folder?(folder_type: 0, server_record_bytes: 'unrelated bytes')
  end

  def test_trash_folder_ignores_non_string_server_record_bytes
    refute Note2webExportCore.trash_folder?(folder_type: nil, server_record_bytes: nil)
  end

  def test_trash_folder_excludes_even_when_name_would_match_a_target
    # design.md §5.2 / issue #72: 名前が対象と一致していても、ゴミ箱判定される
    # フォルダは呼び出し側(エントリポイント)で対象集合から除外される。ここでは
    # trash_folder? 自体が folder_type だけで判定できることだけを確認する。
    assert Note2webExportCore.trash_folder?(folder_type: 1, server_record_bytes: nil)
  end

  # ---------------------------------------------------------------------
  # encrypted_note?
  # ---------------------------------------------------------------------

  def test_encrypted_note_true
    assert Note2webExportCore.encrypted_note?(true)
  end

  def test_encrypted_note_false_for_false
    refute Note2webExportCore.encrypted_note?(false)
  end

  def test_encrypted_note_false_for_nil
    refute Note2webExportCore.encrypted_note?(nil)
  end

  # ---------------------------------------------------------------------
  # note_html_filename
  # ---------------------------------------------------------------------

  def test_note_html_filename_uses_uuid_only
    assert_equal '44444444-4444-4444-8444-444444444444.html',
                 Note2webExportCore.note_html_filename('44444444-4444-4444-8444-444444444444')
  end

  def test_note_html_filename_raises_for_blank_uuid
    assert_raises(ArgumentError) { Note2webExportCore.note_html_filename('') }
    assert_raises(ArgumentError) { Note2webExportCore.note_html_filename('   ') }
    assert_raises(ArgumentError) { Note2webExportCore.note_html_filename(nil) }
  end

  def test_note_html_filename_is_immune_to_pathologically_long_titles
    # issue #72 の根本原因の再現テスト: タイトルは一切引数にならないため、
    # どれだけ長い/壊れたタイトルのノートであってもファイル名は UUID 由来のまま一定。
    uuid = '55555555-5555-4555-8555-555555555555'
    filename = Note2webExportCore.note_html_filename(uuid)
    assert_equal 41, filename.length # 36 (uuid) + '.html' (5)
  end

  # ---------------------------------------------------------------------
  # JSON assembly helpers
  # ---------------------------------------------------------------------

  def test_build_folder_json_shape
    json = Note2webExportCore.build_folder_json(
      id: 10,
      uuid: '22222222-2222-4222-8222-222222222222',
      name: 'Tech',
      account_id: 1,
      account: 'Sample Notes',
      parent_folder_id: nil,
      child_folders: {},
    )
    assert_equal(
      {
        'primary_key' => 10,
        'uuid' => '22222222-2222-4222-8222-222222222222',
        'name' => 'Tech',
        'account_id' => 1,
        'account' => 'Sample Notes',
        'parent_folder_id' => nil,
        'child_folders' => {},
      },
      json,
    )
  end

  def test_build_note_json_shape
    json = Note2webExportCore.build_note_json(
      uuid: '44444444-4444-4444-8444-444444444444',
      folder_key: 10,
      folder: 'Tech',
      title: 'Q3 Sales Table',
      creation_time: '2026-01-10 09:15:00 +0000',
      modify_time: '2026-01-12 18:42:00 +0000',
      embedded_objects: [],
      hashtags: [],
    )
    assert_equal %w[uuid folder_key folder title creation_time modify_time embedded_objects hashtags].sort,
                 json.keys.sort
    assert_equal 'Tech', json['folder']
    assert_equal 10, json['folder_key']
  end

  def test_build_skipped_encrypted_entry_shape
    entry = Note2webExportCore.build_skipped_encrypted_entry(uuid: 'u-1', title: 'Secret')
    assert_equal({ 'uuid' => 'u-1', 'title' => 'Secret' }, entry)
  end

  def test_build_skipped_error_entry_shape
    entry = Note2webExportCore.build_skipped_error_entry(uuid: 'u-2', title: 'Broken', error: 'boom')
    assert_equal({ 'uuid' => 'u-2', 'title' => 'Broken', 'error' => 'boom' }, entry)
  end
end
