import type { PointerEvent } from "react";
import type { GridPoint } from "../models/board";
import type { ModuleDefinition } from "../models/module";
import type { PlacedModuleData } from "../models/placement";
import { pointKey } from "../utils/normalizeShape";
import { getOrientedShape } from "../utils/rotateShape";
import { BOARD_CELL, BOARD_GAP, BOARD_PADDING } from "./boardLayout";

interface PlacedModuleProps {
  placement: PlacedModuleData;
  module: ModuleDefinition;
  selected: boolean;
  locked: boolean;
  hidden: boolean;
  onPointerDown: (placement: PlacedModuleData, anchor: GridPoint, event: PointerEvent<HTMLDivElement>) => void;
}

export function PlacedModule(props: PlacedModuleProps) {
  if (props.hidden) return null;
  const shape = getOrientedShape(props.module, props.placement.orientation.rotation);
  const shapeCells = new Set(shape.map(pointKey));
  const hasCell = (x: number, y: number) => shapeCells.has(pointKey({ x, y }));
  const cellLeft = (x: number) => BOARD_PADDING + (props.placement.origin.x + x) * (BOARD_CELL + BOARD_GAP);
  const cellTop = (y: number) => BOARD_PADDING + (props.placement.origin.y + y) * (BOARD_CELL + BOARD_GAP);
  return (
    <div className={`placed-module${props.selected ? " is-selected" : ""}${props.locked ? " is-locked" : ""}`}>
      {props.locked && (
        <span
          className="lock-indicator"
          style={{
            left: BOARD_PADDING + props.placement.origin.x * (BOARD_CELL + BOARD_GAP) + 3,
            top: BOARD_PADDING + props.placement.origin.y * (BOARD_CELL + BOARD_GAP) + 3,
          }}
        >锁</span>
      )}
      {shape.map((point) => (
        <div
          key={`${point.x},${point.y}`}
          className="placed-cell"
          title={`${props.module.name} · ${props.placement.orientation.rotation}°${props.locked ? " · 自动配装已锁定" : ""}`}
          style={{
            left: cellLeft(point.x),
            top: cellTop(point.y),
            width: BOARD_CELL,
            height: BOARD_CELL,
            backgroundColor: props.module.color,
          }}
          onPointerDown={(event) => props.onPointerDown(props.placement, point, event)}
        />
      ))}
      {shape.flatMap((point) => {
        const left = cellLeft(point.x);
        const top = cellTop(point.y);
        return [
          !hasCell(point.x, point.y - 1) && <span key={`${point.x},${point.y},top`} className="module-outline-edge is-horizontal" style={{ left: left - 2, top: top - 2 }} />,
          !hasCell(point.x + 1, point.y) && <span key={`${point.x},${point.y},right`} className="module-outline-edge is-vertical" style={{ left: left + BOARD_CELL - 1, top: top - 2 }} />,
          !hasCell(point.x, point.y + 1) && <span key={`${point.x},${point.y},bottom`} className="module-outline-edge is-horizontal" style={{ left: left - 2, top: top + BOARD_CELL - 1 }} />,
          !hasCell(point.x - 1, point.y) && <span key={`${point.x},${point.y},left`} className="module-outline-edge is-vertical" style={{ left: left - 2, top: top - 2 }} />,
        ].filter(Boolean);
      })}
    </div>
  );
}
