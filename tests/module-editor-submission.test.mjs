import assert from "node:assert/strict";
import test from "node:test";
import "./typescript-register.mjs";

const { submitModuleEditorDefinition } = await import("../src/utils/submitModuleEditorDefinition.ts");
const original = {
  id: "existing-module", name: "现有模块", type: "储运", color: "#000000",
  baseShape: [{ x: 0, y: 0 }], availableQuantity: 5,
  allowRotation: true, allowMirror: false, baseScore: 0.1, attributes: { mass: 2 },
};

for (const mode of ["create", "edit"]) {
  test(`${mode}: invalid inventory reports a validation error without updating modules`, () => {
    const modules = [structuredClone(original)];
    const before = structuredClone(modules);
    let saveCalls = 0;
    const onSave = (definition) => {
      saveCalls += 1;
      if (mode === "create") modules.push(definition);
      else modules[0] = definition;
    };
    for (const quantity of [Number(""), Number("not-a-number"), Number("1e309"), Number("-1e309"),
      0, -1, 0.5, 1.5, 99.1, 100, Number.MAX_SAFE_INTEGER]) {
      const draft = { ...original, id: mode === "create" ? "new-module" : original.id,
        name: "待提交模块", availableQuantity: quantity };
      assert.throws(() => submitModuleEditorDefinition(draft, onSave), /库存数量必须为 1～99 的有限整数/);
      assert.equal(saveCalls, 0);
      assert.deepEqual(modules, before);
    }
  });

  test(`${mode}: valid inventory boundaries commit once and preserve the submitted module`, () => {
    for (const quantity of [1, 2, 98, 99]) {
      const modules = [structuredClone(original)];
      const draft = { ...structuredClone(original), id: mode === "create" ? "new-module" : original.id,
        name: "已提交模块", availableQuantity: quantity };
      let saveCalls = 0;
      const onSave = (definition) => {
        saveCalls += 1;
        if (mode === "create") modules.push(definition);
        else modules[0] = definition;
      };
      assert.throws(() => submitModuleEditorDefinition({ ...draft, availableQuantity: NaN }, onSave), /库存数量/);
      submitModuleEditorDefinition(draft, onSave);
      assert.equal(saveCalls, 1);
      assert.equal(modules.length, mode === "create" ? 2 : 1);
      assert.deepEqual(modules.at(-1), draft);
      if (mode === "create") assert.deepEqual(modules[0], original);
    }
  });
}

test("editor submission retains score validation before updating module state", () => {
  let saveCalls = 0;
  for (const score of [-1, NaN, Infinity, 0.1234]) {
    assert.throws(() => submitModuleEditorDefinition({ ...original, baseScore: score }, () => { saveCalls += 1; }), /评分/);
  }
  assert.equal(saveCalls, 0);
});
