from __future__ import annotations

from dataclasses import replace
import json

from app.models import (
    BoardDefinition,
    ModuleDefinition,
    ModuleRule,
    Orientation,
    PlacedModule,
    Point,
    SoftSkeletonTrainingLayout,
    SolveRequest,
)
from app.solver.cp_sat_solver import build_model
from app.solver.placement_generator import generate_placements
from app.solver.soft_skeleton import generate_soft_skeleton


SHAPES = (
    [(0, 0), (1, 0), (2, 0), (3, 0)],
    [(0, 0), (1, 0), (2, 0)],
    [(0, 0), (1, 0)],
    [(0, 0)],
)


def board(mask: list[list[int]] | None = None) -> BoardDefinition:
    actual = mask or [[1] * 20 for _ in range(4)]
    return BoardDefinition(id="current-board", name="board", width=len(actual[0]), height=len(actual), mask=actual)


def module(module_id: str, shape: list[tuple[int, int]], *, score: int = 0, rotate: bool = False, mirror: bool = False) -> ModuleDefinition:
    return ModuleDefinition(
        id=module_id,
        name=f"name-{module_id}",
        type="test",
        base_shape=[Point(x=x, y=y) for x, y in shape],
        color="#000000",
        available_quantity=10,
        allow_rotation=rotate,
        allow_mirror=mirror,
        base_score=score,
        attributes={},
    )


def placement(instance_id: str, module_id: str, x: int, y: int, rotation: int = 0, mirrored: bool = False) -> PlacedModule:
    return PlacedModule(
        instance_id=instance_id,
        module_id=module_id,
        origin=Point(x=x, y=y),
        orientation=Orientation(rotation=rotation, mirrored=mirrored),
    )


def shape_key(shape: list[tuple[int, int]]) -> str:
    return ";".join(f"{x},{y}" for x, y in shape)


def layout_signature(layout: list[PlacedModule]) -> str:
    return "|".join(sorted(f"{item.module_id}@{item.orientation.rotation}:{item.origin.x},{item.origin.y}" for item in layout))


def current_request(*, sources: list[SoftSkeletonTrainingLayout] | None = None, current: list[PlacedModule] | None = None, history: list[PlacedModule] | None = None, locked: list[PlacedModule] | None = None) -> SolveRequest:
    modules = [module(f"current-{index}", shape) for index, shape in enumerate(SHAPES)]
    modules.append(module("current-cargo", [(0, 0), (0, 1), (1, 1)], score=10))
    rules = [ModuleRule(module_id=item.id, required_count=1 if item.base_score == 0 else 0, enabled=True, max_count=1 if item.base_score == 0 else 10) for item in modules]
    return SolveRequest(
        board=board(),
        modules=modules,
        module_rules=rules,
        scope="empty-board",
        locked_placements=locked or [],
        current_layout=current or [],
        history_best_layout=history,
        problem_fingerprint="current-fingerprint",
        soft_skeleton_training_layouts=sources or [],
        time_limit_ms=1_000,
    )


def source(prefix: str, fingerprint: str, positions: list[tuple[int, int]], *, score: int = 0) -> SoftSkeletonTrainingLayout:
    module_ids = [f"{prefix}-{index}" for index in range(4)]
    cargo_id = f"{prefix}-cargo"
    modules = [
        {
            "id": module_id,
            "shape": shape_key(shape),
            "availableQuantity": 1,
            "allowRotation": False,
            "allowMirror": False,
            "baseScore": 0,
        }
        for module_id, shape in zip(module_ids, SHAPES, strict=True)
    ]
    modules.append({
        "id": cargo_id,
        "shape": shape_key([(0, 0), (0, 1), (1, 1)]),
        "availableQuantity": 10,
        "allowRotation": False,
        "allowMirror": False,
        "baseScore": 10,
    })
    rules = [
        {"moduleId": module_id, "requiredCount": 1, "enabled": True, "maxCount": 1}
        for module_id in module_ids
    ]
    rules.append({"moduleId": cargo_id, "requiredCount": 0, "enabled": True, "maxCount": 10})
    layout = [
        placement(f"{prefix}-placement-{index}", module_id, x, y)
        for index, (module_id, (x, y)) in enumerate(zip(module_ids, positions, strict=True))
    ]
    proof = json.dumps({
        "version": 2,
        "board": {"id": f"{prefix}-board", "width": 20, "height": 4, "mask": [[1] * 20 for _ in range(4)]},
        "modules": modules,
        "rules": rules,
        "locked": [],
    }, separators=(",", ":"))
    return SoftSkeletonTrainingLayout(
        source_problem_fingerprint=fingerprint,
        source_layout_signature=layout_signature(layout),
        layout=layout,
        proven_score=score,
        best_bound=score,
        proof_problem_signature=proof,
    )


def eligible_sources() -> list[SoftSkeletonTrainingLayout]:
    return [
        source("source-a", "fingerprint-a", [(0, 0), (6, 0), (10, 0), (15, 0)]),
        source("source-b", "fingerprint-b", [(0, 0), (6, 0), (11, 0), (16, 0)]),
    ]


def decision(payload: SolveRequest):
    return generate_soft_skeleton(payload, generate_placements(payload.board, payload.modules), complete_hint_available=False)


def test_generates_two_consensus_hints_with_different_module_ids() -> None:
    payload = current_request(sources=eligible_sources())
    result = decision(payload)

    assert result.enabled
    assert result.positive_hint_count == 2
    diagnostic = result.diagnostic()
    assert diagnostic["qualifiedSourceCount"] == 2
    assert diagnostic["positiveHintCount"] == 2
    assert diagnostic["invariants"] == {
        "candidateCountUnchanged": True,
        "variableCountUnchanged": True,
        "constraintCountUnchanged": True,
        "objectiveUnchanged": True,
        "zeroHintsAdded": 0,
        "fixedPositionsAdded": 0,
        "candidatesDeleted": 0,
    }
    candidates = generate_placements(payload.board, payload.modules)
    chosen = [candidates[index] for index in result.candidate_indices]
    assert [(item.origin_x, item.origin_y) for item in chosen] == [(0, 0), (6, 0)]
    assert {item.module_id for item in chosen} == {"current-0", "current-1"}


def test_inconsistent_positions_do_not_generate_a_partial_unverified_skeleton() -> None:
    sources = eligible_sources()
    sources[1] = source("source-b", "fingerprint-b", [(1, 0), (6, 0), (11, 0), (16, 0)])
    result = decision(current_request(sources=sources))
    assert not result.enabled
    assert result.reason == "consensus-candidate-count-not-two"
    assert len(result.candidate_indices) == 1


def test_invalid_proof_duplicate_source_and_insufficient_sources_fail_open() -> None:
    sources = eligible_sources()
    invalid = sources[0].model_copy(update={"best_bound": 1})
    assert decision(current_request(sources=[invalid, sources[1]])).reason == "invalid-or-incompatible-training-source"
    duplicate = sources[1].model_copy(update={"source_problem_fingerprint": "fingerprint-a"})
    assert decision(current_request(sources=[sources[0], duplicate])).reason == "duplicate-training-source-fingerprint"
    assert decision(current_request(sources=[sources[0]])).reason == "training-source-count-not-two"
    assert decision(current_request(sources=[*sources, source("source-c", "fingerprint-c", [(0, 0), (6, 0), (12, 0), (17, 0)])])).reason == "training-source-count-not-two"


def test_current_fingerprint_cannot_be_used_as_training() -> None:
    sources = eligible_sources()
    sources[0] = sources[0].model_copy(update={"source_problem_fingerprint": "current-fingerprint"})
    assert decision(current_request(sources=sources)).reason == "current-fingerprint-used-as-training"


def test_board_shape_rotation_mirror_and_layout_validation_fail_open() -> None:
    sources = eligible_sources()
    proof = json.loads(sources[0].proof_problem_signature)
    proof["board"]["mask"][0][0] = 0
    bad_board = sources[0].model_copy(update={"proof_problem_signature": json.dumps(proof)})
    assert decision(current_request(sources=[bad_board, sources[1]])).reason == "invalid-or-incompatible-training-source"

    proof = json.loads(sources[0].proof_problem_signature)
    proof["modules"][0]["shape"] = "0,0;0,1;0,2;0,3"
    bad_shape = sources[0].model_copy(update={"proof_problem_signature": json.dumps(proof)})
    assert decision(current_request(sources=[bad_shape, sources[1]])).reason == "invalid-or-incompatible-training-source"

    rotated_layout = list(sources[0].layout)
    rotated_layout[0] = rotated_layout[0].model_copy(update={"orientation": Orientation(rotation=90, mirrored=False)})
    rotated = sources[0].model_copy(update={"layout": rotated_layout, "source_layout_signature": layout_signature(rotated_layout)})
    assert decision(current_request(sources=[rotated, sources[1]])).reason == "invalid-or-incompatible-training-source"

    mirrored_layout = list(sources[0].layout)
    mirrored_layout[0] = mirrored_layout[0].model_copy(update={"orientation": Orientation(rotation=0, mirrored=True)})
    mirrored = sources[0].model_copy(update={"layout": mirrored_layout, "source_layout_signature": layout_signature(mirrored_layout)})
    assert decision(current_request(sources=[mirrored, sources[1]])).reason == "invalid-or-incompatible-training-source"

    overlapping_layout = list(sources[0].layout)
    overlapping_layout[1] = overlapping_layout[1].model_copy(update={"origin": Point(x=1, y=0)})
    overlapping = sources[0].model_copy(update={"layout": overlapping_layout, "source_layout_signature": layout_signature(overlapping_layout)})
    assert decision(current_request(sources=[overlapping, sources[1]])).reason == "invalid-or-incompatible-training-source"


def test_missing_current_candidate_and_overlapping_candidate_metadata_fail_open() -> None:
    payload = current_request(sources=eligible_sources())
    candidates = generate_placements(payload.board, payload.modules)
    enabled = generate_soft_skeleton(payload, candidates, complete_hint_available=False)
    assert enabled.enabled
    missing = [candidate for candidate in candidates if candidate.index != enabled.candidate_indices[0]]
    assert generate_soft_skeleton(payload, missing, complete_hint_available=False).reason == "consensus-candidate-not-currently-legal"

    first_index, second_index = enabled.candidate_indices
    corrupted = list(candidates)
    corrupted[second_index] = replace(corrupted[second_index], occupied_cells=corrupted[first_index].occupied_cells)
    assert generate_soft_skeleton(payload, corrupted, complete_hint_available=False).reason == "consensus-candidates-overlap"


def test_exactly_three_consensus_candidates_disables_v2() -> None:
    sources = [
        source("source-a", "fingerprint-a", [(0, 0), (6, 0), (10, 0), (15, 0)]),
        source("source-b", "fingerprint-b", [(0, 0), (6, 0), (10, 0), (16, 0)]),
    ]
    result = decision(current_request(sources=sources))
    assert not result.enabled
    assert result.reason == "consensus-candidate-count-not-two"
    assert len(result.candidate_indices) == 3


def test_complete_hint_and_locked_placement_take_precedence() -> None:
    payload = current_request(sources=eligible_sources())
    assert generate_soft_skeleton(payload, generate_placements(payload.board, payload.modules), complete_hint_available=True).reason == "complete-layout-hint-available"
    locked_payload = payload.model_copy(update={"locked_placements": [placement("locked", "current-0", 0, 0)]})
    assert decision(locked_payload).reason == "locked-placements-present"


def test_model_only_adds_two_positive_hints_and_one_strategy() -> None:
    baseline_request = current_request()
    v2_request = current_request(sources=eligible_sources())
    baseline = build_model(baseline_request)
    v2 = build_model(v2_request)

    assert v2.soft_skeleton and v2.soft_skeleton.enabled
    assert len(baseline.candidates) == len(v2.candidates)
    assert len(baseline.model.proto.variables) == len(v2.model.proto.variables)
    assert len(baseline.model.proto.constraints) == len(v2.model.proto.constraints)
    assert str(baseline.model.proto.objective) == str(v2.model.proto.objective)
    assert baseline.empty_cell_budget == v2.empty_cell_budget
    assert list(baseline.model.proto.solution_hint.values) == []
    assert list(v2.model.proto.solution_hint.values) == [1, 1]
    assert len(baseline.model.proto.search_strategy) == 0
    assert len(v2.model.proto.search_strategy) == 1
    assert len(v2.soft_skeleton.candidate_indices) == 2


def test_unrelated_disabled_module_does_not_invalidate_soft_skeleton_sources() -> None:
    payload = current_request(sources=eligible_sources())
    ignored = module("ignored", [(0, 0)], score=999)
    payload = payload.model_copy(update={
        "modules": [*payload.modules, ignored],
        "module_rules": [
            *payload.module_rules,
            ModuleRule(module_id="ignored", required_count=0, enabled=False, max_count=0),
        ],
    })

    artifacts = build_model(payload)

    assert artifacts.soft_skeleton and artifacts.soft_skeleton.enabled
    assert "ignored" not in artifacts.effective_module_ids
    assert all(candidate.module_id != "ignored" for candidate in artifacts.candidates)


def test_existing_complete_history_hint_prevents_skeleton_stacking() -> None:
    sources = eligible_sources()
    history = [
        placement("history-0", "current-0", 0, 0),
        placement("history-1", "current-1", 6, 0),
        placement("history-2", "current-2", 10, 0),
        placement("history-3", "current-3", 15, 0),
    ]
    artifacts = build_model(current_request(sources=sources, history=history))
    assert artifacts.soft_skeleton
    assert not artifacts.soft_skeleton.enabled
    assert artifacts.soft_skeleton.reason == "complete-layout-hint-available"
    assert len(artifacts.model.proto.solution_hint.vars) == 4
    assert len(artifacts.model.proto.search_strategy) == 0

    current_artifacts = build_model(current_request(sources=sources, current=history))
    assert current_artifacts.soft_skeleton
    assert current_artifacts.soft_skeleton.reason == "complete-layout-hint-available"
    assert len(current_artifacts.model.proto.solution_hint.vars) == 4
    assert len(current_artifacts.model.proto.search_strategy) == 0
