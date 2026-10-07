import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { GridPoint } from "../models/board";
import type { ModuleDefinition } from "../models/module";
import { isConnectedShape, normalizeShape, pointKey } from "../utils/normalizeShape";
import {
  MODULE_EDITOR_MAX_QUANTITY,
  MODULE_EDITOR_MIN_QUANTITY,
  submitModuleEditorDefinition,
} from "../utils/submitModuleEditorDefinition";

interface ModuleEditorProps {
  module: ModuleDefinition | null;
  onSave: (module: ModuleDefinition) => void;
  onCancel: () => void;
}

const PALETTE = ["#5aa9e6", "#4dbb9d", "#e9a23b", "#8f7ee7", "#e76f78", "#78b65a"];

export function ModuleEditor({ module, onSave, onCancel }: ModuleEditorProps) {
  const [name, setName] = useState("");
  const [type, setType] = useState("通用");
  const [color, setColor] = useState(PALETTE[0]);
  const [quantity, setQuantity] = useState("1");
  const [score, setScore] = useState(10);
  const [allowRotation, setAllowRotation] = useState(true);
  const [width, setWidth] = useState(8);
  const [height, setHeight] = useState(8);
  const [cells, setCells] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const painting = useRef<boolean | null>(null);
  const visited = useRef(new Set<string>());

  useEffect(() => {
    setName(module?.name ?? "");
    setType(module?.type ?? "通用");
    setColor(module?.color ?? PALETTE[0]);
    setQuantity(String(module?.availableQuantity ?? 1));
    setScore(module?.baseScore ?? 10);
    setAllowRotation(module?.allowRotation ?? true);
    setCells(new Set(module?.baseShape.map(pointKey) ?? []));
    const maxX = module ? Math.max(...module.baseShape.map((point) => point.x)) + 2 : 8;
    const maxY = module ? Math.max(...module.baseShape.map((point) => point.y)) + 2 : 8;
    setWidth(Math.max(8, maxX));
    setHeight(Math.max(8, maxY));
    setError("");
  }, [module]);

  useEffect(() => {
    const stop = () => {
      painting.current = null;
      visited.current.clear();
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  const paint = (point: GridPoint, value: boolean) => {
    const key = pointKey(point);
    if (visited.current.has(key)) return;
    visited.current.add(key);
    setCells((current) => {
      const next = new Set(current);
      if (value) next.add(key); else next.delete(key);
      return next;
    });
  };

  const startPaint = (point: GridPoint, event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const value = !cells.has(pointKey(point));
    painting.current = value;
    visited.current.clear();
    paint(point, value);
  };

  const resizeCanvas = (nextWidth: number, nextHeight: number) => {
    const safeWidth = Math.min(12, Math.max(3, nextWidth));
    const safeHeight = Math.min(12, Math.max(3, nextHeight));
    setWidth(safeWidth);
    setHeight(safeHeight);
    setCells((current) => new Set([...current].filter((key) => {
      const [x, y] = key.split(",").map(Number);
      return x < safeWidth && y < safeHeight;
    })));
  };

  const submit = () => {
    const shape = normalizeShape([...cells].map((key) => {
      const [x, y] = key.split(",").map(Number);
      return { x, y };
    }));
    if (!name.trim()) return setError("请填写模块名称。");
    if (shape.length === 0) return setError("请至少绘制一个模块格子。");
    if (!isConnectedShape(shape)) return setError("模块格子必须通过边相连，不能分成多块。 ");
    try {
      submitModuleEditorDefinition({
        id: module?.id ?? crypto.randomUUID(),
        name: name.trim(),
        type: type.trim() || "通用",
        baseShape: shape,
        color,
        availableQuantity: Number(quantity),
        allowRotation,
        allowMirror: false,
        baseScore: score,
        attributes: module?.attributes ?? {},
      }, onSave);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "模块输入无效。");
    }
  };

  return (
    <section className="editor-stage">
      <div className="stage-heading">
        <div>
          <span className="eyebrow">MODULE SHAPE EDITOR</span>
          <h2>{module ? "编辑装备模块" : "绘制新模块"}</h2>
          <p>点击或拖动格子绘制形状。模块必须由上下左右相连的格子组成。</p>
        </div>
        <div className="status-chip"><i /> {module ? "编辑现有模块" : "新建模块"}</div>
      </div>

      <div className="module-editor-layout">
        <div className="shape-editor-area">
          <div className="shape-editor-grid" style={{ gridTemplateColumns: `repeat(${width}, 34px)` }}>
            {Array.from({ length: width * height }, (_, index) => {
              const point = { x: index % width, y: Math.floor(index / width) };
              const filled = cells.has(pointKey(point));
              return (
                <button
                  type="button"
                  key={pointKey(point)}
                  aria-label={`模块格子 ${point.x + 1}, ${point.y + 1}`}
                  className={`shape-editor-cell${filled ? " is-on" : ""}`}
                  style={filled ? { backgroundColor: color, borderColor: color } : undefined}
                  onPointerDown={(event) => startPaint(point, event)}
                  onPointerEnter={() => painting.current !== null && paint(point, painting.current)}
                />
              );
            })}
          </div>
          <div className="shape-grid-controls">
            <label>画布宽 <input type="number" min="3" max="12" value={width} onChange={(event) => resizeCanvas(Number(event.target.value), height)} /></label>
            <label>画布高 <input type="number" min="3" max="12" value={height} onChange={(event) => resizeCanvas(width, Number(event.target.value))} /></label>
            <button className="text-button" type="button" onClick={() => setCells(new Set())}>清空形状</button>
            <strong>{cells.size} 格</strong>
          </div>
        </div>

        <div className="module-form">
          <label className="field"><span>模块名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：聚变反应堆" /></label>
          <label className="field"><span>模块类型</span><input value={type} onChange={(event) => setType(event.target.value)} placeholder="动力 / 防御 / 储运" /></label>
          <div className="field-row">
            <label className="field"><span>库存数量</span><input type="number" min={MODULE_EDITOR_MIN_QUANTITY} max={MODULE_EDITOR_MAX_QUANTITY} step="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
            <label className="field"><span>基础评分</span><input type="number" min="0" step="0.001" value={score} onChange={(event) => setScore(Number(event.target.value))} /></label>
          </div>
          <div className="field"><span>识别颜色</span><div className="color-palette">
            {PALETTE.map((item) => <button type="button" aria-label={`选择颜色 ${item}`} key={item} className={color === item ? "is-selected" : ""} style={{ backgroundColor: item }} onClick={() => setColor(item)} />)}
            <input type="color" value={color} onChange={(event) => setColor(event.target.value)} aria-label="自定义颜色" />
          </div></div>
          <label className="check-line"><input type="checkbox" checked={allowRotation} onChange={(event) => setAllowRotation(event.target.checked)} /><span><strong>允许旋转</strong><small>拖动时使用鼠标滚轮，每次旋转 90°</small></span></label>
          <label className="check-line is-disabled"><input type="checkbox" disabled /><span><strong>允许镜像</strong><small>当前游戏规则未启用，已为未来版本预留</small></span></label>
          <div
            className={`form-error form-error-slot${error ? "" : " is-empty"}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {error || "模块校验提示占位"}
          </div>
          <div className="form-actions">
            <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
            <button className="primary-button" type="button" onClick={submit}>{module ? "保存修改" : "创建模块"}</button>
          </div>
        </div>
      </div>
    </section>
  );
}
