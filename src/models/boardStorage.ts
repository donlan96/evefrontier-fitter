import type { BoardDefinition } from "./board";
import type { PlacedModuleData } from "./placement";

export const BOARD_STORAGE_VERSION = 3;

export interface SavedBoardEntry {
  board: BoardDefinition;
  savedAt: string;
}

export interface BoardHistoryEntry {
  id: string;
  savedAt: string;
  board: BoardDefinition;
  placements: PlacedModuleData[];
  lockedPlacementIds: string[];
}

export interface BoardStorageDocument {
  version: typeof BOARD_STORAGE_VERSION;
  savedBoards: SavedBoardEntry[];
  history: BoardHistoryEntry[];
}
