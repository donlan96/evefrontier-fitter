from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from app.models import (
    BoardDefinition,
    ModuleDefinition,
    ModuleRule,
    PlacedModule,
    SearchWorkersSetting,
    SolverJobSnapshot,
    SolverSolution,
    to_camel,
)
from app.starter_content import default_starter_path, starter_document


DATA_SCHEMA_VERSION = 1


class DataModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class SavedBoardEntry(DataModel):
    board: BoardDefinition
    saved_at: str


class BoardHistoryEntry(DataModel):
    id: str
    saved_at: str
    board: BoardDefinition
    placements: list[PlacedModule]
    locked_placement_ids: list[str]


class BoardStorageDocument(DataModel):
    version: Literal[3]
    saved_boards: list[SavedBoardEntry]
    history: list[BoardHistoryEntry]


class StoredSolverSettings(DataModel):
    rules: list[ModuleRule]
    scope: Literal["empty-board", "fill-current", "rearrange-unlocked"]
    time_limit_ms: Literal[30_000, 60_000, 300_000, 900_000] | None
    search_workers: SearchWorkersSetting = Field(default_factory=SearchWorkersSetting)
    locked_placement_ids: list[str]


class SavedFittingEntry(DataModel):
    id: str
    board_id: str
    name: str = Field(min_length=1)
    description: str
    created_at: str
    updated_at: str
    placements: list[PlacedModule]
    solver_settings: StoredSolverSettings


class FittingLibraryDocument(DataModel):
    version: Literal[3]
    entries: list[SavedFittingEntry]


class OptimalityProof(DataModel):
    proven_at: str
    score: float
    best_bound: float
    problem_signature: str


class SolutionHistoryEntry(DataModel):
    id: str
    saved_at: str
    layout_signature: str
    saved_score: float
    module_shape_signatures: dict[str, str]
    solution: SolverSolution
    optimality_proof: OptimalityProof | None = None


class SolutionHistoryDocument(DataModel):
    version: Literal[3]
    models: dict[str, list[SolutionHistoryEntry]]


class StoredBuild(DataModel):
    id: str
    name: str
    board_id: str
    placements: list[PlacedModule]


class StoredFittingDocument(DataModel):
    document_type: Literal["eve-frontier-grid-fitting"]
    schema_version: Literal[1]
    board: BoardDefinition
    modules: list[ModuleDefinition]
    build: StoredBuild

    @model_validator(mode="after")
    def validate_references(self) -> "StoredFittingDocument":
        if self.build.board_id != self.board.id:
            raise ValueError("workspace build.boardId does not match board.id")
        module_ids = [module.id for module in self.modules]
        if len(set(module_ids)) != len(module_ids):
            raise ValueError("workspace module IDs must be unique")
        if any(placement.module_id not in module_ids for placement in self.build.placements):
            raise ValueError("workspace placement references an unknown module")
        placement_ids = [placement.instance_id for placement in self.build.placements]
        if len(set(placement_ids)) != len(placement_ids):
            raise ValueError("workspace placement IDs must be unique")
        return self


class WorkspaceFittingProfile(DataModel):
    active_fitting_id: str | None
    name: str
    description: str


class WorkspaceSolverSettings(StoredSolverSettings):
    last_result: SolverJobSnapshot | None
    last_result_fingerprint: str | None


class WorkspaceSnapshot(DataModel):
    snapshot_version: Literal[3]
    saved_at: str
    document: StoredFittingDocument
    fitting: WorkspaceFittingProfile
    solver: WorkspaceSolverSettings

    @field_validator("solver")
    @classmethod
    def validate_locked_placements(cls, solver: WorkspaceSolverSettings) -> WorkspaceSolverSettings:
        if len(set(solver.locked_placement_ids)) != len(solver.locked_placement_ids):
            raise ValueError("workspace locked placement IDs must be unique")
        return solver


class FitterDataDocument(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    schema_version: Literal[DATA_SCHEMA_VERSION] = Field(alias="schemaVersion")
    revision: int = Field(ge=0)
    saved_at: str | None = Field(default=None, alias="savedAt")
    boards: BoardStorageDocument
    fittings: FittingLibraryDocument
    solution_history: SolutionHistoryDocument = Field(alias="solutionHistory")
    workspace: WorkspaceSnapshot | None


@dataclass(frozen=True, slots=True)
class LoadedFitterData:
    document: FitterDataDocument
    source: Literal["primary", "backup", "empty"]


class DataStoreError(RuntimeError):
    pass


class DataCorruptionError(DataStoreError):
    pass


class RevisionConflictError(DataStoreError):
    def __init__(self, current_revision: int) -> None:
        super().__init__(f"current data revision is {current_revision}")
        self.current_revision = current_revision


def empty_fitter_data() -> FitterDataDocument:
    return FitterDataDocument.model_validate({
        "schemaVersion": DATA_SCHEMA_VERSION,
        "revision": 0,
        "savedAt": None,
        "boards": {"version": 3, "savedBoards": [], "history": []},
        "fittings": {"version": 3, "entries": []},
        "solutionHistory": {"version": 3, "models": {}},
        "workspace": None,
    })


def default_data_path() -> Path | None:
    configured_path = os.environ.get("EVE_FRONTIER_FITTER_DATA_PATH")
    if configured_path:
        return Path(configured_path)
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        return None
    return Path(local_app_data) / "EveFrontierFitter" / "data" / "fitter-data.json"


class FitterDataStore:
    def __init__(self, path: Path | None = None, *, starter_path: Path | None = None) -> None:
        self.path = path if path is not None else default_data_path()
        self.backup_path = self.path.with_suffix(".json.bak") if self.path else None
        self.starter_path = starter_path if starter_path is not None else default_starter_path() if path is None else None
        self._lock = threading.RLock()

    @staticmethod
    def _decode(raw: bytes) -> FitterDataDocument:
        try:
            return FitterDataDocument.model_validate_json(raw)
        except (ValidationError, ValueError) as error:
            raise DataCorruptionError("fitter data is not a valid supported document") from error

    @staticmethod
    def _encode(document: FitterDataDocument) -> bytes:
        return json.dumps(
            document.model_dump(by_alias=True, mode="json"),
            ensure_ascii=False,
            indent=2,
        ).encode("utf-8")

    def _read_valid(self, path: Path | None) -> tuple[FitterDataDocument, bytes] | None:
        if path is None or not path.exists():
            return None
        raw = path.read_bytes()
        return self._decode(raw), raw

    def load(self) -> LoadedFitterData:
        with self._lock:
            if self.path is None:
                raise DataStoreError("LOCALAPPDATA is unavailable")
            primary_error: DataCorruptionError | OSError | None = None
            try:
                primary = self._read_valid(self.path)
                if primary is not None:
                    return LoadedFitterData(primary[0], "primary")
            except (DataCorruptionError, OSError) as error:
                primary_error = error
            try:
                backup = self._read_valid(self.backup_path)
                if backup is not None:
                    return LoadedFitterData(backup[0], "backup")
            except (DataCorruptionError, OSError) as error:
                if primary_error is None:
                    primary_error = error
            if primary_error is not None:
                raise DataCorruptionError("primary and backup fitter data are unavailable") from primary_error
            if self.starter_path is not None:
                try:
                    document = FitterDataDocument.model_validate(starter_document(self.starter_path))
                except (OSError, ValueError) as error:
                    raise DataCorruptionError("bundled starter content is unavailable or invalid") from error
                return LoadedFitterData(document, "empty")
            return LoadedFitterData(empty_fitter_data(), "empty")

    @staticmethod
    def _write_and_sync(path: Path, raw: bytes) -> None:
        with path.open("wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())

    def save(self, incoming: FitterDataDocument) -> FitterDataDocument:
        with self._lock:
            if self.path is None or self.backup_path is None:
                raise DataStoreError("LOCALAPPDATA is unavailable")
            loaded = self.load()
            current = loaded.document
            if incoming.revision == current.revision:
                if incoming.model_dump(by_alias=True) == current.model_dump(by_alias=True):
                    return current
                raise RevisionConflictError(current.revision)
            if incoming.revision != current.revision + 1:
                raise RevisionConflictError(current.revision)

            raw = self._encode(incoming)
            self._decode(raw)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            primary_temp = self.path.with_suffix(".json.tmp")
            backup_temp = self.backup_path.with_suffix(".bak.tmp")
            try:
                self._write_and_sync(primary_temp, raw)
                self._decode(primary_temp.read_bytes())

                # Rotate only a verified primary. When load used the backup because
                # the primary was corrupt, preserving that backup is essential.
                if loaded.source == "primary":
                    verified_primary = self.path.read_bytes()
                    self._decode(verified_primary)
                    self._write_and_sync(backup_temp, verified_primary)
                    self._decode(backup_temp.read_bytes())
                    os.replace(backup_temp, self.backup_path)

                os.replace(primary_temp, self.path)
            finally:
                primary_temp.unlink(missing_ok=True)
                backup_temp.unlink(missing_ok=True)
            return incoming


fitter_data_store = FitterDataStore()
