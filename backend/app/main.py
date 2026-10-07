from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.jobs import job_manager
from app.data_store import (
    DataStoreError,
    FitterDataDocument,
    RevisionConflictError,
    fitter_data_store,
)
from app.models import HealthResponse, SolveRequest, SolverJobSnapshot
from app.version import APP_VERSION


app = FastAPI(title="EVE Frontier Fitting CP-SAT Solver", version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT"],
    allow_headers=["Content-Type"],
)


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(version=APP_VERSION)


@app.get("/api/data")
def load_fitter_data() -> dict:
    try:
        loaded = fitter_data_store.load()
    except (DataStoreError, OSError) as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return {
        "document": loaded.document.model_dump(by_alias=True, mode="json"),
        "source": loaded.source,
    }


@app.put("/api/data", response_model=FitterDataDocument)
def save_fitter_data(document: FitterDataDocument) -> FitterDataDocument:
    try:
        return fitter_data_store.save(document)
    except RevisionConflictError as error:
        raise HTTPException(
            status_code=409,
            detail={"message": str(error), "currentRevision": error.current_revision},
        ) from error
    except (DataStoreError, OSError) as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.post("/api/solver/solve", response_model=SolverJobSnapshot, status_code=202)
def start_solver(request: SolveRequest) -> SolverJobSnapshot:
    return job_manager.create(request).snapshot()


@app.get("/api/solver/status/{job_id}", response_model=SolverJobSnapshot)
def solver_status(job_id: str) -> SolverJobSnapshot:
    job = job_manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="solver job not found")
    return job.snapshot()


@app.post("/api/solver/stop/{job_id}", response_model=SolverJobSnapshot)
def stop_solver(job_id: str) -> SolverJobSnapshot:
    job = job_manager.stop(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="solver job not found")
    return job.snapshot()
