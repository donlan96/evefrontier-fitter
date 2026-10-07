import type { BoardCell, BoardDefinition, GridPoint } from "../models/board";
import type { ModuleDefinition } from "../models/module";
import type { PlacedModuleData } from "../models/placement";
import { pointKey } from "./normalizeShape";
import { getPlacementCells } from "./validatePlacement";

export type BoardSelectionMoveError =
  | "EMPTY_SELECTION"
  | "OUT_OF_BOUNDS"
  | "MASK_COLLISION"
  | "PARTIAL_PLACEMENT";

export interface BoardSelectionMoveValidation {
  valid: boolean;
  error: BoardSelectionMoveError | null;
}

export interface BoardSelectionMoveInput {
  board: BoardDefinition;
  modules: ModuleDefinition[];
  placements: PlacedModuleData[];
  selectedCells: GridPoint[];
  deltaX: number;
  deltaY: number;
}

export interface TranslatedBoardSelection {
  board: BoardDefinition;
  placements: PlacedModuleData[];
}

function getActiveSelection(input: BoardSelectionMoveInput): Set<string> {
  return new Set(input.selectedCells
    .filter((cell) => input.board.mask[cell.y]?.[cell.x] === 1)
    .map(pointKey));
}

export function validateBoardSelectionMove(input: BoardSelectionMoveInput): BoardSelectionMoveValidation {
  const selected = getActiveSelection(input);
  if (selected.size === 0 || !Number.isInteger(input.deltaX) || !Number.isInteger(input.deltaY)) {
    return { valid: false, error: "EMPTY_SELECTION" };
  }

  const moduleMap = new Map(input.modules.map((module) => [module.id, module]));
  for (const placement of input.placements) {
    const module = moduleMap.get(placement.moduleId);
    if (!module) continue;
    const occupied = getPlacementCells(module, placement.origin, placement.orientation.rotation);
    const selectedCount = occupied.filter((cell) => selected.has(pointKey(cell))).length;
    if (selectedCount > 0 && selectedCount < occupied.length) {
      return { valid: false, error: "PARTIAL_PLACEMENT" };
    }
  }

  for (const key of selected) {
    const [x, y] = key.split(",").map(Number);
    const nextX = x + input.deltaX;
    const nextY = y + input.deltaY;
    if (nextX < 0 || nextY < 0 || nextX >= input.board.width || nextY >= input.board.height) {
      return { valid: false, error: "OUT_OF_BOUNDS" };
    }
    if (input.board.mask[nextY]?.[nextX] === 1 && !selected.has(pointKey({ x: nextX, y: nextY }))) {
      return { valid: false, error: "MASK_COLLISION" };
    }
  }

  return { valid: true, error: null };
}

export function translateBoardSelection(input: BoardSelectionMoveInput): TranslatedBoardSelection | null {
  if (!validateBoardSelectionMove(input).valid) return null;
  const selected = getActiveSelection(input);
  const mask = input.board.mask.map((row) => [...row]) as BoardCell[][];

  for (const key of selected) {
    const [x, y] = key.split(",").map(Number);
    mask[y][x] = 0;
  }
  for (const key of selected) {
    const [x, y] = key.split(",").map(Number);
    mask[y + input.deltaY][x + input.deltaX] = 1;
  }

  const moduleMap = new Map(input.modules.map((module) => [module.id, module]));
  const placements = input.placements.map((placement) => {
    const module = moduleMap.get(placement.moduleId);
    if (!module) return placement;
    const occupied = getPlacementCells(module, placement.origin, placement.orientation.rotation);
    const shouldMove = occupied.length > 0 && occupied.every((cell) => selected.has(pointKey(cell)));
    return {
      ...placement,
      origin: shouldMove
        ? { x: placement.origin.x + input.deltaX, y: placement.origin.y + input.deltaY }
        : { ...placement.origin },
      orientation: { ...placement.orientation },
    };
  });

  return { board: { ...input.board, mask }, placements };
}
