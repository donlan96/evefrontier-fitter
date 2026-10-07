import type { BoardDefinition } from "./board";
import type { ShipBuild } from "./build";
import type { ModuleDefinition } from "./module";

export const FITTING_DOCUMENT_TYPE = "eve-frontier-grid-fitting";
export const FITTING_DOCUMENT_VERSION = 1;

export interface FittingDocument {
  documentType: typeof FITTING_DOCUMENT_TYPE;
  schemaVersion: typeof FITTING_DOCUMENT_VERSION;
  board: BoardDefinition;
  modules: ModuleDefinition[];
  build: ShipBuild;
}
