interface FittingLibraryBarProps {
  name: string;
  description: string;
  active: boolean;
  dirty: boolean;
  saveStatus: "loading" | "saving" | "saved" | "error";
  disabled: boolean;
  onSave: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function FittingLibraryBar(props: FittingLibraryBarProps) {
  const statusLabel = props.saveStatus === "saving"
    ? "保存中"
    : props.saveStatus === "error" ? "保存失败"
      : props.dirty ? "有未保存修改" : "已保存";
  const needsSave = props.dirty || props.saveStatus === "error";
  return (
    <section className={`current-fitting-bar${props.active ? " is-active" : ""}`}>
      <div className="current-fitting-copy">
        <span className="eyebrow">CURRENT FITTING</span>
        {props.active ? (
          <>
            <strong>{props.name}</strong>
            <p>{props.description || "暂无说明"}</p>
          </>
        ) : (
          <strong>请从左侧选择或新建配装</strong>
        )}
      </div>
      {props.active && <span className={`current-fitting-status${needsSave ? " is-dirty" : ""}`}>{statusLabel}</span>}
      <div className="current-fitting-actions">
        <button className="primary-button" type="button" disabled={props.disabled || !props.active || !needsSave} onClick={props.onSave}>{props.saveStatus === "error" ? "重试保存" : "保存修改"}</button>
        <button className="secondary-button" type="button" disabled={props.disabled || !props.active} onClick={props.onEdit}>编辑名称与说明</button>
        <button className="danger-button" type="button" disabled={props.disabled || !props.active} onClick={props.onDelete}>删除配装</button>
      </div>
    </section>
  );
}
