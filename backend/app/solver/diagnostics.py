from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.models import SolveRequest, SolverSolution


DIAGNOSTIC_SCHEMA_VERSION = 1
WRITE_INTERVAL_SECONDS = 2.0
MAX_BOUND_EVENTS = 5_000
MAX_SOLUTION_EVENTS = 1_000


def default_diagnostics_root() -> Path | None:
    configured_root = os.environ.get("EVE_FRONTIER_FITTER_DIAGNOSTICS_DIR")
    if configured_root:
        return Path(configured_root)
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        return None
    return Path(local_app_data) / "EveFrontierFitter" / "diagnostics"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class SolverDiagnostics:
    def __init__(self, root: Path, job_id: str, request: SolveRequest) -> None:
        self._root = root
        self._lock = threading.RLock()
        self._last_write = 0.0
        self._last_raw_bound: float | None = None
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        self.path = root / f"solver-{stamp}-{job_id}.json"
        self._document: dict[str, Any] = {
            "schemaVersion": DIAGNOSTIC_SCHEMA_VERSION,
            "jobId": job_id,
            "createdAt": utc_now(),
            "request": request.model_dump(by_alias=True, mode="json"),
            "model": None,
            "boundTimeline": [],
            "solutionTimeline": [],
            "solverStatistics": None,
            "final": None,
        }
        self._write(force=True)

    def record_model(self, summary: dict[str, Any]) -> None:
        with self._lock:
            self._document["model"] = summary
            self._write(force=True)

    def record_bound(self, score_bound: float, raw_objective_bound: float | None, elapsed_ms: float) -> None:
        with self._lock:
            if raw_objective_bound is not None and raw_objective_bound == self._last_raw_bound:
                return
            self._last_raw_bound = raw_objective_bound
            event = {
                "elapsedMs": round(elapsed_ms, 3),
                "scoreBound": score_bound,
                "rawObjectiveBound": raw_objective_bound,
            }
            timeline = self._document["boundTimeline"]
            if len(timeline) < MAX_BOUND_EVENTS:
                timeline.append(event)
            else:
                timeline[-1] = event
            self._write(force=False)

    def record_solution(self, solution: SolverSolution, elapsed_ms: float) -> None:
        with self._lock:
            event = {
                "elapsedMs": round(elapsed_ms, 3),
                "score": solution.total_score,
                "occupiedCells": solution.occupied_cells,
                "remainingCells": solution.remaining_cells,
                "moduleCounts": solution.module_counts,
            }
            timeline = self._document["solutionTimeline"]
            if len(timeline) < MAX_SOLUTION_EVENTS:
                timeline.append(event)
            else:
                timeline[-1] = event
            self._write(force=False)

    def record_solver_statistics(self, statistics: dict[str, Any]) -> None:
        with self._lock:
            self._document["solverStatistics"] = statistics
            self._write(force=True)

    def finish(self, final: dict[str, Any]) -> None:
        with self._lock:
            self._document["finishedAt"] = utc_now()
            self._document["final"] = final
            self._write(force=True)

    def _write(self, force: bool) -> None:
        now = time.monotonic()
        if not force and now - self._last_write < WRITE_INTERVAL_SECONDS:
            return
        self._root.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self._document, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, self.path)
        self._last_write = now
