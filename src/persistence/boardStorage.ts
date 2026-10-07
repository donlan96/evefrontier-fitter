import {
  BOARD_STORAGE_VERSION,
  type BoardHistoryEntry,
  type BoardStorageDocument,
  type SavedBoardEntry,
} from "../models/boardStorage";
import type { BoardDefinition } from "../models/board";
import type { PlacedModuleData } from "../models/placement";

export const BOARD_STORAGE_KEY = "eve-frontier-grid-fitting.boards.v3";
const MAX_BOARD_HISTORY = 20;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function cloneBoard(board: BoardDefinition): BoardDefinition {
  return { ...board, mask: board.mask.map((row) => [...row]) };
}

function clonePlacements(placements: PlacedModuleData[]): PlacedModuleData[] {
  return placements.map((placement) => ({
    ...placement,
    origin: { ...placement.origin },
    orientation: { ...placement.orientation },
  }));
}

function emptyDocument(): BoardStorageDocument {
  return { version: BOARD_STORAGE_VERSION, savedBoards: [], history: [] };
}

function loadDocument(storage: StorageLike): BoardStorageDocument {
  const raw = storage.getItem(BOARD_STORAGE_KEY);
  if (!raw) return emptyDocument();
  try {
    const parsed = JSON.parse(raw) as Partial<BoardStorageDocument>;
    if (parsed.version !== BOARD_STORAGE_VERSION || !Array.isArray(parsed.savedBoards) || !Array.isArray(parsed.history)) return emptyDocument();
    return { version: BOARD_STORAGE_VERSION, savedBoards: parsed.savedBoards, history: parsed.history };
  } catch {
    return emptyDocument();
  }
}

function saveDocument(storage: StorageLike, document: BoardStorageDocument): void {
  storage.setItem(BOARD_STORAGE_KEY, JSON.stringify(document));
}

export function loadSavedBoards(storage: StorageLike): SavedBoardEntry[] {
  return loadDocument(storage).savedBoards
    .map((entry) => ({ board: cloneBoard(entry.board), savedAt: entry.savedAt }))
    .sort((a, b) => a.board.name.localeCompare(b.board.name) || b.savedAt.localeCompare(a.savedAt));
}

export function saveBoardToLibrary(
  storage: StorageLike,
  board: BoardDefinition,
  saveAsNew = false,
  savedAt = new Date().toISOString(),
): { board: BoardDefinition; savedBoards: SavedBoardEntry[] } {
  const document = loadDocument(storage);
  const savedBoard = cloneBoard(saveAsNew
    ? { ...board, id: `board-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }
    : board);
  document.savedBoards = document.savedBoards.filter((entry) => entry.board.id !== savedBoard.id);
  document.savedBoards.push({ board: savedBoard, savedAt });
  saveDocument(storage, document);
  return { board: cloneBoard(savedBoard), savedBoards: loadSavedBoards(storage) };
}

export function deleteSavedBoard(storage: StorageLike, boardId: string): SavedBoardEntry[] {
  const document = loadDocument(storage);
  document.savedBoards = document.savedBoards.filter((entry) => entry.board.id !== boardId);
  saveDocument(storage, document);
  return loadSavedBoards(storage);
}

export function recordBoardHistory(
  storage: StorageLike,
  board: BoardDefinition,
  placements: PlacedModuleData[],
  lockedPlacementIds: Iterable<string>,
  savedAt = new Date().toISOString(),
): BoardHistoryEntry[] {
  const document = loadDocument(storage);
  const locked = [...lockedPlacementIds].sort();
  const signature = JSON.stringify({ board, placements, locked });
  const latest = document.history[0];
  const latestSignature = latest
    ? JSON.stringify({ board: latest.board, placements: latest.placements, locked: [...latest.lockedPlacementIds].sort() })
    : null;
  if (signature !== latestSignature) {
    document.history.unshift({
      id: `board-history-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      savedAt,
      board: cloneBoard(board),
      placements: clonePlacements(placements),
      lockedPlacementIds: locked,
    });
    document.history = document.history.slice(0, MAX_BOARD_HISTORY);
    saveDocument(storage, document);
  }
  return loadBoardHistory(storage);
}

export function loadBoardHistory(storage: StorageLike): BoardHistoryEntry[] {
  return loadDocument(storage).history.map((entry) => ({
    ...entry,
    board: cloneBoard(entry.board),
    placements: clonePlacements(entry.placements),
    lockedPlacementIds: [...entry.lockedPlacementIds],
  }));
}

export function clearBoardHistory(storage: StorageLike, boardId?: string): void {
  const document = loadDocument(storage);
  document.history = boardId ? document.history.filter((entry) => entry.board.id !== boardId) : [];
  saveDocument(storage, document);
}
