import type { BoardDefinition } from "../models/board";
import type { ModuleDefinition } from "../models/module";
import type { PlacedModuleData } from "../models/placement";
import { calculateLayoutScore } from "../core/scoring";

interface BuildStatsProps {
  board: BoardDefinition;
  modules: ModuleDefinition[];
  placements: PlacedModuleData[];
  provenOptimal?: boolean;
  selectedInstanceId: string | null;
  isSelectedLocked: boolean;
  onRotate: () => void;
  onDelete: () => void;
  onClear: () => void;
  onExport: () => void;
  onImport: (json: string) => void;
  onToggleLock: () => void;
  onSave: () => void;
  saveStatus: "loading" | "saving" | "saved" | "error";
  lastSavedAt: Date | null;
}

export function BuildStats(props: BuildStatsProps) {
  const moduleMap = new Map(props.modules.map((module) => [module.id, module]));
  const valid = props.board.mask.flat().filter(Boolean).length;
  const occupied = props.placements.reduce((sum, placement) => sum + (moduleMap.get(placement.moduleId)?.baseShape.length ?? 0), 0);
  const score = calculateLayoutScore(props.modules, props.placements);
  const utilization = valid ? Math.round((occupied / valid) * 100) : 0;
  const selected = props.placements.find((placement) => placement.instanceId === props.selectedInstanceId);
  const selectedModule = selected ? moduleMap.get(selected.moduleId) : null;

  return (
    <aside className="panel stats-panel">
      <div className="panel-heading">
        <div><span className="eyebrow">BUILD TELEMETRY</span><h2>配装统计</h2></div>
        {props.provenOptimal
          ? <span className="optimality-stamp" title="当前布局已证明最优">最优</span>
          : <span className="live-dot">LIVE</span>}
      </div>
      <div className="utilization-block">
        <div className="utilization-head"><span>空间利用率</span><strong>{utilization}%</strong></div>
        <div className="progress-track"><i style={{ width: `${utilization}%` }} /></div>
        <small>{occupied} / {valid} 个有效格已占用</small>
      </div>
      <div className="stat-grid">
        <div><span>剩余空间</span><strong>{Math.max(0, valid - occupied)}</strong><small>格</small></div>
        <div><span>模块数量</span><strong>{props.placements.length}</strong><small>件</small></div>
        <div><span>当前评分</span><strong>{score}</strong><small>PTS</small></div>
        <div><span>舰体网格</span><strong>{props.board.width}×{props.board.height}</strong><small>范围</small></div>
      </div>

      <div className="selection-card">
        <span className="eyebrow">SELECTED MODULE</span>
        {selected && selectedModule ? (
          <>
            <div className="selection-title"><i style={{ backgroundColor: selectedModule.color }} /><div><strong>{selectedModule.name}</strong><span>{selectedModule.type} · {selected.orientation.rotation}°</span></div></div>
            <div className="coordinate-line"><span>网格坐标</span><code>X {selected.origin.x} / Y {selected.origin.y}</code></div>
            <div className="selection-actions">
              <button className="secondary-button" type="button" onClick={props.onRotate}>旋转 90°</button>
              <button className="secondary-button" type="button" onClick={props.onToggleLock}>{props.isSelectedLocked ? "解除锁定" : "锁定求解"}</button>
              <button className="danger-button" type="button" onClick={props.onDelete}>删除模块</button>
            </div>
          </>
        ) : <p>点击棋盘中的模块，可查看位置并进行旋转或删除。</p>}
      </div>

      <div className="control-guide">
        <span><kbd>拖动</kbd> 放置 / 移动模块</span>
        <span><kbd>滚轮</kbd> 拖动时旋转 90°</span>
        <span><kbd>Delete</kbd> 删除选中模块</span>
      </div>
      <div className={`local-save-block is-${props.saveStatus}`}>
        <div>
          <i />
          <span>
            <strong>{props.saveStatus === "error" ? "本地保存失败" : props.saveStatus === "loading" ? "正在读取存档" : props.saveStatus === "saving" ? "正在自动保存" : "已自动保存到本机"}</strong>
            <small>{props.lastSavedAt ? `最近保存 ${props.lastSavedAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "修改后会自动保存"}</small>
          </span>
        </div>
        <button className="secondary-button" type="button" onClick={props.onSave}>{props.saveStatus === "error" ? "重试保存" : "立即保存"}</button>
      </div>
      <div className="data-transfer-actions">
        <button className="secondary-button" type="button" onClick={props.onExport}>导出 JSON</button>
        <label className="secondary-button file-import-button">
          导入 JSON
          <input
            type="file"
            accept="application/json,.json"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (file) props.onImport(await file.text());
              event.target.value = "";
            }}
          />
        </label>
      </div>
      <button className="clear-build-button" type="button" disabled={props.placements.length === 0} onClick={props.onClear}>清空当前配装</button>
    </aside>
  );
}
