import type { PlacedModuleData } from "./placement";

export interface ShipBuild {
  id: string;
  name: string;
  boardId: string;
  placements: PlacedModuleData[];
}
