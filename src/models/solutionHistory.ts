import type { SolverSolution } from "./solver";

export const SOLUTION_HISTORY_VERSION = 3;

export interface OptimalityProof {
  provenAt: string;
  score: number;
  bestBound: number;
  problemSignature: string;
}

export interface BuildModelFingerprintPayload {
  version: 3;
  boardId: string;
  required: Array<{ moduleId: string; count: number }>;
  locked: Array<{ moduleId: string; x: number; y: number; rotation: number; mirrored: boolean }>;
}

export interface SolutionHistoryEntry {
  id: string;
  savedAt: string;
  layoutSignature: string;
  savedScore: number;
  moduleShapeSignatures: Record<string, string>;
  solution: SolverSolution;
  optimalityProof?: OptimalityProof | null;
}

export interface ValidatedSolutionHistoryEntry {
  entry: SolutionHistoryEntry;
  valid: boolean;
  reasons: string[];
  currentScore: number;
  currentSolution: SolverSolution;
  provenOptimal: boolean;
  proofInvalidReason: string | null;
}

export interface SolutionHistoryStore {
  version: typeof SOLUTION_HISTORY_VERSION;
  models: Record<string, SolutionHistoryEntry[]>;
}
