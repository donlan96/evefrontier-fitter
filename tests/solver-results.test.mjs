import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "./typescript-register.mjs";

const [history, scoring, layout, result, jsonApi, persistence] = await Promise.all([
  import("../src/persistence/solutionHistory.ts"), import("../src/core/scoring.ts"),
  import("../src/core/solverLayout.ts"), import("../src/core/solverResult.ts"),
  import("../src/utils/fittingJson.ts"), import("../src/persistence/filePersistence.ts"),
]);
const { SolverControls } = await import("../src/components/SolverControls.tsx");
const board = { id: "business-regression", name: "业务回归", width: 6, height: 1, mask: [[1, 1, 1, 1, 1, 1]] };
const cargo = { id: "cargo", name: "cargo", type: "cargo", baseShape: [{ x: 0, y: 0 }],
  color: "#000", availableQuantity: 6, allowRotation: true, allowMirror: false, baseScore: 10, attributes: {} };
const context = { board, modules: [cargo], rules: [{ moduleId: "cargo", requiredCount: 0, enabled: true, maxCount: 6 }], lockedPlacements: [] };
function solution(count, score = 10) {
  return { id: `s${count}`, placements: Array.from({ length: count }, (_, x) => ({ instanceId: `p${x}`, moduleId: "cargo", origin: { x, y: 0 }, orientation: { rotation: 0, mirrored: false } })),
    requiredSatisfied: true, moduleCounts: { cargo: count }, totalScore: scoring.scoreToUnits(score) * count / 1000,
    occupiedCells: count, utilization: count / 6, remainingCells: 6 - count, isolatedEmptyCells: 0, emptyRegionCount: 1, elapsedMs: 1 };
}
function snapshot(bestSolution, patch = {}) {
  return { jobId: "job", status: "completed", solverStatus: "OPTIMAL", provenOptimal: true,
    bestSolution, score: bestSolution?.totalScore ?? 0, bestBound: bestSolution?.totalScore ?? 0,
    optimalityGap: 0, elapsedMs: 1, errors: [], infeasibleReasons: [], ...patch };
}
class MemoryStorage {
  data = new Map();
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, value); }
}

test("tightening or disabling candidates removes the old Best without deleting history", () => {
  const storage = new MemoryStorage();
  history.saveSolutionToHistory(storage, "group", solution(6), context);
  const original = storage.getItem(history.SOLUTION_HISTORY_STORAGE_KEY);
  for (const rule of [{ ...context.rules[0], maxCount: 1 }, { ...context.rules[0], enabled: false, maxCount: 0 }]) {
    const changed = { ...context, rules: [rule] };
    const entries = history.loadSolutionHistory(storage, "group", changed);
    assert.equal(entries[0].valid, false);
    const legal = solution(rule.enabled ? 1 : 0);
    const merged = result.reconcileSolverSnapshot(snapshot(legal), entries[0].currentSolution, changed).snapshot;
    assert.equal(merged.bestSolution.placements.length, legal.placements.length);
    assert.equal(merged.score, legal.totalScore);
    assert.equal(merged.provenOptimal, true);
    assert.equal(layout.validateSolverLayout(changed, merged.bestSolution.placements).valid, true);
    assert.equal(layout.validateSolverLayout(changed, entries[0].currentSolution.placements).valid, false);
  }
  assert.equal(storage.getItem(history.SOLUTION_HISTORY_STORAGE_KEY), original);
  assert.equal(history.loadSolutionHistory(storage, "group", context)[0].valid, true);
});

test("fixed and required modules remain allowed when disabled, while extra instances are rejected", () => {
  const fixed = solution(1).placements;
  const disabled = { ...context, rules: [{ ...context.rules[0], enabled: false, maxCount: 0 }], lockedPlacements: fixed };
  assert.equal(layout.validateSolverLayout(disabled, fixed).valid, true);
  assert.equal(layout.validateSolverLayout(disabled, solution(2).placements).valid, false);
  assert.equal(layout.validateSolverLayout({ ...disabled, lockedPlacements: [], rules: [{ ...disabled.rules[0], requiredCount: 1 }] }, fixed).valid, true);
  assert.equal(layout.validateSolverLayout({ ...context, lockedPlacements: fixed }, []).valid, false);
  const noRules = { ...context, rules: [] };
  assert.equal(layout.validateSolverLayout(noRules, fixed).valid, false);
});

test("cached Best and proof are revalidated immediately when candidate rules change", () => {
  const restricted = { ...context, rules: [{ ...context.rules[0], maxCount: 1 }] };
  const cached = snapshot(solution(1));
  const signature = history.createOptimalityProblemSignature(restricted);
  assert.equal(result.revalidateCachedSolverSnapshot(cached, restricted,
    signature === history.createOptimalityProblemSignature(restricted)).provenOptimal, true);
  const expanded = result.revalidateCachedSolverSnapshot(cached, context,
    signature === history.createOptimalityProblemSignature(context));
  assert.equal(expanded.score, 10);
  assert.equal(expanded.provenOptimal, false);
  assert.equal(expanded.problemChanged, true);
  const controls = renderToStaticMarkup(createElement(SolverControls, {
    modules: context.modules, placements: [], rules: context.rules, scope: "empty-board", lockedCount: 0,
    timeLimitMs: 1000, workerSetting: { mode: "standard", value: null }, logicalCpuCount: 8,
    solving: false, remainingMs: null, elapsedMs: 1, result: expanded, fingerprintLabel: "test", historyEntries: [],
  }));
  assert.match(controls, /Best bound<strong>需重新计算/);
  assert.match(controls, /评分差距<strong>待计算/);
  assert.doesNotMatch(controls, /已证明最优/);
  const disabled = { ...restricted, rules: [{ ...restricted.rules[0], enabled: false }] };
  const invalid = result.revalidateCachedSolverSnapshot(cached, disabled, false);
  assert.equal(invalid.bestSolution, null);
  assert.equal(invalid.provenOptimal, false);
  assert.equal(invalid.problemChanged, true);
  const restored = result.revalidateCachedSolverSnapshot(cached, restricted, false);
  assert.equal(restored.bestSolution.placements.length, 1);
  assert.equal(restored.provenOptimal, false);
});

test("fill-current validates every fixed position and stop preserves only a legal complete Best", () => {
  const fixed = solution(2).placements;
  const filling = { ...context, rules: [{ ...context.rules[0], maxCount: 1 }], lockedPlacements: fixed };
  const stopped = result.reconcileSolverSnapshot(snapshot(null, { status: "stopped", solverStatus: "STOPPED", provenOptimal: false, bestBound: 30 }), solution(2), filling).snapshot;
  assert.equal(stopped.score, 20);
  assert.equal(stopped.bestSolution.placements.length, 2);
  assert.equal(stopped.provenOptimal, false);
  const wrongFixed = solution(2);
  wrongFixed.placements[1].origin.x = 4;
  assert.equal(result.reconcileSolverSnapshot(snapshot(null), wrongFixed, filling).snapshot.bestSolution, null);
});

test("invalid backend layouts and unverified optimal flags cannot replace a complete incumbent", () => {
  const valid = solution(2);
  const overlapping = solution(3);
  overlapping.placements[1].origin.x = 0;
  const merged = result.reconcileSolverSnapshot(snapshot(overlapping), valid, context).snapshot;
  assert.equal(merged.score, 20);
  assert.equal(merged.provenOptimal, false);
  assert.ok(merged.errors.some((error) => error.includes("完整校验")));
  for (const solverStatus of ["FEASIBLE", "UNKNOWN", "STOPPED"]) {
    assert.equal(result.reconcileSolverSnapshot(snapshot(valid, { solverStatus }), valid, context).snapshot.provenOptimal, false);
  }
  assert.equal(result.reconcileSolverSnapshot(snapshot(valid, { provenOptimal: false }), valid, context).snapshot.provenOptimal, false);
  assert.equal(result.reconcileSolverSnapshot(snapshot(valid, { score: 999 }), valid, context).snapshot.provenOptimal, false);
});

test("fractional scores stay exact through history, proof, file save, reload and result reconciliation", async () => {
  const fractional = { ...context, modules: [{ ...cargo, baseScore: 0.1 }] };
  const best = solution(3, 0.1);
  let disk = { schemaVersion: 1, revision: 0, savedAt: null, boards: { version: 3, savedBoards: [], history: [] },
    fittings: { version: 3, entries: [] }, solutionHistory: { version: 3, models: {} }, workspace: null };
  const store = new persistence.FilePersistenceStorage(disk, () => {}, async (document) => { disk = structuredClone(document); return disk; });
  history.saveSolutionToHistory(store, "fractional", best, fractional, "2026-10-02", { score: 0.3, bestBound: 0.3 });
  await store.flush();
  const restarted = new persistence.FilePersistenceStorage(disk, () => {}, async (document) => document);
  const entries = history.loadSolutionHistory(restarted, "fractional", fractional);
  assert.equal(entries[0].currentScore, 0.3);
  assert.equal(entries[0].provenOptimal, true);
  assert.equal(scoring.calculateLayoutScore(fractional.modules, best.placements), 0.3);
  assert.equal(result.reconcileSolverSnapshot(snapshot(best), entries[0].currentSolution, fractional).snapshot.provenOptimal, true);
});

test("import and module-editor validation reject exactly the shared invalid score cases", () => {
  const cases = JSON.parse(readFileSync(new URL("./fixtures/module-score-cases.json", import.meta.url), "utf8"));
  for (const { score, valid } of cases) {
    const document = jsonApi.createFittingDocument(board, [{ ...cargo, baseScore: score }], []);
    if (valid) {
      assert.equal(scoring.validateModuleScore(score), score);
      assert.equal(jsonApi.parseFittingDocument(JSON.stringify(document)).modules[0].baseScore, score);
    } else {
      assert.throws(() => scoring.validateModuleScore(score), /评分/);
      assert.throws(() => jsonApi.parseFittingDocument(JSON.stringify(document)), /baseScore/);
    }
  }
  for (const score of [NaN, Infinity, -Infinity, undefined]) assert.throws(() => scoring.validateModuleScore(score));
});
