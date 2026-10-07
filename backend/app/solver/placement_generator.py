from __future__ import annotations

from dataclasses import dataclass

from app.models import BoardDefinition, ModuleDefinition, Point, Rotation


SCORE_SCALE = 1_000


@dataclass(frozen=True, slots=True)
class PlacementCandidate:
    index: int
    module_id: str
    rotation: Rotation
    origin_x: int
    origin_y: int
    occupied_cells: tuple[tuple[int, int], ...]
    cell_indices: tuple[int, ...]
    score_units: int
    area: int

    @property
    def key(self) -> str:
        return placement_key(self.module_id, self.rotation, self.origin_x, self.origin_y)


def placement_key(module_id: str, rotation: int, x: int, y: int) -> str:
    return f"{module_id}@{rotation}:{x},{y}"


def normalize_shape(points: list[tuple[int, int]]) -> tuple[tuple[int, int], ...]:
    unique = set(points)
    min_x = min(x for x, _ in unique)
    min_y = min(y for _, y in unique)
    return tuple(sorted(((x - min_x, y - min_y) for x, y in unique), key=lambda item: (item[1], item[0])))


def rotate_shape(shape: tuple[tuple[int, int], ...], rotation: Rotation) -> tuple[tuple[int, int], ...]:
    result = normalize_shape(list(shape))
    for _ in range(rotation // 90):
        result = normalize_shape([(-y, x) for x, y in result])
    return result


def unique_rotations(module: ModuleDefinition) -> list[tuple[Rotation, tuple[tuple[int, int], ...]]]:
    base = normalize_shape([(point.x, point.y) for point in module.base_shape])
    rotations: list[Rotation] = [0, 90, 180, 270] if module.allow_rotation else [0]
    seen: set[tuple[tuple[int, int], ...]] = set()
    result: list[tuple[Rotation, tuple[tuple[int, int], ...]]] = []
    for rotation in rotations:
        shape = rotate_shape(base, rotation)
        if shape in seen:
            continue
        seen.add(shape)
        result.append((rotation, shape))
    return result


def generate_placements(board: BoardDefinition, modules: list[ModuleDefinition]) -> list[PlacementCandidate]:
    placements: list[PlacementCandidate] = []
    for module in modules:
        for rotation, shape in unique_rotations(module):
            shape_width = max(x for x, _ in shape) + 1
            shape_height = max(y for _, y in shape) + 1
            for origin_y in range(board.height - shape_height + 1):
                for origin_x in range(board.width - shape_width + 1):
                    cells = tuple((origin_x + x, origin_y + y) for x, y in shape)
                    if any(board.mask[y][x] != 1 for x, y in cells):
                        continue
                    placements.append(PlacementCandidate(
                        index=len(placements),
                        module_id=module.id,
                        rotation=rotation,
                        origin_x=origin_x,
                        origin_y=origin_y,
                        occupied_cells=cells,
                        cell_indices=tuple(y * board.width + x for x, y in cells),
                        score_units=round(module.base_score * SCORE_SCALE),
                        area=len(shape),
                    ))
    return placements


def candidate_cells(candidate: PlacementCandidate) -> list[Point]:
    return [Point(x=x, y=y) for x, y in candidate.occupied_cells]
