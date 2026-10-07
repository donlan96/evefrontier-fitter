import type { GridPoint } from "./board";
import type { Rotation } from "./module";

export interface ModuleOrientation {
  rotation: Rotation;
  mirrored: boolean;
}

export interface PlacedModuleData {
  instanceId: string;
  moduleId: string;
  origin: GridPoint;
  orientation: ModuleOrientation;
}

export type PlacementError =
  | "OUT_OF_BOUNDS"
  | "INVALID_BOARD_CELL"
  | "OVERLAP"
  | "OUT_OF_STOCK";

export interface PlacementValidation {
  valid: boolean;
  occupiedCells: GridPoint[];
  errors: PlacementError[];
  conflictPlacementIds: string[];
}
