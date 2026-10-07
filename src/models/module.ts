import type { GridPoint } from "./board";

export type Rotation = 0 | 90 | 180 | 270;
export type ModuleShape = GridPoint[];

export interface ModuleDefinition {
  id: string;
  name: string;
  type: string;
  baseShape: ModuleShape;
  color: string;
  availableQuantity: number;
  allowRotation: boolean;
  allowMirror: boolean;
  baseScore: number;
  attributes: Record<string, number>;
}
