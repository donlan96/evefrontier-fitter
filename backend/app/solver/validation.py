from __future__ import annotations

from collections import Counter, deque
from dataclasses import dataclass

from app.models import PlacedModule, SolveRequest, SolverSolution
from app.solver.effective_modules import effective_limits, fixed_placements
from app.solver.placement_generator import SCORE_SCALE, PlacementCandidate, placement_key, rotate_shape, normalize_shape


@dataclass(slots=True)
class LayoutValidation:
    valid: bool
    reasons: list[str]
    candidate_indices: list[int]
    solution: SolverSolution | None


def placement_cells(request: SolveRequest, placement: PlacedModule) -> tuple[tuple[int, int], ...] | None:
    module = next((item for item in request.modules if item.id == placement.module_id), None)
    if module is None or placement.orientation.mirrored:
        return None
    if not module.allow_rotation and placement.orientation.rotation != 0:
        return None
    base = normalize_shape([(point.x, point.y) for point in module.base_shape])
    shape = rotate_shape(base, placement.orientation.rotation)
    return tuple((placement.origin.x + x, placement.origin.y + y) for x, y in shape)


def analyze_empty_space(request: SolveRequest, occupied: set[tuple[int, int]]) -> tuple[int, int, int]:
    empty = {(x, y) for y, row in enumerate(request.board.mask) for x, cell in enumerate(row) if cell == 1 and (x, y) not in occupied}
    isolated = 0
    for x, y in empty:
        if not any((x + dx, y + dy) in empty for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
            isolated += 1
    regions = 0
    unseen = set(empty)
    while unseen:
        regions += 1
        queue = deque([unseen.pop()])
        while queue:
            x, y = queue.popleft()
            for neighbor in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if neighbor in unseen:
                    unseen.remove(neighbor)
                    queue.append(neighbor)
    return isolated, regions, len(empty)


def build_solution(request: SolveRequest, placements: list[PlacedModule], elapsed_ms: float, solution_id: str) -> SolverSolution:
    module_map = {module.id: module for module in request.modules}
    counts = Counter(placement.module_id for placement in placements)
    occupied: set[tuple[int, int]] = set()
    for placement in placements:
        cells = placement_cells(request, placement)
        if cells:
            occupied.update(cells)
    isolated, regions, remaining = analyze_empty_space(request, occupied)
    valid_cells = sum(cell == 1 for row in request.board.mask for cell in row)
    score_units = sum(round(module_map[module_id].base_score * SCORE_SCALE) * count
        for module_id, count in counts.items() if module_id in module_map)
    rule_map = {rule.module_id: rule for rule in request.module_rules}
    return SolverSolution(
        id=solution_id,
        placements=placements,
        required_satisfied=all(counts[module_id] >= rule.required_count for module_id, rule in rule_map.items()),
        module_counts={module.id: counts[module.id] for module in request.modules},
        total_score=score_units / SCORE_SCALE,
        occupied_cells=len(occupied),
        utilization=0 if valid_cells == 0 else len(occupied) / valid_cells,
        remaining_cells=remaining,
        isolated_empty_cells=isolated,
        empty_region_count=regions,
        elapsed_ms=elapsed_ms,
    )


def validate_layout(
    request: SolveRequest,
    layout: list[PlacedModule] | None,
    candidates_by_key: dict[str, PlacementCandidate] | None = None,
    require_fixed: bool = True,
    enforce_counts: bool = True,
) -> LayoutValidation:
    if layout is None:
        return LayoutValidation(False, ["布局不存在"], [], None)
    reasons: list[str] = []
    occupied: set[tuple[int, int]] = set()
    counts: Counter[str] = Counter()
    candidate_indices: list[int] = []
    layout_keys = Counter(placement_key(item.module_id, item.orientation.rotation, item.origin.x, item.origin.y) for item in layout)
    fixed = fixed_placements(request)
    fixed_counts = Counter(item.module_id for item in fixed)
    minimums, maximums = effective_limits(request, fixed_counts)

    if require_fixed:
        for placement in fixed:
            key = placement_key(placement.module_id, placement.orientation.rotation, placement.origin.x, placement.origin.y)
            if layout_keys[key] <= 0:
                reasons.append(f"缺少固定模块 {placement.module_id}")
            else:
                layout_keys[key] -= 1

    for placement in layout:
        cells = placement_cells(request, placement)
        if cells is None:
            reasons.append(f"模块 {placement.module_id} 不存在、方向无效或使用了镜像")
            continue
        if any(x < 0 or y < 0 or x >= request.board.width or y >= request.board.height or request.board.mask[y][x] != 1 for x, y in cells):
            reasons.append(f"模块 {placement.module_id} 超出有效棋盘")
            continue
        if any(cell in occupied for cell in cells):
            reasons.append(f"模块 {placement.module_id} 与其他模块重叠")
            continue
        occupied.update(cells)
        counts[placement.module_id] += 1
        if candidates_by_key is not None:
            candidate = candidates_by_key.get(placement_key(placement.module_id, placement.orientation.rotation, placement.origin.x, placement.origin.y))
            if candidate is None:
                reasons.append(f"模块 {placement.module_id} 不是合法候选位置")
            else:
                candidate_indices.append(candidate.index)

    if enforce_counts:
        for module in request.modules:
            if counts[module.id] > module.available_quantity:
                reasons.append(f"模块 {module.id} 超过库存 {module.available_quantity}")
        for module_id, minimum in minimums.items():
            if counts[module_id] < minimum:
                reasons.append(f"必备模块 {module_id} 需要 {minimum}，当前只有 {counts[module_id]}")
            if counts[module_id] > maximums[module_id]:
                reasons.append(f"模块 {module_id} 超过最大数量 {maximums[module_id]}")
    unknown = set(counts) - set(maximums)
    if unknown:
        reasons.append(f"布局引用未知模块：{', '.join(sorted(unknown))}")

    solution = None if reasons else build_solution(request, layout, 0, "hint")
    return LayoutValidation(not reasons, reasons, candidate_indices, solution)
