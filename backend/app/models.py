from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator, model_validator


def to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Point(ApiModel):
    x: int
    y: int


class BoardDefinition(ApiModel):
    id: str
    name: str
    width: int = Field(ge=1, le=200)
    height: int = Field(ge=1, le=200)
    mask: list[list[Literal[0, 1]]]

    @model_validator(mode="after")
    def validate_mask(self) -> "BoardDefinition":
        if len(self.mask) != self.height or any(len(row) != self.width for row in self.mask):
            raise ValueError("board mask dimensions do not match width and height")
        return self


Rotation = Literal[0, 90, 180, 270]


class ModuleDefinition(ApiModel):
    id: str
    name: str
    type: str
    base_shape: list[Point] = Field(min_length=1)
    color: str
    available_quantity: int = Field(ge=0)
    allow_rotation: bool
    allow_mirror: bool
    base_score: float = Field(ge=0, strict=True, allow_inf_nan=False)
    attributes: dict[str, float] = Field(default_factory=dict)

    @field_validator("base_score")
    @classmethod
    def limit_score_precision(cls, value: float) -> float:
        if round(value, 3) != value:
            raise ValueError("baseScore supports at most three decimal places")
        return value


class Orientation(ApiModel):
    rotation: Rotation
    mirrored: bool = False


class PlacedModule(ApiModel):
    instance_id: str
    module_id: str
    origin: Point
    orientation: Orientation


class ModuleRule(ApiModel):
    module_id: str
    required_count: int = Field(ge=0)
    enabled: bool
    max_count: int = Field(ge=0)


class SoftSkeletonTrainingLayout(ApiModel):
    source_problem_fingerprint: str = Field(min_length=1)
    source_layout_signature: str = Field(min_length=1)
    layout: list[PlacedModule] = Field(min_length=1)
    proven_score: float = Field(ge=0)
    best_bound: float = Field(ge=0)
    proof_problem_signature: str = Field(min_length=1)


SolveScope = Literal["empty-board", "fill-current", "rearrange-unlocked"]
SearchWorkersMode = Literal["standard", "all", "custom"]
MAX_REQUESTED_SEARCH_WORKERS = 256


class SearchWorkersSetting(ApiModel):
    mode: SearchWorkersMode = "standard"
    value: StrictInt | None = None

    @model_validator(mode="after")
    def validate_value(self) -> "SearchWorkersSetting":
        if self.mode == "custom":
            if self.value is None:
                raise ValueError("custom search workers requires a value")
            if self.value < 1 or self.value > MAX_REQUESTED_SEARCH_WORKERS:
                raise ValueError(f"custom search workers must be between 1 and {MAX_REQUESTED_SEARCH_WORKERS}")
        elif self.value is not None:
            raise ValueError("search worker value is only valid in custom mode")
        return self


class SolveRequest(ApiModel):
    board: BoardDefinition
    modules: list[ModuleDefinition]
    module_rules: list[ModuleRule]
    scope: SolveScope
    locked_placements: list[PlacedModule]
    current_layout: list[PlacedModule]
    history_best_layout: list[PlacedModule] | None = None
    problem_fingerprint: str | None = None
    soft_skeleton_training_layouts: list[SoftSkeletonTrainingLayout] = Field(default_factory=list)
    search_workers: SearchWorkersSetting | None = None
    time_limit_ms: int | None = Field(default=30_000, ge=1, le=86_400_000)

    @model_validator(mode="after")
    def validate_unique_ids(self) -> "SolveRequest":
        module_ids = [module.id for module in self.modules]
        rule_ids = [rule.module_id for rule in self.module_rules]
        if len(set(module_ids)) != len(module_ids):
            raise ValueError("module IDs must be unique")
        if len(set(rule_ids)) != len(rule_ids):
            raise ValueError("module rules must be unique")
        return self


class SolverSolution(ApiModel):
    id: str
    placements: list[PlacedModule]
    required_satisfied: bool
    module_counts: dict[str, int]
    total_score: float
    occupied_cells: int
    utilization: float
    remaining_cells: int
    isolated_empty_cells: int
    empty_region_count: int
    elapsed_ms: float


JobStatus = Literal["queued", "running", "completed", "time-limit", "stopped", "infeasible", "error"]
SolverStatus = Literal["UNKNOWN", "MODEL_INVALID", "FEASIBLE", "INFEASIBLE", "OPTIMAL", "STOPPED", "ERROR"]


class SolverJobSnapshot(ApiModel):
    job_id: str
    status: JobStatus
    best_solution: SolverSolution | None = None
    score: float = 0
    best_bound: float = 0
    optimality_gap: float = 0
    elapsed_ms: float = 0
    solver_status: SolverStatus = "UNKNOWN"
    proven_optimal: bool = False
    solver_phase: str | None = None
    requested_search_workers: SearchWorkersSetting | None = None
    effective_search_workers: int = 8
    logical_cpu_count: int = 1
    default_search_workers: int = 8
    search_workers_clamped: bool = False
    infeasible_reasons: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


class HealthResponse(ApiModel):
    status: Literal["ok"] = "ok"
    solver: Literal["ortools-cp-sat"] = "ortools-cp-sat"
    version: str
