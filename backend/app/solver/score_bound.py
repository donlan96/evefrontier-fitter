from __future__ import annotations

from dataclasses import dataclass

from app.models import ModuleDefinition, SolveRequest
from app.solver.placement_generator import SCORE_SCALE


@dataclass(frozen=True, slots=True)
class IntegerScoreBound:
    valid_cells: int
    minimum_area: int
    upper_bound_units: int


def module_area(module) -> int:
    return len({(point.x, point.y) for point in module.base_shape})


def integer_score_upper_bound(
    request: SolveRequest,
    minimums: dict[str, int],
    maximums: dict[str, int],
    modules: list[ModuleDefinition] | None = None,
) -> IntegerScoreBound:
    valid_cells = sum(cell == 1 for row in request.board.mask for cell in row)
    minimum_area = 0
    minimum_score = 0
    extras: list[tuple[int, int, int]] = []

    for module in modules if modules is not None else request.modules:
        area = module_area(module)
        score_units = round(module.base_score * SCORE_SCALE)
        minimum = minimums[module.id]
        maximum = maximums[module.id]
        minimum_area += minimum * area
        minimum_score += minimum * score_units
        extras.append((area, score_units, max(0, maximum - minimum)))

    remaining_capacity = max(0, valid_cells - minimum_area)
    unreachable = -1
    best_score_by_area = [unreachable] * (remaining_capacity + 1)
    best_score_by_area[0] = 0

    for area, score_units, quantity in extras:
        if score_units <= 0 or quantity <= 0 or area > remaining_capacity:
            continue
        quantity = min(quantity, remaining_capacity // area)
        chunk = 1
        while quantity > 0:
            take = min(chunk, quantity)
            weight = area * take
            value = score_units * take
            for capacity in range(remaining_capacity, weight - 1, -1):
                previous = best_score_by_area[capacity - weight]
                if previous != unreachable:
                    best_score_by_area[capacity] = max(best_score_by_area[capacity], previous + value)
            quantity -= take
            chunk *= 2

    return IntegerScoreBound(
        valid_cells=valid_cells,
        minimum_area=minimum_area,
        upper_bound_units=minimum_score + max(best_score_by_area),
    )
