import {
  SOLUTION_HISTORY_VERSION,
  type SolutionHistoryEntry,
  type SolutionHistoryStore,
  type ValidatedSolutionHistoryEntry,
} from "../models/solutionHistory";
import type { SoftSkeletonTrainingLayout, SolverSolution } from "../models/solver";
import { calculateEffectiveModuleLimits } from "../core/effectiveSolverModules";
import { createSolutionSignature } from "../utils/solutionMetrics";
import { validateSolverSolution, type SolverLayoutContext } from "../core/solverLayout";
import { shapeKey } from "../utils/normalizeShape";

export const SOLUTION_HISTORY_STORAGE_KEY = "eve-frontier-grid-fitting.solution-history.v3";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type HistoryValidationContext = SolverLayoutContext;

export interface OptimalityProofInput {
  provenAt?: string;
  score: number;
  bestBound: number;
}

function emptyStore(): SolutionHistoryStore {
  return { version: SOLUTION_HISTORY_VERSION, models: {} };
}

function cloneSolution(solution: SolverSolution): SolverSolution {
  return JSON.parse(JSON.stringify(solution)) as SolverSolution;
}

function parseStore(raw: string | null): SolutionHistoryStore {
  if (!raw) return emptyStore();
  try {
    const value = JSON.parse(raw) as Partial<SolutionHistoryStore>;
    if (value.version !== SOLUTION_HISTORY_VERSION || typeof value.models !== "object" || value.models === null) return emptyStore();
    return { version: SOLUTION_HISTORY_VERSION, models: value.models as Record<string, SolutionHistoryEntry[]> };
  } catch {
    return emptyStore();
  }
}

function saveStore(storage: StorageLike, store: SolutionHistoryStore): void {
  storage.setItem(SOLUTION_HISTORY_STORAGE_KEY, JSON.stringify(store));
}

export function createOptimalityProblemSignature(context: HistoryValidationContext): string {
  const limits = calculateEffectiveModuleLimits(context.modules, context.rules, context.lockedPlacements);
  const limitsByModule = new Map(limits.map((limit) => [limit.moduleId, limit]));
  const effectiveModules = context.modules.filter((module) => (limitsByModule.get(module.id)?.maximumCount ?? 0) > 0);
  return JSON.stringify({
    version: 2,
    board: {
      id: context.board.id,
      width: context.board.width,
      height: context.board.height,
      mask: context.board.mask,
    },
    modules: effectiveModules
      .map((module) => ({
        id: module.id,
        shape: shapeKey(module.baseShape),
        availableQuantity: limitsByModule.get(module.id)!.maximumCount,
        allowRotation: module.allowRotation,
        allowMirror: module.allowMirror,
        baseScore: module.baseScore,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    rules: limits
      .filter((limit) => limit.maximumCount > 0)
      .map((limit) => ({
        moduleId: limit.moduleId,
        requiredCount: limit.minimumCount,
        enabled: limit.maximumCount > limit.minimumCount,
        maxCount: limit.maximumCount,
      }))
      .sort((a, b) => a.moduleId.localeCompare(b.moduleId)),
    locked: context.lockedPlacements
      .map((placement) => ({
        moduleId: placement.moduleId,
        x: placement.origin.x,
        y: placement.origin.y,
        rotation: placement.orientation.rotation,
        mirrored: placement.orientation.mirrored,
      }))
      .sort((a, b) => a.moduleId.localeCompare(b.moduleId)
        || a.x - b.x
        || a.y - b.y
        || a.rotation - b.rotation
        || Number(a.mirrored) - Number(b.mirrored)),
  });
}

function moduleCatalogSignature(context: HistoryValidationContext): string[] {
  const limits = calculateEffectiveModuleLimits(context.modules, context.rules, context.lockedPlacements);
  const limitsByModule = new Map(limits.map((limit) => [limit.moduleId, limit]));
  return context.modules
    .filter((module) => (limitsByModule.get(module.id)?.maximumCount ?? 0) > 0)
    .map((module) => JSON.stringify({
      shape: shapeKey(module.baseShape),
      availableQuantity: limitsByModule.get(module.id)!.maximumCount,
      allowRotation: module.allowRotation,
      allowMirror: module.allowMirror,
      baseScore: module.baseScore,
    })).sort();
}

function hasMatchingTrainingProblem(
  problemSignature: string,
  context: HistoryValidationContext,
): boolean {
  try {
    const parsed = JSON.parse(problemSignature) as {
      version?: unknown;
      board?: { width?: unknown; height?: unknown; mask?: unknown };
      modules?: Array<{
        shape?: unknown;
        availableQuantity?: unknown;
        allowRotation?: unknown;
        allowMirror?: unknown;
        baseScore?: unknown;
      }>;
      rules?: unknown;
      locked?: unknown;
    };
    const sourceCatalog = Array.isArray(parsed.modules)
      ? parsed.modules.map((module) => JSON.stringify({
        shape: module.shape,
        availableQuantity: module.availableQuantity,
        allowRotation: module.allowRotation,
        allowMirror: module.allowMirror,
        baseScore: module.baseScore,
      })).sort()
      : null;
    return parsed.version === 2
      && parsed.board?.width === context.board.width
      && parsed.board?.height === context.board.height
      && JSON.stringify(parsed.board?.mask) === JSON.stringify(context.board.mask)
      && JSON.stringify(sourceCatalog) === JSON.stringify(moduleCatalogSignature(context))
      && Array.isArray(parsed.rules)
      && Array.isArray(parsed.locked)
      && parsed.locked.length === 0;
  } catch {
    return false;
  }
}

export function loadSoftSkeletonTrainingLayouts(
  storage: StorageLike,
  currentFingerprint: string,
  currentContext: HistoryValidationContext,
): SoftSkeletonTrainingLayout[] {
  const store = parseStore(storage.getItem(SOLUTION_HISTORY_STORAGE_KEY));
  const candidates: Array<SoftSkeletonTrainingLayout & { provenAt: string }> = [];
  for (const [sourceFingerprint, entries] of Object.entries(store.models)) {
    if (sourceFingerprint === currentFingerprint) continue;
    const qualified = entries
      .filter((entry) => {
        const proof = entry.optimalityProof;
        return Boolean(proof)
          && proof!.score === proof!.bestBound
          && proof!.score === entry.solution.totalScore
          && entry.savedScore === entry.solution.totalScore
          && entry.layoutSignature === createSolutionSignature(entry.solution.placements)
          && hasMatchingTrainingProblem(proof!.problemSignature, currentContext);
      })
      .sort((a, b) => b.optimalityProof!.provenAt.localeCompare(a.optimalityProof!.provenAt)
        || a.layoutSignature.localeCompare(b.layoutSignature));
    const entry = qualified[0];
    if (!entry?.optimalityProof) continue;
    candidates.push({
      sourceProblemFingerprint: sourceFingerprint,
      sourceLayoutSignature: entry.layoutSignature,
      layout: cloneSolution(entry.solution).placements,
      provenScore: entry.optimalityProof.score,
      bestBound: entry.optimalityProof.bestBound,
      proofProblemSignature: entry.optimalityProof.problemSignature,
      provenAt: entry.optimalityProof.provenAt,
    });
  }
  candidates.sort((a, b) => b.provenAt.localeCompare(a.provenAt)
    || a.sourceProblemFingerprint.localeCompare(b.sourceProblemFingerprint)
    || a.sourceLayoutSignature.localeCompare(b.sourceLayoutSignature));
  if (candidates.length < 2) return [];
  return candidates.slice(0, 2).map((candidate) => ({
    sourceProblemFingerprint: candidate.sourceProblemFingerprint,
    sourceLayoutSignature: candidate.sourceLayoutSignature,
    layout: candidate.layout,
    provenScore: candidate.provenScore,
    bestBound: candidate.bestBound,
    proofProblemSignature: candidate.proofProblemSignature,
  }));
}

export function validateHistoryEntry(
  entry: SolutionHistoryEntry,
  context: HistoryValidationContext,
): ValidatedSolutionHistoryEntry {
  const validation = validateSolverSolution(cloneSolution(entry.solution), context);
  const reasons = new Set(validation.reasons);
  const moduleMap = new Map(context.modules.map((module) => [module.id, module]));
  for (const placement of entry.solution.placements) {
    const module = moduleMap.get(placement.moduleId);
    if (module && entry.moduleShapeSignatures[module.id] !== shapeKey(module.baseShape)) {
      reasons.add(`模块“${module.name}”形状已修改`);
    }
  }
  const currentSolution = validation.solution;
  const currentScore = currentSolution.totalScore;
  const proof = entry.optimalityProof;
  let proofInvalidReason: string | null = null;
  if (proof) {
    if (proof.problemSignature !== createOptimalityProblemSignature(context)) {
      proofInvalidReason = "证明时的棋盘、模块或自动装配规则已变化";
    } else if (proof.score !== currentScore || proof.bestBound !== proof.score) {
      proofInvalidReason = "证明分数与当前方案不一致";
    } else if (reasons.size > 0) {
      proofInvalidReason = "已证明方案当前已经失效";
    }
  }
  return {
    entry,
    valid: reasons.size === 0,
    reasons: [...reasons],
    currentScore,
    currentSolution,
    provenOptimal: Boolean(proof) && proofInvalidReason === null,
    proofInvalidReason,
  };
}

export function loadSolutionHistory(
  storage: StorageLike,
  fingerprint: string,
  context: HistoryValidationContext,
): ValidatedSolutionHistoryEntry[] {
  const entries = parseStore(storage.getItem(SOLUTION_HISTORY_STORAGE_KEY)).models[fingerprint] ?? [];
  return entries
    .map((entry) => validateHistoryEntry(entry, context))
    .sort((a, b) => Number(b.valid) - Number(a.valid) || b.currentScore - a.currentScore || b.entry.savedAt.localeCompare(a.entry.savedAt));
}

export function saveSolutionToHistory(
  storage: StorageLike,
  fingerprint: string,
  solution: SolverSolution,
  context: HistoryValidationContext,
  savedAt = new Date().toISOString(),
  optimalityProof?: OptimalityProofInput,
): ValidatedSolutionHistoryEntry[] {
  const store = parseStore(storage.getItem(SOLUTION_HISTORY_STORAGE_KEY));
  let entries = store.models[fingerprint] ?? [];
  const layoutSignature = createSolutionSignature(solution.placements);
  const duplicate = entries.find((entry) => entry.layoutSignature === layoutSignature);
  if (duplicate && validateHistoryEntry(duplicate, context).valid) {
    if (optimalityProof && optimalityProof.score === solution.totalScore && optimalityProof.bestBound === optimalityProof.score) {
      duplicate.optimalityProof = {
        provenAt: optimalityProof.provenAt ?? savedAt,
        score: optimalityProof.score,
        bestBound: optimalityProof.bestBound,
        problemSignature: createOptimalityProblemSignature(context),
      };
      saveStore(storage, store);
    }
    return loadSolutionHistory(storage, fingerprint, context);
  }
  if (duplicate) entries = entries.filter((entry) => entry.id !== duplicate.id);
  {
    const moduleMap = new Map(context.modules.map((module) => [module.id, module]));
    const entry: SolutionHistoryEntry = {
      id: `history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      savedAt,
      layoutSignature,
      savedScore: solution.totalScore,
      moduleShapeSignatures: Object.fromEntries([...new Set(solution.placements.map((placement) => placement.moduleId))]
        .map((moduleId) => [moduleId, moduleMap.has(moduleId) ? shapeKey(moduleMap.get(moduleId)!.baseShape) : "missing"])),
      solution: cloneSolution(solution),
      optimalityProof: optimalityProof && optimalityProof.score === solution.totalScore && optimalityProof.bestBound === optimalityProof.score
        ? {
          provenAt: optimalityProof.provenAt ?? savedAt,
          score: optimalityProof.score,
          bestBound: optimalityProof.bestBound,
          problemSignature: createOptimalityProblemSignature(context),
        }
        : undefined,
    };
    const current = entries.map((item) => validateHistoryEntry(item, context));
    const incoming = validateHistoryEntry(entry, context);
    const currentRanked = [...current]
      .sort((a, b) => Number(b.valid) - Number(a.valid) || b.currentScore - a.currentScore || b.entry.savedAt.localeCompare(a.entry.savedAt));
    const currentLowest = currentRanked[Math.min(4, currentRanked.length - 1)];
    const canEnter = entries.length < 5 || !currentLowest.valid || incoming.currentScore > currentLowest.currentScore;
    const ranked = [...current, incoming]
      .sort((a, b) => Number(b.valid) - Number(a.valid) || b.currentScore - a.currentScore || b.entry.savedAt.localeCompare(a.entry.savedAt));
    if (canEnter) {
      store.models[fingerprint] = ranked.slice(0, 5).map((item) => item.entry);
      saveStore(storage, store);
    }
  }
  return loadSolutionHistory(storage, fingerprint, context);
}

export function deleteSolutionHistoryEntry(storage: StorageLike, fingerprint: string, entryId: string): void {
  const store = parseStore(storage.getItem(SOLUTION_HISTORY_STORAGE_KEY));
  store.models[fingerprint] = (store.models[fingerprint] ?? []).filter((entry) => entry.id !== entryId);
  saveStore(storage, store);
}

export function clearSolutionHistory(storage: StorageLike, fingerprint: string): void {
  const store = parseStore(storage.getItem(SOLUTION_HISTORY_STORAGE_KEY));
  delete store.models[fingerprint];
  saveStore(storage, store);
}
