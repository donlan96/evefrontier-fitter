import type { BoardDefinition } from "../models/board";
import type { ModuleDefinition } from "../models/module";
import type { PlacedModuleData } from "../models/placement";
import type { ModuleSolverRule, SolverSolution } from "../models/solver";
import { getPlacementCells, validatePlacement } from "../utils/validatePlacement";
import { analyzeEmptySpace } from "../utils/solutionMetrics";
import { calculateEffectiveModuleLimits } from "./effectiveSolverModules";
import { calculateLayoutScore, validateModuleScore } from "./scoring";

export interface SolverLayoutContext {
  board: BoardDefinition;
  modules: ModuleDefinition[];
  rules: ModuleSolverRule[];
  /** All fixed placements for the scope being validated, including fill-current. */
  lockedPlacements: PlacedModuleData[];
}

function placementKey(placement: PlacedModuleData): string {
  return JSON.stringify([placement.moduleId, placement.origin.x, placement.origin.y,
    placement.orientation.rotation, placement.orientation.mirrored]);
}

export function validateSolverLayout(context: SolverLayoutContext, placements: PlacedModuleData[]) {
  const reasons = new Set<string>();
  const moduleMap = new Map(context.modules.map((module) => [module.id, module]));
  const accepted: PlacedModuleData[] = [];
  const instanceIds = new Set<string>();
  const counts = new Map<string, number>();
  const occupancy = new Uint8Array(context.board.width * context.board.height);
  for (const placement of placements) {
    if (instanceIds.has(placement.instanceId)) reasons.add("模块实例 ID 重复");
    instanceIds.add(placement.instanceId);
    const module = moduleMap.get(placement.moduleId);
    if (!module) {
      reasons.add(`模块“${placement.moduleId}”已删除`);
      continue;
    }
    if (placement.orientation.mirrored || ![0, 90, 180, 270].includes(placement.orientation.rotation)
      || (!module.allowRotation && placement.orientation.rotation !== 0)) {
      reasons.add(`模块“${module.name}”方向规则已变化`);
      continue;
    }
    try { validateModuleScore(module.baseScore); }
    catch { reasons.add(`模块“${module.name}”评分无效`); }
    const validation = validatePlacement({
      board: context.board, module, origin: placement.origin, rotation: placement.orientation.rotation,
      placements: accepted, modules: context.modules, isNew: true,
    });
    if (!validation.valid) reasons.add(`模块“${module.name}”的位置或库存已失效`);
    accepted.push(placement);
    counts.set(module.id, (counts.get(module.id) ?? 0) + 1);
    for (const cell of getPlacementCells(module, placement.origin, placement.orientation.rotation)) {
      if (cell.x >= 0 && cell.y >= 0 && cell.x < context.board.width && cell.y < context.board.height) {
        occupancy[cell.y * context.board.width + cell.x] = 1;
      }
    }
  }
  const limits = calculateEffectiveModuleLimits(context.modules, context.rules, context.lockedPlacements);
  for (const limit of limits) {
    const count = counts.get(limit.moduleId) ?? 0;
    const name = moduleMap.get(limit.moduleId)!.name;
    if (count < limit.minimumCount) reasons.add(`必备或固定模块“${name}”需要 ${limit.minimumCount}，当前只有 ${count}`);
    if (count > limit.maximumCount) reasons.add(`模块“${name}”超过最大数量 ${limit.maximumCount}`);
  }
  for (const rule of context.rules) {
    if (rule.requiredCount > 0 && !moduleMap.has(rule.moduleId)) reasons.add(`必备模块“${rule.moduleId}”已删除`);
  }
  const layoutKeys = new Map<string, number>();
  for (const placement of placements) {
    const key = placementKey(placement);
    layoutKeys.set(key, (layoutKeys.get(key) ?? 0) + 1);
  }
  for (const locked of context.lockedPlacements) {
    const key = placementKey(locked);
    const available = layoutKeys.get(key) ?? 0;
    if (available === 0) reasons.add(`锁定模块“${moduleMap.get(locked.moduleId)?.name ?? locked.moduleId}”的位置或方向不一致`);
    else layoutKeys.set(key, available - 1);
  }
  const space = analyzeEmptySpace(context.board, occupancy);
  const validCells = context.board.mask.flat().filter((cell) => cell === 1).length;
  const occupiedCells = validCells - space.remainingCells;
  return {
    valid: reasons.size === 0,
    reasons: [...reasons],
    metrics: {
      requiredSatisfied: context.rules.every((rule) => (counts.get(rule.moduleId) ?? 0) >= rule.requiredCount),
      moduleCounts: Object.fromEntries(context.modules.map((module) => [module.id, counts.get(module.id) ?? 0])),
      totalScore: calculateLayoutScore(context.modules, placements),
      occupiedCells,
      utilization: validCells ? occupiedCells / validCells : 0,
      ...space,
    },
  };
}

export function validateSolverSolution(solution: SolverSolution, context: SolverLayoutContext) {
  const validation = validateSolverLayout(context, solution.placements);
  return { ...validation, solution: { ...solution, ...validation.metrics } };
}
