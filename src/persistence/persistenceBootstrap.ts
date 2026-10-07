import type { BoardHistoryEntry, SavedBoardEntry } from "../models/boardStorage";
import type { FitterDataDocument, FitterDataLoadResponse } from "../models/fitterData";
import type { SavedFittingEntry } from "../models/fittingStorage";
import type { WorkspaceSnapshot } from "../models/workspaceSnapshot";
import { loadFitterData, saveFitterData } from "../services/dataApi";
import { loadBoardHistory, loadSavedBoards } from "./boardStorage";
import { FilePersistenceStorage, type FilePersistenceStatus } from "./filePersistence";
import { loadSavedFittings } from "./fittingLibrary";
import { parseFitterDataDocument } from "./fitterDataValidation";
import { loadWorkspaceSnapshot } from "./localWorkspace";

interface PersistenceBaseline {
  storage: FilePersistenceStorage;
  source: FitterDataLoadResponse["source"];
  savedAt: string | null;
  workspace: WorkspaceSnapshot | null;
  savedBoards: SavedBoardEntry[];
  boardHistory: BoardHistoryEntry[];
  savedFittings: SavedFittingEntry[];
}

type LoadDocument = () => Promise<FitterDataLoadResponse>;
type SaveDocument = (document: FitterDataDocument) => Promise<FitterDataDocument>;

export async function readPersistenceBaseline(
  onStatus: (status: FilePersistenceStatus) => void,
  loadDocument: LoadDocument = loadFitterData,
  saveDocument: SaveDocument = saveFitterData,
): Promise<PersistenceBaseline> {
  const response = await loadDocument();
  const document = parseFitterDataDocument(response.document);
  const storage = new FilePersistenceStorage(document, onStatus, saveDocument);
  return {
    storage,
    source: response.source,
    savedAt: response.document.savedAt,
    workspace: loadWorkspaceSnapshot(storage)?.snapshot ?? null,
    savedBoards: loadSavedBoards(storage),
    boardHistory: loadBoardHistory(storage),
    savedFittings: loadSavedFittings(storage),
  };
}
