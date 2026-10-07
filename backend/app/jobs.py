from __future__ import annotations

import threading
import time
import uuid
import math
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from ortools.sat.python import cp_model

from app.models import SolveRequest, SolverJobSnapshot, SolverSolution
from app.solver.cp_sat_solver import ModelBuildError, SearchWorkersResolution, resolve_search_workers, solve_cp_sat
from app.solver.diagnostics import SolverDiagnostics, default_diagnostics_root
from app.solver.placement_generator import SCORE_SCALE
from app.solver.score_bound import integer_score_upper_bound
from app.solver.effective_modules import effective_limits, effective_modules, fixed_placements
from app.solver.validation import validate_layout


@dataclass(slots=True)
class SolverJob:
    job_id: str
    request: SolveRequest
    worker_resolution: SearchWorkersResolution
    created_at: float = field(default_factory=time.monotonic)
    status: str = "queued"
    solver_status: str = "UNKNOWN"
    best_solution: SolverSolution | None = None
    score: float = 0
    best_bound: float = 0
    stop_requested: bool = False
    proven_optimal: bool = False
    raw_objective_value: float | None = None
    raw_best_objective_bound: float | None = None
    solver_phase: str | None = None
    infeasible_reasons: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    solver: cp_model.CpSolver | None = None
    diagnostics: SolverDiagnostics | None = None
    lock: threading.RLock = field(default_factory=threading.RLock)

    def elapsed_ms(self) -> float:
        return (time.monotonic() - self.created_at) * 1_000

    def snapshot_bound(self) -> float:
        with self.lock:
            return max(self.score, self.best_bound)

    def snapshot(self) -> SolverJobSnapshot:
        with self.lock:
            bound = max(self.score, self.best_bound)
            return SolverJobSnapshot(
                job_id=self.job_id,
                status=self.status,
                best_solution=self.best_solution,
                score=self.score,
                best_bound=bound,
                optimality_gap=max(0, round(bound - self.score, 3)),
                elapsed_ms=self.elapsed_ms(),
                solver_status=self.solver_status,
                proven_optimal=self.proven_optimal,
                solver_phase=self.solver_phase,
                requested_search_workers=self.worker_resolution.requested,
                effective_search_workers=self.worker_resolution.effective_workers,
                logical_cpu_count=self.worker_resolution.logical_cpu_count,
                default_search_workers=self.worker_resolution.default_workers,
                search_workers_clamped=self.worker_resolution.clamped,
                infeasible_reasons=list(self.infeasible_reasons),
                errors=list(self.errors),
            )

    def record_solution(
        self,
        solution: SolverSolution,
        best_bound: float,
        raw_objective_bound: float | None = None,
    ) -> None:
        with self.lock:
            current_key = -1.0 if self.best_solution is None else self.best_solution.total_score
            candidate_key = solution.total_score
            if candidate_key > current_key:
                self.best_solution = solution
                self.score = solution.total_score
                if self.diagnostics:
                    try:
                        self.diagnostics.record_solution(solution, self.elapsed_ms())
                    except OSError:
                        self.diagnostics = None
            self._record_bound_locked(best_bound)
            if self.diagnostics:
                try:
                    self.diagnostics.record_bound(best_bound, raw_objective_bound, self.elapsed_ms())
                except OSError:
                    self.diagnostics = None

    def record_bound(self, best_bound: float, raw_objective_bound: float | None = None) -> None:
        with self.lock:
            self._record_bound_locked(best_bound)
            if self.diagnostics:
                try:
                    self.diagnostics.record_bound(best_bound, raw_objective_bound, self.elapsed_ms())
                except OSError:
                    self.diagnostics = None

    def record_model_summary(self, summary: dict) -> None:
        if self.diagnostics:
            try:
                self.diagnostics.record_model(summary)
            except OSError:
                self.diagnostics = None

    def record_solver_statistics(self, statistics: dict) -> None:
        with self.lock:
            self.raw_objective_value = statistics.get("rawObjectiveValue")
            self.raw_best_objective_bound = statistics.get("rawBestObjectiveBound")
        if self.diagnostics:
            try:
                self.diagnostics.record_solver_statistics(statistics)
            except OSError:
                self.diagnostics = None

    def has_strict_optimality_proof(self) -> bool:
        objective, bound = self.raw_objective_value, self.raw_best_objective_bound
        if objective is None or bound is None or self.best_solution is None:
            return False
        if not math.isfinite(objective) or not math.isfinite(bound):
            return False
        if not float(objective).is_integer() or objective != bound:
            return False
        validation = validate_layout(self.request, self.best_solution.placements)
        return bool(validation.valid and validation.solution
            and validation.solution.total_score == self.best_solution.total_score == self.score
            and round(validation.solution.total_score * SCORE_SCALE) == objective)

    def _record_bound_locked(self, best_bound: float) -> None:
        if best_bound < self.score:
            best_bound = self.score
        if self.best_bound <= 0 or best_bound < self.best_bound or self.best_bound < self.score:
            self.best_bound = best_bound

    def should_stop(self) -> bool:
        with self.lock:
            return self.stop_requested

    def record_phase(self, phase: str | None) -> None:
        with self.lock:
            self.solver_phase = phase

    def register_solver(self, solver: cp_model.CpSolver) -> None:
        with self.lock:
            self.solver = solver
            should_stop = self.stop_requested
        if should_stop:
            solver.stop_search()

    def request_stop(self) -> None:
        with self.lock:
            self.stop_requested = True
            solver = self.solver
        if solver is not None:
            solver.stop_search()


class JobManager:
    def __init__(self, diagnostics_root: Path | None = None) -> None:
        self._jobs: dict[str, SolverJob] = {}
        self._lock = threading.RLock()
        self._diagnostics_root = diagnostics_root

    def create(self, request: SolveRequest) -> SolverJob:
        worker_resolution = resolve_search_workers(request.search_workers)
        job = SolverJob(job_id=str(uuid.uuid4()), request=request, worker_resolution=worker_resolution)
        if self._diagnostics_root:
            try:
                job.diagnostics = SolverDiagnostics(self._diagnostics_root, job.job_id, request)
            except OSError:
                job.diagnostics = None
        fixed = fixed_placements(request)
        fixed_counts = Counter(item.module_id for item in fixed)
        minimums, maximums = effective_limits(request, fixed_counts)
        score_bound = integer_score_upper_bound(request, minimums, maximums, effective_modules(request, fixed_counts))
        optimistic = score_bound.upper_bound_units / SCORE_SCALE
        job.best_bound = optimistic

        warm_starts = [request.current_layout, request.history_best_layout]
        for layout in warm_starts:
            validation = validate_layout(request, layout)
            if validation.valid and validation.solution:
                job.record_solution(validation.solution, optimistic)

        with self._lock:
            self._jobs[job.job_id] = job
        threading.Thread(target=self._run, args=(job,), name=f"cp-sat-{job.job_id[:8]}", daemon=True).start()
        return job

    def get(self, job_id: str) -> SolverJob | None:
        with self._lock:
            return self._jobs.get(job_id)

    def stop(self, job_id: str) -> SolverJob | None:
        job = self.get(job_id)
        if job is not None:
            job.request_stop()
        return job

    def _run(self, job: SolverJob) -> None:
        try:
            with job.lock:
                if job.stop_requested:
                    job.status = "stopped"
                    job.solver_status = "STOPPED"
                    return
                job.status = "running"
            status, status_name, best_bound = solve_cp_sat(
                job.request,
                job.job_id,
                job,
                job.register_solver,
                job.worker_resolution,
            )
            job.record_bound(best_bound)
            with job.lock:
                if status == cp_model.OPTIMAL:
                    job.status = "completed"
                    job.solver_status = "OPTIMAL"
                    job.proven_optimal = job.has_strict_optimality_proof()
                elif job.stop_requested or status_name == "STOPPED":
                    job.status = "stopped"
                    job.solver_status = "STOPPED"
                elif status == cp_model.INFEASIBLE:
                    job.status = "infeasible"
                    job.solver_status = "INFEASIBLE"
                    required = [rule for rule in job.request.module_rules if rule.required_count > 0]
                    names = {module.id: module.name for module in job.request.modules}
                    job.infeasible_reasons = [
                        f"必备模块“{names.get(rule.module_id, rule.module_id)}”需要 {rule.required_count} 个"
                        for rule in required
                    ] or ["CP-SAT 已证明当前棋盘、锁定和数量约束没有可行方案"]
                elif status == cp_model.MODEL_INVALID:
                    job.status = "error"
                    job.solver_status = "MODEL_INVALID"
                    job.errors = ["CP-SAT 模型无效"]
                else:
                    job.status = "time-limit"
                    job.solver_status = "FEASIBLE" if job.best_solution else "UNKNOWN"
        except ModelBuildError as error:
            with job.lock:
                job.status = "infeasible"
                job.solver_status = "INFEASIBLE"
                job.infeasible_reasons = error.reasons
        except Exception as error:  # pragma: no cover - defensive API boundary
            with job.lock:
                job.status = "error"
                job.solver_status = "ERROR"
                job.errors = [str(error)]
        finally:
            with job.lock:
                job.solver = None
                final = {
                    "status": job.status,
                    "solverStatus": job.solver_status,
                    "elapsedMs": round(job.elapsed_ms(), 3),
                    "score": job.score,
                    "bestBound": max(job.score, job.best_bound),
                    "optimalityGap": max(0, round(max(job.score, job.best_bound) - job.score, 3)),
                    "provenOptimal": job.proven_optimal,
                    "solverPhase": job.solver_phase,
                    "bestSolutionId": job.best_solution.id if job.best_solution else None,
                    "errors": list(job.errors),
                    "infeasibleReasons": list(job.infeasible_reasons),
                }
            if job.diagnostics:
                try:
                    job.diagnostics.finish(final)
                except OSError:
                    job.diagnostics = None


job_manager = JobManager(diagnostics_root=default_diagnostics_root())
