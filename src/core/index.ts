export type { BoardCell, BoardDefinition, GridPoint } from "../models/board";
export type { ShipBuild } from "../models/build";
export type { FittingDocument } from "../models/fittingDocument";
export { FITTING_DOCUMENT_TYPE, FITTING_DOCUMENT_VERSION } from "../models/fittingDocument";
export type {
  FittingLibraryDocument,
  FittingProfileDraft,
  SaveFittingInput,
  SavedFittingEntry,
  SavedFittingSolverSettings,
} from "../models/fittingStorage";
export { FITTING_LIBRARY_VERSION } from "../models/fittingStorage";
export type { ModuleDefinition, ModuleShape, Rotation } from "../models/module";
export type {
  ModuleOrientation,
  PlacedModuleData,
  PlacementError,
  PlacementValidation,
} from "../models/placement";
export {
  createFittingDocument,
  parseFittingDocument,
  serializeFittingDocument,
} from "../utils/fittingJson";
export { getShapeBounds, isConnectedShape, normalizeShape, shapeKey } from "../utils/normalizeShape";
export {
  getOrientedShape,
  getUniqueRotations,
  nextRotation,
  rotateShape,
  rotateShapeClockwise,
} from "../utils/rotateShape";
export { getPlacementCells, validatePlacement } from "../utils/validatePlacement";
export { analyzeEmptySpace, createSolutionSignature } from "../utils/solutionMetrics";
export { SCORE_SCALE, validateModuleScore, scoreToUnits, calculateLayoutScore } from "./scoring";
export { validateSolverLayout, validateSolverSolution } from "./solverLayout";
export type { SolverLayoutContext } from "./solverLayout";
export { reconcileSolverSnapshot, revalidateCachedSolverSnapshot } from "./solverResult";
export { translateBoardSelection, validateBoardSelectionMove } from "../utils/translateBoardSelection";
export type {
  BoardSelectionMoveError,
  BoardSelectionMoveInput,
  BoardSelectionMoveValidation,
  TranslatedBoardSelection,
} from "../utils/translateBoardSelection";
export type {
  CpSatStatus,
  ModuleSolverRule,
  SolveScope,
  SolverApiRequest,
  SolverJobSnapshot,
  SolverJobStatus,
  SolverSolution,
  SolverTimeLimit,
} from "../models/solver";
