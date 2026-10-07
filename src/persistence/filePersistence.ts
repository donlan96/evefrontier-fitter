import type { BoardStorageDocument } from "../models/boardStorage";
import type { FittingLibraryDocument } from "../models/fittingStorage";
import type { SolutionHistoryStore } from "../models/solutionHistory";
import type { WorkspaceSnapshot } from "../models/workspaceSnapshot";
import type { FitterDataDocument } from "../models/fitterData";

export class RevisionConflictError extends Error {
  constructor(public readonly currentRevision: number | null, message: string) {
    super(message);
    this.name = "RevisionConflictError";
  }
}

const BOARD_STORAGE_KEY = "eve-frontier-grid-fitting.boards.v3";
const FITTING_LIBRARY_STORAGE_KEY = "eve-frontier-grid-fitting.fittings.v3";
const LOCAL_WORKSPACE_KEY = "eve-frontier-grid-fitting.workspace.v3";
const SOLUTION_HISTORY_STORAGE_KEY = "eve-frontier-grid-fitting.solution-history.v3";

export interface FilePersistenceStatus {
  status: "saving" | "saved" | "error";
  savedAt: string | null;
  error?: Error;
  conflict?: boolean;
}

type StatusListener = (status: FilePersistenceStatus) => void;
type SaveDocument = (document: FitterDataDocument) => Promise<FitterDataDocument>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function contentSignature(document: FitterDataDocument): string {
  const workspace = document.workspace
    ? Object.fromEntries(Object.entries(document.workspace).filter(([key]) => key !== "savedAt"))
    : null;
  return JSON.stringify({
    boards: document.boards,
    fittings: document.fittings,
    solutionHistory: document.solutionHistory,
    workspace,
  });
}

function validateDocumentEnvelope(value: FitterDataDocument): FitterDataDocument {
  const isRecord = (item: unknown): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item);
  if (value.schemaVersion !== 1 || !Number.isInteger(value.revision) || value.revision < 0) {
    throw new Error("本机存档格式或 schemaVersion 无效。");
  }
  if (!isRecord(value.boards) || value.boards.version !== 3 || !Array.isArray(value.boards.savedBoards) || !Array.isArray(value.boards.history)) {
    throw new Error("本机存档的 boards 分区无效。");
  }
  if (!isRecord(value.fittings) || value.fittings.version !== 3 || !Array.isArray(value.fittings.entries)) {
    throw new Error("本机存档的 fittings 分区无效。");
  }
  if (!isRecord(value.solutionHistory) || value.solutionHistory.version !== 3 || !isRecord(value.solutionHistory.models)) {
    throw new Error("本机存档的 solutionHistory 分区无效。");
  }
  if (value.workspace !== null && (!isRecord(value.workspace)
    || value.workspace.snapshotVersion !== 3
    || !isRecord(value.workspace.document)
    || !isRecord(value.workspace.solver))) {
    throw new Error("本机存档的工作区无效。");
  }
  return value;
}

export class FilePersistenceStorage {
  private document: FitterDataDocument;
  private persistedContentSignature: string;
  private dirty = false;
  private failedPayload: FitterDataDocument | null = null;
  private drainPromise: Promise<void> | null = null;
  private flushScheduled = false;
  private conflictError: RevisionConflictError | null = null;

  constructor(
    document: FitterDataDocument,
    private readonly onStatus: StatusListener,
    private readonly saveDocument: SaveDocument,
  ) {
    this.document = clone(validateDocumentEnvelope(document));
    this.persistedContentSignature = contentSignature(this.document);
  }

  getItem(key: string): string | null {
    if (key === BOARD_STORAGE_KEY) return JSON.stringify(this.document.boards);
    if (key === FITTING_LIBRARY_STORAGE_KEY) return JSON.stringify(this.document.fittings);
    if (key === SOLUTION_HISTORY_STORAGE_KEY) return JSON.stringify(this.document.solutionHistory);
    if (key === LOCAL_WORKSPACE_KEY) return this.document.workspace ? JSON.stringify(this.document.workspace) : null;
    return null;
  }

  setItem(key: string, value: string): void {
    const previousSignature = contentSignature(this.document);
    const parsed = JSON.parse(value) as unknown;
    if (key === BOARD_STORAGE_KEY) this.document.boards = parsed as BoardStorageDocument;
    else if (key === FITTING_LIBRARY_STORAGE_KEY) this.document.fittings = parsed as FittingLibraryDocument;
    else if (key === SOLUTION_HISTORY_STORAGE_KEY) this.document.solutionHistory = parsed as SolutionHistoryStore;
    else if (key === LOCAL_WORKSPACE_KEY) this.document.workspace = parsed as WorkspaceSnapshot;
    else throw new Error(`不支持的本机存储分区：${key}`);
    if (contentSignature(this.document) === previousSignature) return;
    this.dirty = true;
    this.scheduleFlush();
  }

  flush(): Promise<void> {
    this.flushScheduled = false;
    if (this.conflictError) return Promise.reject(this.conflictError);
    if (this.drainPromise) return this.drainPromise;
    if (!this.dirty && !this.failedPayload) return Promise.resolve();
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      if (!this.flushScheduled) return;
      this.flushScheduled = false;
      void this.flush().catch(() => {
        // The status listener exposes the failure; the in-memory state stays intact.
      });
    });
  }

  private async drain(): Promise<void> {
    while (this.dirty || this.failedPayload) {
      let payload = this.failedPayload;
      if (!payload) {
        this.dirty = false;
        if (contentSignature(this.document) === this.persistedContentSignature) continue;
        payload = clone(this.document);
        payload.revision = this.document.revision + 1;
        payload.savedAt = new Date().toISOString();
      }
      this.onStatus({ status: "saving", savedAt: this.document.savedAt });
      try {
        const saved = validateDocumentEnvelope(await this.saveDocument(payload));
        if (saved.revision !== payload.revision) throw new Error("本机服务返回了不一致的数据 revision。");
        this.document.revision = saved.revision;
        this.document.savedAt = saved.savedAt;
        this.persistedContentSignature = contentSignature(saved);
        this.failedPayload = null;
        if (contentSignature(this.document) !== contentSignature(payload)) this.dirty = true;
        this.onStatus({ status: "saved", savedAt: saved.savedAt });
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("本机文件保存失败。");
        if (failure instanceof RevisionConflictError) {
          this.conflictError = failure;
          this.failedPayload = null;
          this.dirty = true;
        } else {
          this.failedPayload = payload;
        }
        this.onStatus({
          status: "error",
          savedAt: this.document.savedAt,
          error: failure,
          conflict: failure instanceof RevisionConflictError,
        });
        throw failure;
      }
    }
  }
}
