import type { BoardDefinition } from "./board";
import type { ModuleDefinition } from "./module";
import type { PlacedModuleData } from "./placement";

export type SolveScope = "empty-board" | "fill-current" | "rearrange-unlocked";
export type SolverTimeLimit = 30_000 | 60_000 | 300_000 | 900_000 | null;
export type SolverWorkerMode = "standard" | "all" | "custom";

export const DEFAULT_SOLVER_WORKERS = 8;
export const MAX_SOLVER_WORKERS = 256;

export interface SolverWorkerSetting {
  mode: SolverWorkerMode;
  value?: number;
}

export function createDefaultSolverWorkerSetting(): SolverWorkerSetting {
  return { mode: "standard" };
}

export function clampSolverWorkerSetting(setting: SolverWorkerSetting, logicalCpuCount: number): SolverWorkerSetting {
  if (setting.mode !== "custom") return { mode: setting.mode };
  const reported = Number.isFinite(logicalCpuCount) ? Math.floor(logicalCpuCount) : 1;
  const maximum = Math.max(1, Math.min(MAX_SOLVER_WORKERS, reported));
  const value = Number.isInteger(setting.value) ? setting.value as number : DEFAULT_SOLVER_WORKERS;
  return { mode: "custom", value: Math.max(1, Math.min(maximum, value)) };
}

export interface ModuleSolverRule {
  moduleId: string;
  requiredCount: number;
  enabled: boolean;
  maxCount: number;
}

export interface SoftSkeletonTrainingLayout {
  sourceProblemFingerprint: string;
  sourceLayoutSignature: string;
  layout: PlacedModuleData[];
  provenScore: number;
  bestBound: number;
  proofProblemSignature: string;
}

export interface SolverSolution {
  id: string;
  placements: PlacedModuleData[];
  requiredSatisfied: boolean;
  moduleCounts: Record<string, number>;
  totalScore: number;
  occupiedCells: number;
  utilization: number;
  remainingCells: number;
  isolatedEmptyCells: number;
  emptyRegionCount: number;
  elapsedMs: number;
}

export type SolverJobStatus = "queued" | "running" | "completed" | "time-limit" | "stopped" | "infeasible" | "error";
export type CpSatStatus = "UNKNOWN" | "MODEL_INVALID" | "FEASIBLE" | "INFEASIBLE" | "OPTIMAL" | "STOPPED" | "ERROR";

export interface SolverJobSnapshot {
  /** Frontend cache marker; old bounds must not describe a changed problem. */
  problemChanged?: boolean;
  jobId: string;
  status: SolverJobStatus;
  bestSolution: SolverSolution | null;
  score: number;
  bestBound: number;
  optimalityGap: number;
  elapsedMs: number;
  solverStatus: CpSatStatus;
  provenOptimal: boolean;
  solverPhase?: string | null;
  requestedSearchWorkers?: SolverWorkerSetting | null;
  effectiveSearchWorkers?: number;
  logicalCpuCount?: number;
  defaultSearchWorkers?: number;
  searchWorkersClamped?: boolean;
  infeasibleReasons: string[];
  errors: string[];
}

export interface SolverApiRequest {
  board: BoardDefinition;
  modules: ModuleDefinition[];
  moduleRules: ModuleSolverRule[];
  scope: SolveScope;
  lockedPlacements: PlacedModuleData[];
  currentLayout: PlacedModuleData[];
  historyBestLayout: PlacedModuleData[] | null;
  problemFingerprint: string;
  softSkeletonTrainingLayouts: SoftSkeletonTrainingLayout[];
  searchWorkers: SolverWorkerSetting;
  timeLimitMs: SolverTimeLimit;
}
