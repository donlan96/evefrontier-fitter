import type { BoardDefinition } from "../models/board";
import type { BuildModelFingerprintPayload } from "../models/solutionHistory";
import type { PlacedModuleData } from "../models/placement";
import type { ModuleSolverRule } from "../models/solver";

export function createBuildModelFingerprint(
  board: BoardDefinition,
  rules: ModuleSolverRule[],
  placements: PlacedModuleData[],
  lockedPlacementIds: Iterable<string>,
): string {
  const lockedIds = new Set(lockedPlacementIds);
  const payload: BuildModelFingerprintPayload = {
    version: 3,
    boardId: board.id,
    required: rules
      .filter((rule) => rule.requiredCount > 0)
      .map((rule) => ({ moduleId: rule.moduleId, count: rule.requiredCount }))
      .sort((a, b) => a.moduleId.localeCompare(b.moduleId) || a.count - b.count),
    locked: placements
      .filter((placement) => lockedIds.has(placement.instanceId))
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
  };
  return JSON.stringify(payload);
}

export function getBuildModelFingerprintLabel(fingerprint: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < fingerprint.length; index += 1) {
    hash ^= fingerprint.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").toUpperCase();
}
