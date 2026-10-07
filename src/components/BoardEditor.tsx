import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { BoardCell, BoardDefinition, GridPoint } from "../models/board";
import type { BoardHistoryEntry, SavedBoardEntry } from "../models/boardStorage";
import type { BoardSelectionMoveError, BoardSelectionMoveValidation } from "../utils/translateBoardSelection";
import { BOARD_EDITOR_CELL } from "./boardLayout";

interface BoardEditorProps {
  board: BoardDefinition;
  boardIsSaved: boolean;
  savedBoards: SavedBoardEntry[];
  history: BoardHistoryEntry[];
  onChange: (board: BoardDefinition, recordHistory?: boolean) => boolean;
  onCreateBoard: () => void;
  onSaveBoard: () => void;
  onLoadSavedBoard: (boardId: string) => void;
  onDeleteSavedBoard: (boardId: string) => void;
  onRestoreHistory: (entryId: string) => void;
  onClearHistory: () => void;
  onValidateSelectionMove: (selectedCells: GridPoint[], deltaX: number, deltaY: number) => BoardSelectionMoveValidation;
  onMoveSelection: (selectedCells: GridPoint[], deltaX: number, deltaY: number) => boolean;
}

type EditorMode = "paint" | "select";
type SelectionGesture =
  | { kind: "marquee"; start: GridPoint; current: GridPoint }
  | { kind: "move"; anchor: GridPoint; delta: GridPoint };

const MIN_BOARD_WIDTH = 4;
const MIN_BOARD_HEIGHT = 4;
const MAX_BOARD_WIDTH = 99;
const MAX_BOARD_HEIGHT = 99;
const MOVE_ERROR_TEXT: Record<BoardSelectionMoveError, string> = {
  EMPTY_SELECTION: "请先框选需要移动的可用区域。",
  OUT_OF_BOUNDS: "目标位置超出棋盘边界，区域已保持原位。",
  MASK_COLLISION: "目标位置与其他可用区域重叠，区域已保持原位。",
  PARTIAL_PLACEMENT: "选区只包含了某个模块的一部分，请扩大选区或先移除模块。",
};

function resizeMask(board: BoardDefinition, width: number, height: number): BoardCell[][] {
  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => board.mask[y]?.[x] ?? 0),
  );
}

function cellKey(cell: GridPoint): string {
  return `${cell.x},${cell.y}`;
}

function activeCellsInRectangle(board: BoardDefinition, start: GridPoint, end: GridPoint): GridPoint[] {
  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);
  const cells: GridPoint[] = [];
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (board.mask[y]?.[x] === 1) cells.push({ x, y });
    }
  }
  return cells;
}

function shiftCells(cells: GridPoint[], deltaX: number, deltaY: number): GridPoint[] {
  return cells.map((cell) => ({ x: cell.x + deltaX, y: cell.y + deltaY }));
}

export function BoardEditor(props: BoardEditorProps) {
  const { board, onChange, onMoveSelection, onValidateSelectionMove } = props;
  const painting = useRef<BoardCell | null>(null);
  const visited = useRef(new Set<string>());
  const latestBoard = useRef(board);
  const selectedCellsRef = useRef<GridPoint[]>([]);
  const gestureRef = useRef<SelectionGesture | null>(null);
  const [editingName, setEditingName] = useState(board.name);
  const [editingWidth, setEditingWidth] = useState(String(board.width));
  const [editingHeight, setEditingHeight] = useState(String(board.height));
  const [dimensionError, setDimensionError] = useState("");
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [editorMode, setEditorMode] = useState<EditorMode>("paint");
  const [selectedCells, setSelectedCells] = useState<GridPoint[]>([]);
  const [gesture, setGesture] = useState<SelectionGesture | null>(null);
  const [selectionMessage, setSelectionMessage] = useState<{ text: string; error: boolean } | null>(null);

  const updateSelectedCells = (cells: GridPoint[]) => {
    selectedCellsRef.current = cells;
    setSelectedCells(cells);
  };

  const updateGesture = (next: SelectionGesture | null) => {
    gestureRef.current = next;
    setGesture(next);
  };

  useEffect(() => { latestBoard.current = board; }, [board]);
  useEffect(() => setEditingName(board.name), [board.name]);
  useEffect(() => {
    setEditingWidth(String(board.width));
    setEditingHeight(String(board.height));
    setDimensionError("");
    selectedCellsRef.current = [];
    setSelectedCells([]);
    gestureRef.current = null;
    setGesture(null);
  }, [board.height, board.id, board.width]);
  useEffect(() => {
    const finish = (apply: boolean) => {
      painting.current = null;
      visited.current.clear();
      const currentGesture = gestureRef.current;
      if (!currentGesture) return;
      if (apply && currentGesture.kind === "marquee") {
        const nextSelection = activeCellsInRectangle(latestBoard.current, currentGesture.start, currentGesture.current);
        updateSelectedCells(nextSelection);
        setSelectionMessage(nextSelection.length > 0
          ? { text: `已选中 ${nextSelection.length} 个可用格，可以按住高亮区域拖动。`, error: false }
          : { text: "选框内没有可用格，请重新框选。", error: true });
      }
      if (apply && currentGesture.kind === "move" && (currentGesture.delta.x !== 0 || currentGesture.delta.y !== 0)) {
        const currentSelection = selectedCellsRef.current;
        const validation = onValidateSelectionMove(currentSelection, currentGesture.delta.x, currentGesture.delta.y);
        if (!validation.valid) {
          setSelectionMessage({ text: validation.error ? MOVE_ERROR_TEXT[validation.error] : "选中区域无法移动到目标位置。", error: true });
        } else if (onMoveSelection(currentSelection, currentGesture.delta.x, currentGesture.delta.y)) {
          updateSelectedCells(shiftCells(currentSelection, currentGesture.delta.x, currentGesture.delta.y));
          setSelectionMessage({ text: `已移动 ${currentSelection.length} 个可用格。`, error: false });
        }
      }
      updateGesture(null);
    };
    const finishPointer = () => finish(true);
    const cancelPointer = () => finish(false);
    window.addEventListener("pointerup", finishPointer);
    window.addEventListener("pointercancel", cancelPointer);
    return () => {
      window.removeEventListener("pointerup", finishPointer);
      window.removeEventListener("pointercancel", cancelPointer);
    };
  }, [onMoveSelection, onValidateSelectionMove]);

  const paint = (x: number, y: number, value: BoardCell, recordHistory = false) => {
    const key = `${x},${y}`;
    const currentBoard = latestBoard.current;
    if (visited.current.has(key) || currentBoard.mask[y][x] === value) return;
    visited.current.add(key);
    const mask = currentBoard.mask.map((row) => [...row]);
    mask[y][x] = value;
    const nextBoard = { ...currentBoard, mask };
    if (onChange(nextBoard, recordHistory)) latestBoard.current = nextBoard;
  };

  const startPaint = (x: number, y: number, event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const value: BoardCell = latestBoard.current.mask[y][x] === 1 ? 0 : 1;
    painting.current = value;
    visited.current.clear();
    paint(x, y, value, true);
  };

  const startSelection = (x: number, y: number, event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const point = { x, y };
    const isSelected = selectedCellsRef.current.some((cell) => cell.x === x && cell.y === y);
    if (isSelected) {
      updateGesture({ kind: "move", anchor: point, delta: { x: 0, y: 0 } });
    } else {
      setSelectionMessage(null);
      updateSelectedCells([]);
      updateGesture({ kind: "marquee", start: point, current: point });
    }
  };

  const continueInteraction = (x: number, y: number) => {
    if (editorMode === "paint") {
      if (painting.current !== null) paint(x, y, painting.current);
      return;
    }
    const current = gestureRef.current;
    if (!current) return;
    if (current.kind === "marquee") {
      updateGesture({ ...current, current: { x, y } });
    } else {
      updateGesture({ ...current, delta: { x: x - current.anchor.x, y: y - current.anchor.y } });
    }
  };

  const changeMode = (mode: EditorMode) => {
    painting.current = null;
    visited.current.clear();
    updateGesture(null);
    if (mode === "paint") updateSelectedCells([]);
    setSelectionMessage(null);
    setEditorMode(mode);
  };

  const moveSelection = (deltaX: number, deltaY: number) => {
    const currentSelection = selectedCellsRef.current;
    if (!onValidateSelectionMove(currentSelection, deltaX, deltaY).valid) return;
    if (props.onMoveSelection(currentSelection, deltaX, deltaY)) {
      updateSelectedCells(shiftCells(currentSelection, deltaX, deltaY));
      setSelectionMessage({ text: `已移动 ${currentSelection.length} 个可用格。`, error: false });
    }
  };

  const applyDimensions = () => {
    if (!editingWidth.trim() || !editingHeight.trim()) {
      setDimensionError("宽和高都填写完整后才能应用。");
      return;
    }
    const width = Number(editingWidth);
    const height = Number(editingHeight);
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
      setDimensionError("请输入完整的整数尺寸，再点击应用。");
      return;
    }
    if (width < MIN_BOARD_WIDTH || width > MAX_BOARD_WIDTH || height < MIN_BOARD_HEIGHT || height > MAX_BOARD_HEIGHT) {
      setDimensionError(`尺寸范围必须是 ${MIN_BOARD_WIDTH}–${MAX_BOARD_WIDTH} × ${MIN_BOARD_HEIGHT}–${MAX_BOARD_HEIGHT}。`);
      return;
    }
    setEditingWidth(String(width));
    setEditingHeight(String(height));
    setDimensionError("");
    onChange({ ...board, width, height, mask: resizeMask(board, width, height) }, true);
  };

  const fill = (value: BoardCell) => {
    updateSelectedCells([]);
    onChange({ ...board, mask: board.mask.map((row) => row.map(() => value)) }, true);
  };

  const selectedKeys = new Set(selectedCells.map(cellKey));
  const marqueeCells = gesture?.kind === "marquee"
    ? activeCellsInRectangle(board, gesture.start, gesture.current)
    : [];
  const marqueeKeys = new Set(marqueeCells.map(cellKey));
  const moveValidation = gesture?.kind === "move"
    ? onValidateSelectionMove(selectedCells, gesture.delta.x, gesture.delta.y)
    : null;
  const movePreviewKeys = new Set(gesture?.kind === "move"
    ? shiftCells(selectedCells, gesture.delta.x, gesture.delta.y).map(cellKey)
    : []);
  const canMove = (deltaX: number, deltaY: number) => selectedCells.length > 0
    && onValidateSelectionMove(selectedCells, deltaX, deltaY).valid;
  const editorFeedback = dimensionError
    ? { text: dimensionError, error: true }
    : selectionMessage;

  return (
    <section className="editor-stage">
      <div className="stage-heading">
        <div>
          <span className="eyebrow">HULL MASK EDITOR</span>
          <h2>绘制飞船棋盘</h2>
          <p>{editorMode === "paint"
            ? "按住鼠标拖过格子可以连续绘制。尺寸可自定义为 4–99 × 4–99。"
            : "拖出矩形框选择一块可用区域，再按住高亮格拖到目标位置。"}</p>
        </div>
        <div className="status-chip"><i /> {editorMode === "paint" ? "图形编辑模式" : "区域移动模式"}</div>
      </div>

      <div className="editor-toolbar">
        <label className="field field-wide">
          <span>棋盘名称</span>
          <input value={editingName} onChange={(event) => setEditingName(event.target.value)} onBlur={() => editingName.trim() && onChange({ ...board, name: editingName.trim() }, true)} />
        </label>
        <label className="field field-small">
          <span>宽</span>
          <input type="number" min={MIN_BOARD_WIDTH} max={MAX_BOARD_WIDTH} value={editingWidth} onChange={(event) => setEditingWidth(event.target.value)} onKeyDown={(event) => event.key === "Enter" && applyDimensions()} />
        </label>
        <label className="field field-small">
          <span>高</span>
          <input type="number" min={MIN_BOARD_HEIGHT} max={MAX_BOARD_HEIGHT} value={editingHeight} onChange={(event) => setEditingHeight(event.target.value)} onKeyDown={(event) => event.key === "Enter" && applyDimensions()} />
        </label>
        <button className="primary-button" type="button" onClick={applyDimensions}>应用尺寸</button>
        <button className="secondary-button" type="button" onClick={() => fill(1)}>全部启用</button>
        <button className="secondary-button" type="button" onClick={() => fill(0)}>清空轮廓</button>
        <div className="board-edit-mode-controls" aria-label="棋盘编辑工具">
          <span>编辑工具</span>
          <div>
            <button type="button" className={editorMode === "paint" ? "is-active" : ""} onClick={() => changeMode("paint")}>绘制</button>
            <button type="button" className={editorMode === "select" ? "is-active" : ""} onClick={() => changeMode("select")}>框选移动</button>
          </div>
        </div>
        {editorMode === "select" && (
          <div className="board-translate-controls" aria-label="移动选中区域">
            <span>已选 {selectedCells.length} 格</span>
            <div>
              <button type="button" aria-label="选中区域向上移动一格" disabled={!canMove(0, -1)} onClick={() => moveSelection(0, -1)}>↑</button>
              <button type="button" aria-label="选中区域向左移动一格" disabled={!canMove(-1, 0)} onClick={() => moveSelection(-1, 0)}>←</button>
              <button type="button" aria-label="选中区域向下移动一格" disabled={!canMove(0, 1)} onClick={() => moveSelection(0, 1)}>↓</button>
              <button type="button" aria-label="选中区域向右移动一格" disabled={!canMove(1, 0)} onClick={() => moveSelection(1, 0)}>→</button>
              <button type="button" className="clear-selection" disabled={selectedCells.length === 0} onClick={() => updateSelectedCells([])}>取消选择</button>
            </div>
          </div>
        )}
      </div>
      <div
        className={`editor-feedback-slot${editorFeedback?.error ? " is-error" : ""}${editorFeedback ? "" : " is-empty"}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {editorFeedback?.text ?? "棋盘编辑提示占位"}
      </div>

      <div className="board-storage-panel">
        <section className="board-library-manager">
          <div className="board-library-manager-heading">
            <div><span className="eyebrow">BOARD LIBRARY</span><strong>棋盘库</strong></div>
            <button className="add-board-button" type="button" onClick={props.onCreateBoard}><b>＋</b> 新建棋盘</button>
          </div>
          <div className="board-library-cards">
            {props.savedBoards.length === 0 && <span>还没有已创建棋盘</span>}
            {props.savedBoards.map((entry) => (
              <button type="button" key={entry.board.id} className={entry.board.id === board.id && props.boardIsSaved ? "is-active" : ""} onClick={() => props.onLoadSavedBoard(entry.board.id)}>
                <strong>{entry.board.name}</strong><small>{entry.board.width} × {entry.board.height}</small>
              </button>
            ))}
          </div>
          <div className="board-library-current">
            <span>{props.boardIsSaved ? `正在编辑：${board.name}` : `新棋盘草稿：${board.name}`}</span>
            <button className="primary-button" type="button" disabled={!editingName.trim()} onClick={props.onSaveBoard}>{props.boardIsSaved ? "保存棋盘修改" : "创建并保存棋盘"}</button>
            <button className="danger-button" type="button" disabled={!props.boardIsSaved} onClick={() => props.onDeleteSavedBoard(board.id)}>删除棋盘</button>
          </div>
        </section>
        <section className="board-storage-card">
          <div className="board-storage-heading"><span className="eyebrow">RECOVERY HISTORY</span><strong>自动恢复</strong></div>
          <select className="board-storage-select" aria-label="选择棋盘历史快照" value={selectedHistoryId} onChange={(event) => setSelectedHistoryId(event.target.value)}>
            <option value="">选择修改前的快照</option>
            {props.history.map((entry) => <option value={entry.id} key={entry.id}>{new Date(entry.savedAt).toLocaleString()} · {entry.board.name} · {entry.board.width}×{entry.board.height} · {entry.placements.length} 个模块</option>)}
          </select>
          <div className="board-storage-actions">
            <button className="primary-button" type="button" disabled={!selectedHistoryId} onClick={() => {
              if (!selectedHistoryId) return;
              updateSelectedCells([]);
              props.onRestoreHistory(selectedHistoryId);
            }}>恢复所选快照</button>
            <button className="danger-button" type="button" disabled={props.history.length === 0} onClick={props.onClearHistory}>清空历史</button>
          </div>
        </section>
      </div>

      <div className="mask-editor-wrap">
        <div className={`mask-editor is-${editorMode}-mode`} style={{ gridTemplateColumns: `repeat(${board.width}, ${BOARD_EDITOR_CELL}px)` }}>
          {board.mask.flatMap((row, y) => row.map((cell, x) => {
            const key = `${x},${y}`;
            const classNames = ["mask-cell", cell ? "is-on" : "is-off"];
            if (selectedKeys.has(key)) classNames.push("is-region-selected");
            if (marqueeKeys.has(key)) classNames.push("is-marquee-selected");
            if (gesture?.kind === "move" && selectedKeys.has(key)) classNames.push("is-move-source");
            if (gesture?.kind === "move" && movePreviewKeys.has(key)) {
              classNames.push("is-move-target", moveValidation?.valid ? "is-valid-target" : "is-invalid-target");
            }
            return (
              <button
                type="button"
                aria-label={`格子 ${x + 1}, ${y + 1}：${cell ? "可用" : "不可用"}`}
                aria-pressed={selectedKeys.has(key)}
                key={key}
                className={classNames.join(" ")}
                onPointerDown={(event) => editorMode === "paint" ? startPaint(x, y, event) : startSelection(x, y, event)}
                onPointerEnter={() => continueInteraction(x, y)}
                onPointerMove={() => continueInteraction(x, y)}
              />
            );
          }))}
        </div>
      </div>
      <div className="editor-legend">
        <span><i className="legend-cell active" /> 可用空间</span>
        <span><i className="legend-cell inactive" /> 棋盘外部</span>
        {editorMode === "select" && <span><i className="legend-cell region-selected" /> 已选区域</span>}
        <strong>{board.mask.flat().filter(Boolean).length} 个有效格</strong>
      </div>
    </section>
  );
}
