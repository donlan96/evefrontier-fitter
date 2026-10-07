from __future__ import annotations

from collections import Counter
from typing import Callable, Protocol

from ortools.sat.python import cp_model

from app.models import PlacedModule, Point, Orientation, SolveRequest
from app.solver.placement_generator import SCORE_SCALE, PlacementCandidate
from app.solver.validation import build_solution


class JobSink(Protocol):
    def record_solution(self, solution, best_bound: float, raw_objective_bound: float | None = None) -> None: ...
    def record_bound(self, best_bound: float, raw_objective_bound: float | None = None) -> None: ...
    def record_model_summary(self, summary: dict) -> None: ...
    def record_solver_statistics(self, statistics: dict) -> None: ...
    def should_stop(self) -> bool: ...
    def snapshot_bound(self) -> float: ...
    def record_phase(self, phase: str | None) -> None: ...


def objective_bound_to_score(bound: float, multiplier: int) -> float:
    if bound <= 0:
        return 0
    objective_units = max(0, int(bound + 1e-6))
    return (objective_units // multiplier) / SCORE_SCALE


class BestSolutionCallback(cp_model.CpSolverSolutionCallback):
    def __init__(
        self,
        request: SolveRequest,
        candidates: list[PlacementCandidate],
        variables: list[cp_model.IntVar],
        fixed_instance_ids: dict[int, str],
        objective_multiplier: int,
        job_id: str,
        sink: JobSink,
    ) -> None:
        super().__init__()
        self._request = request
        self._candidates = candidates
        self._variables = variables
        self._fixed_instance_ids = fixed_instance_ids
        self._objective_multiplier = objective_multiplier
        self._job_id = job_id
        self._sink = sink
        self._solution_count = 0

    def on_solution_callback(self) -> None:
        if self._sink.should_stop():
            self.stop_search()
            return
        self._solution_count += 1
        placements: list[PlacedModule] = []
        per_module = Counter()
        for candidate, variable in zip(self._candidates, self._variables, strict=True):
            if not self.boolean_value(variable):
                continue
            per_module[candidate.module_id] += 1
            placements.append(PlacedModule(
                instance_id=self._fixed_instance_ids.get(
                    candidate.index,
                    f"cp-{self._job_id[:8]}-{candidate.module_id}-{per_module[candidate.module_id]}-{candidate.index}",
                ),
                module_id=candidate.module_id,
                origin=Point(x=candidate.origin_x, y=candidate.origin_y),
                orientation=Orientation(rotation=candidate.rotation, mirrored=False),
            ))
        solution = build_solution(
            self._request,
            placements,
            self.wall_time * 1_000,
            f"cp-solution-{self._job_id}-{self._solution_count}",
        )
        raw_bound = self.best_objective_bound
        bound = objective_bound_to_score(raw_bound, self._objective_multiplier)
        self._sink.record_solution(solution, bound, raw_bound)


def make_bound_callback(sink: JobSink, objective_multiplier: int) -> Callable[[float], None]:
    def update(bound: float) -> None:
        sink.record_bound(objective_bound_to_score(bound, objective_multiplier), bound)
    return update
