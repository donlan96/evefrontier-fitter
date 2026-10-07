from __future__ import annotations

import os
import time
from collections import Counter, defaultdict
from dataclasses import dataclass

from ortools.sat.python import cp_model

from app.models import MAX_REQUESTED_SEARCH_WORKERS, SearchWorkersSetting, SolveRequest
from app.solver.board_components import BoardComponents, find_board_components
from app.solver.effective_modules import effective_limits, effective_modules, fixed_placements
from app.solver.empty_cell_budget import add_empty_cell_budget
from app.solver.placement_generator import SCORE_SCALE, PlacementCandidate, generate_placements, placement_key
from app.solver.score_bound import integer_score_upper_bound
from app.solver.soft_skeleton import SoftSkeletonDecision, generate_soft_skeleton
from app.solver.solution_callback import BestSolutionCallback, JobSink, make_bound_callback, objective_bound_to_score
from app.solver.validation import validate_layout


DEFAULT_SEARCH_WORKERS = 8
ABSOLUTE_MAX_SEARCH_WORKERS = MAX_REQUESTED_SEARCH_WORKERS


@dataclass(frozen=True, slots=True)
class SearchWorkersResolution:
    requested: SearchWorkersSetting | None
    requested_mode: str
    requested_value: int | None
    effective_workers: int
    logical_cpu_count: int
    default_workers: int
    absolute_max_workers: int
    clamped: bool

    def diagnostic(self) -> dict:
        return {
            "requested": self.requested.model_dump(by_alias=True, mode="json") if self.requested else None,
            "requestedMode": self.requested_mode,
            "requestedValue": self.requested_value,
            "effectiveWorkers": self.effective_workers,
            "logicalCpuCount": self.logical_cpu_count,
            "defaultWorkers": self.default_workers,
            "absoluteMaxWorkers": self.absolute_max_workers,
            "clamped": self.clamped,
        }


def resolve_search_workers(
    setting: SearchWorkersSetting | None,
    logical_cpu_count: int | None = None,
) -> SearchWorkersResolution:
    logical = max(1, int(logical_cpu_count if logical_cpu_count is not None else (os.cpu_count() or 1)))
    machine_limit = min(logical, ABSOLUTE_MAX_SEARCH_WORKERS)
    if setting is None:
        requested_mode = "default"
        requested_value = None
        requested_workers = DEFAULT_SEARCH_WORKERS
    elif setting.mode == "standard":
        requested_mode = "standard"
        requested_value = DEFAULT_SEARCH_WORKERS
        requested_workers = DEFAULT_SEARCH_WORKERS
    elif setting.mode == "all":
        requested_mode = "all"
        requested_value = logical
        requested_workers = logical
    else:
        requested_mode = "custom"
        requested_value = setting.value
        requested_workers = setting.value or DEFAULT_SEARCH_WORKERS
    effective = max(1, min(requested_workers, machine_limit))
    return SearchWorkersResolution(
        requested=setting,
        requested_mode=requested_mode,
        requested_value=requested_value,
        effective_workers=effective,
        logical_cpu_count=logical,
        default_workers=DEFAULT_SEARCH_WORKERS,
        absolute_max_workers=ABSOLUTE_MAX_SEARCH_WORKERS,
        clamped=effective != requested_workers,
    )


class ModelBuildError(Exception):
    def __init__(self, reasons: list[str]) -> None:
        super().__init__("; ".join(reasons))
        self.reasons = reasons


@dataclass(slots=True)
class ModelArtifacts:
    model: cp_model.CpModel
    candidates: list[PlacementCandidate]
    variables: list[cp_model.IntVar]
    fixed_instance_ids: dict[int, str]
    objective_multiplier: int
    integer_score_upper_bound_units: int
    incumbent_score_units: int
    components: BoardComponents
    effective_module_ids: tuple[str, ...]
    empty_cell_budget: int | None = None
    soft_skeleton: SoftSkeletonDecision | None = None


def _expression_from_terms(model: cp_model.CpModel, terms: tuple[tuple[int, int], ...]):
    return sum(coefficient * model.get_int_var_from_proto_index(index) for index, coefficient in terms)


def build_model(request: SolveRequest) -> ModelArtifacts:
    fixed = fixed_placements(request)
    fixed_counts = Counter(item.module_id for item in fixed)
    minimums, maximums = effective_limits(request, fixed_counts)
    active_modules = effective_modules(request, fixed_counts)
    candidates = generate_placements(request.board, active_modules)
    candidate_by_key = {candidate.key: candidate for candidate in candidates}
    fixed_validation_request = request.model_copy(update={"scope": "fill-current", "current_layout": fixed})
    fixed_validation = validate_layout(fixed_validation_request, fixed, candidate_by_key, enforce_counts=False)
    if not fixed_validation.valid:
        raise ModelBuildError(fixed_validation.reasons)

    model = cp_model.CpModel()
    variables = [model.new_bool_var(f"x_{candidate.index}_{candidate.module_id}") for candidate in candidates]
    by_cell: dict[int, list[cp_model.IntVar]] = defaultdict(list)
    by_module: dict[str, list[cp_model.IntVar]] = defaultdict(list)
    for candidate, variable in zip(candidates, variables, strict=True):
        by_module[candidate.module_id].append(variable)
        for cell_index in candidate.cell_indices:
            by_cell[cell_index].append(variable)
    for y, row in enumerate(request.board.mask):
        for x, cell in enumerate(row):
            if cell == 1:
                by_cell[y * request.board.width + x]
    cell_constraints = {
        cell: model.add(sum(cell_variables) <= 1)
        for cell, cell_variables in by_cell.items()
    }

    components = find_board_components(request.board)
    component_terms: list[list[tuple[cp_model.IntVar, int]]] = [[] for _ in components.cells]
    for candidate, variable in zip(candidates, variables, strict=True):
        cells_by_component = Counter(components.cell_to_component[cell] for cell in candidate.cell_indices)
        for component_id, occupied_cells in cells_by_component.items():
            component_terms[component_id].append((variable, occupied_cells))
    for component_id, terms in enumerate(component_terms):
        model.add(sum(variable * occupied_cells for variable, occupied_cells in terms) <= components.sizes[component_id])

    module_map = {module.id: module for module in active_modules}
    module_count_variables: dict[str, cp_model.IntVar] = {}
    for module_id, module in module_map.items():
        module_variables = by_module[module_id]
        minimum = minimums[module_id]
        maximum = maximums[module_id]
        if minimum > module.available_quantity:
            raise ModelBuildError([f"必备模块 {module.name} 需要 {minimum}，库存只有 {module.available_quantity}"])
        if not module_variables and minimum > 0:
            raise ModelBuildError([f"必备模块 {module.name} 没有合法摆放位置"])
        count_variable = model.new_int_var(minimum, maximum, f"count_{module_id}")
        model.add(count_variable == sum(module_variables))
        module_count_variables[module_id] = count_variable

    for module_id, module in module_map.items():
        candidates_by_component: list[list[cp_model.IntVar]] = [[] for _ in components.cells]
        all_candidates_are_local = True
        for candidate in candidates:
            if candidate.module_id != module_id:
                continue
            component_ids = {components.cell_to_component[cell] for cell in candidate.cell_indices}
            if len(component_ids) != 1:
                all_candidates_are_local = False
                break
            candidates_by_component[next(iter(component_ids))].append(variables[candidate.index])
        if not all_candidates_are_local:
            continue
        component_counts: list[cp_model.IntVar] = []
        for component_id, component_variables in enumerate(candidates_by_component):
            if not component_variables:
                continue
            component_count = model.new_int_var(
                0,
                maximums[module_id],
                f"component_count_{component_id}_{module_id}",
            )
            model.add(component_count == sum(component_variables))
            component_counts.append(component_count)
        model.add(module_count_variables[module_id] == sum(component_counts))

    fixed_instance_ids: dict[int, str] = {}
    for placement in fixed:
        key = placement_key(placement.module_id, placement.orientation.rotation, placement.origin.x, placement.origin.y)
        candidate = candidate_by_key.get(key)
        if candidate is None:
            raise ModelBuildError([f"固定模块 {placement.module_id} 的位置或方向无效"])
        model.add(variables[candidate.index] == 1)
        fixed_instance_ids[candidate.index] = placement.instance_id

    hint_options = [request.current_layout, request.history_best_layout]
    validated_hints = [validate_layout(request, layout, candidate_by_key) for layout in hint_options if layout]
    valid_hints = [hint for hint in validated_hints if hint.valid and hint.solution]
    best_hint = None
    if valid_hints:
        best_hint = max(valid_hints, key=lambda item: (item.solution.total_score, item.solution.occupied_cells))
        for candidate_index in best_hint.candidate_indices:
            model.add_hint(variables[candidate_index], 1)

    soft_skeleton = generate_soft_skeleton(
        request,
        candidates,
        complete_hint_available=best_hint is not None,
    )
    if soft_skeleton.enabled:
        strategy_variables = []
        for candidate_index in soft_skeleton.candidate_indices:
            variable = variables[candidate_index]
            model.add_hint(variable, 1)
            strategy_variables.append(variable)
        model.add_decision_strategy(
            strategy_variables,
            cp_model.CHOOSE_FIRST,
            cp_model.SELECT_MAX_VALUE,
        )
        soft_skeleton.decision_strategy_added = True

    score_terms = tuple(
        (module_count_variables[module.id].index, round(module.base_score * SCORE_SCALE))
        for module in active_modules
        if round(module.base_score * SCORE_SCALE) != 0
    )
    score_expression = _expression_from_terms(model, score_terms)
    score_bound = integer_score_upper_bound(request, minimums, maximums, active_modules)
    if score_bound.minimum_area > score_bound.valid_cells:
        raise ModelBuildError([
            f"必备与固定模块至少需要 {score_bound.minimum_area} 格，棋盘只有 {score_bound.valid_cells} 格"
        ])
    incumbent_score_units = 0
    if best_hint is not None:
        incumbent_score_units = round(best_hint.solution.total_score * SCORE_SCALE)
        model.add(score_expression >= incumbent_score_units)
    model.maximize(score_expression)
    empty_budget = add_empty_cell_budget(
        model, by_cell, cell_constraints, module_count_variables, active_modules,
        minimums, maximums, incumbent_score_units if best_hint is not None else None,
    )

    return ModelArtifacts(
        model=model,
        candidates=candidates,
        variables=variables,
        fixed_instance_ids=fixed_instance_ids,
        objective_multiplier=1,
        integer_score_upper_bound_units=score_bound.upper_bound_units,
        incumbent_score_units=incumbent_score_units,
        components=components,
        effective_module_ids=tuple(module.id for module in active_modules),
        empty_cell_budget=empty_budget,
        soft_skeleton=soft_skeleton,
    )


def _solver_statistics(solver: cp_model.CpSolver, status: int, phase: str) -> dict:
    return {
        "phase": phase,
        "status": solver.status_name(status),
        "wallTimeSeconds": solver.wall_time,
        "userTimeSeconds": solver.user_time,
        "numBooleans": solver.num_booleans,
        "numBranches": solver.num_branches,
        "numConflicts": solver.num_conflicts,
        "rawObjectiveValue": solver.objective_value,
        "rawBestObjectiveBound": solver.best_objective_bound,
        "responseStats": solver.response_stats(),
    }


def _solve_phase(
    request: SolveRequest,
    artifacts: ModelArtifacts,
    job_id: str,
    sink: JobSink,
    register_solver,
    max_time_seconds: float | None,
    phase: str,
    search_workers: int,
) -> tuple[int, cp_model.CpSolver, dict]:
    solver = cp_model.CpSolver()
    register_solver(solver)
    if max_time_seconds is not None:
        solver.parameters.max_time_in_seconds = max(0.001, max_time_seconds)
    solver.parameters.num_search_workers = search_workers
    solver.parameters.log_search_progress = False
    solver.best_bound_callback = make_bound_callback(sink, artifacts.objective_multiplier)
    callback = BestSolutionCallback(
        request,
        artifacts.candidates,
        artifacts.variables,
        artifacts.fixed_instance_ids,
        artifacts.objective_multiplier,
        job_id,
        sink,
    )
    if sink.should_stop():
        return cp_model.UNKNOWN, solver, {"status": "STOPPED"}
    status = solver.solve(artifacts.model, callback)
    return status, solver, _solver_statistics(solver, status, phase)


def solve_cp_sat(
    request: SolveRequest,
    job_id: str,
    sink: JobSink,
    register_solver,
    worker_resolution: SearchWorkersResolution,
) -> tuple[int, str, float]:
    started_at = time.monotonic()
    artifacts = build_model(request)
    candidates_by_module = Counter(candidate.module_id for candidate in artifacts.candidates)
    candidates_by_rotation = Counter(str(candidate.rotation) for candidate in artifacts.candidates)
    sink.record_model_summary({
        "boardWidth": request.board.width,
        "boardHeight": request.board.height,
        "validCells": sum(artifacts.components.sizes),
        "boardComponentCount": len(artifacts.components.cells),
        "boardComponentSizes": sorted(artifacts.components.sizes, reverse=True),
        "moduleDefinitions": len(request.modules),
        "effectiveModuleDefinitions": len(artifacts.effective_module_ids),
        "fixedPlacements": len(fixed_placements(request)),
        "candidatePlacements": len(artifacts.candidates),
        "candidatesByModule": dict(sorted(candidates_by_module.items())),
        "candidatesByRotation": dict(sorted(candidates_by_rotation.items())),
        "modelVariables": len(artifacts.model.proto.variables),
        "modelConstraints": len(artifacts.model.proto.constraints),
        "hintVariables": len(artifacts.model.proto.solution_hint.vars),
        "searchWorkers": worker_resolution.diagnostic(),
        "integerScoreUpperBound": artifacts.integer_score_upper_bound_units / SCORE_SCALE,
        "incumbentScoreLowerBound": artifacts.incumbent_score_units / SCORE_SCALE,
        "emptyCellBudget": artifacts.empty_cell_budget,
        "objectiveMultiplier": artifacts.objective_multiplier,
        "scoreScale": SCORE_SCALE,
        "softSkeleton": artifacts.soft_skeleton.diagnostic() if artifacts.soft_skeleton else None,
    })

    elapsed = time.monotonic() - started_at
    remaining_seconds = None if request.time_limit_ms is None else request.time_limit_ms / 1_000 - elapsed
    if remaining_seconds is not None and remaining_seconds <= 0:
        sink.record_solver_statistics({
            "status": "UNKNOWN",
            "configuredSearchWorkers": worker_resolution.effective_workers,
        })
        return cp_model.UNKNOWN, "UNKNOWN", sink.snapshot_bound()

    sink.record_phase("正在搜索更高分方案")
    status, solver, statistics = _solve_phase(
        request,
        artifacts,
        job_id,
        sink,
        register_solver,
        remaining_seconds,
        "maximize",
        worker_resolution.effective_workers,
    )
    sink.record_solver_statistics({
        **statistics,
        "configuredSearchWorkers": worker_resolution.effective_workers,
    })
    if sink.should_stop():
        return status, "STOPPED", sink.snapshot_bound()
    return status, solver.status_name(status), objective_bound_to_score(
        solver.best_objective_bound,
        artifacts.objective_multiplier,
    )
