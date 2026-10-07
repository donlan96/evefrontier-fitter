import {
  FITTING_LIBRARY_VERSION,
  type FittingLibraryDocument,
  type SaveFittingInput,
  type SavedFittingEntry,
  type SavedFittingSolverSettings,
} from "../models/fittingStorage";
import {
  MAX_SOLVER_WORKERS,
  createDefaultSolverWorkerSetting,
  type ModuleSolverRule,
  type SolveScope,
  type SolverTimeLimit,
  type SolverWorkerSetting,
} from "../models/solver";
import type { PlacedModuleData } from "../models/placement";

export const FITTING_LIBRARY_STORAGE_KEY = "eve-frontier-grid-fitting.fittings.v3";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneEntry(entry: SavedFittingEntry): SavedFittingEntry {
  return JSON.parse(JSON.stringify(entry)) as SavedFittingEntry;
}

function parsePlacements(value: unknown): PlacedModuleData[] | null {
  if (!Array.isArray(value)) return null;
  const placements: PlacedModuleData[] = [];
  for (const item of value) {
    if (!isRecord(item)
      || typeof item.instanceId !== "string"
      || typeof item.moduleId !== "string"
      || !isRecord(item.origin)
      || !Number.isInteger(item.origin.x)
      || !Number.isInteger(item.origin.y)
      || !isRecord(item.orientation)
      || ![0, 90, 180, 270].includes(item.orientation.rotation as number)
      || typeof item.orientation.mirrored !== "boolean") return null;
    placements.push({
      instanceId: item.instanceId,
      moduleId: item.moduleId,
      origin: { x: item.origin.x as number, y: item.origin.y as number },
      orientation: {
        rotation: item.orientation.rotation as PlacedModuleData["orientation"]["rotation"],
        mirrored: item.orientation.mirrored,
      },
    });
  }
  return placements;
}

function parseRules(value: unknown): ModuleSolverRule[] | null {
  if (!Array.isArray(value)) return null;
  const rules: ModuleSolverRule[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.moduleId !== "string" || !Number.isInteger(item.requiredCount) || !Number.isInteger(item.maxCount)) return null;
    rules.push({
      moduleId: item.moduleId,
      requiredCount: Math.max(0, item.requiredCount as number),
      enabled: item.enabled === true,
      maxCount: Math.max(0, item.maxCount as number),
    });
  }
  return rules;
}

function parseWorkerSetting(value: unknown): SolverWorkerSetting | null {
  if (value === undefined) return createDefaultSolverWorkerSetting();
  if (!isRecord(value) || !["standard", "all", "custom"].includes(value.mode as string)) return null;
  if (value.mode === "custom") {
    if (!Number.isInteger(value.value) || (value.value as number) < 1 || (value.value as number) > MAX_SOLVER_WORKERS) return null;
    return { mode: "custom", value: value.value as number };
  }
  if (value.value !== undefined && value.value !== null) return null;
  return { mode: value.mode as "standard" | "all" };
}

function parseSolverSettings(value: unknown): SavedFittingSolverSettings | null {
  if (!isRecord(value)) return null;
  const rules = parseRules(value.rules);
  const scopes: SolveScope[] = ["empty-board", "fill-current", "rearrange-unlocked"];
  const times: SolverTimeLimit[] = [30_000, 60_000, 300_000, 900_000, null];
  const searchWorkers = parseWorkerSetting(value.searchWorkers);
  if (!rules || !searchWorkers || !scopes.includes(value.scope as SolveScope) || !times.includes(value.timeLimitMs as SolverTimeLimit)) return null;
  if (!Array.isArray(value.lockedPlacementIds) || !value.lockedPlacementIds.every((id) => typeof id === "string")) return null;
  return {
    rules,
    scope: value.scope as SolveScope,
    timeLimitMs: value.timeLimitMs as SolverTimeLimit,
    searchWorkers,
    lockedPlacementIds: [...value.lockedPlacementIds] as string[],
  };
}

function parseEntry(value: unknown): SavedFittingEntry | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.boardId !== "string" || typeof value.name !== "string" || !value.name.trim()) return null;
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return null;
  const settings = parseSolverSettings(value.solverSettings);
  const placements = parsePlacements(value.placements);
  if (!settings || !placements) return null;
  return {
    id: value.id,
    boardId: value.boardId,
    name: value.name.trim(),
    description: typeof value.description === "string" ? value.description : "",
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    placements,
    solverSettings: settings,
  };
}

function loadDocument(storage: StorageLike): FittingLibraryDocument {
  const raw = storage.getItem(FITTING_LIBRARY_STORAGE_KEY);
  if (!raw) return { version: FITTING_LIBRARY_VERSION, entries: [] };
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.version !== FITTING_LIBRARY_VERSION || !Array.isArray(value.entries)) {
      return { version: FITTING_LIBRARY_VERSION, entries: [] };
    }
    return { version: FITTING_LIBRARY_VERSION, entries: value.entries.map(parseEntry).filter((entry): entry is SavedFittingEntry => entry !== null) };
  } catch {
    return { version: FITTING_LIBRARY_VERSION, entries: [] };
  }
}

function saveDocument(storage: StorageLike, document: FittingLibraryDocument): void {
  storage.setItem(FITTING_LIBRARY_STORAGE_KEY, JSON.stringify(document));
}

export function loadSavedFittings(storage: StorageLike): SavedFittingEntry[] {
  return loadDocument(storage).entries
    .map(cloneEntry)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
}

export function loadSavedFittingsForBoard(storage: StorageLike, boardId: string): SavedFittingEntry[] {
  return loadSavedFittings(storage).filter((entry) => entry.boardId === boardId);
}

export function saveFittingToLibrary(
  storage: StorageLike,
  input: SaveFittingInput,
  saveAsNew = false,
  savedAt = new Date().toISOString(),
): { entry: SavedFittingEntry; entries: SavedFittingEntry[] } {
  const name = input.name.trim();
  if (!name) throw new Error("配装名称不能为空。");
  const document = loadDocument(storage);
  const existing = !saveAsNew && input.activeFittingId
    ? document.entries.find((entry) => entry.id === input.activeFittingId)
    : null;
  const id = existing?.id ?? `fitting-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: SavedFittingEntry = {
    id,
    boardId: input.boardId,
    name,
    description: input.description.trim(),
    createdAt: existing?.createdAt ?? savedAt,
    updatedAt: savedAt,
    placements: JSON.parse(JSON.stringify(input.placements)) as PlacedModuleData[],
    solverSettings: JSON.parse(JSON.stringify(input.solverSettings)) as SavedFittingSolverSettings,
  };
  document.entries = document.entries.filter((item) => item.id !== id);
  document.entries.push(entry);
  saveDocument(storage, document);
  return { entry: cloneEntry(entry), entries: loadSavedFittings(storage) };
}

export function deleteSavedFitting(storage: StorageLike, fittingId: string): SavedFittingEntry[] {
  const document = loadDocument(storage);
  document.entries = document.entries.filter((entry) => entry.id !== fittingId);
  saveDocument(storage, document);
  return loadSavedFittings(storage);
}

export function updateSavedFittingProfile(
  storage: StorageLike,
  fittingId: string,
  name: string,
  description: string,
  savedAt = new Date().toISOString(),
): { entry: SavedFittingEntry; entries: SavedFittingEntry[] } {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("配装名称不能为空。");
  const document = loadDocument(storage);
  const existing = document.entries.find((entry) => entry.id === fittingId);
  if (!existing) throw new Error("找不到需要编辑的配装。");
  const entry = { ...existing, name: trimmedName, description: description.trim(), updatedAt: savedAt };
  document.entries = document.entries.map((item) => item.id === fittingId ? entry : item);
  saveDocument(storage, document);
  return { entry: cloneEntry(entry), entries: loadSavedFittings(storage) };
}

export function deleteSavedFittingsForBoard(storage: StorageLike, boardId: string): SavedFittingEntry[] {
  const document = loadDocument(storage);
  document.entries = document.entries.filter((entry) => entry.boardId !== boardId);
  saveDocument(storage, document);
  return loadSavedFittings(storage);
}

export function createFittingContentSignature(input: SaveFittingInput): string {
  return JSON.stringify({
    name: input.name.trim(),
    description: input.description.trim(),
    boardId: input.boardId,
    placements: input.placements,
    solverSettings: {
      ...input.solverSettings,
      rules: [...input.solverSettings.rules].sort((a, b) => a.moduleId.localeCompare(b.moduleId)),
      lockedPlacementIds: [...input.solverSettings.lockedPlacementIds].sort(),
    },
  });
}
