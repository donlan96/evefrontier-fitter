import type { BoardDefinition } from "../models/board";
import type { PlacedModuleData } from "../models/placement";

export function analyzeEmptySpace(
  board: BoardDefinition,
  occupancy: Uint8Array,
): { isolatedEmptyCells: number; emptyRegionCount: number; remainingCells: number } {
  const empty = new Set<number>();
  for (let y = 0; y < board.height; y += 1) {
    for (let x = 0; x < board.width; x += 1) {
      const index = y * board.width + x;
      if (board.mask[y][x] === 1 && occupancy[index] === 0) empty.add(index);
    }
  }
  let isolatedEmptyCells = 0;
  for (const index of empty) {
    const x = index % board.width;
    const y = Math.floor(index / board.width);
    const neighbors = [
      y > 0 ? index - board.width : -1,
      y + 1 < board.height ? index + board.width : -1,
      x > 0 ? index - 1 : -1,
      x + 1 < board.width ? index + 1 : -1,
    ];
    if (!neighbors.some((neighbor) => empty.has(neighbor))) isolatedEmptyCells += 1;
  }
  let emptyRegionCount = 0;
  const unseen = new Set(empty);
  while (unseen.size > 0) {
    emptyRegionCount += 1;
    const queue = [unseen.values().next().value as number];
    unseen.delete(queue[0]);
    while (queue.length > 0) {
      const index = queue.pop()!;
      const x = index % board.width;
      const y = Math.floor(index / board.width);
      const neighbors = [
        y > 0 ? index - board.width : -1,
        y + 1 < board.height ? index + board.width : -1,
        x > 0 ? index - 1 : -1,
        x + 1 < board.width ? index + 1 : -1,
      ];
      for (const neighbor of neighbors) if (unseen.delete(neighbor)) queue.push(neighbor);
    }
  }
  return { isolatedEmptyCells, emptyRegionCount, remainingCells: empty.size };
}

export function createSolutionSignature(placements: PlacedModuleData[]): string {
  return placements
    .map((placement) => `${placement.moduleId}@${placement.orientation.rotation}:${placement.origin.x},${placement.origin.y}`)
    .sort()
    .join("|");
}
