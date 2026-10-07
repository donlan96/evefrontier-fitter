import type { FittingDocument } from "../models/fittingDocument";
import type { FittingProfileDraft } from "../models/fittingStorage";
import type { WorkspaceSnapshot } from "../models/workspaceSnapshot";
import { WORKSPACE_SNAPSHOT_VERSION } from "../models/workspaceSnapshot";
import {
  MAX_SOLVER_WORKERS,
  createDefaultSolverWorkerSetting,
  type ModuleSolverRule,
  type SolveScope,
  type SolverJobSnapshot,
  type SolverJobStatus,
  type SolverTimeLimit,
  type SolverWorkerSetting,
} from "../models/solver";
import { parseFittingDocument } from "../utils/fittingJson";

export const LOCAL_WORKSPACE_KEY = "eve-frontier-grid-fitting.workspace.v3";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWorkerSetting(value: unknown): SolverWorkerSetting {
  if (value === undefined) return createDefaultSolverWorkerSetting();
  if (!isRecord(value) || !["standard", "all", "custom"].includes(value.mode as string)) {
    throw new Error("本地存档的求解线程设置无效。");
  }
  if (value.mode === "custom") {
    if (!Number.isInteger(value.value) || (value.value as number) < 1 || (value.value as number) > MAX_SOLVER_WORKERS) {
      throw new Error("本地存档的自定义求解线程数无效。");
    }
    return { mode: "custom", value: value.value as number };
  }
  if (value.value !== undefined && value.value !== null) throw new Error("本地存档的求解线程设置包含多余数值。");
  return { mode: value.mode as "standard" | "all" };
}

function parseSolverResult(value: unknown): SolverJobSnapshot | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error("本地存档的自动配装结果无效。");
  const statuses: SolverJobStatus[] = ["queued", "running", "completed", "time-limit", "stopped", "infeasible", "error"];
  if (typeof value.jobId === "string" && statuses.includes(value.status as SolverJobStatus)) {
    return value as unknown as SolverJobSnapshot;
  }
  const legacySolutions = Array.isArray(value.solutions) ? value.solutions : [];
  const bestSolution = legacySolutions[0] ?? null;
  const legacyStatus = typeof value.status === "string" ? value.status : "";
  const status: SolverJobStatus = legacyStatus === "completed"
    ? "completed"
    : legacyStatus === "infeasible" ? "infeasible"
      : legacyStatus.startsWith("timeout") ? "time-limit" : "error";
  const score = isRecord(bestSolution) && typeof bestSolution.totalScore === "number" ? bestSolution.totalScore : 0;
  const bestBound = typeof value.theoreticalScoreUpperBound === "number" ? value.theoreticalScoreUpperBound : score;
  return {
    jobId: "legacy-result",
    status,
    bestSolution: bestSolution as SolverJobSnapshot["bestSolution"],
    score,
    bestBound,
    optimalityGap: Math.max(0, bestBound - score),
    elapsedMs: typeof value.elapsedMs === "number" ? value.elapsedMs : 0,
    solverStatus: status === "infeasible" ? "INFEASIBLE" : "UNKNOWN",
    provenOptimal: false,
    infeasibleReasons: [],
    errors: Array.isArray(value.errors) ? value.errors.filter((item): item is string => typeof item === "string") : [],
  };
}

function parseSolverSettings(value: unknown): WorkspaceSnapshot["solver"] {
  if (!isRecord(value) || !Array.isArray(value.rules) || !Array.isArray(value.lockedPlacementIds)) {
    throw new Error("本地存档的自动配装设置无效。");
  }
  const scopes: SolveScope[] = ["empty-board", "fill-current", "rearrange-unlocked"];
  const times: SolverTimeLimit[] = [30_000, 60_000, 300_000, 900_000, null];
  if (!scopes.includes(value.scope as SolveScope)) {
    throw new Error("本地存档的求解范围或时间设置无效。");
  }
  const timeLimitMs = times.includes(value.timeLimitMs as SolverTimeLimit) ? value.timeLimitMs as SolverTimeLimit : 30_000;
  const rules: ModuleSolverRule[] = value.rules.map((rule, index) => {
    if (!isRecord(rule) || typeof rule.moduleId !== "string") throw new Error(`本地存档的模块规则 ${index + 1} 无效。`);
    if (!Number.isInteger(rule.requiredCount) || !Number.isInteger(rule.maxCount)) {
      throw new Error(`本地存档的模块规则 ${index + 1} 数量无效。`);
    }
    return {
      moduleId: rule.moduleId,
      requiredCount: rule.requiredCount as number,
      enabled: rule.enabled === true,
      maxCount: rule.maxCount as number,
    };
  });
  if (!value.lockedPlacementIds.every((id) => typeof id === "string")) throw new Error("本地存档的锁定模块列表无效。");
  return {
    rules,
    scope: value.scope as SolveScope,
    timeLimitMs,
    searchWorkers: parseWorkerSetting(value.searchWorkers),
    lockedPlacementIds: [...value.lockedPlacementIds] as string[],
    lastResult: parseSolverResult(value.lastResult),
    lastResultFingerprint: typeof value.lastResultFingerprint === "string" ? value.lastResultFingerprint : null,
  };
}

export function createWorkspaceSnapshot(
  document: FittingDocument,
  solver: WorkspaceSnapshot["solver"],
  fitting: FittingProfileDraft = {
    activeFittingId: null,
    name: `${document.board.name} 配装`,
    description: "",
  },
  savedAt = new Date().toISOString(),
): WorkspaceSnapshot {
  return {
    snapshotVersion: WORKSPACE_SNAPSHOT_VERSION,
    savedAt,
    document,
    fitting: {
      activeFittingId: fitting.activeFittingId,
      name: fitting.name,
      description: fitting.description,
    },
    solver: {
      rules: solver.rules.map((rule) => ({ ...rule })),
      scope: solver.scope,
      timeLimitMs: solver.timeLimitMs,
      searchWorkers: { ...solver.searchWorkers },
      lockedPlacementIds: [...solver.lockedPlacementIds],
      lastResult: solver.lastResult
        ? JSON.parse(JSON.stringify(solver.lastResult)) as SolverJobSnapshot
        : null,
      lastResultFingerprint: solver.lastResultFingerprint,
    },
  };
}

export function parseWorkspaceSnapshot(raw: string): WorkspaceSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("本地存档不是有效 JSON。");
  }
  if (!isRecord(value) || value.snapshotVersion !== WORKSPACE_SNAPSHOT_VERSION || typeof value.savedAt !== "string") {
    throw new Error("不支持的本地存档版本。");
  }
  const document = parseFittingDocument(JSON.stringify(value.document)) as FittingDocument;
  const fittingValue = isRecord(value.fitting) ? value.fitting : null;
  const fitting: FittingProfileDraft = {
    activeFittingId: fittingValue && typeof fittingValue.activeFittingId === "string" ? fittingValue.activeFittingId : null,
    name: fittingValue && typeof fittingValue.name === "string" && fittingValue.name.trim()
      ? fittingValue.name
      : document.build.name,
    description: fittingValue && typeof fittingValue.description === "string" ? fittingValue.description : "",
  };
  return {
    snapshotVersion: WORKSPACE_SNAPSHOT_VERSION,
    savedAt: value.savedAt,
    document,
    fitting,
    solver: parseSolverSettings(value.solver),
  };
}

export function saveWorkspaceSnapshot(storage: StorageLike, snapshot: WorkspaceSnapshot): void {
  storage.setItem(LOCAL_WORKSPACE_KEY, JSON.stringify(snapshot));
}

export function loadWorkspaceSnapshot(storage: StorageLike): { snapshot: WorkspaceSnapshot; fromBackup: boolean } | null {
  const primary = storage.getItem(LOCAL_WORKSPACE_KEY);
  return primary ? { snapshot: parseWorkspaceSnapshot(primary), fromBackup: false } : null;
}
