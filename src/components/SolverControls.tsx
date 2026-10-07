import type { ModuleDefinition } from "../models/module";
import type { PlacedModuleData } from "../models/placement";
import type { ValidatedSolutionHistoryEntry } from "../models/solutionHistory";
import type {
  ModuleSolverRule,
  SolveScope,
  SolverJobSnapshot,
  SolverSolution,
  SolverTimeLimit,
  SolverWorkerSetting,
} from "../models/solver";
import { DEFAULT_SOLVER_WORKERS, MAX_SOLVER_WORKERS } from "../models/solver";
import { ShapeMiniature } from "./ShapeMiniature";
import { SolutionHistoryPanel } from "./SolutionHistoryPanel";

interface SolverControlsProps {
  modules: ModuleDefinition[];
  placements: PlacedModuleData[];
  rules: ModuleSolverRule[];
  scope: SolveScope;
  lockedCount: number;
  timeLimitMs: SolverTimeLimit;
  workerSetting: SolverWorkerSetting;
  logicalCpuCount: number;
  solving: boolean;
  remainingMs: number | null;
  elapsedMs: number;
  result: SolverJobSnapshot | null;
  fingerprintLabel: string;
  historyEntries: ValidatedSolutionHistoryEntry[];
  onRuleChange: (moduleId: string, patch: Partial<ModuleSolverRule>) => void;
  onScopeChange: (scope: SolveScope) => void;
  onTimeLimitChange: (timeLimit: SolverTimeLimit) => void;
  onWorkerSettingChange: (setting: SolverWorkerSetting) => void;
  onSolve: () => void;
  onCancel: () => void;
  onApply: (solution: SolverSolution) => void;
  onApplyHistory: (entry: ValidatedSolutionHistoryEntry) => void;
  onDeleteHistory: (entryId: string) => void;
  onClearHistory: () => void;
}

const STATUS_TEXT: Record<SolverJobSnapshot["status"], string> = {
  queued: "正在建立 CP-SAT 模型",
  running: "CP-SAT 正在求解",
  completed: "搜索完成",
  "time-limit": "达到时间限制，返回当前最佳",
  stopped: "已停止，保留当前最佳",
  infeasible: "无可行方案",
  error: "本地求解服务发生错误",
};

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function SolverControls(props: SolverControlsProps) {
  const moduleMap = new Map(props.modules.map((module) => [module.id, module]));
  const solution = props.result?.bestSolution ?? null;
  const hasProvenHistory = props.historyEntries.some((entry) => entry.provenOptimal);
  const customWorkerMaximum = Math.min(props.logicalCpuCount, MAX_SOLVER_WORKERS);
  const customWorkers = props.workerSetting.mode === "custom"
    ? props.workerSetting.value ?? Math.min(DEFAULT_SOLVER_WORKERS, customWorkerMaximum)
    : Math.min(DEFAULT_SOLVER_WORKERS, customWorkerMaximum);
  const quickWorkerOptions = [4, 8, 12, 16].filter((workers) => workers <= customWorkerMaximum);
  const idleStatus = props.result
    ? props.result.provenOptimal ? "已证明最优" : STATUS_TEXT[props.result.status]
    : hasProvenHistory ? "该型号已证明最优" : "等待设置";
  return (
    <section className="solver-stage">
      <div className="stage-heading solver-heading">
        <div>
          <span className="eyebrow">GOOGLE OR-TOOLS · CP-SAT</span>
          <h2>自动配装</h2>
          <p>先严格满足全部必装和锁定约束，再以模块总评分作为唯一优化目标。</p>
        </div>
        <div className={`status-chip${props.solving ? " is-solving" : ""}`}><i /> {props.solving ? "正在计算" : idleStatus}</div>
      </div>

      <div className="solver-scroll">
        <div className="solver-section">
          <div className="solver-section-title"><strong>模块规则</strong><span>必装不受“参与”开关影响；参与表示允许继续添加至最大数量。</span></div>
          <div className="solver-rule-grid">
            {props.modules.map((module) => {
              const rule = props.rules.find((item) => item.moduleId === module.id);
              if (!rule) return null;
              const currentCount = props.placements.filter((placement) => placement.moduleId === module.id).length;
              const required = rule.requiredCount > 0;
              return (
                <article className={`solver-rule-card${required ? " is-required" : ""}${rule.enabled ? " is-enabled" : ""}`} key={module.id}>
                  <div className="solver-rule-card-head">
                    <div className="solver-module-shape"><ShapeMiniature shape={module.baseShape} color={module.color} /></div>
                    <span><strong>{module.name}</strong><small>当前 {currentCount} · 库存 {module.availableQuantity} · 评分 {module.baseScore}</small></span>
                  </div>
                  <div className="solver-rule-card-controls">
                    <label className="solver-rule-option">
                      <input
                        aria-label={`${module.name}设为必装`}
                        type="checkbox"
                        checked={required}
                        onChange={(event) => props.onRuleChange(module.id, { requiredCount: event.target.checked ? 1 : 0 })}
                      />
                      <span><strong>必装</strong><small>必须满足</small></span>
                    </label>
                    <label className="solver-rule-number">
                      <span>数量</span>
                      <input aria-label={`${module.name}必装数量`} type="number" min="1" max={module.availableQuantity} value={rule.requiredCount} disabled={!required} onChange={(event) => props.onRuleChange(module.id, { requiredCount: Number(event.target.value) })} />
                    </label>
                    <label className="solver-rule-option">
                      <input aria-label={`${module.name}参与自动装配`} type="checkbox" checked={rule.enabled} onChange={(event) => props.onRuleChange(module.id, { enabled: event.target.checked })} />
                      <span><strong>参与填充</strong><small>允许额外添加</small></span>
                    </label>
                    <label className="solver-rule-number">
                      <span>最大</span>
                      <input aria-label={`${module.name}最大数量`} type="number" min={rule.requiredCount} max={module.availableQuantity} value={rule.maxCount} disabled={!rule.enabled} onChange={(event) => props.onRuleChange(module.id, { maxCount: Number(event.target.value) })} />
                    </label>
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <div className="solver-bottom-grid">
          <div className="solver-section compact-section">
            <div className="solver-section-title"><strong>当前摆放</strong><span>已锁定 {props.lockedCount} 个模块</span></div>
            <div className="scope-options">
              <label className={props.scope === "empty-board" ? "is-selected" : ""}>
                <input type="radio" name="solve-scope" checked={props.scope === "empty-board"} onChange={() => props.onScopeChange("empty-board")} />
                <span><strong>从空棋盘开始</strong><small>当前布局只作为 hint，不固定位置</small></span>
              </label>
              <label className={props.scope === "fill-current" ? "is-selected" : ""}>
                <input type="radio" name="solve-scope" checked={props.scope === "fill-current"} onChange={() => props.onScopeChange("fill-current")} />
                <span><strong>保留并填充</strong><small>当前模块全部固定</small></span>
              </label>
              <label className={props.scope === "rearrange-unlocked" ? "is-selected" : ""}>
                <input type="radio" name="solve-scope" checked={props.scope === "rearrange-unlocked"} onChange={() => props.onScopeChange("rearrange-unlocked")} />
                <span><strong>重排未锁定模块</strong><small>只固定锁定模块，其余可增减和重排</small></span>
              </label>
            </div>
          </div>

          <div className="solver-section compact-section">
            <div className="solver-section-title"><strong>求解线程</strong><span>浏览器识别 {props.logicalCpuCount} 个逻辑线程，后端最终校验</span></div>
            <div className="worker-options">
              <button
                type="button"
                disabled={props.solving}
                className={props.workerSetting.mode === "standard" ? "is-selected" : ""}
                onClick={() => props.onWorkerSettingChange({ mode: "standard" })}
              >标准（8，推荐）<small>适合日常找高分</small></button>
              <button
                type="button"
                disabled={props.solving}
                className={props.workerSetting.mode === "all" ? "is-selected" : ""}
                onClick={() => props.onWorkerSettingChange({ mode: "all" })}
              >全线程（{props.logicalCpuCount}）<small>电脑闲置时挂机</small></button>
              <button
                type="button"
                disabled={props.solving}
                className={props.workerSetting.mode === "custom" ? "is-selected" : ""}
                onClick={() => props.onWorkerSettingChange({ mode: "custom", value: customWorkers })}
              >自定义<small>1–{customWorkerMaximum}</small></button>
            </div>
            {props.workerSetting.mode === "custom" && (
              <div className="worker-custom">
                <label>线程数<input
                  aria-label="自定义求解线程数"
                  type="number"
                  min={1}
                  max={customWorkerMaximum}
                  value={customWorkers}
                  disabled={props.solving}
                  onChange={(event) => props.onWorkerSettingChange({
                    mode: "custom",
                    value: Math.max(1, Math.min(customWorkerMaximum, Math.floor(Number(event.target.value) || 1))),
                  })}
                /></label>
                <div>{quickWorkerOptions.map((workers) => (
                  <button type="button" disabled={props.solving} key={workers} onClick={() => props.onWorkerSettingChange({ mode: "custom", value: workers })}>{workers}</button>
                ))}</div>
              </div>
            )}
            <p className="solver-worker-note">全线程可能更耗内存和发热，适合压低上限，但不保证一定更快。</p>
            {props.result?.effectiveSearchWorkers && (
              <p className="solver-worker-effective">
                本次实际使用 {props.result.effectiveSearchWorkers} 个逻辑线程
                {props.result.searchWorkersClamped ? `（后端已按本机 ${props.result.logicalCpuCount ?? "可用"} 线程限制）` : ""}
              </p>
            )}
            <div className="solver-section-title"><strong>计算时间</strong><span>停止或到时都保留当前最佳</span></div>
            <div className="time-options">
              {([30_000, 60_000, 300_000, 900_000, null] as SolverTimeLimit[]).map((time) => (
                <button type="button" className={props.timeLimitMs === time ? "is-selected" : ""} key={time ?? "unlimited"} onClick={() => props.onTimeLimitChange(time)}>
                  {time === null ? "不限时" : time === 60_000 ? "1 分钟" : time >= 60_000 ? `${time / 60_000} 分钟` : "30 秒"}
                </button>
              ))}
            </div>
            {props.solving ? (
              <button className="solve-button is-solving" type="button" onClick={props.onCancel}>
                停止计算
              </button>
            ) : (
              <button className="solve-button" type="button" onClick={props.onSolve}>开始 CP-SAT 自动配装</button>
            )}
            {!props.solving && hasProvenHistory && <p className="solver-proof-hint">当前型号已有严格最优记录；仍可主动重新计算。</p>}
            {props.solving && (
              <div className="solver-live-progress" aria-live="polite">
                <div><span>剩余时间</span><strong>{props.remainingMs === null ? "不限时" : formatDuration(props.remainingMs)}</strong></div>
                <div><span>已计算</span><strong>{formatDuration(props.elapsedMs)}</strong></div>
                <div><span>当前最佳</span><strong>{(props.result?.score ?? 0).toLocaleString()}</strong></div>
                <div><span>Best bound</span><strong>{props.result?.problemChanged ? "需重新计算" : (props.result?.bestBound ?? 0).toLocaleString()}</strong></div>
                {props.result?.solverPhase && <small className="solver-phase">{props.result.solverPhase}</small>}
                <small>差距 {props.result?.problemChanged ? "待计算" : (props.result?.optimalityGap ?? 0).toLocaleString()} · {props.result?.provenOptimal ? "已证明最优" : `状态 ${props.result?.solverStatus ?? "UNKNOWN"}`}</small>
              </div>
            )}
          </div>
        </div>

        {props.result && (
          <div className="solver-section result-section">
            <div className="solver-result-summary">
              <div><span className="eyebrow">CP-SAT RESULT</span><strong>{props.result.provenOptimal ? "已证明最优" : STATUS_TEXT[props.result.status]}</strong></div>
              <small>{Math.round(props.result.elapsedMs)} ms · {props.result.solverStatus}</small>
            </div>
            <div className="solver-score-overview">
              <span>当前最佳<strong>{props.result.score.toLocaleString()}</strong></span>
              <span>Best bound<strong>{props.result.problemChanged ? "需重新计算" : props.result.bestBound.toLocaleString()}</strong></span>
              <span>评分差距<strong>{props.result.problemChanged ? "待计算" : props.result.optimalityGap.toLocaleString()}</strong></span>
            </div>
            {props.result.problemChanged && <p>当前条件已变化或上次问题未能复核；仅展示当前仍合法的布局，请重新计算当前上界与最优状态。</p>}
            {props.result.errors.length > 0 && <div className="solver-error-list">{props.result.errors.map((error) => <p key={error}>{error}</p>)}</div>}
            {props.result.infeasibleReasons.length > 0 && <div className="solver-error-list">{props.result.infeasibleReasons.map((reason) => <p key={reason}>{reason}</p>)}</div>}
            {solution && (
              <div className="solution-list cp-sat-solution-list">
                <article className="solution-card">
                  <div className="solution-card-head"><span>当前最佳方案</span><strong>{solution.requiredSatisfied ? "必装已满足" : "必装未满足"}</strong></div>
                  <div className="solution-score"><span>总评分</span><strong>{solution.totalScore.toLocaleString()}</strong></div>
                  <div className="solution-metrics">
                    <span>占用<strong>{solution.occupiedCells}</strong></span>
                    <span>利用率<strong>{Math.round(solution.utilization * 100)}%</strong></span>
                    <span>剩余<strong>{solution.remainingCells}</strong></span>
                    <span>空洞<strong>{solution.isolatedEmptyCells}</strong></span>
                  </div>
                  <div className="solution-modules">
                    {Object.entries(solution.moduleCounts).filter(([, count]) => count > 0).map(([moduleId, count]) => (
                      <span key={moduleId}><i style={{ backgroundColor: moduleMap.get(moduleId)?.color }} />{moduleMap.get(moduleId)?.name ?? moduleId} × {count}</span>
                    ))}
                  </div>
                  <button className="primary-button" type="button" disabled={props.solving} onClick={() => props.onApply(solution)}>{props.solving ? "停止计算后应用" : "应用此方案"}</button>
                </article>
              </div>
            )}
          </div>
        )}
        <SolutionHistoryPanel fingerprintLabel={props.fingerprintLabel} entries={props.historyEntries} applyDisabled={props.solving} onApply={props.onApplyHistory} onDelete={props.onDeleteHistory} onClear={props.onClearHistory} />
      </div>
    </section>
  );
}
