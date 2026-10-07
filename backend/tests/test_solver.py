from __future__ import annotations

import json
import os
import time
from collections import Counter
from importlib import import_module

from fastapi.testclient import TestClient
import pytest

from app.jobs import JobManager
from app.main import app
from app.solver.cp_sat_solver import build_model, resolve_search_workers
from app.solver.board_components import find_board_components
from app.solver.score_bound import integer_score_upper_bound
from app.solver.validation import effective_limits, validate_layout


main_module = import_module("app.main")
from app.models import (
    BoardDefinition,
    ModuleDefinition,
    ModuleRule,
    Orientation,
    PlacedModule,
    Point,
    SolveRequest,
    SearchWorkersSetting,
)


def board(width: int, height: int, mask: list[list[int]] | None = None) -> BoardDefinition:
    return BoardDefinition(id=f"board-{width}x{height}", name="测试棋盘", width=width, height=height, mask=mask or [[1] * width for _ in range(height)])


def module(module_id: str, shape: list[tuple[int, int]], score: int = 0, quantity: int = 100, rotate: bool = True) -> ModuleDefinition:
    return ModuleDefinition(
        id=module_id,
        name=module_id,
        type="测试",
        base_shape=[Point(x=x, y=y) for x, y in shape],
        color="#000000",
        available_quantity=quantity,
        allow_rotation=rotate,
        allow_mirror=False,
        base_score=score,
        attributes={},
    )


def placement(instance_id: str, module_id: str, x: int, y: int = 0, rotation: int = 0) -> PlacedModule:
    return PlacedModule(instance_id=instance_id, module_id=module_id, origin=Point(x=x, y=y), orientation=Orientation(rotation=rotation, mirrored=False))


def request(
    test_board: BoardDefinition,
    modules: list[ModuleDefinition],
    rules: list[ModuleRule],
    *,
    scope: str = "empty-board",
    current: list[PlacedModule] | None = None,
    locked: list[PlacedModule] | None = None,
    history: list[PlacedModule] | None = None,
    time_limit_ms: int | None = 5_000,
    search_workers: SearchWorkersSetting | None = None,
) -> SolveRequest:
    return SolveRequest(
        board=test_board,
        modules=modules,
        module_rules=rules,
        scope=scope,
        locked_placements=locked or [],
        current_layout=current or [],
        history_best_layout=history,
        search_workers=search_workers,
        time_limit_ms=time_limit_ms,
    )


def solve(payload: SolveRequest, timeout: float = 8) -> object:
    manager = JobManager()
    job = manager.create(payload)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snapshot = job.snapshot()
        if snapshot.status not in {"queued", "running"}:
            return snapshot
        time.sleep(0.01)
    job.request_stop()
    raise AssertionError("solver job did not finish in the test timeout")


def enabled_rule(module_id: str, maximum: int, required: int = 0) -> ModuleRule:
    return ModuleRule(module_id=module_id, required_count=required, enabled=True, max_count=maximum)


def test_known_optimal_score_prefers_two_temporary_cargo_modules() -> None:
    formal = module("formal", [(0, 0), (1, 0)], score=36, quantity=1)
    temporary = module("temporary", [(0, 0)], score=25, quantity=2)
    result = solve(request(board(2, 1), [formal, temporary], [enabled_rule("formal", 1), enabled_rule("temporary", 2)]))
    assert result.status == "completed"
    assert result.proven_optimal is True
    assert result.score == 50
    assert result.best_bound == 50
    assert result.best_solution.module_counts == {"formal": 0, "temporary": 2}


def test_disabled_module_is_absent_from_candidates_variables_bounds_and_solution() -> None:
    cargo = module("cargo", [(0, 0)], score=10, quantity=2)
    ignored = module("ignored", [(0, 0)], score=999, quantity=100)
    base = request(board(2, 1), [cargo], [enabled_rule("cargo", 2)])
    expanded = request(
        board(2, 1),
        [cargo, ignored],
        [enabled_rule("cargo", 2), ModuleRule(module_id="ignored", required_count=0, enabled=False, max_count=100)],
    )

    base_artifacts = build_model(base)
    expanded_artifacts = build_model(expanded)
    result = solve(expanded)

    assert expanded_artifacts.effective_module_ids == ("cargo",)
    assert [(item.module_id, item.rotation, item.origin_x, item.origin_y) for item in expanded_artifacts.candidates] == [
        (item.module_id, item.rotation, item.origin_x, item.origin_y) for item in base_artifacts.candidates
    ]
    assert len(expanded_artifacts.model.proto.variables) == len(base_artifacts.model.proto.variables)
    assert len(expanded_artifacts.model.proto.constraints) == len(base_artifacts.model.proto.constraints)
    assert str(expanded_artifacts.model.proto.objective) == str(base_artifacts.model.proto.objective)
    assert expanded_artifacts.integer_score_upper_bound_units == base_artifacts.integer_score_upper_bound_units
    assert expanded_artifacts.empty_cell_budget == base_artifacts.empty_cell_budget
    assert result.score == 20
    assert result.best_bound == 20
    assert all(item.module_id != "ignored" for item in result.best_solution.placements)
    invalid = validate_layout(expanded, [placement("illegal", "ignored", 0)])
    assert not invalid.valid
    assert any("超过最大数量 0" in reason for reason in invalid.reasons)


def test_required_enabled_locked_and_fill_current_modules_define_effective_set() -> None:
    test_module = module("conditional", [(0, 0)], score=1, quantity=1)
    disabled_rule = ModuleRule(module_id="conditional", required_count=0, enabled=False, max_count=0)

    disabled = build_model(request(board(1, 1), [test_module], [disabled_rule]))
    enabled = build_model(request(board(1, 1), [test_module], [enabled_rule("conditional", 1)]))
    required = build_model(request(
        board(1, 1),
        [test_module],
        [ModuleRule(module_id="conditional", required_count=1, enabled=False, max_count=0)],
    ))
    fixed = placement("fixed", "conditional", 0)
    locked = build_model(request(
        board(1, 1),
        [test_module],
        [disabled_rule],
        scope="rearrange-unlocked",
        locked=[fixed],
    ))
    fill_current = build_model(request(
        board(1, 1),
        [test_module],
        [disabled_rule],
        scope="fill-current",
        current=[fixed],
    ))

    assert disabled.effective_module_ids == ()
    assert disabled.candidates == []
    for artifacts in (enabled, required, locked, fill_current):
        assert artifacts.effective_module_ids == ("conditional",)
        assert len(artifacts.candidates) == 1
    assert locked.fixed_instance_ids
    assert fill_current.fixed_instance_ids


def test_enabled_module_with_zero_effective_maximum_remains_inactive() -> None:
    unavailable = module("unavailable", [(0, 0)], score=10, quantity=0)
    artifacts = build_model(request(board(1, 1), [unavailable], [enabled_rule("unavailable", 10)]))
    assert artifacts.effective_module_ids == ()
    assert artifacts.candidates == []


def test_search_workers_default_preserves_eight_and_modes_resolve_authoritatively() -> None:
    assert resolve_search_workers(None, 16).effective_workers == 8
    assert resolve_search_workers(None, 16).requested_mode == "default"
    for workers in (1, 8, 12, 16):
        resolution = resolve_search_workers(SearchWorkersSetting(mode="custom", value=workers), 16)
        assert resolution.effective_workers == workers
        assert resolution.requested_value == workers
        assert resolution.clamped is False
    all_threads = resolve_search_workers(SearchWorkersSetting(mode="all"), 16)
    assert all_threads.effective_workers == 16
    assert all_threads.logical_cpu_count == 16
    assert all_threads.default_workers == 8
    assert all_threads.clamped is False


def test_search_workers_are_clamped_to_the_backend_logical_cpu_count() -> None:
    resolution = resolve_search_workers(SearchWorkersSetting(mode="custom", value=64), 16)
    assert resolution.effective_workers == 16
    assert resolution.clamped is True
    low_core_default = resolve_search_workers(None, 4)
    assert low_core_default.effective_workers == 4
    assert low_core_default.clamped is True


def test_search_workers_reject_invalid_values() -> None:
    for value in (True, False, 0, -1, 257, 1.5, float("nan")):
        with pytest.raises(ValueError):
            SearchWorkersSetting(mode="custom", value=value)
    with pytest.raises(ValueError):
        SearchWorkersSetting(mode="custom")
    with pytest.raises(ValueError):
        SearchWorkersSetting(mode="all", value=16)


def test_search_workers_do_not_change_model_objective_or_problem_fingerprint() -> None:
    cargo = module("cargo", [(0, 0)], score=10, quantity=2)
    base = request(board(2, 1), [cargo], [enabled_rule("cargo", 2)])
    base.problem_fingerprint = "strict-problem-fingerprint"
    settings = [None, SearchWorkersSetting(mode="standard"), SearchWorkersSetting(mode="all"), SearchWorkersSetting(mode="custom", value=1)]
    artifacts = [build_model(base.model_copy(update={"search_workers": setting})) for setting in settings]
    assert len({str(item.model.proto) for item in artifacts}) == 1
    assert len({str(item.model.proto.objective) for item in artifacts}) == 1
    assert {base.model_copy(update={"search_workers": setting}).problem_fingerprint for setting in settings} == {"strict-problem-fingerprint"}


def test_integer_score_bound_rejects_fractional_cargo_counts() -> None:
    formal = module("formal", [(x, 0) for x in range(6)], score=36, quantity=100, rotate=False)
    temporary = module("temporary", [(x, 0) for x in range(5)], score=25, quantity=50, rotate=False)
    payload = request(
        board(113, 1),
        [formal, temporary],
        [enabled_rule("formal", 100), enabled_rule("temporary", 50)],
    )
    minimums, maximums = effective_limits(payload, Counter())

    bound = integer_score_upper_bound(payload, minimums, maximums)

    assert bound.valid_cells == 113
    assert bound.upper_bound_units == 673_000

def test_board_is_split_into_independent_installation_regions() -> None:
    test_board = board(7, 1, [[1, 1, 1, 0, 1, 1, 1]])

    components = find_board_components(test_board)

    assert components.sizes == (3, 3)
    assert components.cell_to_component[0] != components.cell_to_component[4]


def test_required_count_is_enforced() -> None:
    required = module("required", [(0, 0)], quantity=2)
    cargo = module("cargo", [(0, 0)], score=100, quantity=2)
    result = solve(request(board(2, 1), [required, cargo], [enabled_rule("required", 2, 2), enabled_rule("cargo", 2)]))
    assert result.best_solution.module_counts["required"] == 2
    assert result.best_solution.module_counts["cargo"] == 0


def test_cell_overlap_constraint_prevents_duplicate_occupancy() -> None:
    cargo = module("cargo", [(0, 0)], score=10, quantity=5)
    result = solve(request(board(1, 1), [cargo], [enabled_rule("cargo", 5)]))
    assert result.best_solution.occupied_cells == 1
    assert len(result.best_solution.placements) == 1


def test_rotation_generates_the_only_legal_vertical_position() -> None:
    domino = module("domino", [(0, 0), (1, 0)], score=10, quantity=1, rotate=True)
    result = solve(request(board(1, 2), [domino], [enabled_rule("domino", 1, 1)]))
    assert result.best_solution.placements[0].orientation.rotation == 90


def test_locked_module_keeps_instance_position_and_rotation() -> None:
    cargo = module("cargo", [(0, 0)], score=10, quantity=2)
    locked = placement("locked-original", "cargo", 1)
    result = solve(request(
        board(2, 1),
        [cargo],
        [enabled_rule("cargo", 2)],
        scope="rearrange-unlocked",
        current=[locked],
        locked=[locked],
    ))
    retained = next(item for item in result.best_solution.placements if item.instance_id == "locked-original")
    assert (retained.origin.x, retained.origin.y, retained.orientation.rotation) == (1, 0, 0)


def test_candidate_maximum_is_enforced() -> None:
    cargo = module("cargo", [(0, 0)], score=10, quantity=5)
    result = solve(request(board(3, 1), [cargo], [enabled_rule("cargo", 2)]))
    assert result.best_solution.module_counts["cargo"] == 2


def test_impossible_required_module_returns_infeasible() -> None:
    domino = module("domino", [(0, 0), (1, 0)], quantity=1)
    result = solve(request(board(1, 1), [domino], [enabled_rule("domino", 1, 1)]))
    assert result.status == "infeasible"
    assert result.best_solution is None
    assert result.infeasible_reasons


def test_stop_keeps_the_best_hint_solution() -> None:
    cargo = module("cargo", [(0, 0)], score=1, quantity=80)
    hint = [placement(f"hint-{x}", "cargo", x) for x in range(40)]
    manager = JobManager()
    job = manager.create(request(board(80, 1), [cargo], [enabled_rule("cargo", 80)], current=hint, time_limit_ms=None))
    assert job.snapshot().score >= 40
    job.request_stop()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and job.snapshot().status in {"queued", "running"}:
        time.sleep(0.01)
    result = job.snapshot()
    assert result.status in {"stopped", "completed"}
    assert result.best_solution is not None
    assert result.score >= 40


def test_1324_point_manual_hint_is_available_immediately_and_never_regresses() -> None:
    formal = module("formal", [(0, 0)], score=36, quantity=49)
    temporary = module("temporary", [(0, 0)], score=25, quantity=49)
    hint = [placement(f"formal-{x}", "formal", x) for x in range(9)]
    hint.extend(placement(f"temporary-{x}", "temporary", x) for x in range(9, 49))
    manager = JobManager()
    job = manager.create(request(
        board(49, 1),
        [formal, temporary],
        [enabled_rule("formal", 49), enabled_rule("temporary", 49)],
        current=hint,
        time_limit_ms=1_000,
    ))
    assert job.snapshot().score == 1324
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline and job.snapshot().status in {"queued", "running"}:
        time.sleep(0.01)
    assert job.snapshot().score >= 1324


def test_warm_start_only_hints_selected_placements() -> None:
    cargo = module("cargo", [(0, 0)], score=10, quantity=3)
    hint = [placement("selected", "cargo", 1)]
    artifacts = build_model(request(
        board(3, 1),
        [cargo],
        [enabled_rule("cargo", 3)],
        current=hint,
    ))

    assert len(artifacts.candidates) == 3
    assert list(artifacts.model.proto.solution_hint.values) == [1]
    assert len(artifacts.model.proto.solution_hint.vars) == 1


def test_warm_start_keeps_the_normal_maximization_objective_and_can_improve() -> None:
    cargo = module("cargo", [(0, 0)], score=10, quantity=3)
    hint = [placement("historical", "cargo", 0)]
    payload = request(
        board(3, 1),
        [cargo],
        [enabled_rule("cargo", 3)],
        history=hint,
    )

    artifacts = build_model(payload)
    result = solve(payload)

    assert len(artifacts.model.proto.objective.vars) > 0
    assert artifacts.incumbent_score_units == 10_000
    assert result.score == 30
    assert result.proven_optimal is True


def test_repeated_inputs_return_consistent_scores_and_valid_layouts() -> None:
    cargo = module("cargo", [(0, 0)], score=10, quantity=3)
    payload = request(board(3, 1), [cargo], [enabled_rule("cargo", 3)])
    first = solve(payload)
    second = solve(payload)
    assert first.score == second.score == 30
    assert first.best_solution.occupied_cells == second.best_solution.occupied_cells == 3


def test_http_health_and_job_endpoints(monkeypatch) -> None:
    monkeypatch.setattr(main_module, "job_manager", JobManager())
    client = TestClient(app)
    assert client.get("/api/health").json() == {
        "status": "ok",
        "solver": "ortools-cp-sat",
        "version": main_module.APP_VERSION,
    }
    cargo = module("cargo", [(0, 0)], score=10, quantity=1)
    payload = request(board(1, 1), [cargo], [enabled_rule("cargo", 1)]).model_dump(by_alias=True)
    started = client.post("/api/solver/solve", json=payload)
    assert started.status_code == 202
    assert started.json()["effectiveSearchWorkers"] == min(8, max(1, os.cpu_count() or 1))
    assert started.json()["defaultSearchWorkers"] == 8
    job_id = started.json()["jobId"]
    assert client.get(f"/api/solver/status/{job_id}").status_code == 200
    assert client.post(f"/api/solver/stop/{job_id}").status_code == 200

    invalid = {**payload, "searchWorkers": {"mode": "custom", "value": True}}
    assert client.post("/api/solver/solve", json=invalid).status_code == 422


def test_solver_diagnostics_are_persisted(tmp_path) -> None:
    cargo = module("cargo", [(0, 0)], score=10, quantity=2)
    manager = JobManager(diagnostics_root=tmp_path)
    job = manager.create(request(board(2, 1), [cargo], [enabled_rule("cargo", 2)]))
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and job.snapshot().status in {"queued", "running"}:
        time.sleep(0.01)

    diagnostic = None
    diagnostic_deadline = time.monotonic() + 2
    while time.monotonic() < diagnostic_deadline:
        files = list(tmp_path.glob("solver-*.json"))
        if len(files) == 1:
            candidate = json.loads(files[0].read_text(encoding="utf-8"))
            if candidate["final"] is not None:
                diagnostic = candidate
                break
        time.sleep(0.01)

    assert diagnostic is not None
    assert diagnostic["request"]["board"]["id"] == "board-2x1"
    assert diagnostic["model"]["candidatePlacements"] == 2
    assert diagnostic["model"]["candidatesByModule"] == {"cargo": 2}
    assert diagnostic["model"]["integerScoreUpperBound"] == 20
    assert diagnostic["model"]["searchWorkers"] == {
        "requested": None,
        "requestedMode": "default",
        "requestedValue": None,
        "effectiveWorkers": min(8, max(1, os.cpu_count() or 1)),
        "logicalCpuCount": max(1, os.cpu_count() or 1),
        "defaultWorkers": 8,
        "absoluteMaxWorkers": 256,
        "clamped": (os.cpu_count() or 1) < 8,
    }
    assert diagnostic["boundTimeline"]
    assert diagnostic["solverStatistics"]["numBranches"] >= 0
    assert diagnostic["final"]["status"] == "completed"
    assert diagnostic["final"]["score"] == 20


def test_stopped_solver_diagnostics_keep_the_final_state(tmp_path) -> None:
    cargo = module("cargo", [(0, 0)], score=1, quantity=80)
    manager = JobManager(diagnostics_root=tmp_path)
    job = manager.create(request(board(80, 1), [cargo], [enabled_rule("cargo", 80)], time_limit_ms=None))
    job.request_stop()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and job.snapshot().status in {"queued", "running"}:
        time.sleep(0.01)

    files = list(tmp_path.glob("solver-*.json"))
    assert len(files) == 1
    diagnostic = json.loads(files[0].read_text(encoding="utf-8"))
    assert diagnostic["final"]["status"] in {"stopped", "completed"}
    assert diagnostic["final"]["elapsedMs"] >= 0
