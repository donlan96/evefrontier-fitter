import type { GridPoint } from "../models/board";
import type { ModuleShape } from "../models/module";

export function pointKey(point: GridPoint): string {
  return `${point.x},${point.y}`;
}

export function normalizeShape(shape: ModuleShape): ModuleShape {
  if (shape.length === 0) return [];
  const unique = [...new Map(shape.map((point) => [pointKey(point), point])).values()];
  const minX = Math.min(...unique.map((point) => point.x));
  const minY = Math.min(...unique.map((point) => point.y));
  return unique
    .map((point) => ({ x: point.x - minX, y: point.y - minY }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

export function shapeKey(shape: ModuleShape): string {
  return normalizeShape(shape).map(pointKey).join(";");
}

export function getShapeBounds(shape: ModuleShape): { width: number; height: number } {
  if (shape.length === 0) return { width: 0, height: 0 };
  return {
    width: Math.max(...shape.map((point) => point.x)) + 1,
    height: Math.max(...shape.map((point) => point.y)) + 1,
  };
}

export function isConnectedShape(shape: ModuleShape): boolean {
  if (shape.length === 0) return false;
  const cells = new Set(shape.map(pointKey));
  const visited = new Set<string>();
  const queue = [shape[0]];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const key = pointKey(current);
    if (visited.has(key)) continue;
    visited.add(key);
    [
      { x: current.x + 1, y: current.y },
      { x: current.x - 1, y: current.y },
      { x: current.x, y: current.y + 1 },
      { x: current.x, y: current.y - 1 },
    ].forEach((next) => {
      if (cells.has(pointKey(next)) && !visited.has(pointKey(next))) queue.push(next);
    });
  }
  return visited.size === cells.size;
}
