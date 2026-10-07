import type { FitterDataDocument } from "../models/fitterData";
import { parseWorkspaceSnapshot } from "./localWorkspace";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} 必须是对象。`);
  return value;
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== "string") throw new Error(`${field} 必须是字符串。`);
}

function requireNumber(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} 必须是有限数字。`);
}

function requireInteger(value: unknown, field: string): void {
  if (!Number.isInteger(value)) throw new Error(`${field} 必须是整数。`);
}

function validateBoard(value: unknown, field: string): void {
  const board = requireRecord(value, field);
  requireString(board.id, `${field}.id`);
  requireString(board.name, `${field}.name`);
  requireInteger(board.width, `${field}.width`);
  requireInteger(board.height, `${field}.height`);
  const width = board.width as number;
  const height = board.height as number;
  if (width < 1 || height < 1 || !Array.isArray(board.mask) || board.mask.length !== height) {
    throw new Error(`${field}.mask 尺寸无效。`);
  }
  board.mask.forEach((row, y) => {
    if (!Array.isArray(row) || row.length !== width || row.some((cell) => cell !== 0 && cell !== 1)) {
      throw new Error(`${field}.mask[${y}] 无效。`);
    }
  });
}

function validatePlacement(value: unknown, field: string): void {
  const placement = requireRecord(value, field);
  requireString(placement.instanceId, `${field}.instanceId`);
  requireString(placement.moduleId, `${field}.moduleId`);
  const origin = requireRecord(placement.origin, `${field}.origin`);
  requireInteger(origin.x, `${field}.origin.x`);
  requireInteger(origin.y, `${field}.origin.y`);
  const orientation = requireRecord(placement.orientation, `${field}.orientation`);
  if (![0, 90, 180, 270].includes(orientation.rotation as number) || typeof orientation.mirrored !== "boolean") {
    throw new Error(`${field}.orientation 无效。`);
  }
}

function validateRules(value: unknown, field: string): void {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组。`);
  value.forEach((item, index) => {
    const rule = requireRecord(item, `${field}[${index}]`);
    requireString(rule.moduleId, `${field}[${index}].moduleId`);
    requireInteger(rule.requiredCount, `${field}[${index}].requiredCount`);
    requireInteger(rule.maxCount, `${field}[${index}].maxCount`);
    if (typeof rule.enabled !== "boolean") throw new Error(`${field}[${index}].enabled 必须是布尔值。`);
  });
}

function validateSolverSettings(value: unknown, field: string): void {
  const settings = requireRecord(value, field);
  validateRules(settings.rules, `${field}.rules`);
  if (!["empty-board", "fill-current", "rearrange-unlocked"].includes(settings.scope as string)) {
    throw new Error(`${field}.scope 无效。`);
  }
  if (![30_000, 60_000, 300_000, 900_000, null].includes(settings.timeLimitMs as number | null)) {
    throw new Error(`${field}.timeLimitMs 无效。`);
  }
  if (settings.searchWorkers !== undefined) {
    const workers = requireRecord(settings.searchWorkers, `${field}.searchWorkers`);
    if (!["standard", "all", "custom"].includes(workers.mode as string)) {
      throw new Error(`${field}.searchWorkers.mode 无效。`);
    }
    if (workers.mode === "custom") {
      requireInteger(workers.value, `${field}.searchWorkers.value`);
      const value = workers.value as number;
      if (value < 1 || value > 256) throw new Error(`${field}.searchWorkers.value 超出范围。`);
    } else if (workers.value !== undefined && workers.value !== null) {
      throw new Error(`${field}.searchWorkers.value 仅可用于自定义模式。`);
    }
  }
  if (!Array.isArray(settings.lockedPlacementIds) || settings.lockedPlacementIds.some((id) => typeof id !== "string")) {
    throw new Error(`${field}.lockedPlacementIds 无效。`);
  }
}

function validateBoards(value: unknown): void {
  const boards = requireRecord(value, "boards");
  if (boards.version !== 3 || !Array.isArray(boards.savedBoards) || !Array.isArray(boards.history)) {
    throw new Error("boards 分区版本或列表无效。");
  }
  boards.savedBoards.forEach((item, index) => {
    const entry = requireRecord(item, `boards.savedBoards[${index}]`);
    validateBoard(entry.board, `boards.savedBoards[${index}].board`);
    requireString(entry.savedAt, `boards.savedBoards[${index}].savedAt`);
  });
  boards.history.forEach((item, index) => {
    const entry = requireRecord(item, `boards.history[${index}]`);
    requireString(entry.id, `boards.history[${index}].id`);
    requireString(entry.savedAt, `boards.history[${index}].savedAt`);
    validateBoard(entry.board, `boards.history[${index}].board`);
    if (!Array.isArray(entry.placements)) throw new Error(`boards.history[${index}].placements 必须是数组。`);
    entry.placements.forEach((placement, placementIndex) => validatePlacement(placement, `boards.history[${index}].placements[${placementIndex}]`));
    if (!Array.isArray(entry.lockedPlacementIds) || entry.lockedPlacementIds.some((id) => typeof id !== "string")) {
      throw new Error(`boards.history[${index}].lockedPlacementIds 无效。`);
    }
  });
}

function validateFittings(value: unknown): void {
  const fittings = requireRecord(value, "fittings");
  if (fittings.version !== 3 || !Array.isArray(fittings.entries)) throw new Error("fittings 分区版本或列表无效。");
  fittings.entries.forEach((item, index) => {
    const entry = requireRecord(item, `fittings.entries[${index}]`);
    for (const field of ["id", "boardId", "name", "description", "createdAt", "updatedAt"]) {
      requireString(entry[field], `fittings.entries[${index}].${field}`);
    }
    if (!Array.isArray(entry.placements)) throw new Error(`fittings.entries[${index}].placements 必须是数组。`);
    entry.placements.forEach((placement, placementIndex) => validatePlacement(placement, `fittings.entries[${index}].placements[${placementIndex}]`));
    validateSolverSettings(entry.solverSettings, `fittings.entries[${index}].solverSettings`);
  });
}

function validateSolution(value: unknown, field: string): void {
  const solution = requireRecord(value, field);
  requireString(solution.id, `${field}.id`);
  if (!Array.isArray(solution.placements)) throw new Error(`${field}.placements 必须是数组。`);
  solution.placements.forEach((placement, index) => validatePlacement(placement, `${field}.placements[${index}]`));
  if (typeof solution.requiredSatisfied !== "boolean") throw new Error(`${field}.requiredSatisfied 必须是布尔值。`);
  const counts = requireRecord(solution.moduleCounts, `${field}.moduleCounts`);
  Object.entries(counts).forEach(([key, count]) => requireInteger(count, `${field}.moduleCounts.${key}`));
  for (const key of ["totalScore", "occupiedCells", "utilization", "remainingCells", "isolatedEmptyCells", "emptyRegionCount", "elapsedMs"]) {
    requireNumber(solution[key], `${field}.${key}`);
  }
}

function validateSolutionHistory(value: unknown): void {
  const history = requireRecord(value, "solutionHistory");
  if (history.version !== 3) throw new Error("solutionHistory 分区版本无效。");
  const models = requireRecord(history.models, "solutionHistory.models");
  Object.entries(models).forEach(([fingerprint, entries]) => {
    if (!Array.isArray(entries)) throw new Error(`solutionHistory.models.${fingerprint} 必须是数组。`);
    entries.forEach((item, index) => {
      const field = `solutionHistory.models.${fingerprint}[${index}]`;
      const entry = requireRecord(item, field);
      for (const key of ["id", "savedAt", "layoutSignature"]) requireString(entry[key], `${field}.${key}`);
      requireNumber(entry.savedScore, `${field}.savedScore`);
      const signatures = requireRecord(entry.moduleShapeSignatures, `${field}.moduleShapeSignatures`);
      Object.entries(signatures).forEach(([key, signature]) => requireString(signature, `${field}.moduleShapeSignatures.${key}`));
      validateSolution(entry.solution, `${field}.solution`);
      if (entry.optimalityProof !== undefined && entry.optimalityProof !== null) {
        const proof = requireRecord(entry.optimalityProof, `${field}.optimalityProof`);
        requireString(proof.provenAt, `${field}.optimalityProof.provenAt`);
        requireNumber(proof.score, `${field}.optimalityProof.score`);
        requireNumber(proof.bestBound, `${field}.optimalityProof.bestBound`);
        requireString(proof.problemSignature, `${field}.optimalityProof.problemSignature`);
      }
    });
  });
}

export function parseFitterDataDocument(value: unknown): FitterDataDocument {
  const document = requireRecord(value, "本机存档");
  if (document.schemaVersion !== 1 || !Number.isInteger(document.revision) || (document.revision as number) < 0) {
    throw new Error("本机存档格式或 schemaVersion 无效。");
  }
  if (document.savedAt !== null && typeof document.savedAt !== "string") throw new Error("本机存档 savedAt 无效。");
  validateBoards(document.boards);
  validateFittings(document.fittings);
  validateSolutionHistory(document.solutionHistory);
  if (document.workspace !== null) parseWorkspaceSnapshot(JSON.stringify(document.workspace));
  return JSON.parse(JSON.stringify(document)) as FitterDataDocument;
}
