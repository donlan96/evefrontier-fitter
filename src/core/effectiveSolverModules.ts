import type { ModuleDefinition } from "../models/module";
import type { PlacedModuleData } from "../models/placement";
import type { ModuleSolverRule } from "../models/solver";

export interface EffectiveModuleLimit {
  moduleId: string;
  minimumCount: number;
  maximumCount: number;
}

export function calculateEffectiveModuleLimits(
  modules: ModuleDefinition[],
  rules: ModuleSolverRule[],
  fixedPlacements: PlacedModuleData[],
): EffectiveModuleLimit[] {
  const rulesByModule = new Map(rules.map((rule) => [rule.moduleId, rule]));
  const fixedCounts = new Map<string, number>();
  for (const placement of fixedPlacements) {
    fixedCounts.set(placement.moduleId, (fixedCounts.get(placement.moduleId) ?? 0) + 1);
  }
  return modules.map((module) => {
    const rule = rulesByModule.get(module.id);
    const requiredCount = rule?.requiredCount ?? 0;
    const minimumCount = Math.max(requiredCount, fixedCounts.get(module.id) ?? 0);
    const enabledMaximum = rule?.enabled
      ? Math.min(module.availableQuantity, rule.maxCount)
      : minimumCount;
    return {
      moduleId: module.id,
      minimumCount,
      maximumCount: Math.max(minimumCount, enabledMaximum),
    };
  });
}

export function effectiveModuleIds(
  modules: ModuleDefinition[],
  rules: ModuleSolverRule[],
  fixedPlacements: PlacedModuleData[],
): Set<string> {
  return new Set(
    calculateEffectiveModuleLimits(modules, rules, fixedPlacements)
      .filter((limit) => limit.maximumCount > 0)
      .map((limit) => limit.moduleId),
  );
}
