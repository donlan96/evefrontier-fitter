import type { PointerEvent } from "react";
import type { GridPoint } from "../models/board";
import type { ModuleShape } from "../models/module";
import { getShapeBounds, pointKey } from "../utils/normalizeShape";

interface ShapeMiniatureProps {
  shape: ModuleShape;
  color: string;
  interactive?: boolean;
  onCellPointerDown?: (point: GridPoint, event: PointerEvent<HTMLDivElement>) => void;
}

export function ShapeMiniature({ shape, color, interactive, onCellPointerDown }: ShapeMiniatureProps) {
  const { width, height } = getShapeBounds(shape);
  const occupied = new Set(shape.map(pointKey));
  return (
    <div
      className={`shape-miniature${interactive ? " is-draggable" : ""}`}
      style={{ gridTemplateColumns: `repeat(${width}, 14px)` }}
      aria-label={`${width} × ${height}，${shape.length} 格`}
    >
      {Array.from({ length: width * height }, (_, index) => {
        const point = { x: index % width, y: Math.floor(index / width) };
        const filled = occupied.has(pointKey(point));
        return (
          <div
            key={pointKey(point)}
            className={`mini-cell${filled ? " is-filled" : ""}`}
            style={filled ? { backgroundColor: color, borderColor: color } : undefined}
            onPointerDown={filled && interactive ? (event) => onCellPointerDown?.(point, event) : undefined}
          />
        );
      })}
    </div>
  );
}
