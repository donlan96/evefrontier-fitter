from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main as main_module
from app.data_store import (
    DATA_SCHEMA_VERSION,
    DataCorruptionError,
    FitterDataDocument,
    FitterDataStore,
    RevisionConflictError,
    default_data_path,
    empty_fitter_data,
)
from app.main import app
from app.models import BoardDefinition, ModuleDefinition, ModuleRule, Point, SolveRequest
from app.solver.diagnostics import SolverDiagnostics


def next_document(revision: int, marker: str, payload_size: int = 0) -> FitterDataDocument:
    value = empty_fitter_data().model_dump(by_alias=True, mode="json")
    value["revision"] = revision
    value["savedAt"] = f"2026-09-12T00:00:0{revision}.000Z"
    value["workspace"] = {
        "snapshotVersion": 3,
        "savedAt": value["savedAt"],
        "document": {
            "documentType": "eve-frontier-grid-fitting",
            "schemaVersion": 1,
            "board": {"id": "board", "name": marker, "width": 1, "height": 1, "mask": [[1]]},
            "modules": [],
            "build": {"id": "build", "name": "build", "boardId": "board", "placements": []},
        },
        "fitting": {"activeFittingId": None, "name": "fit", "description": "x" * payload_size},
        "solver": {
            "rules": [],
            "scope": "fill-current",
            "timeLimitMs": 30_000,
            "lockedPlacementIds": [],
            "lastResult": None,
            "lastResultFingerprint": None,
        },
    }
    return FitterDataDocument.model_validate(value)


def workspace_marker(document: FitterDataDocument) -> str:
    assert document.workspace is not None
    return document.workspace.document.board.name


def unproven_history_entry() -> dict:
    return {
        "id": "history-unproven",
        "savedAt": "2026-09-13T00:00:00.000Z",
        "layoutSignature": "empty-layout",
        "savedScore": 0,
        "moduleShapeSignatures": {},
        "solution": {
            "id": "solution-unproven",
            "placements": [],
            "requiredSatisfied": True,
            "moduleCounts": {},
            "totalScore": 0,
            "occupiedCells": 0,
            "utilization": 0,
            "remainingCells": 1,
            "isolatedEmptyCells": 1,
            "emptyRegionCount": 1,
            "elapsedMs": 0,
        },
    }


def test_empty_store_starts_with_supported_schema(tmp_path: Path) -> None:
    loaded = FitterDataStore(tmp_path / "fitter-data.json").load()
    assert loaded.source == "empty"
    assert loaded.document.schema_version == DATA_SCHEMA_VERSION
    assert loaded.document.revision == 0


def test_default_data_path_uses_local_app_data(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("EVE_FRONTIER_FITTER_DATA_PATH", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))

    assert default_data_path() == tmp_path / "EveFrontierFitter" / "data" / "fitter-data.json"


def test_atomic_save_rotates_one_verified_backup(tmp_path: Path) -> None:
    path = tmp_path / "fitter-data.json"
    store = FitterDataStore(path)
    store.save(next_document(1, "first"))
    store.save(next_document(2, "second"))

    assert workspace_marker(store.load().document) == "second"
    backup = json.loads(path.with_suffix(".json.bak").read_text(encoding="utf-8"))
    assert backup["revision"] == 1
    assert backup["workspace"]["document"]["board"]["name"] == "first"


def test_corrupt_primary_loads_backup_and_repair_preserves_it(tmp_path: Path) -> None:
    path = tmp_path / "fitter-data.json"
    store = FitterDataStore(path)
    first = next_document(1, "first")
    store.save(first)
    store.save(next_document(2, "second"))
    path.write_text("{broken", encoding="utf-8")

    recovered = store.load()
    assert recovered.source == "backup"
    assert recovered.document.revision == 1
    store.save(next_document(2, "repaired"))

    assert workspace_marker(store.load().document) == "repaired"
    backup = FitterDataDocument.model_validate_json(path.with_suffix(".json.bak").read_bytes())
    assert workspace_marker(backup) == "first"


def test_nested_invalid_primary_loads_valid_backup_without_rotating_corruption(tmp_path: Path) -> None:
    path = tmp_path / "fitter-data.json"
    store = FitterDataStore(path)
    store.save(next_document(1, "backup"))
    store.save(next_document(2, "primary"))
    corrupt = json.loads(path.read_text(encoding="utf-8"))
    corrupt["workspace"]["solver"]["rules"] = "not-an-array"
    path.write_text(json.dumps(corrupt), encoding="utf-8")

    recovered = store.load()
    assert recovered.source == "backup"
    assert workspace_marker(recovered.document) == "backup"
    store.save(next_document(2, "repaired"))
    assert workspace_marker(FitterDataDocument.model_validate_json(path.with_suffix(".json.bak").read_bytes())) == "backup"


def test_nested_invalid_primary_and_backup_fail_closed(tmp_path: Path) -> None:
    path = tmp_path / "fitter-data.json"
    invalid = empty_fitter_data().model_dump(by_alias=True, mode="json")
    invalid["boards"]["savedBoards"] = "not-an-array"
    path.write_text(json.dumps(invalid), encoding="utf-8")
    invalid["boards"] = {"version": 3, "savedBoards": [], "history": "not-an-array"}
    path.with_suffix(".json.bak").write_text(json.dumps(invalid), encoding="utf-8")

    with pytest.raises(DataCorruptionError):
        FitterDataStore(path).load()


def test_corrupt_primary_and_backup_fail_closed(tmp_path: Path) -> None:
    path = tmp_path / "fitter-data.json"
    path.write_text("{broken", encoding="utf-8")
    path.with_suffix(".json.bak").write_text("[]", encoding="utf-8")
    with pytest.raises(DataCorruptionError):
        FitterDataStore(path).load()


def test_revision_rejects_stale_writes_and_retries_identically(tmp_path: Path) -> None:
    store = FitterDataStore(tmp_path / "fitter-data.json")
    first = next_document(1, "first")
    store.save(first)
    assert store.save(first).revision == 1
    with pytest.raises(RevisionConflictError) as conflict:
        store.save(next_document(1, "different"))
    assert conflict.value.current_revision == 1
    with pytest.raises(RevisionConflictError):
        store.save(next_document(3, "skipped"))


def test_large_document_round_trip(tmp_path: Path) -> None:
    store = FitterDataStore(tmp_path / "fitter-data.json")
    document = next_document(1, "large", payload_size=8 * 1024 * 1024)
    store.save(document)
    loaded = store.load().document
    assert loaded.workspace is not None
    assert len(loaded.workspace.fitting.description) == 8 * 1024 * 1024


def test_failed_primary_replace_keeps_previous_primary(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    path = tmp_path / "fitter-data.json"
    store = FitterDataStore(path)
    store.save(next_document(1, "safe"))
    original_replace = __import__("app.data_store", fromlist=["os"]).os.replace

    def fail_primary(source: Path, destination: Path) -> None:
        if Path(destination) == path:
            raise OSError("simulated replace failure")
        original_replace(source, destination)

    monkeypatch.setattr("app.data_store.os.replace", fail_primary)
    with pytest.raises(OSError, match="simulated"):
        store.save(next_document(2, "not-committed"))
    assert workspace_marker(FitterDataStore(path).load().document) == "safe"


def test_data_api_reads_writes_and_reports_revision_conflicts(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    store = FitterDataStore(tmp_path / "api" / "fitter-data.json")
    monkeypatch.setattr(main_module, "fitter_data_store", store)
    client = TestClient(app)

    initial = client.get("/api/data")
    assert initial.status_code == 200
    assert initial.json()["source"] == "empty"
    document = next_document(1, "api").model_dump(by_alias=True, mode="json")
    assert client.put("/api/data", json=document).status_code == 200
    stale = next_document(1, "stale").model_dump(by_alias=True, mode="json")
    conflict = client.put("/api/data", json=stale)
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["currentRevision"] == 1


def test_data_api_round_trips_worker_settings_and_defaults_old_documents(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    store = FitterDataStore(tmp_path / "workers" / "fitter-data.json")
    monkeypatch.setattr(main_module, "fitter_data_store", store)
    client = TestClient(app)
    payload = next_document(1, "workers").model_dump(by_alias=True, mode="json")
    assert payload["workspace"] is not None
    payload["workspace"]["solver"]["searchWorkers"] = {"mode": "custom", "value": 16}
    payload["fittings"]["entries"] = [{
        "id": "fit-workers",
        "boardId": "board",
        "name": "worker settings",
        "description": "",
        "createdAt": payload["savedAt"],
        "updatedAt": payload["savedAt"],
        "placements": [],
        "solverSettings": {
            "rules": [],
            "scope": "fill-current",
            "timeLimitMs": 30_000,
            "searchWorkers": {"mode": "all"},
            "lockedPlacementIds": [],
        },
    }]

    saved = client.put("/api/data", json=payload)
    assert saved.status_code == 200
    assert saved.json()["workspace"]["solver"]["searchWorkers"] == {"mode": "custom", "value": 16}
    assert saved.json()["fittings"]["entries"][0]["solverSettings"]["searchWorkers"] == {"mode": "all", "value": None}

    old_payload = next_document(2, "old-workers").model_dump(by_alias=True, mode="json")
    assert old_payload["workspace"] is not None
    del old_payload["workspace"]["solver"]["searchWorkers"]
    old_payload["fittings"]["entries"] = payload["fittings"]["entries"]
    del old_payload["fittings"]["entries"][0]["solverSettings"]["searchWorkers"]
    normalized = client.put("/api/data", json=old_payload)
    assert normalized.status_code == 200
    assert normalized.json()["workspace"]["solver"]["searchWorkers"] == {"mode": "standard", "value": None}
    assert normalized.json()["fittings"]["entries"][0]["solverSettings"]["searchWorkers"] == {"mode": "standard", "value": None}


def test_unproven_history_survives_backend_normalization_frontend_restart_and_backup(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    path = tmp_path / "cross-layer" / "fitter-data.json"
    store = FitterDataStore(path)
    monkeypatch.setattr(main_module, "fitter_data_store", store)
    client = TestClient(app)
    payload = next_document(1, "cross-layer").model_dump(by_alias=True, mode="json")
    payload["solutionHistory"]["models"] = {"cross-layer": [unproven_history_entry()]}

    saved = client.put("/api/data", json=payload)
    assert saved.status_code == 200
    assert saved.json()["solutionHistory"]["models"]["cross-layer"][0]["optimalityProof"] is None
    restarted = client.get("/api/data")
    assert restarted.status_code == 200
    assert restarted.json()["document"]["solutionHistory"]["models"]["cross-layer"][0]["optimalityProof"] is None

    frontend_input = tmp_path / "frontend-input.json"
    frontend_input.write_text(json.dumps(restarted.json()["document"], ensure_ascii=False), encoding="utf-8")
    project_root = Path(__file__).resolve().parents[2]
    frontend = subprocess.run(
        ["node", str(project_root / "tests" / "parse-fitter-data-cli.mjs"), str(frontend_input)],
        cwd=project_root,
        capture_output=True,
        text=True,
        check=False,
    )
    assert frontend.returncode == 0, frontend.stderr
    assert frontend.stdout == "cross-layer-history-ok"

    revision_two = restarted.json()["document"]
    revision_two["revision"] = 2
    revision_two["savedAt"] = "2026-09-13T00:00:02.000Z"
    assert client.put("/api/data", json=revision_two).status_code == 200
    primary = FitterDataDocument.model_validate_json(path.read_bytes())
    backup = FitterDataDocument.model_validate_json(path.with_suffix(".json.bak").read_bytes())
    assert primary.solution_history.models["cross-layer"][0].optimality_proof is None
    assert backup.solution_history.models["cross-layer"][0].optimality_proof is None

    path.write_text("{broken", encoding="utf-8")
    recovered = store.load()
    assert recovered.source == "backup"
    assert recovered.document.solution_history.models["cross-layer"][0].optimality_proof is None


def test_diagnostics_are_not_pruned(tmp_path: Path) -> None:
    request = SolveRequest(
        board=BoardDefinition(id="board", name="board", width=1, height=1, mask=[[1]]),
        modules=[ModuleDefinition(
            id="module",
            name="module",
            type="test",
            base_shape=[Point(x=0, y=0)],
            color="#000000",
            available_quantity=1,
            allow_rotation=False,
            allow_mirror=False,
            base_score=1,
            attributes={},
        )],
        module_rules=[ModuleRule(module_id="module", required_count=0, enabled=True, max_count=1)],
        scope="empty-board",
        locked_placements=[],
        current_layout=[],
        time_limit_ms=1_000,
    )
    root = tmp_path / "diagnostics"
    for index in range(25):
        SolverDiagnostics(root, f"job-{index}", request)
    assert len(list(root.glob("solver-*.json"))) == 25
