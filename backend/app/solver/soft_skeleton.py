from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
import hashlib
import json
import time
from typing import Any

from app.models import PlacedModule, SoftSkeletonTrainingLayout, SolveRequest
from app.solver.effective_modules import effective_limits, effective_modules
from app.solver.placement_generator import SCORE_SCALE, PlacementCandidate, normalize_shape, rotate_shape


GeometrySignature = tuple[tuple[tuple[int, int], ...], bool, bool]


@dataclass(slots=True)
class SoftSkeletonDecision:
    enabled: bool
    reason: str
    generation_ms: float
    qualified_source_count: int = 0
    source_fingerprints: list[str] = field(default_factory=list)
    selected_module_shapes: list[dict[str, Any]] = field(default_factory=list)
    candidate_indices: list[int] = field(default_factory=list)
    positive_hint_count: int = 0
    decision_strategy_added: bool = False
    details: list[str] = field(default_factory=list)

    def diagnostic(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "reason": self.reason,
            "generationMs": round(self.generation_ms, 3),
            "qualifiedSourceCount": self.qualified_source_count,
            "sourceFingerprints": self.source_fingerprints,
            "selectedModuleShapes": self.selected_module_shapes,
            "candidateIndices": self.candidate_indices,
            "positiveHintCount": self.positive_hint_count,
            "decisionStrategyAdded": self.decision_strategy_added,
            "invariants": {
                "candidateCountUnchanged": True,
                "variableCountUnchanged": True,
                "constraintCountUnchanged": True,
                "objectiveUnchanged": True,
                "zeroHintsAdded": 0,
                "fixedPositionsAdded": 0,
                "candidatesDeleted": 0,
            },
            "details": self.details,
        }


@dataclass(frozen=True, slots=True)
class _SourceModule:
    module_id: str
    geometry: GeometrySignature
    catalog_key: tuple[Any, ...]
    available_quantity: int
    base_score_units: int


@dataclass(slots=True)
class _ValidatedSource:
    fingerprint: str
    layout_signature: str
    modules: dict[str, _SourceModule]
    placements_by_geometry: dict[GeometrySignature, list[PlacedModule]]


def module_geometry_signature(shape: list[tuple[int, int]], allow_rotation: bool, allow_mirror: bool) -> GeometrySignature:
    return normalize_shape(shape), allow_rotation, allow_mirror


def module_shape_digest(signature: GeometrySignature) -> str:
    shape, allow_rotation, allow_mirror = signature
    payload = {
        "baseShape": shape,
        "allowRotation": allow_rotation,
        "allowMirror": allow_mirror,
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _shape_from_key(value: Any) -> tuple[tuple[int, int], ...]:
    if not isinstance(value, str) or not value:
        raise ValueError("模块形状签名缺失")
    points: list[tuple[int, int]] = []
    for part in value.split(";"):
        x_text, separator, y_text = part.partition(",")
        if separator != ",":
            raise ValueError("模块形状签名格式错误")
        points.append((int(x_text), int(y_text)))
    normalized = normalize_shape(points)
    if len(normalized) != len(points):
        raise ValueError("模块形状签名包含重复格")
    return normalized


def _catalog_key(geometry: GeometrySignature, available_quantity: int, base_score_units: int) -> tuple[Any, ...]:
    return geometry, available_quantity, base_score_units


def _current_catalog(request: SolveRequest) -> Counter[tuple[Any, ...]]:
    _, maximums = effective_limits(request)
    return Counter(
        _catalog_key(
            module_geometry_signature(
                [(point.x, point.y) for point in module.base_shape],
                module.allow_rotation,
                module.allow_mirror,
            ),
            maximums[module.id],
            round(module.base_score * SCORE_SCALE),
        )
        for module in effective_modules(request)
    )


def _solution_signature(layout: list[PlacedModule]) -> str:
    return "|".join(
        sorted(
            f"{placement.module_id}@{placement.orientation.rotation}:{placement.origin.x},{placement.origin.y}"
            for placement in layout
        )
    )


def _consensus_key(module_geometry: GeometrySignature, candidate: PlacementCandidate) -> str:
    return json.dumps(
        {
            "shapeSignature": module_shape_digest(module_geometry),
            "origin": {"x": candidate.origin_x, "y": candidate.origin_y},
            "orientation": {"rotation": candidate.rotation, "mirrored": False},
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def _proof_document(source: SoftSkeletonTrainingLayout) -> dict[str, Any]:
    document = json.loads(source.proof_problem_signature)
    if not isinstance(document, dict):
        raise ValueError("证明问题签名不是对象")
    if document.get("version") != 2:
        raise ValueError("证明问题签名版本不兼容")
    if not isinstance(document.get("board"), dict):
        raise ValueError("证明问题签名缺少棋盘")
    if not isinstance(document.get("modules"), list) or not isinstance(document.get("rules"), list):
        raise ValueError("证明问题签名缺少模块或规则")
    if not isinstance(document.get("locked"), list):
        raise ValueError("证明问题签名缺少锁定列表")
    return document


def _validate_source(
    request: SolveRequest,
    source: SoftSkeletonTrainingLayout,
    current_catalog: Counter[tuple[Any, ...]],
) -> _ValidatedSource:
    if source.proven_score != source.best_bound:
        raise ValueError("证明分数与Best bound不一致")
    if _solution_signature(source.layout) != source.source_layout_signature:
        raise ValueError("来源布局签名不一致")
    document = _proof_document(source)
    board = document["board"]
    if (
        board.get("width") != request.board.width
        or board.get("height") != request.board.height
        or board.get("mask") != request.board.mask
    ):
        raise ValueError("棋盘几何不兼容")
    if document["locked"]:
        raise ValueError("来源证明包含锁定模块")

    modules: dict[str, _SourceModule] = {}
    source_catalog: Counter[tuple[Any, ...]] = Counter()
    for raw in document["modules"]:
        if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
            raise ValueError("证明模块字段无效")
        module_id = raw["id"]
        if module_id in modules:
            raise ValueError("证明模块ID重复")
        shape = _shape_from_key(raw.get("shape"))
        allow_rotation = raw.get("allowRotation")
        allow_mirror = raw.get("allowMirror")
        available_quantity = raw.get("availableQuantity")
        base_score = raw.get("baseScore")
        if not isinstance(allow_rotation, bool) or not isinstance(allow_mirror, bool):
            raise ValueError("证明模块方向规则无效")
        if not isinstance(available_quantity, int) or available_quantity < 0:
            raise ValueError("证明模块库存无效")
        if not isinstance(base_score, (int, float)) or base_score < 0 or round(base_score, 3) != base_score:
            raise ValueError("证明模块评分无效")
        geometry = module_geometry_signature(list(shape), allow_rotation, allow_mirror)
        catalog_key = _catalog_key(geometry, available_quantity, round(base_score * SCORE_SCALE))
        modules[module_id] = _SourceModule(
            module_id=module_id,
            geometry=geometry,
            catalog_key=catalog_key,
            available_quantity=available_quantity,
            base_score_units=round(base_score * SCORE_SCALE),
        )
        source_catalog[catalog_key] += 1
    if source_catalog != current_catalog:
        raise ValueError("模块形状、方向、库存或评分目录不兼容")

    rules: dict[str, dict[str, Any]] = {}
    for raw in document["rules"]:
        if not isinstance(raw, dict) or raw.get("moduleId") not in modules:
            raise ValueError("证明规则引用无效模块")
        module_id = raw["moduleId"]
        if module_id in rules:
            raise ValueError("证明规则模块重复")
        if (
            not isinstance(raw.get("requiredCount"), int)
            or raw["requiredCount"] < 0
            or not isinstance(raw.get("maxCount"), int)
            or raw["maxCount"] < 0
            or not isinstance(raw.get("enabled"), bool)
        ):
            raise ValueError("证明规则字段无效")
        rules[module_id] = raw
    if set(rules) != set(modules):
        raise ValueError("证明规则未完整覆盖模块目录")

    occupied: set[tuple[int, int]] = set()
    counts: Counter[str] = Counter()
    score_units = 0
    placements_by_geometry: dict[GeometrySignature, list[PlacedModule]] = {}
    for placement in source.layout:
        module = modules.get(placement.module_id)
        if module is None:
            raise ValueError("来源布局引用未知模块")
        if placement.orientation.mirrored:
            raise ValueError("来源布局使用了未支持的镜像")
        if not module.geometry[1] and placement.orientation.rotation != 0:
            raise ValueError("来源布局旋转规则无效")
        shape = rotate_shape(module.geometry[0], placement.orientation.rotation)
        cells = tuple((placement.origin.x + x, placement.origin.y + y) for x, y in shape)
        if any(
            x < 0
            or y < 0
            or x >= request.board.width
            or y >= request.board.height
            or request.board.mask[y][x] != 1
            for x, y in cells
        ):
            raise ValueError("来源布局包含非法位置")
        if occupied.intersection(cells):
            raise ValueError("来源布局存在重叠")
        occupied.update(cells)
        counts[module.module_id] += 1
        score_units += module.base_score_units
        placements_by_geometry.setdefault(module.geometry, []).append(placement)

    for module_id, module in modules.items():
        raw_rule = rules.get(module_id, {"requiredCount": 0, "enabled": False, "maxCount": 0})
        minimum = raw_rule["requiredCount"]
        maximum = max(
            minimum,
            min(module.available_quantity, raw_rule["maxCount"]) if raw_rule["enabled"] else minimum,
        )
        if counts[module_id] < minimum or counts[module_id] > maximum:
            raise ValueError("来源布局不满足证明数量规则")
    if score_units != round(source.proven_score * SCORE_SCALE):
        raise ValueError("来源布局评分与证明分数不一致")
    return _ValidatedSource(
        fingerprint=source.source_problem_fingerprint,
        layout_signature=source.source_layout_signature,
        modules=modules,
        placements_by_geometry=placements_by_geometry,
    )


def _disabled(started: float, reason: str, **kwargs: Any) -> SoftSkeletonDecision:
    return SoftSkeletonDecision(
        enabled=False,
        reason=reason,
        generation_ms=(time.monotonic() - started) * 1_000,
        **kwargs,
    )


def generate_soft_skeleton(
    request: SolveRequest,
    candidates: list[PlacementCandidate],
    *,
    complete_hint_available: bool,
) -> SoftSkeletonDecision:
    started = time.monotonic()
    if complete_hint_available:
        return _disabled(started, "complete-layout-hint-available")
    if request.locked_placements:
        return _disabled(started, "locked-placements-present")
    sources = request.soft_skeleton_training_layouts
    source_fingerprints = [source.source_problem_fingerprint for source in sources]
    if len(sources) != 2:
        return _disabled(
            started,
            "training-source-count-not-two",
            source_fingerprints=source_fingerprints,
            details=[f"received {len(sources)} training sources"],
        )
    if len(set(source_fingerprints)) != 2:
        return _disabled(
            started,
            "duplicate-training-source-fingerprint",
            source_fingerprints=source_fingerprints,
        )
    if request.problem_fingerprint and request.problem_fingerprint in source_fingerprints:
        return _disabled(
            started,
            "current-fingerprint-used-as-training",
            source_fingerprints=source_fingerprints,
        )

    current_catalog = _current_catalog(request)
    validated_sources: list[_ValidatedSource] = []
    source_errors: list[str] = []
    for source in sources:
        try:
            validated_sources.append(_validate_source(request, source, current_catalog))
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            source_errors.append(f"{source.source_problem_fingerprint}: {error}")
    if len(validated_sources) != 2:
        return _disabled(
            started,
            "invalid-or-incompatible-training-source",
            qualified_source_count=len(validated_sources),
            source_fingerprints=source_fingerprints,
            details=source_errors,
        )

    rules = {rule.module_id: rule for rule in request.module_rules}
    eligible_modules = [
        module
        for module in request.modules
        if rules.get(module.id) is not None
        and rules[module.id].required_count > 0
        and round(module.base_score * SCORE_SCALE) == 0
    ]
    selected = sorted(
        eligible_modules,
        key=lambda module: (
            -len(normalize_shape([(point.x, point.y) for point in module.base_shape])),
            module_shape_digest(
                module_geometry_signature(
                    [(point.x, point.y) for point in module.base_shape],
                    module.allow_rotation,
                    module.allow_mirror,
                )
            ),
        ),
    )[:4]
    selected_shapes = []
    geometries: list[GeometrySignature] = []
    eligible_geometry_counts = Counter(
        module_geometry_signature(
            [(point.x, point.y) for point in module.base_shape],
            module.allow_rotation,
            module.allow_mirror,
        )
        for module in eligible_modules
    )
    for module in selected:
        geometry = module_geometry_signature(
            [(point.x, point.y) for point in module.base_shape],
            module.allow_rotation,
            module.allow_mirror,
        )
        geometries.append(geometry)
        selected_shapes.append(
            {
                "shapeSignature": module_shape_digest(geometry),
                "area": len(geometry[0]),
                "requiredCount": rules[module.id].required_count,
            }
        )
    if any(eligible_geometry_counts[geometry] > 1 for geometry in geometries):
        return _disabled(
            started,
            "ambiguous-selected-module-shapes",
            qualified_source_count=2,
            source_fingerprints=source_fingerprints,
            selected_module_shapes=selected_shapes,
        )
    if any(rules[module.id].required_count != 1 for module in selected):
        return _disabled(
            started,
            "selected-module-required-count-not-one",
            qualified_source_count=2,
            source_fingerprints=source_fingerprints,
            selected_module_shapes=selected_shapes,
        )

    current_candidate_map = {
        (candidate.module_id, candidate.origin_x, candidate.origin_y, candidate.rotation): candidate
        for candidate in candidates
    }
    consensus: list[tuple[GeometrySignature, PlacementCandidate]] = []
    details: list[str] = []
    for module, geometry in zip(selected, geometries, strict=True):
        source_positions = [source.placements_by_geometry.get(geometry, []) for source in validated_sources]
        if any(len(items) != 1 for items in source_positions):
            continue
        left, right = source_positions[0][0], source_positions[1][0]
        left_key = (left.origin.x, left.origin.y, left.orientation.rotation, left.orientation.mirrored)
        right_key = (right.origin.x, right.origin.y, right.orientation.rotation, right.orientation.mirrored)
        if left_key != right_key:
            continue
        if left.orientation.mirrored:
            return _disabled(
                started,
                "consensus-candidate-uses-mirror",
                qualified_source_count=2,
                source_fingerprints=source_fingerprints,
                selected_module_shapes=selected_shapes,
            )
        candidate = current_candidate_map.get((module.id, left.origin.x, left.origin.y, left.orientation.rotation))
        if candidate is None:
            return _disabled(
                started,
                "consensus-candidate-not-currently-legal",
                qualified_source_count=2,
                source_fingerprints=source_fingerprints,
                selected_module_shapes=selected_shapes,
            )
        consensus.append((geometry, candidate))
        details.append(f"{module_shape_digest(geometry)} -> candidate {candidate.index}")

    if len(consensus) != 2:
        return _disabled(
            started,
            "consensus-candidate-count-not-two",
            qualified_source_count=2,
            source_fingerprints=source_fingerprints,
            selected_module_shapes=selected_shapes,
            candidate_indices=[candidate.index for _, candidate in consensus],
            details=details,
        )
    consensus.sort(key=lambda item: _consensus_key(item[0], item[1]))
    if set(consensus[0][1].occupied_cells).intersection(consensus[1][1].occupied_cells):
        return _disabled(
            started,
            "consensus-candidates-overlap",
            qualified_source_count=2,
            source_fingerprints=source_fingerprints,
            selected_module_shapes=selected_shapes,
            candidate_indices=[candidate.index for _, candidate in consensus],
            details=details,
        )
    return SoftSkeletonDecision(
        enabled=True,
        reason="enabled",
        generation_ms=(time.monotonic() - started) * 1_000,
        qualified_source_count=2,
        source_fingerprints=source_fingerprints,
        selected_module_shapes=selected_shapes,
        candidate_indices=[candidate.index for _, candidate in consensus],
        positive_hint_count=2,
        details=details,
    )
