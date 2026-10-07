import type { PointerEvent } from "react";
import type { GridPoint } from "../models/board";
import type { ModuleDefinition } from "../models/module";
import type { PlacedModuleData } from "../models/placement";
import { ShapeMiniature } from "./ShapeMiniature";

interface ModuleListProps {
  modules: ModuleDefinition[];
  placements: PlacedModuleData[];
  assemblyMode: boolean;
  onStartDrag: (moduleId: string, anchor: GridPoint, event: PointerEvent<HTMLDivElement>) => void;
  onEdit: (moduleId: string) => void;
  onCreate: () => void;
}

export function ModuleList(props: ModuleListProps) {
  return (
    <aside className="panel module-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">MODULE BAY</span>
          <h2>装备模块</h2>
        </div>
        <button className="icon-button" type="button" onClick={props.onCreate} title="创建模块">＋</button>
      </div>
      <p className="panel-hint">
        {props.assemblyMode ? "按住彩色模块拖入棋盘" : "选择一个模块进行编辑"}
      </p>
      <div className="module-list">
        {props.modules.map((module) => {
          const used = props.placements.filter((placement) => placement.moduleId === module.id).length;
          const remaining = Math.max(0, module.availableQuantity - used);
          return (
            <article className={`module-card${remaining === 0 ? " is-depleted" : ""}`} key={module.id}>
              <div className="module-visual">
                <ShapeMiniature
                  shape={module.baseShape}
                  color={module.color}
                  interactive={props.assemblyMode && remaining > 0}
                  onCellPointerDown={(point, event) => props.onStartDrag(module.id, point, event)}
                />
              </div>
              <div className="module-card-copy">
                <strong>{module.name}</strong>
                <span>{module.type} · {module.baseShape.length} 格</span>
                <div className="inventory-line">
                  <i style={{ backgroundColor: module.color }} />
                  <span>剩余 {remaining} / {module.availableQuantity}</span>
                </div>
              </div>
              <button className="text-button" type="button" onClick={() => props.onEdit(module.id)}>编辑</button>
            </article>
          );
        })}
      </div>
      <button className="add-module-button" type="button" onClick={props.onCreate}>
        <span>＋</span> 绘制新模块
      </button>
    </aside>
  );
}
