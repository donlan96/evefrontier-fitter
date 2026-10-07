import type { ModuleDefinition } from "../models/module";
import { validateModuleScore } from "../core/scoring";

export const MODULE_EDITOR_MIN_QUANTITY = 1;
export const MODULE_EDITOR_MAX_QUANTITY = 99;

/** Validate the editor draft before invoking the application's state update. */
export function submitModuleEditorDefinition(
  definition: ModuleDefinition,
  onSave: (definition: ModuleDefinition) => void,
): void {
  const quantity = definition.availableQuantity;
  if (!Number.isFinite(quantity) || !Number.isInteger(quantity)
    || quantity < MODULE_EDITOR_MIN_QUANTITY || quantity > MODULE_EDITOR_MAX_QUANTITY) {
    throw new Error(`库存数量必须为 ${MODULE_EDITOR_MIN_QUANTITY}～${MODULE_EDITOR_MAX_QUANTITY} 的有限整数。`);
  }
  validateModuleScore(definition.baseScore);
  onSave(definition);
}
