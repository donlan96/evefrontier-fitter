import type { BoardDefinition, GridPoint } from "../models/board";
import type { ModuleDefinition, Rotation } from "../models/module";
import type { PlacedModuleData, PlacementError, PlacementValidation } from "../models/placement";
import { pointKey } from "./normalizeShape";
import { getOrientedShape } from "./rotateShape";

export function getPlacementCells(
  module: ModuleDefinition,
  origin: GridPoint,
  rotation: Rotation,
): GridPoint[] {
  return getOrientedShape(module, rotation).map((point) => ({
    x: origin.x + point.x,
    y: origin.y + point.y,
  }));
}

interface ValidationInput {
  board: BoardDefinition;
  module: ModuleDefinition;
  origin: GridPoint;
  rotation: Rotation;
  placements: PlacedModuleData[];
  modules: ModuleDefinition[];
  ignoreInstanceId?: string;
  isNew: boolean;
}

export function validatePlacement(input: ValidationInput): PlacementValidation {
  const occupiedCells = getPlacementCells(input.module, input.origin, input.rotation);
  const errors = new Set<PlacementError>();
  const conflictPlacementIds = new Set<string>();
  const moduleMap = new Map(input.modules.map((module) => [module.id, module]));
  const occupied = new Map<string, string>();

  input.placements.forEach((placement) => {
    if (placement.instanceId === input.ignoreInstanceId) return;
    const definition = moduleMap.get(placement.moduleId);
    if (!definition) return;
    getPlacementCells(definition, placement.origin, placement.orientation.rotation).forEach((cell) => {
      occupied.set(pointKey(cell), placement.instanceId);
    });
  });

  occupiedCells.forEach((cell) => {
    if (cell.x < 0 || cell.y < 0 || cell.x >= input.board.width || cell.y >= input.board.height) {
      errors.add("OUT_OF_BOUNDS");
      return;
    }
    if (input.board.mask[cell.y]?.[cell.x] !== 1) errors.add("INVALID_BOARD_CELL");
    const conflict = occupied.get(pointKey(cell));
    if (conflict) {
      errors.add("OVERLAP");
      conflictPlacementIds.add(conflict);
    }
  });

  if (input.isNew) {
    const used = input.placements.filter((placement) => placement.moduleId === input.module.id).length;
    if (used >= input.module.availableQuantity) errors.add("OUT_OF_STOCK");
  }

  return {
    valid: errors.size === 0,
    occupiedCells,
    errors: [...errors],
    conflictPlacementIds: [...conflictPlacementIds],
  };
}
