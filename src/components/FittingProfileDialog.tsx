interface FittingProfileDialogProps {
  mode: "create" | "edit";
  name: string;
  description: string;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function FittingProfileDialog(props: FittingProfileDialogProps) {
  return (
    <div className="dialog-backdrop" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && props.onCancel()}>
      <section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="fitting-profile-title">
        <span className="eyebrow">{props.mode === "create" ? "NEW FITTING" : "FITTING PROFILE"}</span>
        <h2 id="fitting-profile-title">{props.mode === "create" ? "新建配装" : "编辑名称与说明"}</h2>
        <label>
          <span>配装名称</span>
          <input autoFocus value={props.name} maxLength={80} placeholder="例如：采矿极限" onChange={(event) => props.onNameChange(event.target.value)} onKeyDown={(event) => event.key === "Enter" && props.name.trim() && props.onConfirm()} />
        </label>
        <label>
          <span>说明</span>
          <textarea value={props.description} maxLength={500} placeholder="例如：牺牲非必要设备，尽量提高货舱容量" onChange={(event) => props.onDescriptionChange(event.target.value)} />
        </label>
        <div className="profile-dialog-actions">
          <button className="secondary-button" type="button" onClick={props.onCancel}>取消</button>
          <button className="primary-button" type="button" disabled={!props.name.trim()} onClick={props.onConfirm}>{props.mode === "create" ? "创建配装" : "保存资料"}</button>
        </div>
      </section>
    </div>
  );
}
