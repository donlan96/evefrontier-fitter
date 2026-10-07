from __future__ import annotations

from collections import deque
from dataclasses import dataclass

from app.models import BoardDefinition


@dataclass(frozen=True, slots=True)
class BoardComponents:
    cell_to_component: dict[int, int]
    cells: tuple[tuple[int, ...], ...]

    @property
    def sizes(self) -> tuple[int, ...]:
        return tuple(len(component) for component in self.cells)


def find_board_components(board: BoardDefinition) -> BoardComponents:
    """Split usable board cells into orthogonally connected regions."""

    unseen = {
        y * board.width + x
        for y, row in enumerate(board.mask)
        for x, cell in enumerate(row)
        if cell == 1
    }
    components: list[tuple[int, ...]] = []
    cell_to_component: dict[int, int] = {}

    while unseen:
        start = min(unseen)
        unseen.remove(start)
        queue = deque([start])
        component: list[int] = []
        while queue:
            cell_index = queue.popleft()
            component.append(cell_index)
            x = cell_index % board.width
            y = cell_index // board.width
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if nx < 0 or nx >= board.width or ny < 0 or ny >= board.height:
                    continue
                neighbor = ny * board.width + nx
                if neighbor in unseen:
                    unseen.remove(neighbor)
                    queue.append(neighbor)
        component_id = len(components)
        normalized = tuple(sorted(component))
        components.append(normalized)
        for cell_index in normalized:
            cell_to_component[cell_index] = component_id

    return BoardComponents(cell_to_component, tuple(components))
