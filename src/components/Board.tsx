import { forwardRef, type PointerEvent } from "react";
import type { BoardDefinition, GridPoint } from "../models/board";
import type { ModuleDefinition } from "../models/module";
import type { PlacedModuleData } from "../models/placement";
import { pointKey } from "../utils/normalizeShape";
import { PlacedModule } from "./PlacedModule";
import { BOARD_CELL, BOARD_GAP, BOARD_PADDING } from "./boardLayout";

interface BoardProps {
  board: BoardDefinition;
  modules: ModuleDefinition[];
  placements: PlacedModuleData[];
  selectedInstanceId: string | null;
  lockedPlacementIds: Set<string>;
  hiddenInstanceId?: string;
  preview?: { cells: GridPoint[]; valid: boolean } | null;
  onPlacedPointerDown: (
    placement: PlacedModuleData,
    anchor: GridPoint,
    event: PointerEvent<HTMLDivElement>,
  ) => void;
}

export const Board = forwardRef<HTMLDivElement, BoardProps>(function Board(props, ref) {
  const moduleMap = new Map(props.modules.map((module) => [module.id, module]));
  const previewCells = new Set(props.preview?.cells.map(pointKey) ?? []);
  const width = BOARD_PADDING * 2 + props.board.width * BOARD_CELL + (props.board.width - 1) * BOARD_GAP;
  const height = BOARD_PADDING * 2 + props.board.height * BOARD_CELL + (props.board.height - 1) * BOARD_GAP;

  return (
    <div className="board-viewport">
      <div className="board-ruler board-ruler-top">舰首方向 →</div>
      <div
        className="board-surface"
        ref={ref}
        style={{ width, height }}
        aria-label={`${props.board.name}，${props.board.width} × ${props.board.height}`}
      >
        <div
          className="board-cell-layer"
          style={{
            left: BOARD_PADDING,
            top: BOARD_PADDING,
            gridTemplateColumns: `repeat(${props.board.width}, ${BOARD_CELL}px)`,
            gridTemplateRows: `repeat(${props.board.height}, ${BOARD_CELL}px)`,
            gap: BOARD_GAP,
          }}
        >
          {props.board.mask.flatMap((row, y) => row.map((cell, x) => (
            <div
              className={`board-cell ${cell === 1 ? "is-valid" : "is-void"}`}
              key={`${x},${y}`}
              data-x={x}
              data-y={y}
            />
          )))}
        </div>

        {props.placements.map((placement) => {
          const module = moduleMap.get(placement.moduleId);
          if (!module) return null;
          return (
            <PlacedModule
              key={placement.instanceId}
              placement={placement}
              module={module}
              selected={placement.instanceId === props.selectedInstanceId}
              locked={props.lockedPlacementIds.has(placement.instanceId)}
              hidden={placement.instanceId === props.hiddenInstanceId}
              onPointerDown={props.onPlacedPointerDown}
            />
          );
        })}

        {props.preview && [...previewCells].map((key) => {
          const [x, y] = key.split(",").map(Number);
          if (x < 0 || y < 0 || x >= props.board.width || y >= props.board.height) return null;
          return (
            <div
              key={`preview-${key}`}
              className={`preview-cell ${props.preview!.valid ? "is-legal" : "is-illegal"}`}
              style={{
                left: BOARD_PADDING + x * (BOARD_CELL + BOARD_GAP),
                top: BOARD_PADDING + y * (BOARD_CELL + BOARD_GAP),
                width: BOARD_CELL,
                height: BOARD_CELL,
              }}
            />
          );
        })}
      </div>
    </div>
  );
});
