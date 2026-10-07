from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.data_store import DataCorruptionError, FitterDataDocument, FitterDataStore
from app.starter_content import default_starter_path


def test_first_run_has_approved_boards_modules_and_no_private_results(tmp_path: Path):
    path = tmp_path / "data.json"
    loaded = FitterDataStore(path, starter_path=default_starter_path()).load()
    document = loaded.document
    assert loaded.source == "empty"
    assert document.revision == 0 and not path.exists()
    assert [entry.board.name for entry in document.boards.saved_boards] == ["掠夺者", "初始飞船"]
    assert [sum(sum(row) for row in entry.board.mask) for entry in document.boards.saved_boards] == [294, 478]
    assert len(document.workspace.document.modules) == 23
    assert not document.boards.history and not document.fittings.entries and not document.solution_history.models
    assert not document.workspace.document.build.placements
    assert document.workspace.solver.last_result is None
    assert document.workspace.fitting.active_fitting_id is None


def test_upgrade_and_deleted_presets_preserve_existing_data_byte_for_byte(tmp_path: Path):
    path = tmp_path / "data.json"
    store = FitterDataStore(path, starter_path=default_starter_path())
    payload = store.load().document.model_dump(by_alias=True, mode="json")
    payload["revision"] = 1
    payload["boards"]["savedBoards"] = []
    payload["workspace"]["document"]["modules"][0]["name"] = "用户自己的装备"
    store.save(FitterDataDocument.model_validate(payload))
    before = path.read_bytes()
    # A missing/broken/new default package must not affect existing user data.
    loaded = FitterDataStore(path, starter_path=tmp_path / "not-present.json").load()
    assert loaded.source == "primary" and not loaded.document.boards.saved_boards
    assert loaded.document.workspace.document.modules[0].name == "用户自己的装备"
    assert path.read_bytes() == before


def test_corrupt_user_data_is_not_replaced_by_starter_content(tmp_path: Path):
    path = tmp_path / "data.json"
    path.write_text("{broken", encoding="utf-8")
    with pytest.raises(DataCorruptionError):
        FitterDataStore(path, starter_path=default_starter_path()).load()
    assert path.read_text() == "{broken"


def test_backup_takes_precedence_over_bundled_starter(tmp_path: Path):
    path = tmp_path / "data.json"
    store = FitterDataStore(path, starter_path=default_starter_path())
    payload = store.load().document.model_dump(by_alias=True, mode="json")
    payload["revision"] = 1
    payload["workspace"]["document"]["board"]["name"] = "用户棋盘"
    saved = store.save(FitterDataDocument.model_validate(payload))
    store.backup_path.write_text(saved.model_dump_json(by_alias=True), encoding="utf-8")
    path.write_text("broken", encoding="utf-8")
    loaded = store.load()
    assert loaded.source == "backup"
    assert loaded.document.workspace.document.board.name == "用户棋盘"


def test_invalid_starter_fails_closed_without_writing_a_user_file(tmp_path: Path):
    starter = tmp_path / "bad-starter.json"
    starter.write_text(json.dumps({"version": 1, "boards": [], "modules": []}))
    target = tmp_path / "user.json"
    with pytest.raises(DataCorruptionError):
        FitterDataStore(target, starter_path=starter).load()
    assert not target.exists()
