"""Replay the three archived V2 folds through the production generator.

This script builds each holdout request without current/history hints and uses
only the other two archived strictly-optimal layouts as training material. The
default replay does not solve or inspect a holdout optimal layout. Optional
smoke runs separately validate complete real requests with a legal full hint.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.models import PlacedModule, SoftSkeletonTrainingLayout, SolveRequest
from app.solver.cp_sat_solver import build_model
from app.solver.effective_modules import effective_limits, effective_modules
from app.solver.placement_generator import normalize_shape
from app.solver.validation import validate_layout
from app.solver.soft_skeleton import module_geometry_signature
from app.jobs import JobManager
import time


ARCHIVE = ROOT / "exports/soft-skeleton-v2/static-screen-v2"
DYNAMIC = ROOT / "exports/soft-skeleton-v2/dynamic-ab-v2/full"
CASES = (
    ("1463", "166a748fb035510cbd8256c6a589e17fc47408e3d14dbff4931f55981d0eefed"),
    ("1510", "7278728ea24d448e2f26777f0f19a95b18af8bc312b3fdecabad007be4e687a5"),
    ("1155", "0972e6e676b04d468868b72d6386ab59ec65c3d2dfc1e38d3d66b34213d413c3"),
)


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def shape_key(points: list[dict[str, int]]) -> str:
    shape = normalize_shape([(point["x"], point["y"]) for point in points])
    return ";".join(f"{x},{y}" for x, y in shape)


def proof_problem_signature(raw_request: dict) -> str:
    request = SolveRequest.model_validate(raw_request)
    if request.scope == "fill-current" or request.locked_placements:
        raise ValueError("training proof must describe an unlocked whole-board problem")
    minimums, maximums = effective_limits(request)
    active = effective_modules(request)
    document = {
        "version": 2,
        "board": request.board.model_dump(mode="json", by_alias=True, exclude={"name"}),
        "modules": sorted(({
            "id": module.id,
            "shape": shape_key([point.model_dump() for point in module.base_shape]),
            "availableQuantity": maximums[module.id],
            "allowRotation": module.allow_rotation,
            "allowMirror": module.allow_mirror,
            "baseScore": module.base_score,
        } for module in active), key=lambda item: item["id"]),
        "rules": sorted(({
            "moduleId": module.id,
            "requiredCount": minimums[module.id],
            "enabled": maximums[module.id] > minimums[module.id],
            "maxCount": maximums[module.id],
        } for module in active), key=lambda item: item["moduleId"]),
        "locked": [],
    }
    return canonical(document).decode("utf-8")


def solution_signature(layout: list[dict]) -> str:
    return "|".join(sorted(
        f'{item["moduleId"]}@{item["orientation"]["rotation"]}:{item["origin"]["x"]},{item["origin"]["y"]}'
        for item in layout
    ))


def training_source(fingerprint: str) -> SoftSkeletonTrainingLayout:
    source_dir = ARCHIVE / "inputs" / fingerprint[:16]
    raw_request = read_json(source_dir / "request.json")
    proof = read_json(source_dir / "proof-source.json")
    validation = read_json(source_dir / "validation.json")
    raw_objective = proof["solverStatistics"]["rawObjectiveValue"]
    raw_bound = proof["solverStatistics"]["rawBestObjectiveBound"]
    if proof["solverStatistics"]["status"] != "OPTIMAL" or raw_objective != raw_bound:
        raise AssertionError(f"{fingerprint}: source is not strictly OPTIMAL")
    layout = read_json(source_dir / "layout.json")
    checked = validate_layout(SolveRequest.model_validate(raw_request), [PlacedModule.model_validate(item) for item in layout])
    if not checked.valid or checked.solution is None or checked.solution.total_score != validation["score"]:
        raise AssertionError(f"{fingerprint}: source layout no longer validates: {checked.reasons}")
    return SoftSkeletonTrainingLayout(
        source_problem_fingerprint=fingerprint,
        source_layout_signature=solution_signature(layout),
        layout=layout,
        proven_score=validation["score"],
        best_bound=raw_bound / 1_000,
        proof_problem_signature=proof_problem_signature(raw_request),
    )


def objective_signature(artifacts) -> str:
    objective = artifacts.model.proto.objective
    return digest({
        "vars": list(objective.vars),
        "coeffs": list(objective.coeffs),
        "offset": objective.offset,
        "scalingFactor": objective.scaling_factor,
        "domain": list(objective.domain),
    })


def production_request(holdout_fingerprint: str) -> SolveRequest:
    raw = read_json(ARCHIVE / "inputs" / holdout_fingerprint[:16] / "request.json")
    raw["currentLayout"] = []
    raw["historyBestLayout"] = None
    raw["problemFingerprint"] = holdout_fingerprint
    raw["softSkeletonTrainingLayouts"] = [
        training_source(fingerprint).model_dump(mode="json", by_alias=True)
        for _, fingerprint in CASES
        if fingerprint != holdout_fingerprint
    ]
    return SolveRequest.model_validate(raw)


def signature_catalog(signature: str) -> list[tuple]:
    document = json.loads(signature)
    result = []
    for module in document["modules"]:
        shape = [tuple(map(int, point.split(","))) for point in module["shape"].split(";")]
        result.append((module_geometry_signature(shape, module["allowRotation"], module["allowMirror"]),
            module["availableQuantity"], round(module["baseScore"] * 1_000)))
    return sorted(result)


def replay(label: str, holdout_fingerprint: str) -> dict:
    request = production_request(holdout_fingerprint)
    artifacts = build_model(request)
    decision = artifacts.soft_skeleton
    if decision is None:
        raise AssertionError(f"{label}: production generator returned no decision")
    current_catalog = signature_catalog(proof_problem_signature(request.model_dump(by_alias=True, mode="json")))
    source_compatibility = [signature_catalog(source.proof_problem_signature) == current_catalog
        for source in request.soft_skeleton_training_layouts]
    expected_enabled = len(source_compatibility) == 2 and all(source_compatibility)
    if decision.enabled != expected_enabled:
        raise AssertionError(f"{label}: expected enabled={expected_enabled}, got {decision}")

    # The archived run is used only as an expected-output oracle after the
    # production generator has finished. Its bestLayout/timeline are untouched.
    archived_run = read_json(DYNAMIC / f"{label}-seed-1-v2.json")
    # Old indices address the old whole catalog. Compare placement identities after
    # disabled-module filtering, rather than pretending the old model is unchanged.
    from app.solver.placement_generator import generate_placements
    archived_request = SolveRequest.model_validate(read_json(ARCHIVE / "inputs" / holdout_fingerprint[:16] / "request.json"))
    archived_candidates = generate_placements(archived_request.board, archived_request.modules)
    expected_keys = [archived_candidates[index].key
        for index in archived_run["candidateImplementation"]["priorityCandidateIndices"]]
    actual_keys = [artifacts.candidates[index].key for index in decision.candidate_indices]
    if expected_enabled and actual_keys != expected_keys:
        raise AssertionError(f"{label}: hinted placement identities differ from the archive")
    baseline = build_model(request.model_copy(update={"soft_skeleton_training_layouts": []}))
    actual_model = {
        "candidateCount": len(artifacts.candidates),
        "variableCount": len(artifacts.model.proto.variables),
        "constraintCount": len(artifacts.model.proto.constraints),
        "objectiveSignature": objective_signature(artifacts),
        "emptyCellBudget": artifacts.empty_cell_budget,
    }
    baseline_model = {
        "candidateCount": len(baseline.candidates),
        "variableCount": len(baseline.model.proto.variables),
        "constraintCount": len(baseline.model.proto.constraints),
        "objectiveSignature": objective_signature(baseline),
        "emptyCellBudget": baseline.empty_cell_budget,
    }
    if actual_model != baseline_model or [candidate.key for candidate in artifacts.candidates] != [candidate.key for candidate in baseline.candidates]:
        raise AssertionError(f"{label}: V2 changed the current candidates or model structure")
    model_without_hints = artifacts.model.clone()
    model_without_hints.clear_hints()
    model_without_hints.proto.search_strategy.clear()
    if str(model_without_hints.proto) != str(baseline.model.proto):
        raise AssertionError(f"{label}: V2 changed the current constraints")
    expected_model = archived_run["model"]
    archived_structure_matches = actual_model == {key: expected_model[key] for key in actual_model}
    if expected_enabled and list(artifacts.model.proto.solution_hint.values) != [1, 1]:
        raise AssertionError(f"{label}: expected exactly two positive hints")
    if expected_enabled and len(artifacts.model.proto.search_strategy) != 1:
        raise AssertionError(f"{label}: expected exactly one decision strategy")
    if not expected_enabled and str(artifacts.model.proto) != str(baseline.model.proto):
        raise AssertionError(f"{label}: incompatible training did not fully fall back")
    return {
        "label": label,
        "holdoutFingerprint": holdout_fingerprint,
        "trainingFingerprints": [
            source.source_problem_fingerprint for source in request.soft_skeleton_training_layouts
        ],
        "holdoutOptimalLayoutRead": False,
        "solverInvoked": False,
        "enabled": decision.enabled,
        "expectedEnabled": expected_enabled,
        "sourceCatalogCompatibility": source_compatibility,
        "safeFallback": not expected_enabled,
        "currentContractPassed": True,
        "candidateIndices": decision.candidate_indices,
        "hintPlacementsMatchArchivedExperiment": True if expected_enabled else None,
        "hintValues": list(artifacts.model.proto.solution_hint.values),
        "decisionStrategyCount": len(artifacts.model.proto.search_strategy),
        "model": actual_model,
        "modelMatchesCurrentBaseline": True,
        "archivedModelStructureMatches": archived_structure_matches,
        "comparisonScope": "current effective-module model; archived hints compared by placement identity",
    }


def smoke(label: str, holdout_fingerprint: str, seconds: float) -> dict:
    # Replay a complete real diagnostic as a warm correctness regression. The
    # original archived request/layout are read only; no cold-search claim is made.
    raw = read_json(ARCHIVE / "inputs" / holdout_fingerprint[:16] / "request.json")
    raw["timeLimitMs"] = max(1, round(seconds * 1_000))
    request = SolveRequest.model_validate(raw)
    current = validate_layout(request, request.current_layout)
    initial = current
    hint_source = "request.currentLayout"
    if not initial.valid:
        initial = validate_layout(request, request.history_best_layout)
        hint_source = "request.historyBestLayout"
    if not initial.valid:
        # Some old requests predate their final proof. Preserve their invalid
        # current layout; only add the same archive's verified history hint.
        archived_history = training_source(holdout_fingerprint).layout
        request = request.model_copy(update={"history_best_layout": archived_history})
        initial = validate_layout(request, archived_history)
        hint_source = "archived verified layout.json as historyBestLayout"
    if not initial.valid or initial.solution is None:
        raise AssertionError(f"{label}: no legal archived complete hint: {initial.reasons}")
    manager = JobManager()  # No real diagnostic writes.
    job = manager.create(request)
    deadline = time.monotonic() + seconds + 10
    while time.monotonic() < deadline:
        snapshot = job.snapshot()
        if snapshot.status not in ("queued", "running"):
            break
        time.sleep(0.02)
    else:
        job.request_stop()
        raise AssertionError(f"{label}: regression did not stop within its deadline")
    if snapshot.best_solution is None:
        raise AssertionError(f"{label}: regression lost the complete incumbent")
    validation = validate_layout(request, snapshot.best_solution.placements)
    if not validation.valid or validation.solution is None or validation.solution.total_score != snapshot.score:
        raise AssertionError(f"{label}: invalid regression result: {validation.reasons}")
    if snapshot.score < initial.solution.total_score:
        raise AssertionError(f"{label}: current hint regressed")
    return {
        "label": label,
        "holdoutFingerprint": holdout_fingerprint,
        "timeLimitSeconds": seconds,
        "status": snapshot.solver_status,
        "legalCompleteSolution": True,
        "originalCurrentLayoutValid": current.valid,
        "originalCurrentLayoutReasons": current.reasons,
        "initialHintSource": hint_source,
        "initialScore": initial.solution.total_score,
        "score": snapshot.score,
        "bestBound": snapshot.best_bound,
        "provenOptimal": snapshot.proven_optimal,
        "rawObjectiveValue": job.raw_objective_value,
        "rawBestObjectiveBound": job.raw_best_objective_bound,
        "finalSolution": snapshot.best_solution.model_dump(mode="json", by_alias=True),
        "requestSha256": digest(request.model_dump(mode="json", by_alias=True)),
        "regressionMode": "complete real request with validated full hint; original constraints/current layout preserved, no performance comparison",
    }


def write_result(directory: Path | None, filename: str, result: dict) -> None:
    if directory is None:
        return
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / filename).open("xb") as stream:
        stream.write(canonical(result))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--solve-smoke", action="store_true")
    parser.add_argument("--seconds", type=float, default=8.0)
    parser.add_argument("--output-dir", type=Path, help="Optional new output directory; existing files are never overwritten")
    args = parser.parse_args()
    folds = [replay(label, fingerprint) for label, fingerprint in CASES]
    result = {
        "schemaVersion": 1,
        "purpose": "production soft-skeleton V2 equivalence replay; no performance solve",
        "allPassed": all(fold["currentContractPassed"] and fold["modelMatchesCurrentBaseline"] for fold in folds),
        "folds": folds,
    }
    write_result(args.output_dir, "production-equivalence.json", result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.solve_smoke:
        smoke_folds = [smoke(label, fingerprint, args.seconds) for label, fingerprint in CASES]
        smoke_result = {
            "schemaVersion": 1,
            "purpose": "complete real requests with validated full hints; short correctness regression, no performance comparison",
            "allPassed": all(fold["legalCompleteSolution"] for fold in smoke_folds),
            "folds": smoke_folds,
        }
        write_result(args.output_dir, "production-smoke.json", smoke_result)
        print(json.dumps(smoke_result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
