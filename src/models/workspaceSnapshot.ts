import type { FittingDocument } from "./fittingDocument";
import type { FittingProfileDraft } from "./fittingStorage";
import type { ModuleSolverRule, SolveScope, SolverJobSnapshot, SolverTimeLimit, SolverWorkerSetting } from "./solver";

export const WORKSPACE_SNAPSHOT_VERSION = 3;

export interface WorkspaceSnapshot {
  snapshotVersion: typeof WORKSPACE_SNAPSHOT_VERSION;
  savedAt: string;
  document: FittingDocument;
  fitting: FittingProfileDraft;
  solver: {
    rules: ModuleSolverRule[];
    scope: SolveScope;
    timeLimitMs: SolverTimeLimit;
    searchWorkers: SolverWorkerSetting;
    lockedPlacementIds: string[];
    lastResult: SolverJobSnapshot | null;
    lastResultFingerprint: string | null;
  };
}
