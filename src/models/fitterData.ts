import type { BoardStorageDocument } from "./boardStorage";
import type { FittingLibraryDocument } from "./fittingStorage";
import type { SolutionHistoryStore } from "./solutionHistory";
import type { WorkspaceSnapshot } from "./workspaceSnapshot";

export const FITTER_DATA_SCHEMA_VERSION = 1;

export interface FitterDataDocument {
  schemaVersion: typeof FITTER_DATA_SCHEMA_VERSION;
  revision: number;
  savedAt: string | null;
  boards: BoardStorageDocument;
  fittings: FittingLibraryDocument;
  solutionHistory: SolutionHistoryStore;
  workspace: WorkspaceSnapshot | null;
}

export interface FitterDataLoadResponse {
  document: FitterDataDocument;
  source: "primary" | "backup" | "empty";
}
