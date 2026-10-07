import type { PlacedModuleData } from "./placement";
import type { ModuleSolverRule, SolveScope, SolverTimeLimit, SolverWorkerSetting } from "./solver";

export const FITTING_LIBRARY_VERSION = 3;

export interface FittingProfileDraft {
  activeFittingId: string | null;
  name: string;
  description: string;
}

export interface SavedFittingSolverSettings {
  rules: ModuleSolverRule[];
  scope: SolveScope;
  timeLimitMs: SolverTimeLimit;
  searchWorkers: SolverWorkerSetting;
  lockedPlacementIds: string[];
}

export interface SavedFittingEntry {
  id: string;
  boardId: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  placements: PlacedModuleData[];
  solverSettings: SavedFittingSolverSettings;
}

export interface FittingLibraryDocument {
  version: typeof FITTING_LIBRARY_VERSION;
  entries: SavedFittingEntry[];
}

export interface SaveFittingInput {
  activeFittingId: string | null;
  boardId: string;
  name: string;
  description: string;
  placements: PlacedModuleData[];
  solverSettings: SavedFittingSolverSettings;
}
