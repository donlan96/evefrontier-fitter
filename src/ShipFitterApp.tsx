"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Board } from "./components/Board";
import { BoardEditor } from "./components/BoardEditor";
import { BOARD_CELL, BOARD_GAP, BOARD_PADDING } from "./components/boardLayout";
import { BuildStats } from "./components/BuildStats";
import { FittingProfileDialog } from "./components/FittingProfileDialog";
import { FittingLibraryBar } from "./components/FittingLibraryBar";
import { ModuleEditor } from "./components/ModuleEditor";
import { ModuleList } from "./components/ModuleList";
import { ShapeMiniature } from "./components/ShapeMiniature";
import { SolverControls } from "./components/SolverControls";
import { WorkspaceSelector } from "./components/WorkspaceSelector";
import type { BoardDefinition, GridPoint } from "./models/board";
import type { BoardHistoryEntry, SavedBoardEntry } from "./models/boardStorage";
import type { FittingDocument } from "./models/fittingDocument";
import type { SaveFittingInput, SavedFittingEntry } from "./models/fittingStorage";
import type { ModuleDefinition, Rotation } from "./models/module";
import type { PlacedModuleData, PlacementValidation } from "./models/placement";
import type { ValidatedSolutionHistoryEntry } from "./models/solutionHistory";
import type {
  ModuleSolverRule,
  SolveScope,
  SolverApiRequest,
  SolverJobSnapshot,
  SolverSolution,
  SolverTimeLimit,
  SolverWorkerSetting,
} from "./models/solver";
import { clampSolverWorkerSetting, createDefaultSolverWorkerSetting } from "./models/solver";
import { APP_VERSION_LABEL } from "./version";
import {
  clearBoardHistory,
  deleteSavedBoard,
  loadBoardHistory,
  loadSavedBoards,
  recordBoardHistory,
  saveBoardToLibrary,
} from "./persistence/boardStorage";
import {
  createWorkspaceSnapshot,
  saveWorkspaceSnapshot,
} from "./persistence/localWorkspace";
import { AutosaveScheduler } from "./persistence/autosaveScheduler";
import { FilePersistenceStorage, type FilePersistenceStatus } from "./persistence/filePersistence";
import { readPersistenceBaseline } from "./persistence/persistenceBootstrap";
import {
  createFittingContentSignature,
  deleteSavedFitting,
  deleteSavedFittingsForBoard,
  loadSavedFittings,
  saveFittingToLibrary,
  updateSavedFittingProfile,
} from "./persistence/fittingLibrary";
import {
  clearSolutionHistory,
  createOptimalityProblemSignature,
  deleteSolutionHistoryEntry,
  loadSoftSkeletonTrainingLayouts,
  loadSolutionHistory,
  saveSolutionToHistory,
  validateHistoryEntry,
  type HistoryValidationContext,
  type OptimalityProofInput,
} from "./persistence/solutionHistory";
import { RevisionConflictError } from "./services/dataApi";
import { getSolverJob, startSolverJob, stopSolverJob } from "./services/solverApi";
import {
  createFittingDocument,
  hasMatchingFittingDefinitions,
  parseFittingDocument,
  serializeFittingDocument,
} from "./utils/fittingJson";
import { createBuildModelFingerprint, getBuildModelFingerprintLabel } from "./utils/buildModelFingerprint";
import { getOrientedShape, nextRotation, rotateAnchor } from "./utils/rotateShape";
import { getPlacementCells, validatePlacement } from "./utils/validatePlacement";
import { createSolutionSignature } from "./utils/solutionMetrics";
import {
  translateBoardSelection,
  validateBoardSelectionMove,
  type BoardSelectionMoveError,
} from "./utils/translateBoardSelection";

import { validateSolverLayout, validateSolverSolution, type SolverLayoutContext } from "./core/solverLayout";
import { reconcileSolverSnapshot, revalidateCachedSolverSnapshot } from "./core/solverResult";

type WorkspaceMode = "assembly" | "board" | "module" | "solver";

interface DragState {
  pointerId: number;
  source: "palette" | "board";
  moduleId: string;
  instanceId?: string;
  rotation: Rotation;
  anchor: GridPoint;
  pointer: { x: number; y: number };
  origin: GridPoint | null;
  validation: PlacementValidation | null;
  moved: boolean;
}

interface ActiveSolverRun {
  jobId: string;
  fingerprint: string;
  context: HistoryValidationContext;
  layoutContext: SolverLayoutContext;
  startedAt: number;
  bestSolution: SolverSolution | null;
  lastPersistedSignature: string;
  stopRequested: boolean;
  scope: SolveScope;
}

const ERROR_LABELS: Record<string, string> = {
  OUT_OF_BOUNDS: "模块超出棋盘边界",
  INVALID_BOARD_CELL: "模块覆盖了不可用格",
  OVERLAP: "模块与已有装备重叠",
  OUT_OF_STOCK: "该模块库存已用完",
};

const SELECTION_MOVE_ERROR_LABELS: Record<BoardSelectionMoveError, string> = {
  EMPTY_SELECTION: "请先框选需要移动的可用区域",
  OUT_OF_BOUNDS: "选中区域移动后会超出棋盘边界",
  MASK_COLLISION: "目标位置与未选中的可用区域重叠",
  PARTIAL_PLACEMENT: "选区只包含了某个已放模块的一部分，请扩大选区或先移除模块",
};

function cloneBoard(board: BoardDefinition): BoardDefinition {
  return { ...board, mask: board.mask.map((row) => [...row]) };
}

function cloneModules(modules: ModuleDefinition[]): ModuleDefinition[] {
  return modules.map((module) => ({
    ...module,
    baseShape: module.baseShape.map((point) => ({ ...point })),
    attributes: { ...module.attributes },
  }));
}

function clonePlacements(placements: PlacedModuleData[]): PlacedModuleData[] {
  return placements.map((placement) => ({
    ...placement,
    origin: { ...placement.origin },
    orientation: { ...placement.orientation },
  }));
}

function createDefaultSolverRule(module: ModuleDefinition): ModuleSolverRule {
  return {
    moduleId: module.id,
    requiredCount: 0,
    enabled: false,
    maxCount: module.availableQuantity,
  };
}

function getBrowserLogicalCpuCount(): number {
  if (typeof navigator === "undefined") return 1;
  const reported = navigator.hardwareConcurrency;
  return Number.isFinite(reported) ? Math.max(1, Math.floor(reported)) : 1;
}

function createSolverErrorSnapshot(
  previous: SolverJobSnapshot | null,
  message: string,
  elapsedMs: number,
): SolverJobSnapshot {
  return {
    jobId: previous?.jobId ?? "service-unavailable",
    status: "error",
    bestSolution: previous?.bestSolution ?? null,
    score: previous?.score ?? 0,
    bestBound: previous?.bestBound ?? previous?.score ?? 0,
    optimalityGap: previous?.optimalityGap ?? 0,
    elapsedMs,
    solverStatus: "ERROR",
    provenOptimal: false,
    infeasibleReasons: [],
    errors: [message],
  };
}

export interface ShipFitterAppProps {
  initialBoard: BoardDefinition;
  initialModules: ModuleDefinition[];
  initialPlacements?: PlacedModuleData[];
  onDocumentChange?: (document: FittingDocument) => void;
  enableLocalPersistence?: boolean;
}

export function ShipFitterApp({
  initialBoard,
  initialModules,
  initialPlacements = [],
  onDocumentChange,
  enableLocalPersistence = true,
}: ShipFitterAppProps) {
  const [mode, setMode] = useState<WorkspaceMode>("assembly");
  const [board, setBoard] = useState(() => cloneBoard(initialBoard));
  const [modules, setModules] = useState<ModuleDefinition[]>(() => cloneModules(initialModules));
  const [placements, setPlacements] = useState<PlacedModuleData[]>(() => clonePlacements(initialPlacements));
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [editingModuleId, setEditingModuleId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [lockedPlacementIds, setLockedPlacementIds] = useState<Set<string>>(() => new Set());
  const [solverRules, setSolverRules] = useState<ModuleSolverRule[]>(() => initialModules.map(createDefaultSolverRule));
  const [solveScope, setSolveScope] = useState<SolveScope>("fill-current");
  const [solverTimeLimit, setSolverTimeLimit] = useState<SolverTimeLimit>(30_000);
  const [solverWorkerSetting, setSolverWorkerSetting] = useState<SolverWorkerSetting>(createDefaultSolverWorkerSetting);
  const [browserLogicalCpuCount] = useState(getBrowserLogicalCpuCount);
  const [solverResult, setSolverResult] = useState<SolverJobSnapshot | null>(null);
  const [historyEntries, setHistoryEntries] = useState<ValidatedSolutionHistoryEntry[]>([]);
  const [savedBoards, setSavedBoards] = useState<SavedBoardEntry[]>([]);
  const [boardHistory, setBoardHistory] = useState<BoardHistoryEntry[]>([]);
  const [savedFittings, setSavedFittings] = useState<SavedFittingEntry[]>([]);
  const [activeFittingId, setActiveFittingId] = useState<string | null>(null);
  const [fittingName, setFittingName] = useState(`${initialBoard.name} 配装`);
  const [fittingDescription, setFittingDescription] = useState("");
  const [fittingDialogMode, setFittingDialogMode] = useState<"create" | "edit" | null>(null);
  const [profileName, setProfileName] = useState("");
  const [profileDescription, setProfileDescription] = useState("");
  const [solving, setSolving] = useState(false);
  const [solveDeadline, setSolveDeadline] = useState<number | null>(null);
  const [remainingSolveMs, setRemainingSolveMs] = useState<number | null>(0);
  const [elapsedSolveMs, setElapsedSolveMs] = useState(0);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"loading" | "saving" | "saved" | "error">("loading");
  const [persistenceReadError, setPersistenceReadError] = useState<string | null>(null);
  const [persistenceConflict, setPersistenceConflict] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [notice, setNotice] = useState("从左侧按住模块，将它拖入棋盘开始配装。");
  const boardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const placementsRef = useRef(placements);
  const lastWheelAt = useRef(0);
  const solverPollAbortRef = useRef<AbortController | null>(null);
  const activeSolverRunRef = useRef<ActiveSolverRun | null>(null);
  const solverResultRef = useRef<SolverJobSnapshot | null>(null);
  const solverResultFingerprintRef = useRef<string | null>(null);
  const solverResultProblemSignatureRef = useRef<string | null>(null);
  const buildFingerprintRef = useRef("");
  const persistenceLoadedRef = useRef(false);
  const persistenceStorageRef = useRef<FilePersistenceStorage | null>(null);
  const workspaceAutosaveRef = useRef<AutosaveScheduler | null>(null);
  const skipNextWorkspaceAutosaveRef = useRef(true);

  const handlePersistenceStatus = useCallback((state: FilePersistenceStatus) => {
    setSaveStatus(state.status);
    if (state.savedAt) setLastSavedAt(new Date(state.savedAt));
    if (state.conflict) {
      setPersistenceConflict(true);
      setNotice("另一个页面已经修改本机存档，当前内存修改仍保留；请先导出当前内容，再重新载入磁盘存档。");
    }
  }, []);

  const requirePersistenceStorage = useCallback(() => {
    const storage = persistenceStorageRef.current;
    if (!storage) throw new Error("本机存储服务尚未连接，当前修改只保留在内存中。");
    return storage;
  }, []);

  const readPersistence = useCallback(async (confirmDiscard: boolean) => {
    if (confirmDiscard && !window.confirm("重新载入会放弃当前尚未保存的内存修改。请确认已先导出需要保留的内容。")) return;
    setSaveStatus("loading");
    setPersistenceReadError(null);
    setPersistenceReady(false);
    persistenceStorageRef.current = null;
    try {
      const baseline = await readPersistenceBaseline(handlePersistenceStatus);
      const { storage } = baseline;
      if (baseline.workspace) {
        const snapshot = baseline.workspace;
        const restoredPlacements = clonePlacements(snapshot.document.build.placements);
        const restoredIds = new Set(restoredPlacements.map((placement) => placement.instanceId));
        setBoard(cloneBoard(snapshot.document.board));
        setModules(cloneModules(snapshot.document.modules));
        setPlacements(restoredPlacements);
        placementsRef.current = restoredPlacements;
        setSolverRules(snapshot.solver.rules.map((rule) => ({ ...rule })));
        setSolveScope(snapshot.solver.scope);
        setSolverTimeLimit(snapshot.solver.timeLimitMs);
        setSolverWorkerSetting(clampSolverWorkerSetting(snapshot.solver.searchWorkers, browserLogicalCpuCount));
        setSolverResult(snapshot.solver.lastResult);
        solverResultRef.current = snapshot.solver.lastResult;
        solverResultProblemSignatureRef.current = null;
        solverResultFingerprintRef.current = snapshot.solver.lastResultFingerprint;
        setActiveFittingId(snapshot.fitting.activeFittingId);
        setFittingName(snapshot.fitting.name);
        setFittingDescription(snapshot.fitting.description);
        setLockedPlacementIds(new Set(snapshot.solver.lockedPlacementIds.filter((id) => restoredIds.has(id))));
      } else {
        const restoredPlacements = clonePlacements(initialPlacements);
        setBoard(cloneBoard(initialBoard));
        setModules(cloneModules(initialModules));
        setPlacements(restoredPlacements);
        placementsRef.current = restoredPlacements;
        setSolverRules(initialModules.map(createDefaultSolverRule));
        setSolveScope("fill-current");
        setSolverTimeLimit(30_000);
        setSolverWorkerSetting(createDefaultSolverWorkerSetting());
        setSolverResult(null);
        solverResultRef.current = null;
        solverResultFingerprintRef.current = null;
        setActiveFittingId(null);
        setFittingName(`${initialBoard.name} 配装`);
        setFittingDescription("");
        setLockedPlacementIds(new Set());
      }
      setSavedBoards(baseline.savedBoards);
      setBoardHistory(baseline.boardHistory);
      setSavedFittings(baseline.savedFittings);
      setSelectedInstanceId(null);
      setEditingModuleId(null);
      setDrag(null);
      persistenceStorageRef.current = storage;
      skipNextWorkspaceAutosaveRef.current = true;
      setPersistenceConflict(false);
      setLastSavedAt(baseline.savedAt ? new Date(baseline.savedAt) : null);
      setSaveStatus("saved");
      setPersistenceReady(true);
      if (baseline.source === "backup") setNotice("主存档不可用，已从本机自动备份恢复；下次保存会修复主文件并保留该备份。");
      else if (baseline.workspace) setNotice("已完整恢复本机文件中的工作区、棋盘库、配装库和历史。");
      else setNotice("已读取全新的空白本机存档；旧浏览器数据保持原样且不会迁移。");
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取失败";
      persistenceStorageRef.current = null;
      setSaveStatus("error");
      setPersistenceReadError(message);
      setPersistenceReady(false);
      setNotice(`本机存档读取失败：${message}。磁盘内容未被修改。`);
    }
  }, [browserLogicalCpuCount, handlePersistenceStatus, initialBoard, initialModules, initialPlacements]);

  useEffect(() => {
    if (persistenceLoadedRef.current) return;
    persistenceLoadedRef.current = true;
    if (!enableLocalPersistence) {
      setSaveStatus("saved");
      setPersistenceReady(true);
      return;
    }
    void readPersistence(false);
  }, [enableLocalPersistence, readPersistence]);
  useEffect(() => { dragRef.current = drag; }, [drag]);
  useEffect(() => { placementsRef.current = placements; }, [placements]);
  useEffect(() => {
    if (!persistenceReady) return;
    onDocumentChange?.(createFittingDocument(board, modules, placements));
  }, [board, modules, onDocumentChange, persistenceReady, placements]);
  useEffect(() => {
    if (!persistenceReady) return;
    setSolverRules((current) => modules.map((module) => {
      const existing = current.find((rule) => rule.moduleId === module.id);
      if (!existing) return createDefaultSolverRule(module);
      const requiredCount = Math.min(existing.requiredCount, module.availableQuantity);
      return {
        ...existing,
        requiredCount,
        maxCount: Math.min(module.availableQuantity, Math.max(existing.maxCount, requiredCount)),
      };
    }));
  }, [modules, persistenceReady]);
  useEffect(() => () => solverPollAbortRef.current?.abort(), []);
  useEffect(() => {
    if (!solving) return;
    const updateClock = () => {
      const run = activeSolverRunRef.current;
      setElapsedSolveMs(run ? Date.now() - run.startedAt : 0);
      setRemainingSolveMs(solveDeadline === null ? null : Math.max(0, solveDeadline - Date.now()));
    };
    updateClock();
    const timer = window.setInterval(updateClock, 250);
    return () => window.clearInterval(timer);
  }, [solveDeadline, solving]);
  useEffect(() => {
    if (!persistenceReady || !enableLocalPersistence) return;
    const storage = persistenceStorageRef.current;
    if (!storage) return;
    setSavedBoards(loadSavedBoards(storage));
    setBoardHistory(loadBoardHistory(storage));
    setSavedFittings(loadSavedFittings(storage));
  }, [enableLocalPersistence, persistenceReady]);

  const moduleMap = useMemo(() => new Map(modules.map((module) => [module.id, module])), [modules]);
  const lockedPlacements = useMemo(
    () => placements.filter((placement) => lockedPlacementIds.has(placement.instanceId)),
    [lockedPlacementIds, placements],
  );
  const buildFingerprint = useMemo(
    () => createBuildModelFingerprint(board, solverRules, placements, lockedPlacementIds),
    [board, lockedPlacementIds, placements, solverRules],
  );
  const fingerprintLabel = useMemo(() => getBuildModelFingerprintLabel(buildFingerprint), [buildFingerprint]);
  const historyContext = useMemo<HistoryValidationContext>(() => ({
    board,
    modules,
    rules: solverRules,
    lockedPlacements,
  }), [board, lockedPlacements, modules, solverRules]);
  const currentLayoutProvenOptimal = useMemo(() => {
    const signature = createSolutionSignature(placements);
    return historyEntries.some(({ entry }) => entry.layoutSignature === signature
      && validateHistoryEntry(entry, historyContext).provenOptimal);
  }, [historyContext, historyEntries, placements]);
  const fittingSaveInput = useMemo<SaveFittingInput>(() => ({
    activeFittingId,
    boardId: board.id,
    name: fittingName,
    description: fittingDescription,
    placements: clonePlacements(placements),
    solverSettings: {
      rules: solverRules.map((rule) => ({ ...rule })),
      scope: solveScope,
      timeLimitMs: solverTimeLimit,
      searchWorkers: { ...solverWorkerSetting },
      lockedPlacementIds: [...lockedPlacementIds],
    },
  }), [activeFittingId, board.id, fittingDescription, fittingName, lockedPlacementIds, placements, solveScope, solverRules, solverTimeLimit, solverWorkerSetting]);
  const currentBoardFittings = useMemo(
    () => savedFittings.filter((entry) => entry.boardId === board.id),
    [board.id, savedFittings],
  );
  const currentBoardHistory = useMemo(
    () => boardHistory.filter((entry) => entry.board.id === board.id),
    [board.id, boardHistory],
  );
  const currentBoardIsSaved = useMemo(
    () => savedBoards.some((entry) => entry.board.id === board.id),
    [board.id, savedBoards],
  );
  const fittingWorkspaceReady = currentBoardIsSaved && activeFittingId !== null;
  const activeSavedFitting = useMemo(
    () => activeFittingId ? savedFittings.find((entry) => entry.id === activeFittingId) ?? null : null,
    [activeFittingId, savedFittings],
  );
  const fittingDirty = useMemo(() => {
    if (!activeSavedFitting) return true;
    return createFittingContentSignature(fittingSaveInput) !== createFittingContentSignature({
      activeFittingId: activeSavedFitting.id,
      name: activeSavedFitting.name,
      description: activeSavedFitting.description,
      boardId: activeSavedFitting.boardId,
      placements: activeSavedFitting.placements,
      solverSettings: activeSavedFitting.solverSettings,
    });
  }, [activeSavedFitting, fittingSaveInput]);
  const refreshHistory = useCallback(() => {
    if (!enableLocalPersistence || !persistenceReady) {
      setHistoryEntries([]);
      return [];
    }
    const storage = persistenceStorageRef.current;
    if (!storage) {
      setHistoryEntries([]);
      return [];
    }
    const entries = loadSolutionHistory(storage, buildFingerprint, historyContext);
    setHistoryEntries(entries);
    return entries;
  }, [buildFingerprint, enableLocalPersistence, historyContext, persistenceReady]);

  useEffect(() => {
    buildFingerprintRef.current = buildFingerprint;
    if (solverResultRef.current && solverResultFingerprintRef.current !== buildFingerprint) {
      solverResultRef.current = null;
      solverResultFingerprintRef.current = null;
      setSolverResult(null);
    }
    const entries = refreshHistory();
    const cached = solverResultRef.current;
    if (!cached) return;
    const context: SolverLayoutContext = {
      ...historyContext,
      lockedPlacements: solveScope === "empty-board" ? []
        : solveScope === "fill-current" ? placements : lockedPlacements,
    };
    const signature = createOptimalityProblemSignature(context);
    const storedProofMatches = signature === createOptimalityProblemSignature(historyContext)
      && entries.some((entry) => entry.valid && entry.provenOptimal && cached.bestSolution
        && entry.currentScore === cached.bestSolution.totalScore
        && createSolutionSignature(entry.currentSolution.placements) === createSolutionSignature(cached.bestSolution.placements));
    const checked = revalidateCachedSolverSnapshot(cached, context,
      solverResultProblemSignatureRef.current === signature || storedProofMatches);
    if (JSON.stringify(checked) !== JSON.stringify(cached)) {
      solverResultRef.current = checked;
      setSolverResult(checked);
    }
  }, [buildFingerprint, historyContext, lockedPlacements, placements, refreshHistory, solveScope, solverResult]);

  const persistWorkspace = useCallback(async (manual = false) => {
    if (!persistenceReady || !enableLocalPersistence) return;
    try {
      const storage = persistenceStorageRef.current;
      if (!storage) return;
      const snapshot = createWorkspaceSnapshot(
        createFittingDocument(board, modules, placements),
        {
          rules: solverRules,
          scope: solveScope,
          timeLimitMs: solverTimeLimit,
          searchWorkers: { ...solverWorkerSetting },
          lockedPlacementIds: [...lockedPlacementIds],
          lastResult: solverResultRef.current,
          lastResultFingerprint: solverResultFingerprintRef.current,
        },
        {
          activeFittingId,
          name: fittingName.trim() || `${board.name} 配装`,
          description: fittingDescription,
        },
      );
      saveWorkspaceSnapshot(storage, snapshot);
      await storage.flush();
      if (manual) setNotice("当前棋盘、模块、配装和求解结果已保存到本机文件。");
    } catch (error) {
      setSaveStatus("error");
      if (error instanceof RevisionConflictError) {
        setPersistenceConflict(true);
        setNotice("另一个页面已经修改本机存档，当前内存修改仍保留；请先导出当前内容，再重新载入磁盘存档。");
      } else if (manual) {
        setNotice(`本机文件保存失败：${error instanceof Error ? error.message : "服务不可用"}。当前修改仍在内存中，可稍后重试或先导出 JSON。`);
      }
    }
  }, [activeFittingId, board, enableLocalPersistence, fittingDescription, fittingName, lockedPlacementIds, modules, persistenceReady, placements, solveScope, solverRules, solverTimeLimit, solverWorkerSetting]);

  const persistWorkspaceRef = useRef(persistWorkspace);
  useEffect(() => { persistWorkspaceRef.current = persistWorkspace; }, [persistWorkspace]);

  useEffect(() => {
    if (!persistenceReady || !enableLocalPersistence) {
      workspaceAutosaveRef.current?.cancel();
      workspaceAutosaveRef.current = null;
      return;
    }
    const scheduler = new AutosaveScheduler(() => persistWorkspaceRef.current(false));
    workspaceAutosaveRef.current = scheduler;
    return () => {
      scheduler.cancel();
      if (workspaceAutosaveRef.current === scheduler) workspaceAutosaveRef.current = null;
    };
  }, [enableLocalPersistence, persistenceReady]);

  const persistWorkspaceNow = useCallback((manual = false) => {
    workspaceAutosaveRef.current?.cancel();
    return persistWorkspace(manual);
  }, [persistWorkspace]);

  useEffect(() => {
    if (!persistenceReady || !enableLocalPersistence) return;
    if (skipNextWorkspaceAutosaveRef.current) {
      skipNextWorkspaceAutosaveRef.current = false;
      return;
    }
    workspaceAutosaveRef.current?.schedule();
  }, [enableLocalPersistence, persistWorkspace, persistenceReady]);

  const getBoardPoint = useCallback((clientX: number, clientY: number): GridPoint | null => {
    const surface = boardRef.current;
    if (!surface) return null;
    const rect = surface.getBoundingClientRect();
    const localX = clientX - rect.left - BOARD_PADDING;
    const localY = clientY - rect.top - BOARD_PADDING;
    const pitch = BOARD_CELL + BOARD_GAP;
    if (localX < 0 || localY < 0) return null;
    const x = Math.floor(localX / pitch);
    const y = Math.floor(localY / pitch);
    if (x < 0 || y < 0 || x >= board.width || y >= board.height) return null;
    return { x, y };
  }, [board.width, board.height]);

  const positionDrag = useCallback((current: DragState, pointer: { x: number; y: number }, rotation = current.rotation, anchor = current.anchor): DragState => {
    const definition = moduleMap.get(current.moduleId);
    const gridPoint = getBoardPoint(pointer.x, pointer.y);
    if (!definition || !gridPoint) {
      return { ...current, pointer, rotation, anchor, origin: null, validation: null, moved: current.moved || Math.abs(pointer.x - current.pointer.x) + Math.abs(pointer.y - current.pointer.y) > 3 };
    }
    const origin = { x: gridPoint.x - anchor.x, y: gridPoint.y - anchor.y };
    const validation = validatePlacement({
      board,
      module: definition,
      origin,
      rotation,
      placements,
      modules,
      ignoreInstanceId: current.instanceId,
      isNew: current.source === "palette",
    });
    return {
      ...current,
      pointer,
      rotation,
      anchor,
      origin,
      validation,
      moved: current.moved || Math.abs(pointer.x - current.pointer.x) + Math.abs(pointer.y - current.pointer.y) > 3,
    };
  }, [board, getBoardPoint, moduleMap, modules, placements]);

  const finishDrag = useCallback((pointerId: number) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== pointerId) return;
    const accepted = current.origin && current.validation?.valid;
    if (accepted) {
      if (current.source === "palette") {
        const instanceId = crypto.randomUUID();
        setPlacements((items) => [...items, {
          instanceId,
          moduleId: current.moduleId,
          origin: current.origin!,
          orientation: { rotation: current.rotation, mirrored: false },
        }]);
        setSelectedInstanceId(instanceId);
        setNotice("模块已放置。继续拖动模块，或滚轮旋转后再松开。");
      } else {
        setPlacements((items) => items.map((placement) => placement.instanceId === current.instanceId
          ? { ...placement, origin: current.origin!, orientation: { ...placement.orientation, rotation: current.rotation } }
          : placement));
        setNotice(current.moved ? "模块已移动到新位置。" : "已选中模块，可在右侧旋转或删除。");
      }
    } else if (current.source === "board") {
      const reason = current.validation?.errors[0];
      setNotice(reason ? `${ERROR_LABELS[reason]}，模块已恢复原位。` : "未落在棋盘内，模块已恢复原位。");
    } else {
      const reason = current.validation?.errors[0];
      setNotice(reason ? `${ERROR_LABELS[reason]}，已取消放置。` : "已取消放置。");
    }
    dragRef.current = null;
    setDrag(null);
  }, []);

  useEffect(() => {
    if (!drag) return;
    const move = (event: PointerEvent) => {
      if (event.pointerId !== dragRef.current?.pointerId) return;
      event.preventDefault();
      setDrag((current) => current ? positionDrag(current, { x: event.clientX, y: event.clientY }) : null);
    };
    const up = (event: PointerEvent) => finishDrag(event.pointerId);
    const wheel = (event: WheelEvent) => {
      const current = dragRef.current;
      if (!current) return;
      event.preventDefault();
      const definition = moduleMap.get(current.moduleId);
      if (!definition?.allowRotation) {
        setNotice("这个模块被设置为不可旋转。");
        return;
      }
      const now = performance.now();
      if (now - lastWheelAt.current < 110) return;
      lastWheelAt.current = now;
      const clockwise = event.deltaY > 0;
      const currentShape = getOrientedShape(definition, current.rotation);
      const rotation = nextRotation(current.rotation, clockwise);
      const anchor = rotateAnchor(current.anchor, currentShape, clockwise);
      setDrag((latest) => latest ? positionDrag(latest, latest.pointer, rotation, anchor) : null);
      setNotice(`拖动中旋转至 ${rotation}°。`);
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("wheel", wheel, { passive: false });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("wheel", wheel);
    };
  }, [drag, finishDrag, moduleMap, positionDrag]);

  const startPaletteDrag = (moduleId: string, anchor: GridPoint, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!fittingWorkspaceReady) {
      setNotice("请先从左侧选择棋盘和配装。");
      return;
    }
    event.preventDefault();
    const state: DragState = {
      pointerId: event.pointerId,
      source: "palette",
      moduleId,
      rotation: 0,
      anchor,
      pointer: { x: event.clientX, y: event.clientY },
      origin: null,
      validation: null,
      moved: false,
    };
    dragRef.current = state;
    setDrag(state);
    setNotice("正在拖动：滚动鼠标滚轮可旋转模块。绿色可放置，红色表示冲突。");
  };

  const startPlacedDrag = (placement: PlacedModuleData, anchor: GridPoint, event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedInstanceId(placement.instanceId);
    const state: DragState = {
      pointerId: event.pointerId,
      source: "board",
      moduleId: placement.moduleId,
      instanceId: placement.instanceId,
      rotation: placement.orientation.rotation,
      anchor,
      pointer: { x: event.clientX, y: event.clientY },
      origin: placement.origin,
      validation: null,
      moved: false,
    };
    dragRef.current = state;
    setDrag(state);
    setNotice("正在移动现有模块。非法位置松手后会自动恢复原位。");
  };

  const deleteSelected = useCallback(() => {
    if (!selectedInstanceId) return;
    setPlacements((items) => items.filter((placement) => placement.instanceId !== selectedInstanceId));
    setLockedPlacementIds((items) => {
      const next = new Set(items);
      next.delete(selectedInstanceId);
      return next;
    });
    setSelectedInstanceId(null);
    setNotice("已删除选中的模块。");
  }, [selectedInstanceId]);

  const rotateSelected = useCallback(() => {
    const placement = placements.find((item) => item.instanceId === selectedInstanceId);
    if (!placement) return;
    const definition = moduleMap.get(placement.moduleId);
    if (!definition?.allowRotation) return setNotice("这个模块被设置为不可旋转。");
    const rotation = nextRotation(placement.orientation.rotation, true);
    const validation = validatePlacement({
      board,
      module: definition,
      origin: placement.origin,
      rotation,
      placements,
      modules,
      ignoreInstanceId: placement.instanceId,
      isNew: false,
    });
    if (!validation.valid) return setNotice(`${ERROR_LABELS[validation.errors[0]]}，无法在当前位置旋转。`);
    setPlacements((items) => items.map((item) => item.instanceId === placement.instanceId
      ? { ...item, orientation: { ...item.orientation, rotation } }
      : item));
    setNotice(`模块已旋转至 ${rotation}°。`);
  }, [board, moduleMap, modules, placements, selectedInstanceId]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select") || mode !== "assembly") return;
      if (event.key === "Delete" || event.key === "Backspace") deleteSelected();
      if (event.key.toLowerCase() === "r") rotateSelected();
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  }, [deleteSelected, mode, rotateSelected]);

  const applyBoardChange = (nextBoard: BoardDefinition, shouldRecordHistory = false): boolean => {
    const invalidatesPlacements = nextBoard.id !== board.id || placementsRef.current.some((placement) => {
      const module = moduleMap.get(placement.moduleId);
      if (!module) return true;
      return getPlacementCells(module, placement.origin, placement.orientation.rotation).some((cell) =>
        cell.x < 0
        || cell.y < 0
        || cell.x >= nextBoard.width
        || cell.y >= nextBoard.height
        || nextBoard.mask[cell.y]?.[cell.x] !== 1);
    });
    if (placementsRef.current.length > 0 && invalidatesPlacements) {
      const confirmed = window.confirm("这次棋盘修改会使当前模块失效并清空配装。修改前状态会保存在棋盘历史中，是否继续？");
      if (!confirmed) return false;
    }
    if (shouldRecordHistory && enableLocalPersistence) {
      try {
        setBoardHistory(recordBoardHistory(requirePersistenceStorage(), board, placementsRef.current, lockedPlacementIds));
      } catch {
        setNotice("棋盘仍可修改，但自动历史保存失败，请先保存当前棋盘或导出 JSON。");
      }
    }
    if (placementsRef.current.length > 0 && invalidatesPlacements) {
      placementsRef.current = [];
      setPlacements([]);
      setLockedPlacementIds(new Set());
      setSelectedInstanceId(null);
      setNotice("棋盘已更新，原配装已清空。");
    }
    setBoard(nextBoard);
    return true;
  };

  const validateCurrentBoardSelectionMove = useCallback((selectedCells: GridPoint[], deltaX: number, deltaY: number) => (
    validateBoardSelectionMove({ board, modules, placements: placementsRef.current, selectedCells, deltaX, deltaY })
  ), [board, modules]);

  const moveCurrentBoardSelection = useCallback((selectedCells: GridPoint[], deltaX: number, deltaY: number): boolean => {
    const input = { board, modules, placements: placementsRef.current, selectedCells, deltaX, deltaY };
    const validation = validateBoardSelectionMove(input);
    if (!validation.valid) {
      setNotice(validation.error ? SELECTION_MOVE_ERROR_LABELS[validation.error] : "选中区域无法移动到目标位置。");
      return false;
    }
    const translated = translateBoardSelection(input);
    if (!translated) return false;
    let historySaved = true;
    if (enableLocalPersistence) {
      try {
        setBoardHistory(recordBoardHistory(requirePersistenceStorage(), board, placementsRef.current, lockedPlacementIds));
      } catch {
        historySaved = false;
      }
    }
    placementsRef.current = translated.placements;
    setBoard(translated.board);
    setPlacements(translated.placements);
    const direction = [
      deltaY < 0 ? `上 ${Math.abs(deltaY)} 格` : deltaY > 0 ? `下 ${deltaY} 格` : "",
      deltaX < 0 ? `左 ${Math.abs(deltaX)} 格` : deltaX > 0 ? `右 ${deltaX} 格` : "",
    ].filter(Boolean).join("、");
    setNotice(historySaved
      ? `已将选中的 ${selectedCells.length} 个格及其中模块向${direction}移动。`
      : `选中区域已向${direction}移动，但移动前的历史快照保存失败。`);
    return true;
  }, [board, enableLocalPersistence, lockedPlacementIds, modules, requirePersistenceStorage]);

  const saveCurrentBoard = async () => {
    if (!enableLocalPersistence) return;
    try {
      const storage = requirePersistenceStorage();
      const saved = saveBoardToLibrary(storage, board, false);
      setSavedBoards(saved.savedBoards);
      setBoard(saved.board);
      await storage.flush();
      setNotice(currentBoardIsSaved
        ? `已保存棋盘“${saved.board.name}”的修改。`
        : `已创建棋盘“${saved.board.name}”，现在可以在工作台中选择使用。`);
    } catch (error) {
      setNotice(`棋盘尚未写入本机文件：${error instanceof Error ? error.message : "保存失败"}。内容仍保留在内存中，可重试。`);
    }
  };

  const createNewBoard = () => {
    const currentSaved = savedBoards.find((entry) => entry.board.id === board.id);
    const boardHasUnsavedChanges = !currentSaved || JSON.stringify(currentSaved.board) !== JSON.stringify(board);
    if ((boardHasUnsavedChanges || (activeFittingId && fittingDirty)) && !window.confirm("当前棋盘或配装有未保存修改，确定新建棋盘并放弃这些修改吗？")) return;
    const emptyBoard: BoardDefinition = {
      id: `board-${crypto.randomUUID()}`,
      name: "新棋盘",
      width: 20,
      height: 20,
      mask: Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => 0 as const)),
    };
    setBoard(emptyBoard);
    setPlacements([]);
    placementsRef.current = [];
    setLockedPlacementIds(new Set());
    setActiveFittingId(null);
    setFittingName("");
    setFittingDescription("");
    clearCurrentSolverResult();
    setMode("board");
    setNotice("已建立新棋盘草稿，请命名、绘制并点击“创建并保存棋盘”。");
  };

  const loadSavedBoardById = (boardId: string) => {
    const saved = savedBoards.find((entry) => entry.board.id === boardId);
    if (!saved || saved.board.id === board.id) return;
    const currentSaved = savedBoards.find((entry) => entry.board.id === board.id);
    const boardHasUnsavedChanges = !currentSaved || JSON.stringify(currentSaved.board) !== JSON.stringify(board);
    if ((boardHasUnsavedChanges || (activeFittingId && fittingDirty)) && !window.confirm("当前棋盘或配装有未保存修改，确定切换棋盘吗？")) return;
    if (applyBoardChange(cloneBoard(saved.board), true)) {
      setActiveFittingId(null);
      setFittingName("");
      setFittingDescription("");
      setSolverRules(modules.map(createDefaultSolverRule));
      setSolveScope("fill-current");
      clearCurrentSolverResult();
      setNotice(`已进入棋盘“${saved.board.name}”的工作区，仅显示该棋盘下的配装。`);
    }
  };

  const removeSavedBoard = async (boardId: string) => {
    const saved = savedBoards.find((entry) => entry.board.id === boardId);
    if (!saved) return;
    const fittingCount = savedFittings.filter((entry) => entry.boardId === boardId).length;
    if (!window.confirm(`确定从棋盘库删除“${saved.board.name}”吗？${fittingCount ? `其下 ${fittingCount} 个命名配装也会删除；` : ""}当前工作台内容会保留。`)) return;
    let storage: FilePersistenceStorage;
    try {
      storage = requirePersistenceStorage();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "本机存储服务尚未连接。");
      return;
    }
    setSavedBoards(deleteSavedBoard(storage, boardId));
    setSavedFittings(deleteSavedFittingsForBoard(storage, boardId));
    if (board.id === boardId) {
      setActiveFittingId(null);
      setFittingName("");
      setFittingDescription("");
      setPlacements([]);
      placementsRef.current = [];
      setLockedPlacementIds(new Set());
      clearCurrentSolverResult();
    }
    try {
      await storage.flush();
      setNotice(`已从棋盘库删除“${saved.board.name}”及其命名配装；请在棋盘编辑中创建或选择棋盘。`);
    } catch (error) {
      setNotice(`删除结果尚未写入本机文件：${error instanceof Error ? error.message : "保存失败"}。当前内存状态已保留，可重试保存。`);
    }
  };

  const restoreBoardHistory = async (entryId: string) => {
    const entry = boardHistory.find((item) => item.id === entryId);
    if (!entry || !window.confirm(`恢复 ${new Date(entry.savedAt).toLocaleString()} 的棋盘和配装快照吗？当前状态也会先写入历史。`)) return;
    try {
      const storage = requirePersistenceStorage();
      setBoardHistory(recordBoardHistory(storage, board, placementsRef.current, lockedPlacementIds));
      await storage.flush();
    } catch {
      setNotice("恢复前的当前状态未能写入历史，本次恢复已取消。");
      return;
    }
    const accepted: PlacedModuleData[] = [];
    for (const placement of clonePlacements(entry.placements)) {
      const module = moduleMap.get(placement.moduleId);
      if (!module) continue;
      const validation = validatePlacement({
        board: entry.board,
        module,
        origin: placement.origin,
        rotation: placement.orientation.rotation,
        placements: accepted,
        modules,
        isNew: true,
      });
      if (validation.valid) accepted.push(placement);
    }
    setBoard(cloneBoard(entry.board));
    setPlacements(accepted);
    placementsRef.current = accepted;
    const acceptedIds = new Set(accepted.map((placement) => placement.instanceId));
    setLockedPlacementIds(new Set(entry.lockedPlacementIds.filter((id) => acceptedIds.has(id))));
    setSelectedInstanceId(null);
    setNotice(accepted.length === entry.placements.length
      ? `已恢复棋盘“${entry.board.name}”及 ${accepted.length} 个模块。`
      : `已恢复棋盘；${entry.placements.length - accepted.length} 个因模块变化而失效的摆放未恢复。`);
  };

  const clearCurrentBoardHistory = async () => {
    if (!window.confirm(`确定清空棋盘“${board.name}”的自动恢复历史吗？已保存棋盘不会受影响。`)) return;
    try {
      const storage = requirePersistenceStorage();
      clearBoardHistory(storage, board.id);
      setBoardHistory(loadBoardHistory(storage));
      await storage.flush();
      setNotice(`已清空棋盘“${board.name}”的自动恢复历史。`);
    } catch (error) {
      setNotice(`棋盘历史清理尚未写入本机文件：${error instanceof Error ? error.message : "保存失败"}。可稍后重试。`);
    }
  };

  const clearCurrentSolverResult = () => {
    solverResultRef.current = null;
    solverResultFingerprintRef.current = null;
    setSolverResult(null);
  };

  const saveCurrentFitting = async () => {
    if (!enableLocalPersistence) {
      setNotice("组件内本地存储已关闭，无法使用配装库；仍可导出 JSON。");
      return;
    }
    if (!activeFittingId) return setNotice("请先从左侧选择或新建配装。");
    if (!currentBoardIsSaved) {
      setNotice("请先把当前棋盘保存到棋盘库，再保存其下的命名配装。");
      return;
    }
    try {
      const storage = requirePersistenceStorage();
      const saved = saveFittingToLibrary(storage, fittingSaveInput, false);
      setSavedFittings(saved.entries);
      setActiveFittingId(saved.entry.id);
      setFittingName(saved.entry.name);
      setFittingDescription(saved.entry.description);
      await storage.flush();
      setNotice(`已保存配装“${saved.entry.name}”的修改。`);
    } catch (error) {
      setNotice(error instanceof Error ? `配装尚未写入本机文件：${error.message}。当前内容仍在内存中，可重试。` : "配装保存失败，当前内容仍在内存中。");
    }
  };

  const loadSavedFittingById = (fittingId: string) => {
    const entry = currentBoardFittings.find((item) => item.id === fittingId);
    if (!entry || entry.id === activeFittingId) return;
    if (fittingDirty && !window.confirm(`当前配装“${fittingName || "未命名配装"}”有未保存修改，确定载入“${entry.name}”吗？`)) return;
    const nextPlacements: PlacedModuleData[] = [];
    for (const placement of clonePlacements(entry.placements)) {
      const module = moduleMap.get(placement.moduleId);
      if (!module) continue;
      const validation = validatePlacement({
        board,
        module,
        origin: placement.origin,
        rotation: placement.orientation.rotation,
        placements: nextPlacements,
        modules,
        isNew: true,
      });
      if (validation.valid) nextPlacements.push(placement);
    }
    const ruleMap = new Map(entry.solverSettings.rules.map((rule) => [rule.moduleId, rule]));
    const nextRules = modules.map((module) => {
      const saved = ruleMap.get(module.id) ?? createDefaultSolverRule(module);
      const requiredCount = Math.min(module.availableQuantity, Math.max(0, saved.requiredCount));
      return {
        ...saved,
        requiredCount,
        maxCount: Math.min(module.availableQuantity, Math.max(requiredCount, saved.maxCount)),
      };
    });
    const validPlacementIds = new Set(nextPlacements.map((placement) => placement.instanceId));
    setPlacements(nextPlacements);
    placementsRef.current = nextPlacements;
    setSolverRules(nextRules);
    setSolveScope(entry.solverSettings.scope);
    setSolverTimeLimit(entry.solverSettings.timeLimitMs);
    setSolverWorkerSetting(clampSolverWorkerSetting(entry.solverSettings.searchWorkers, browserLogicalCpuCount));
    setLockedPlacementIds(new Set(entry.solverSettings.lockedPlacementIds.filter((id) => validPlacementIds.has(id))));
    setActiveFittingId(entry.id);
    setFittingName(entry.name);
    setFittingDescription(entry.description);
    setSelectedInstanceId(null);
    setEditingModuleId(null);
    clearCurrentSolverResult();
    const omitted = entry.placements.length - nextPlacements.length;
    setNotice(omitted === 0
      ? `已载入当前棋盘的配装“${entry.name}”：${nextPlacements.length} 个模块。`
      : `已载入“${entry.name}”；${omitted} 个因模块或棋盘变化而失效的摆放已跳过。`);
  };

  const openCreateFitting = () => {
    if (!currentBoardIsSaved) return setNotice("请先在棋盘编辑中创建并保存棋盘。");
    if (fittingDirty && activeFittingId && !window.confirm(`当前配装“${fittingName}”有未保存修改，确定新建配装吗？`)) return;
    setProfileName("");
    setProfileDescription("");
    setFittingDialogMode("create");
  };

  const openEditFittingProfile = () => {
    if (!activeFittingId) return;
    setProfileName(fittingName);
    setProfileDescription(fittingDescription);
    setFittingDialogMode("edit");
  };

  const confirmFittingProfile = async () => {
    const name = profileName.trim();
    if (!name || !currentBoardIsSaved) return;
    let storage: FilePersistenceStorage;
    try {
      storage = requirePersistenceStorage();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "本机存储服务尚未连接。");
      return;
    }
    if (fittingDialogMode === "create") {
      const emptyPlacements: PlacedModuleData[] = [];
      const defaultRules = modules.map(createDefaultSolverRule);
      const saved = saveFittingToLibrary(storage, {
        activeFittingId: null,
        boardId: board.id,
        name,
        description: profileDescription.trim(),
        placements: emptyPlacements,
        solverSettings: {
          rules: defaultRules,
          scope: "fill-current",
          timeLimitMs: solverTimeLimit,
          searchWorkers: createDefaultSolverWorkerSetting(),
          lockedPlacementIds: [],
        },
      }, true);
      setSavedFittings(saved.entries);
      setActiveFittingId(saved.entry.id);
      setFittingName(saved.entry.name);
      setFittingDescription(saved.entry.description);
      setPlacements(emptyPlacements);
      placementsRef.current = emptyPlacements;
      setLockedPlacementIds(new Set());
      setSolverRules(defaultRules);
      setSolveScope("fill-current");
      setSolverWorkerSetting(createDefaultSolverWorkerSetting());
      setSelectedInstanceId(null);
      clearCurrentSolverResult();
      try {
        await storage.flush();
      } catch (error) {
        setNotice(`新配装仍保留在内存中，但尚未写入本机文件：${error instanceof Error ? error.message : "保存失败"}。`);
        setFittingDialogMode(null);
        return;
      }
      setNotice(`已创建配装“${saved.entry.name}”，现在可以开始搭配或自动求解。`);
    } else if (fittingDialogMode === "edit" && activeFittingId) {
      const saved = updateSavedFittingProfile(storage, activeFittingId, name, profileDescription);
      setSavedFittings(saved.entries);
      setFittingName(saved.entry.name);
      setFittingDescription(saved.entry.description);
      try {
        await storage.flush();
      } catch (error) {
        setNotice(`资料修改仍保留在内存中，但尚未写入本机文件：${error instanceof Error ? error.message : "保存失败"}。`);
        setFittingDialogMode(null);
        return;
      }
      setNotice(`已更新配装“${saved.entry.name}”的名称与说明。`);
    }
    setFittingDialogMode(null);
  };

  const removeCurrentFitting = async () => {
    if (!activeFittingId || !activeSavedFitting) return;
    if (!window.confirm(`确定删除配装“${activeSavedFitting.name}”吗？其当前布局也会一并移除。`)) return;
    let storage: FilePersistenceStorage;
    try {
      storage = requirePersistenceStorage();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "本机存储服务尚未连接。");
      return;
    }
    setSavedFittings(deleteSavedFitting(storage, activeFittingId));
    setActiveFittingId(null);
    setFittingName("");
    setFittingDescription("");
    setPlacements([]);
    placementsRef.current = [];
    setLockedPlacementIds(new Set());
    setSelectedInstanceId(null);
    clearCurrentSolverResult();
    try {
      await storage.flush();
      setNotice(`已删除配装“${activeSavedFitting.name}”，请从左侧选择或新建配装。`);
    } catch (error) {
      setNotice(`删除结果尚未写入本机文件：${error instanceof Error ? error.message : "保存失败"}。当前内存状态已保留。`);
    }
  };

  const saveModule = (definition: ModuleDefinition) => {
    const exists = modules.some((module) => module.id === definition.id);
    const used = placements.some((placement) => placement.moduleId === definition.id);
    if (used && !window.confirm("修改模块形状会移除棋盘上该模块的现有实例。是否继续？")) return;
    setModules((items) => exists
      ? items.map((module) => module.id === definition.id ? definition : module)
      : [...items, definition]);
    if (used) {
      setPlacements((items) => items.filter((placement) => placement.moduleId !== definition.id));
      setLockedPlacementIds((items) => new Set([...items].filter((id) => placements.some((placement) => placement.instanceId === id && placement.moduleId !== definition.id))));
      setSelectedInstanceId(null);
    }
    setEditingModuleId(null);
    setMode("assembly");
    setNotice(exists ? `已保存“${definition.name}”的修改。` : `已创建“${definition.name}”，现在可以从左侧拖入棋盘。`);
  };

  const beginModuleEdit = (moduleId: string | null) => {
    setEditingModuleId(moduleId);
    setMode("module");
  };

  const clearBuild = () => {
    if (placements.length === 0 || window.confirm("确定清空棋盘上的全部模块吗？")) {
      setPlacements([]);
      setLockedPlacementIds(new Set());
      setSelectedInstanceId(null);
      setNotice("当前配装已清空。");
    }
  };

  const exportFitting = () => {
    const json = serializeFittingDocument(createFittingDocument(board, modules, placements));
    const blob = new Blob([json], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${board.name.replace(/[\\/:*?"<>|]/g, "-") || "ship-fitting"}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice("已导出包含棋盘、模块定义和摆放结果的纯 JSON 文件。");
  };

  const importFitting = (json: string) => {
    try {
      const imported = parseFittingDocument(json);
      if (fittingWorkspaceReady && hasMatchingFittingDefinitions(board, modules, imported)) {
        setPlacements(imported.build.placements);
        placementsRef.current = imported.build.placements;
        setLockedPlacementIds(new Set());
        clearCurrentSolverResult();
        setSelectedInstanceId(null);
        setEditingModuleId(null);
        setMode("assembly");
        setNotice(`已将“${imported.build.name}”导入当前配装，确认后请保存当前配装。`);
        return;
      }
      setBoard(imported.board);
      setModules(imported.modules);
      setPlacements(imported.build.placements);
      placementsRef.current = imported.build.placements;
      setLockedPlacementIds(new Set());
      setSolverRules(imported.modules.map(createDefaultSolverRule));
      setSolveScope("fill-current");
      setActiveFittingId(null);
      setFittingName("");
      setFittingDescription("");
      clearCurrentSolverResult();
      setSelectedInstanceId(null);
      setEditingModuleId(null);
      setMode("board");
      setNotice(`已导入“${imported.build.name}”作为棋盘草稿，请先在棋盘编辑中确认并保存。`);
    } catch (error) {
      setNotice(error instanceof Error ? `导入失败：${error.message}` : "导入失败：文件内容无效。");
    }
  };

  const updateSolverRule = (moduleId: string, patch: Partial<ModuleSolverRule>) => {
    const module = moduleMap.get(moduleId);
    if (!module) return;
    setSolverRules((rules) => rules.map((rule) => {
      if (rule.moduleId !== moduleId) return rule;
      const requiredCount = Math.min(module.availableQuantity, Math.max(0, Math.trunc(patch.requiredCount ?? rule.requiredCount)));
      const maxCount = Math.min(
        module.availableQuantity,
        Math.max(requiredCount, Math.trunc(patch.maxCount ?? rule.maxCount)),
      );
      return { ...rule, ...patch, requiredCount, maxCount };
    }));
  };

  const toggleSelectedLock = () => {
    if (!selectedInstanceId) return;
    setLockedPlacementIds((current) => {
      const next = new Set(current);
      if (next.has(selectedInstanceId)) next.delete(selectedInstanceId);
      else next.add(selectedInstanceId);
      return next;
    });
    setNotice(lockedPlacementIds.has(selectedInstanceId) ? "已解除自动配装锁定。" : "已锁定模块，自动重排时位置将保持不变。");
  };

  const persistRunSolution = (run: ActiveSolverRun, solution: SolverSolution, proof?: OptimalityProofInput) => {
    if (!enableLocalPersistence) return;
    try {
      const storage = requirePersistenceStorage();
      const entries = saveSolutionToHistory(storage, run.fingerprint, solution, run.context, new Date().toISOString(), proof);
      if (buildFingerprintRef.current === run.fingerprint) setHistoryEntries(entries);
      void storage.flush().catch((error) => {
        setNotice(`当前方案仍然保留在内存中，但历史前五尚未写入本机文件：${error instanceof Error ? error.message : "保存失败"}。`);
      });
    } catch {
      setNotice("当前方案仍然保留在内存中，但历史前五尚未写入本机文件；可重试保存或先导出 JSON。");
    }
  };

  const isTerminalSolverStatus = (status: SolverJobSnapshot["status"]) =>
    ["completed", "time-limit", "stopped", "infeasible", "error"].includes(status);

  const handleSolverSnapshot = (run: ActiveSolverRun, snapshot: SolverJobSnapshot) => {
    if (activeSolverRunRef.current !== run) return;
    const reconciled = reconcileSolverSnapshot(snapshot, run.bestSolution, run.layoutContext);
    const merged = reconciled.snapshot;
    const candidate = reconciled.candidate;
    run.bestSolution = merged.bestSolution;
    if (candidate) {
      const signature = createSolutionSignature(candidate.placements);
      if (signature !== run.lastPersistedSignature) {
        run.lastPersistedSignature = signature;
        persistRunSolution(run, candidate);
      }
    }
    const bestSolution = merged.bestSolution;
    solverResultRef.current = merged;
    solverResultFingerprintRef.current = run.fingerprint;
    solverResultProblemSignatureRef.current = createOptimalityProblemSignature(run.layoutContext);
    setSolverResult(merged);
    if (!isTerminalSolverStatus(snapshot.status)) return;
    const proofMatchesCurrentModel = run.scope === "rearrange-unlocked"
      || (run.scope === "empty-board" && run.context.lockedPlacements.length === 0);
    if (
      merged.provenOptimal
      && bestSolution
      && snapshot.bestBound === bestSolution.totalScore
      && proofMatchesCurrentModel
    ) {
      persistRunSolution(run, bestSolution, {
        score: bestSolution.totalScore,
        bestBound: snapshot.bestBound,
      });
    }
    solverPollAbortRef.current?.abort();
    solverPollAbortRef.current = null;
    activeSolverRunRef.current = null;
    setSolving(false);
    setSolveDeadline(null);
    setRemainingSolveMs(0);
    setElapsedSolveMs(snapshot.elapsedMs);
    void persistWorkspaceNow(false);
    if (bestSolution) {
      const prefix = snapshot.status === "stopped" ? "已停止计算并保留当前最佳" : merged.provenOptimal ? "CP-SAT 已证明最优" : "CP-SAT 已返回当前最佳";
      setNotice(`${prefix}：${bestSolution.totalScore.toLocaleString()} 分。`);
    } else if (snapshot.status === "infeasible") {
      setNotice("CP-SAT 已证明当前必备、锁定和空间约束无可行方案。");
    } else {
      setNotice("本地 CP-SAT 服务未返回可用方案，请查看自动配装区域的错误信息。");
    }
  };

  const pollSolverJob = async (run: ActiveSolverRun) => {
    const controller = new AbortController();
    solverPollAbortRef.current = controller;
    try {
      while (!controller.signal.aborted && activeSolverRunRef.current === run) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        if (controller.signal.aborted || !run.jobId) continue;
        const snapshot = await getSolverJob(run.jobId, controller.signal);
        handleSolverSnapshot(run, snapshot);
        if (isTerminalSolverStatus(snapshot.status)) break;
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = `本地 CP-SAT 服务连接中断：${error instanceof Error ? error.message : "连接失败"}。请运行 start-dev.bat。`;
      const failed = createSolverErrorSnapshot(solverResultRef.current, message, Date.now() - run.startedAt);
      solverResultRef.current = failed;
      solverResultFingerprintRef.current = run.fingerprint;
      setSolverResult(failed);
      activeSolverRunRef.current = null;
      setSolving(false);
      setSolveDeadline(null);
      setRemainingSolveMs(0);
      setNotice(`${message} 当前最佳结果仍已保留。`);
    }
  };

  const cancelSolver = async () => {
    const run = activeSolverRunRef.current;
    if (!run || run.stopRequested) return;
    run.stopRequested = true;
    setNotice("正在请求 CP-SAT 停止；停止前找到的最佳方案会继续保留。");
    if (!run.jobId) return;
    try {
      const snapshot = await stopSolverJob(run.jobId);
      handleSolverSnapshot(run, snapshot);
    } catch (error) {
      setNotice(`停止请求失败：${error instanceof Error ? error.message : "本地服务连接失败"}。当前最佳结果仍已保留。`);
    }
  };

  const runSolver = async () => {
    solverPollAbortRef.current?.abort();
    if (solverResultFingerprintRef.current !== buildFingerprint) {
      solverResultRef.current = null;
      solverResultFingerprintRef.current = null;
      setSolverResult(null);
    }
    const storage = persistenceStorageRef.current;
    const currentHistory = enableLocalPersistence && storage
      ? loadSolutionHistory(storage, buildFingerprint, historyContext)
      : [];
    setHistoryEntries(currentHistory);
    const layoutContext: SolverLayoutContext = {
      ...historyContext,
      lockedPlacements: clonePlacements(solveScope === "empty-board" ? []
        : solveScope === "fill-current" ? placements : lockedPlacements),
    };
    const historicalBest = currentHistory.find((entry) => entry.valid
      && validateSolverLayout(layoutContext, entry.currentSolution.placements).valid)?.currentSolution ?? null;
    const softSkeletonTrainingLayouts = enableLocalPersistence && storage
      ? loadSoftSkeletonTrainingLayouts(storage, buildFingerprint, historyContext)
      : [];
    const runContext: HistoryValidationContext = {
      board: cloneBoard(board),
      modules: cloneModules(modules),
      rules: solverRules.map((rule) => ({ ...rule })),
      lockedPlacements: clonePlacements(lockedPlacements),
    };
    const run: ActiveSolverRun = {
      jobId: "",
      fingerprint: buildFingerprint,
      context: runContext,
      layoutContext: { ...runContext, lockedPlacements: layoutContext.lockedPlacements },
      startedAt: Date.now(),
      bestSolution: historicalBest,
      lastPersistedSignature: historicalBest ? createSolutionSignature(historicalBest.placements) : "",
      stopRequested: false,
      scope: solveScope,
    };
    activeSolverRunRef.current = run;
    setSolving(true);
    setElapsedSolveMs(0);
    const requestedTimeLimit = solverTimeLimit;
    setRemainingSolveMs(requestedTimeLimit);
    setSolveDeadline(requestedTimeLimit === null ? null : Date.now() + requestedTimeLimit);
    setNotice("正在连接本机 CP-SAT 服务并建立完整棋盘模型。");
    const request: SolverApiRequest = {
      board: cloneBoard(board),
      modules: cloneModules(modules),
      moduleRules: solverRules.map((rule) => ({ ...rule })),
      scope: solveScope,
      lockedPlacements: clonePlacements(lockedPlacements),
      currentLayout: clonePlacements(placements),
      historyBestLayout: historicalBest ? clonePlacements(historicalBest.placements) : null,
      problemFingerprint: buildFingerprint,
      softSkeletonTrainingLayouts,
      searchWorkers: { ...solverWorkerSetting },
      timeLimitMs: requestedTimeLimit,
    };
    try {
      const snapshot = await startSolverJob(request);
      if (activeSolverRunRef.current !== run) return;
      run.jobId = snapshot.jobId;
      handleSolverSnapshot(run, snapshot);
      if (run.stopRequested && !isTerminalSolverStatus(snapshot.status)) {
        handleSolverSnapshot(run, await stopSolverJob(run.jobId));
      }
      if (!isTerminalSolverStatus(snapshot.status)) void pollSolverJob(run);
    } catch (error) {
      if (activeSolverRunRef.current !== run) return;
      const message = `无法连接本机 CP-SAT 服务：${error instanceof Error ? error.message : "连接失败"}。请运行 start-dev.bat。`;
      const previous = solverResultFingerprintRef.current === buildFingerprint ? solverResultRef.current : null;
      const failed = createSolverErrorSnapshot(previous, message, Date.now() - run.startedAt);
      solverResultRef.current = failed;
      solverResultFingerprintRef.current = buildFingerprint;
      setSolverResult(failed);
      setSolving(false);
      setSolveDeadline(null);
      setRemainingSolveMs(0);
      activeSolverRunRef.current = null;
      setNotice(message);
    }
  };

  const applySolverSolution = (solution: SolverSolution, context: SolverLayoutContext = {
      ...historyContext,
      lockedPlacements: solveScope === "empty-board" ? []
        : solveScope === "fill-current" ? placements : lockedPlacements,
    }) => {
    const validation = validateSolverSolution(solution, context);
    if (!validation.valid) {
      setMode("solver");
      setNotice(`该方案不满足当前棋盘、模块或数量规则，请重新计算：${validation.reasons.join("；")}`);
      return;
    }
    const nextPlacements = clonePlacements(validation.solution.placements);
    const nextIds = new Set(nextPlacements.map((placement) => placement.instanceId));
    setPlacements(nextPlacements);
    placementsRef.current = nextPlacements;
    setLockedPlacementIds((current) => new Set([...current].filter((id) => nextIds.has(id))));
    setSelectedInstanceId(null);
    setMode("assembly");
    setNotice(`已应用自动配装方案：占用 ${solution.occupiedCells} 格，利用率 ${Math.round(solution.utilization * 100)}%。`);
  };

  const applyHistoryEntry = (entry: ValidatedSolutionHistoryEntry) => {
    if (!entry.valid) {
      setNotice(`该历史方案已经失效：${entry.reasons.join("；")}`);
      return;
    }
    const solution = JSON.parse(JSON.stringify(entry.currentSolution)) as SolverSolution;
    for (const locked of lockedPlacements) {
      const historical = solution.placements.find((placement) =>
        placement.moduleId === locked.moduleId
        && placement.origin.x === locked.origin.x
        && placement.origin.y === locked.origin.y
        && placement.orientation.rotation === locked.orientation.rotation);
      if (historical) historical.instanceId = locked.instanceId;
    }
    applySolverSolution(solution, historyContext);
  };

  const deleteHistoryEntry = async (entryId: string) => {
    try {
      const storage = requirePersistenceStorage();
      deleteSolutionHistoryEntry(storage, buildFingerprint, entryId);
      refreshHistory();
      await storage.flush();
      setNotice("已删除一条当前型号历史方案。");
    } catch (error) {
      setNotice(`历史删除结果尚未写入本机文件：${error instanceof Error ? error.message : "保存失败"}。当前内存状态已保留。`);
    }
  };

  const clearCurrentHistory = async () => {
    if (!window.confirm("确定清空当前配装型号的全部历史方案吗？")) return;
    try {
      const storage = requirePersistenceStorage();
      clearSolutionHistory(storage, buildFingerprint);
      refreshHistory();
      await storage.flush();
      setNotice("已清空当前配装型号的历史方案。");
    } catch (error) {
      setNotice(`历史清理结果尚未写入本机文件：${error instanceof Error ? error.message : "保存失败"}。当前内存状态已保留。`);
    }
  };

  const preview = drag?.origin && drag.validation
    ? { cells: drag.validation.occupiedCells, valid: drag.validation.valid }
    : null;
  const draggingModule = drag ? moduleMap.get(drag.moduleId) : null;
  const draggingShape = draggingModule && drag ? getOrientedShape(draggingModule, drag.rotation) : null;
  const persistenceReadBlocked = enableLocalPersistence && !persistenceReady;

  return (
    <>
      {persistenceReadBlocked && (
        <section className="persistence-gate" role="alert">
          <strong>{persistenceReadError ? "本机存档读取失败" : "正在读取本机存档"}</strong>
          <span>{persistenceReadError ? `${persistenceReadError}。读取成功前不会保存或允许修改业务数据。` : "读取完成前业务数据保持只读。"}</span>
          {persistenceReadError && <button className="primary-button" type="button" onClick={() => void readPersistence(false)}>重新读取</button>}
        </section>
      )}
      {persistenceConflict && !persistenceReadBlocked && (
        <section className="persistence-gate is-conflict" role="alert">
          <strong>本机存档发生 revision 冲突</strong>
          <span>另一个页面已经修改本机存档，当前内存修改仍保留；请先导出当前内容，再重新载入磁盘存档。</span>
          <button className="danger-button" type="button" onClick={() => void readPersistence(true)}>重新载入磁盘存档</button>
        </section>
      )}
      <main className={`app${drag ? " is-dragging" : ""}`} inert={persistenceReadBlocked ? true : undefined}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><span /><span /><span /></div>
          <div><span className="brand-kicker">FRONTIER FIT LAB</span><h1>舰装格局</h1></div>
          <em>{APP_VERSION_LABEL} · MANUAL + AUTO FITTING</em>
        </div>
        <nav className="mode-tabs" aria-label="工作模式">
          <button className={mode === "assembly" ? "is-active" : ""} onClick={() => setMode("assembly")}><span>01</span>配装工作台</button>
          <button className={mode === "board" ? "is-active" : ""} onClick={() => setMode("board")}><span>02</span>棋盘编辑</button>
          <button className={mode === "module" ? "is-active" : ""} onClick={() => beginModuleEdit(null)}><span>03</span>模块绘制</button>
          <button className={mode === "solver" ? "is-active" : ""} onClick={() => setMode("solver")}><span>04</span>自动配装</button>
        </nav>
        <div className="local-badge"><i /> 本地工作区</div>
      </header>

      <FittingLibraryBar
        name={fittingName}
        description={fittingDescription}
        active={activeFittingId !== null}
        dirty={fittingDirty}
        saveStatus={saveStatus}
        disabled={solving || !enableLocalPersistence || !persistenceReady || saveStatus === "loading" || saveStatus === "saving"}
        onSave={saveCurrentFitting}
        onEdit={openEditFittingProfile}
        onDelete={removeCurrentFitting}
      />

      <div className="workspace">
        <div className="left-workspace-column">
          <WorkspaceSelector
            board={board}
            boardIsSaved={currentBoardIsSaved}
            savedBoards={savedBoards}
            fittings={currentBoardFittings}
            activeFittingId={activeFittingId}
            disabled={solving || !enableLocalPersistence || !persistenceReady || saveStatus === "loading" || saveStatus === "saving"}
            onBoardSelect={loadSavedBoardById}
            onFittingSelect={loadSavedFittingById}
            onNewFitting={openCreateFitting}
            onOpenBoardEditor={() => setMode("board")}
          />
          <ModuleList
            modules={modules}
            placements={placements}
            assemblyMode={mode === "assembly" && fittingWorkspaceReady}
            onStartDrag={startPaletteDrag}
            onEdit={(id) => beginModuleEdit(id)}
            onCreate={() => beginModuleEdit(null)}
          />
        </div>

        <section className="center-panel">
          {mode === "assembly" && (
            fittingWorkspaceReady ? <>
              <div className="canvas-heading">
                <div><span className="eyebrow">ASSEMBLY GRID</span><h2>{fittingName || "未命名配装"}</h2><small className="canvas-hull-name">船体：{board.name}</small></div>
                <div className={`interaction-status${drag?.validation && !drag.validation.valid ? " is-error" : ""}`}>
                  <i />
                  <span>{drag?.validation && !drag.validation.valid ? ERROR_LABELS[drag.validation.errors[0]] : notice}</span>
                </div>
              </div>
              <div className="board-stage" onPointerDown={(event) => {
                if (event.target === event.currentTarget) setSelectedInstanceId(null);
              }}>
                <Board
                  ref={boardRef}
                  board={board}
                  modules={modules}
                  placements={placements}
                  selectedInstanceId={selectedInstanceId}
                  lockedPlacementIds={lockedPlacementIds}
                  hiddenInstanceId={drag?.source === "board" ? drag.instanceId : undefined}
                  preview={preview}
                  onPlacedPointerDown={startPlacedDrag}
                />
              </div>
              <div className="canvas-footer">
                <span><i className="legend-cell active" /> 有效格</span>
                <span><i className="legend-cell inactive" /> 不可用区域</span>
                <span><i className="legend-cell preview-ok" /> 可放置</span>
                <span><i className="legend-cell preview-bad" /> 冲突</span>
                <strong>网格单位 {BOARD_CELL} PX · 数据坐标为整数</strong>
              </div>
            </> : <div className="workspace-empty-state"><span className="eyebrow">ASSEMBLY GRID</span><h2>先选择棋盘与配装</h2><p>棋盘需要在“棋盘编辑”中创建；随后从左侧选择棋盘，并新建或选择一个配装。</p></div>
          )}
          {mode === "board" && (
            <BoardEditor
              board={board}
              boardIsSaved={currentBoardIsSaved}
              savedBoards={savedBoards}
              history={currentBoardHistory}
              onChange={applyBoardChange}
              onCreateBoard={createNewBoard}
              onSaveBoard={saveCurrentBoard}
              onLoadSavedBoard={loadSavedBoardById}
              onDeleteSavedBoard={removeSavedBoard}
              onRestoreHistory={restoreBoardHistory}
              onClearHistory={clearCurrentBoardHistory}
              onValidateSelectionMove={validateCurrentBoardSelectionMove}
              onMoveSelection={moveCurrentBoardSelection}
            />
          )}
          {mode === "module" && (
            <ModuleEditor
              module={editingModuleId ? moduleMap.get(editingModuleId) ?? null : null}
              onSave={saveModule}
              onCancel={() => { setEditingModuleId(null); setMode("assembly"); }}
            />
          )}
          {mode === "solver" && (
            fittingWorkspaceReady ? <SolverControls
              modules={modules}
              placements={placements}
              rules={solverRules}
              scope={solveScope}
              lockedCount={lockedPlacementIds.size}
              timeLimitMs={solverTimeLimit}
              workerSetting={solverWorkerSetting}
              logicalCpuCount={browserLogicalCpuCount}
              solving={solving}
              remainingMs={remainingSolveMs}
              elapsedMs={elapsedSolveMs}
              result={solverResult}
              fingerprintLabel={fingerprintLabel}
              historyEntries={historyEntries}
              onRuleChange={updateSolverRule}
              onScopeChange={setSolveScope}
              onTimeLimitChange={setSolverTimeLimit}
              onWorkerSettingChange={setSolverWorkerSetting}
              onSolve={runSolver}
              onCancel={cancelSolver}
              onApply={applySolverSolution}
              onApplyHistory={applyHistoryEntry}
              onDeleteHistory={deleteHistoryEntry}
              onClearHistory={clearCurrentHistory}
            /> : <div className="workspace-empty-state"><span className="eyebrow">AUTO FITTING</span><h2>请先选择配装</h2><p>自动求解结果必须归属于一个已创建配装，请先从左侧选择棋盘并新建或载入配装。</p></div>
          )}
        </section>

        <BuildStats
          board={board}
          modules={modules}
          placements={placements}
          provenOptimal={currentLayoutProvenOptimal}
          selectedInstanceId={selectedInstanceId}
          isSelectedLocked={selectedInstanceId ? lockedPlacementIds.has(selectedInstanceId) : false}
          onRotate={rotateSelected}
          onDelete={deleteSelected}
          onClear={clearBuild}
          onExport={exportFitting}
          onImport={importFitting}
          onToggleLock={toggleSelectedLock}
          onSave={() => persistWorkspaceNow(true)}
          saveStatus={saveStatus}
          lastSavedAt={lastSavedAt}
        />
      </div>

      {draggingModule && draggingShape && drag && (
        <div className={`drag-ghost${drag.validation && !drag.validation.valid ? " is-invalid" : ""}`} style={{ left: drag.pointer.x + 18, top: drag.pointer.y + 18 }}>
          <ShapeMiniature shape={draggingShape} color={draggingModule.color} />
          <span>{drag.rotation}°</span>
        </div>
      )}
      {fittingDialogMode && (
        <FittingProfileDialog
          mode={fittingDialogMode}
          name={profileName}
          description={profileDescription}
          onNameChange={setProfileName}
          onDescriptionChange={setProfileDescription}
          onConfirm={confirmFittingProfile}
          onCancel={() => setFittingDialogMode(null)}
        />
      )}
      </main>
    </>
  );
}
