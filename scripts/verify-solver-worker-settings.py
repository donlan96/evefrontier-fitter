from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import time


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.jobs import JobManager  # noqa: E402
from app.models import SearchWorkersSetting, SolveRequest  # noqa: E402
from app.solver.cp_sat_solver import build_model  # noqa: E402
from app.solver.validation import validate_layout  # noqa: E402


def solve_once(raw: dict, workers: int, seconds: int) -> tuple[object, str]:
    request = SolveRequest.model_validate({
        **raw,
        "searchWorkers": {"mode": "custom", "value": workers},
        "timeLimitMs": seconds * 1_000,
    })
    model_text = str(build_model(request).model.proto)
    manager = JobManager()  # Do not write to the user's real diagnostics directory.
    job = manager.create(request)
    deadline = time.monotonic() + seconds + 10
    while time.monotonic() < deadline:
        snapshot = job.snapshot()
        if snapshot.status not in {"queued", "running"}:
            break
        time.sleep(0.05)
    else:
        job.request_stop()
        raise RuntimeError(f"{workers} workers did not stop within the validation deadline")
    if snapshot.best_solution is None:
        raise RuntimeError(f"{workers} workers returned no complete solution: {snapshot.solver_status}")
    validation = validate_layout(request, snapshot.best_solution.placements)
    if not validation.valid or validation.solution is None or validation.solution.total_score != snapshot.score:
        raise RuntimeError(f"{workers} workers returned an invalid solution: {validation.reasons}")
    if snapshot.effective_search_workers != workers:
        raise RuntimeError(
            f"requested {workers} workers but backend used {snapshot.effective_search_workers} "
            f"of {snapshot.logical_cpu_count} logical threads"
        )
    print(json.dumps({
        "requestedWorkers": workers,
        "effectiveWorkers": snapshot.effective_search_workers,
        "logicalCpuCount": snapshot.logical_cpu_count,
        "status": snapshot.solver_status,
        "score": snapshot.score,
        "bestBound": snapshot.best_bound,
        "valid": validation.valid,
    }, ensure_ascii=False))
    return snapshot, model_text


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("diagnostic", type=Path)
    parser.add_argument("--seconds", type=int, default=15)
    args = parser.parse_args()
    document = json.loads(args.diagnostic.read_text(encoding="utf-8-sig"))
    raw = document["request"] if "request" in document else document
    eight, model_eight = solve_once(raw, 8, args.seconds)
    sixteen, model_sixteen = solve_once(raw, 16, args.seconds)
    if model_eight != model_sixteen:
        raise RuntimeError("worker setting changed the CP-SAT model proto")
    print(json.dumps({
        "valid": True,
        "modelsIdentical": True,
        "scoresArePerformanceNeutral": "not evaluated",
        "runs": [eight.effective_search_workers, sixteen.effective_search_workers],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
