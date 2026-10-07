import type { ValidatedSolutionHistoryEntry } from "../models/solutionHistory";

interface SolutionHistoryPanelProps {
  fingerprintLabel: string;
  entries: ValidatedSolutionHistoryEntry[];
  applyDisabled: boolean;
  onApply: (entry: ValidatedSolutionHistoryEntry) => void;
  onDelete: (entryId: string) => void;
  onClear: () => void;
}

export function SolutionHistoryPanel(props: SolutionHistoryPanelProps) {
  const provenEntry = props.entries.find((item) => item.provenOptimal);
  return (
    <div className="solver-section history-section">
      <div className="solver-section-title">
        <strong>当前型号历史前 5</strong>
        <span>型号 {props.fingerprintLabel} · 必备配置或锁定布局变化后自动切换</span>
      </div>
      {provenEntry && (
        <div className="optimality-certificate" role="status">
          <span className="optimality-stamp">最优</span>
          <span><strong>当前型号已证明最优</strong><small>{provenEntry.currentScore.toLocaleString()} 分 · {new Date(provenEntry.entry.optimalityProof!.provenAt).toLocaleString()}，无需重复计算</small></span>
        </div>
      )}
      {props.entries.length === 0 ? (
        <div className="history-empty">当前配装型号还没有历史方案。</div>
      ) : (
        <div className="history-list">
          {props.entries.map((item, index) => (
            <article className={`history-card${item.valid ? "" : " is-invalid"}`} key={item.entry.id}>
              <div className="history-rank">#{index + 1}</div>
              <div className="history-main">
                <strong>{item.currentScore.toLocaleString()} 分 {item.provenOptimal && <em className="history-proof-badge">已证明最优</em>}</strong>
                <span>{item.currentSolution.placements.length} 个模块 · {new Date(item.entry.savedAt).toLocaleString()}</span>
                {!item.valid && <small>失效：{item.reasons.join("；")}</small>}
                {item.valid && item.proofInvalidReason && <small>原最优证明已失效：{item.proofInvalidReason}</small>}
              </div>
              <div className="history-actions">
                <button type="button" disabled={!item.valid || props.applyDisabled} onClick={() => props.onApply(item)}>应用</button>
                <button type="button" onClick={() => props.onDelete(item.entry.id)}>删除</button>
              </div>
            </article>
          ))}
        </div>
      )}
      {props.entries.length > 0 && <button className="history-clear" type="button" onClick={props.onClear}>清空当前型号历史</button>}
    </div>
  );
}
