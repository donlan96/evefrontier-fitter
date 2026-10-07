from __future__ import annotations

import importlib.util
import json
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from ortools.sat.python import cp_model
from pydantic import ValidationError

from app import jobs, main
from app.data_store import FitterDataStore, empty_fitter_data
from app.jobs import JobManager, SolverJob
from app.models import ModuleDefinition, SolveRequest
from app.solver.cp_sat_solver import resolve_search_workers
from app.solver.solution_callback import objective_bound_to_score
from app.solver.validation import build_solution, validate_layout

ROOT = Path(__file__).resolve().parents[2]


def raw_request(score=10, maximum=6, enabled=True):
    return {
        "board": {"id": "regression", "name": "regression", "width": 6, "height": 1, "mask": [[1] * 6]},
        "modules": [{"id": "cargo", "name": "cargo", "type": "cargo", "baseShape": [{"x": 0, "y": 0}],
            "color": "#000", "availableQuantity": 6, "allowRotation": True, "allowMirror": False,
            "baseScore": score, "attributes": {}}],
        "moduleRules": [{"moduleId": "cargo", "requiredCount": 0, "enabled": enabled, "maxCount": maximum}],
        "scope": "empty-board", "lockedPlacements": [], "currentLayout": [], "historyBestLayout": None,
        "timeLimitMs": 1_000,
    }


def finished(manager, request):
    job = manager.create(SolveRequest.model_validate(request))
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if job.snapshot().status not in ("queued", "running"):
            return job
        time.sleep(0.01)
    job.request_stop()
    raise AssertionError("small regression did not finish")


def context(raw):
    return {"board": raw["board"], "modules": raw["modules"], "rules": raw["moduleRules"], "lockedPlacements": raw["lockedPlacements"]}


def frontend(tmp_path, input):
    path = tmp_path / "frontend.json"
    path.write_text(json.dumps(input), encoding="utf-8")
    process = subprocess.run(["node", str(ROOT / "tests/solver-workflow-cli.mjs"), str(path)],
        cwd=ROOT, capture_output=True, text=True, check=False)
    assert process.returncode == 0, process.stderr
    return json.loads(process.stdout)


@pytest.mark.parametrize("raw_objective,raw_bound,expected", [
    (60_000, 60_000, True),
    (60_000, 60_000.49, False),  # Same displayed score; raw values differ.
    (60_000, 60_001, False),
    (60_000.1, 60_000.1, False),
    (None, None, False),
    (float("inf"), float("inf"), False),
    (float("nan"), float("nan"), False),
])
def test_job_proof_requires_exact_raw_integer_equality(monkeypatch, raw_objective, raw_bound, expected):
    request = SolveRequest.model_validate(raw_request())
    initial = finished(JobManager(), raw_request()).best_solution
    assert initial is not None
    displayed_bound = 60 if raw_bound is None or not isinstance(raw_bound, (int, float)) or raw_bound != raw_bound or raw_bound == float("inf") else objective_bound_to_score(raw_bound, 1)

    def fake_solve(request, job_id, sink, register_solver, workers):
        sink.record_solution(initial, displayed_bound)
        sink.record_solver_statistics({"rawObjectiveValue": raw_objective, "rawBestObjectiveBound": raw_bound})
        return cp_model.OPTIMAL, "OPTIMAL", displayed_bound

    monkeypatch.setattr(jobs, "solve_cp_sat", fake_solve)
    job = SolverJob("proof-regression", request, resolve_search_workers(None))
    JobManager()._run(job)
    snapshot = job.snapshot()
    assert snapshot.solver_status == "OPTIMAL"
    assert snapshot.proven_optimal is expected
    assert snapshot.best_bound == displayed_bound


@pytest.mark.parametrize("status,name", [(cp_model.FEASIBLE, "FEASIBLE"), (cp_model.UNKNOWN, "UNKNOWN")])
def test_equal_raw_bounds_do_not_prove_nonoptimal_status(monkeypatch, status, name):
    request = SolveRequest.model_validate(raw_request())
    initial = finished(JobManager(), raw_request()).best_solution

    def fake_solve(request, job_id, sink, register_solver, workers):
        sink.record_solution(initial, 60)
        sink.record_solver_statistics({"rawObjectiveValue": 60_000, "rawBestObjectiveBound": 60_000})
        return status, name, 60

    monkeypatch.setattr(jobs, "solve_cp_sat", fake_solve)
    job = SolverJob("nonoptimal", request, resolve_search_workers(None))
    JobManager()._run(job)
    assert job.snapshot().proven_optimal is False
    assert job.snapshot().best_solution is not None


@pytest.mark.parametrize("fault", ["overlap", "incorrect-layout-score", "incorrect-job-score"])
def test_equal_raw_optimal_values_still_require_a_complete_consistent_best(monkeypatch, fault):
    request = SolveRequest.model_validate(raw_request())
    initial = finished(JobManager(), raw_request()).best_solution.model_copy(deep=True)
    if fault == "overlap":
        initial.placements[1].origin.x = initial.placements[0].origin.x
    elif fault == "incorrect-layout-score":
        initial.placements.pop()

    def fake_solve(request, job_id, sink, register_solver, workers):
        sink.record_solution(initial, 60)
        if fault == "incorrect-job-score":
            sink.score = 59
        sink.record_solver_statistics({"rawObjectiveValue": 60_000, "rawBestObjectiveBound": 60_000})
        return cp_model.OPTIMAL, "OPTIMAL", 60

    monkeypatch.setattr(jobs, "solve_cp_sat", fake_solve)
    job = SolverJob("invalid-optimal-best", request, resolve_search_workers(None))
    JobManager()._run(job)
    assert job.snapshot().proven_optimal is False


@pytest.mark.parametrize("maximum,enabled,expected", [(1, True, 10), (0, False, 0)])
def test_api_rule_change_and_frontend_history_workflow(monkeypatch, tmp_path, maximum, enabled, expected):
    client = TestClient(main.app)
    old = raw_request()
    initial = finished(main.job_manager, old).snapshot()
    changed = raw_request(maximum=maximum, enabled=enabled)
    changed["historyBestLayout"] = initial.best_solution.model_dump(by_alias=True)["placements"]
    response = client.post("/api/solver/solve", json=changed)
    assert response.status_code == 202
    job = main.job_manager.get(response.json()["jobId"])
    deadline = time.monotonic() + 5
    while job.snapshot().status in ("queued", "running") and time.monotonic() < deadline:
        time.sleep(0.01)
    snapshot = client.get(f"/api/solver/status/{job.job_id}").json()
    assert snapshot["score"] == expected
    assert validate_layout(job.request, job.best_solution.placements).valid
    result = frontend(tmp_path, {"initialContext": context(old), "initialSolution": initial.best_solution.model_dump(by_alias=True),
        "initialProof": {"score": 60, "bestBound": 60}, "context": context(changed), "snapshot": snapshot})
    assert result["historyValid"] is False
    assert result["score"] == expected
    assert result["provenOptimal"] is True


def test_fractional_solver_proof_survives_frontend_revalidation(tmp_path):
    raw = raw_request(score=0.1, maximum=3)
    job = finished(JobManager(), raw)
    snapshot = job.snapshot()
    assert snapshot.score == 0.3
    assert snapshot.proven_optimal is True
    assert job.raw_objective_value == job.raw_best_objective_bound == 300
    result = frontend(tmp_path, {"initialContext": context(raw), "initialSolution": snapshot.best_solution.model_dump(by_alias=True),
        "initialProof": {"score": 0.3, "bestBound": 0.3}, "context": context(raw), "snapshot": snapshot.model_dump(by_alias=True)})
    assert result["historyProven"] is True
    assert result["score"] == 0.3
    assert result["provenOptimal"] is True


def test_shared_score_cases_and_failed_put_preserve_disk(monkeypatch, tmp_path):
    cases = json.loads((ROOT / "tests/fixtures/module-score-cases.json").read_text())
    store = FitterDataStore(tmp_path / "fitter-data.json")
    monkeypatch.setattr(main, "fitter_data_store", store)
    client = TestClient(main.app)
    disk = empty_fitter_data().model_dump(by_alias=True)
    disk["revision"] = 1
    assert client.put("/api/data", json=disk).status_code == 200
    original = store.path.read_bytes()
    for case in cases:
        definition = raw_request()["modules"][0] | {"baseScore": case["score"]}
        if case["valid"]:
            assert ModuleDefinition.model_validate(definition).base_score == case["score"]
        else:
            with pytest.raises(ValidationError):
                ModuleDefinition.model_validate(definition)
            invalid = raw_request() | {"modules": [definition]}
            assert client.post("/api/solver/solve", json=invalid).status_code == 422
            payload = disk | {"revision": 2, "workspace": {
                "snapshotVersion": 3, "savedAt": "2026-10-02", "document": {
                    "documentType": "eve-frontier-grid-fitting", "schemaVersion": 1,
                    "board": invalid["board"], "modules": [definition],
                    "build": {"id": "build", "name": "build", "boardId": "regression", "placements": []}},
                "fitting": {"activeFittingId": None, "name": "fit", "description": ""},
                "solver": {"rules": [], "scope": "empty-board", "timeLimitMs": 30_000,
                    "lockedPlacementIds": [], "lastResult": None, "lastResultFingerprint": None}}}
            assert client.put("/api/data", json=payload).status_code == 422
            assert store.path.read_bytes() == original


def test_empty_scope_ignores_old_locks_but_fixed_inventory_still_applies():
    raw = raw_request(maximum=1)
    initial = finished(JobManager(), raw).best_solution
    raw["lockedPlacements"] = initial.model_dump(by_alias=True)["placements"]
    request = SolveRequest.model_validate(raw)
    assert validate_layout(request, []).valid
    raw["scope"] = "fill-current"
    raw["currentLayout"] = initial.model_dump(by_alias=True)["placements"] * 2
    raw["currentLayout"][1] = raw["currentLayout"][1] | {"instanceId": "extra", "origin": {"x": 1, "y": 0}}
    raw["modules"][0]["availableQuantity"] = 1
    request = SolveRequest.model_validate(raw)
    assert not validate_layout(request, request.current_layout).valid


def verifier():
    spec = importlib.util.spec_from_file_location("current_equivalence_verifier", ROOT / "scripts/verify-soft-skeleton-v2-equivalence.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_verifier_signature_matches_frontend_normalized_v2(tmp_path):
    raw = raw_request(maximum=3)
    disabled = raw["modules"][0] | {"id": "disabled", "baseScore": 999}
    raw["modules"].append(disabled)
    raw["moduleRules"].append({"moduleId": "disabled", "enabled": False, "requiredCount": 0, "maxCount": 0})
    actual = json.loads(verifier().proof_problem_signature(raw))
    expected = frontend(tmp_path, {"action": "signature", "context": context(raw)})
    assert actual == expected
    assert actual["version"] == 2
    assert [module["id"] for module in actual["modules"]] == ["cargo"]
    assert actual["modules"][0]["availableQuantity"] == 3


@pytest.mark.parametrize("case_index", range(3))
def test_real_archived_request_preserves_hint_and_returns_complete_valid_data(case_index):
    regression = verifier()
    if not regression.ARCHIVE.is_dir():
        pytest.skip("真实归档为本机非提交数据；未提供归档时跳过真实规模回归")
    label, fingerprint = regression.CASES[case_index]
    snapshot = regression.smoke(label, fingerprint, 0.5)
    assert snapshot["legalCompleteSolution"]
    assert snapshot["score"] >= snapshot["initialScore"]
    if label == "1510":
        assert not snapshot["originalCurrentLayoutValid"]
        assert snapshot["originalCurrentLayoutReasons"]
        assert snapshot["initialHintSource"] == "request.historyBestLayout"
    if label == "1155":
        assert not snapshot["originalCurrentLayoutValid"]
        assert snapshot["originalCurrentLayoutReasons"]
        assert snapshot["initialHintSource"] == "archived verified layout.json as historyBestLayout"


def test_verifier_output_never_overwrites_existing_evidence(tmp_path):
    regression = verifier()
    path = tmp_path / "result.json"
    path.write_bytes(b"existing-evidence")
    with pytest.raises(FileExistsError):
        regression.write_result(tmp_path, "result.json", {"new": True})
    assert path.read_bytes() == b"existing-evidence"
