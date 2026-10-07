import type { BoardDefinition } from "../models/board";
import type { SavedBoardEntry } from "../models/boardStorage";
import type { SavedFittingEntry } from "../models/fittingStorage";

interface WorkspaceSelectorProps {
  board: BoardDefinition;
  boardIsSaved: boolean;
  savedBoards: SavedBoardEntry[];
  fittings: SavedFittingEntry[];
  activeFittingId: string | null;
  disabled: boolean;
  onBoardSelect: (boardId: string) => void;
  onFittingSelect: (fittingId: string) => void;
  onNewFitting: () => void;
  onOpenBoardEditor: () => void;
}

export function WorkspaceSelector(props: WorkspaceSelectorProps) {
  return (
    <section className="workspace-selector panel">
      <div className="workspace-selector-heading">
        <span className="eyebrow">FITTING CONTEXT</span>
        <strong>配装选择</strong>
      </div>
      <label>
        <span>当前棋盘（必选）</span>
        <select value={props.boardIsSaved ? props.board.id : ""} disabled={props.disabled || props.savedBoards.length === 0} onChange={(event) => event.target.value && props.onBoardSelect(event.target.value)}>
          <option value="">{props.savedBoards.length ? "选择一个已创建棋盘" : "尚未创建棋盘"}</option>
          {props.savedBoards.map((entry) => <option key={entry.board.id} value={entry.board.id}>{entry.board.name}</option>)}
        </select>
      </label>
      {!props.boardIsSaved && (
        <button className="secondary-button workspace-selector-board-action" type="button" onClick={props.onOpenBoardEditor}>前往棋盘编辑创建</button>
      )}
      <label>
        <span>当前配装（必选）</span>
        <select value={props.activeFittingId ?? ""} disabled={props.disabled || !props.boardIsSaved || props.fittings.length === 0} onChange={(event) => event.target.value && props.onFittingSelect(event.target.value)}>
          <option value="">{props.fittings.length ? "选择本棋盘的配装" : "本棋盘暂无配装"}</option>
          {props.fittings.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
      </label>
      <div className="workspace-selector-create">
        <span>创建新档案</span>
        <button className="add-fitting-button" type="button" disabled={props.disabled || !props.boardIsSaved} onClick={props.onNewFitting}>
          <b>＋</b> 新建配装
        </button>
      </div>
    </section>
  );
}
