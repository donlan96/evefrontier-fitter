import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("solver module rules use compact cards with independent required and candidate controls", () => {
  const component = read("../src/components/SolverControls.tsx");
  const styles = read("../src/styles.css");

  assert.match(component, /solver-rule-grid/);
  assert.match(component, /solver-rule-card/);
  assert.match(component, /设为必装/);
  assert.match(component, /requiredCount: event\.target\.checked \? 1 : 0/);
  assert.match(component, /参与自动装配/);
  assert.match(component, /该型号已证明最优/);
  assert.doesNotMatch(component, /仅证明当前上限/);
  assert.match(styles, /repeat\(auto-fill, minmax\(220px, 1fr\)\)/);
  assert.match(styles, /\.optimality-stamp/);
});

test("desktop shell keeps page height fixed and delegates overflow to work areas", () => {
  const styles = read("../src/styles.css");

  assert.match(styles, /html, body \{ height: 100%; margin: 0; overflow: hidden;/);
  assert.match(styles, /\.app \{ height: 100vh; min-height: 0; overflow: hidden;/);
  assert.match(styles, /\.workspace \{ flex: 1; min-height: 0;/);
  assert.match(styles, /\.solver-scroll \{ flex: 1; min-height: 0; overflow: auto;/);
  assert.match(styles, /@media \(max-width: 920px\)[\s\S]*html, body \{ height: auto; overflow: auto; \}/);
});

test("solver controls expose standard, all-thread and bounded custom worker modes", () => {
  const component = read("../src/components/SolverControls.tsx");
  const application = read("../src/ShipFitterApp.tsx");

  assert.match(component, /标准（8，推荐）/);
  assert.match(component, /适合日常找高分/);
  assert.match(component, /全线程（\{props\.logicalCpuCount\}）/);
  assert.match(component, /更耗内存和发热/);
  assert.match(component, /不保证一定更快/);
  assert.match(component, /min=\{1\}/);
  assert.match(component, /max=\{customWorkerMaximum\}/);
  assert.match(application, /searchWorkers: \{ \.\.\.solverWorkerSetting \}/);
  assert.match(application, /navigator\.hardwareConcurrency/);
});
