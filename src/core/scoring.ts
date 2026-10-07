import type { ModuleDefinition } from "../models/module";
import type { PlacedModuleData } from "../models/placement";

export const SCORE_SCALE = 1_000;

export function validateModuleScore(value: unknown, field = "基础评分"): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} 必须是非负有限数字。`);
  }
  if (Math.round(value * SCORE_SCALE) / SCORE_SCALE !== value) {
    throw new Error(`${field} 最多支持三位小数。`);
  }
  return value;
}

export function scoreToUnits(score: number): number {
  return Math.round(score * SCORE_SCALE);
}

export function calculateLayoutScore(modules: ModuleDefinition[], placements: PlacedModuleData[]): number {
  const scores = new Map(modules.map((module) => [module.id, scoreToUnits(module.baseScore)]));
  return placements.reduce((units, placement) => units + (scores.get(placement.moduleId) ?? 0), 0) / SCORE_SCALE;
}
