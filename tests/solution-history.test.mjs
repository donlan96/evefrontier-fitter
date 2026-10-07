import assert from "node:assert/strict";
import { test } from "node:test";
import "./typescript-register.mjs";

const [fingerprintApi, historyApi] = await Promise.all([
  import("../src/utils/buildModelFingerprint.ts"),
  import("../src/persistence/solutionHistory.ts"),
]);

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

const board = {
  id: "ship-alpha",
  name: "测试船体",
  width: 6,
  height: 1,
  mask: [[1, 1, 1, 1, 1, 1]],
};

function module(id = "cargo", score = 10) {
  return {
    id,
    name: id,
    type: "储运",
    baseShape: [{ x: 0, y: 0 }],
    color: "#000000",
    availableQuantity: 10,
    allowRotation: true,
    allowMirror: false,
    baseScore: score,
    attributes: {},
  };
}

function rule(moduleId, requiredCount, enabled = true, maxCount = 10) {
  return { moduleId, requiredCount, enabled, maxCount };
}

function placement(instanceId, moduleId, x, rotation = 0) {
  return { instanceId, moduleId, origin: { x, y: 0 }, orientation: { rotation, mirrored: false } };
}

function solution(count, offset = 0) {
  const placements = Array.from({ length: count }, (_, index) => placement(`p-${count}-${offset}-${index}`, "cargo", offset + index));
  return {
    id: `solution-${count}-${offset}`,
    placements,
    requiredSatisfied: true,
    moduleCounts: { cargo: count },
    totalScore: count * 10,
    occupiedCells: count,
    utilization: count / 6,
    remainingCells: 6 - count,
    isolatedEmptyCells: 0,
    emptyRegionCount: count === 6 ? 0 : 1,
    elapsedMs: 1,
  };
}

test("build model fingerprint sorts required and locked modules and ignores candidate settings", () => {
  const lockedA = placement("locked-a", "required-a", 0, 90);
  const lockedB = placement("locked-b", "required-b", 3, 0);
  const rulesA = [rule("required-b", 2), rule("cargo", 0, true, 9), rule("required-a", 1)];
  const rulesB = [rule("required-a", 1), rule("required-b", 2), rule("cargo", 0, false, 1)];
  const first = fingerprintApi.createBuildModelFingerprint(board, rulesA, [lockedA, lockedB], ["locked-b", "locked-a"]);
  const second = fingerprintApi.createBuildModelFingerprint(board, rulesB, [lockedB, lockedA], ["locked-a", "locked-b"]);
  assert.equal(first, second);
  assert.equal(first, fingerprintApi.createBuildModelFingerprint({ ...board, mask: [[1, 0, 1, 1, 1, 1]] }, rulesB, [lockedB, lockedA], ["locked-a", "locked-b"]));

  const changedRequired = fingerprintApi.createBuildModelFingerprint(board, [rule("required-a", 2), rule("required-b", 2)], [lockedA, lockedB], ["locked-a", "locked-b"]);
  assert.notEqual(first, changedRequired);
  const changedLock = fingerprintApi.createBuildModelFingerprint(board, rulesB, [{ ...lockedA, origin: { x: 1, y: 0 } }, lockedB], ["locked-a", "locked-b"]);
  assert.notEqual(first, changedLock);
});

test("stores only the five highest distinct layouts and rescales history with current scores", () => {
  const storage = new MemoryStorage();
  const cargo = module();
  const context = { board, modules: [cargo], rules: [rule("cargo", 0)], lockedPlacements: [] };
  const fingerprint = fingerprintApi.createBuildModelFingerprint(board, context.rules, [], []);
  for (let count = 1; count <= 5; count += 1) {
    historyApi.saveSolutionToHistory(storage, fingerprint, solution(count), context, `2026-07-25T00:0${count}:00.000Z`);
  }
  historyApi.saveSolutionToHistory(storage, fingerprint, solution(1, 5), context, "2026-07-25T00:06:00.000Z");
  let entries = historyApi.loadSolutionHistory(storage, fingerprint, context);
  assert.deepEqual(entries.map((entry) => entry.currentScore), [50, 40, 30, 20, 10]);

  historyApi.saveSolutionToHistory(storage, fingerprint, solution(6), context, "2026-07-25T00:07:00.000Z");
  entries = historyApi.loadSolutionHistory(storage, fingerprint, context);
  assert.deepEqual(entries.map((entry) => entry.currentScore), [60, 50, 40, 30, 20]);

  const rescoredContext = { ...context, modules: [module("cargo", 25)] };
  entries = historyApi.loadSolutionHistory(storage, fingerprint, rescoredContext);
  assert.equal(entries[0].currentScore, 150);
});

test("marks history invalid when a used module shape changes", () => {
  const storage = new MemoryStorage();
  const context = { board, modules: [module()], rules: [rule("cargo", 1)], lockedPlacements: [] };
  const fingerprint = fingerprintApi.createBuildModelFingerprint(board, context.rules, [], []);
  historyApi.saveSolutionToHistory(storage, fingerprint, solution(1), context);
  const changed = module();
  changed.baseShape = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
  const entries = historyApi.loadSolutionHistory(storage, fingerprint, { ...context, modules: [changed] });
  assert.equal(entries[0].valid, false);
  assert.ok(entries[0].reasons.some((reason) => reason.includes("形状已修改")));
});

test("keeps proofs and layouts but invalidates an oversized layout when candidate limits tighten", () => {
  const storage = new MemoryStorage();
  const context = { board, modules: [module()], rules: [rule("cargo", 0, true, 6)], lockedPlacements: [] };
  const fingerprint = fingerprintApi.createBuildModelFingerprint(board, context.rules, [], []);
  const best = solution(6);

  historyApi.saveSolutionToHistory(storage, fingerprint, best, context);
  let entries = historyApi.saveSolutionToHistory(
    storage,
    fingerprint,
    best,
    context,
    "2026-09-05T12:00:00.000Z",
    { score: 60, bestBound: 60 },
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].provenOptimal, true);
  assert.equal(entries[0].entry.optimalityProof.provenAt, "2026-09-05T12:00:00.000Z");

  const changedContext = { ...context, rules: [rule("cargo", 0, true, 5)] };
  entries = historyApi.loadSolutionHistory(storage, fingerprint, changedContext);
  assert.equal(entries[0].valid, false);
  assert.equal(entries[0].provenOptimal, false);
  assert.match(entries[0].proofInvalidReason, /规则已变化/);
  assert.ok(entries[0].reasons.some((reason) => reason.includes("最大数量 5")));
  const restored = historyApi.loadSolutionHistory(storage, fingerprint, context);
  assert.equal(restored[0].valid, true);
  assert.equal(restored[0].provenOptimal, true);
});

test("strict proof signature includes only modules that change the normalized solve problem", () => {
  const cargo = module();
  cargo.availableQuantity = 6;
  const baseContext = { board, modules: [cargo], rules: [rule("cargo", 0, true, 6)], lockedPlacements: [] };
  const baseSignature = historyApi.createOptimalityProblemSignature(baseContext);
  assert.equal(JSON.parse(baseSignature).version, 2);

  const disabled = module("disabled", 999);
  const disabledRule = rule("disabled", 0, false, 0);
  const withDisabled = { ...baseContext, modules: [cargo, disabled], rules: [...baseContext.rules, disabledRule] };
  assert.equal(historyApi.createOptimalityProblemSignature(withDisabled), baseSignature);

  const changedDisabled = { ...disabled, baseShape: [{ x: 0, y: 0 }, { x: 1, y: 0 }], availableQuantity: 1, baseScore: 1 };
  assert.equal(
    historyApi.createOptimalityProblemSignature({ ...withDisabled, modules: [cargo, changedDisabled] }),
    baseSignature,
  );
  const zeroStockEnabled = { ...disabled, availableQuantity: 0 };
  assert.equal(
    historyApi.createOptimalityProblemSignature({
      ...withDisabled,
      modules: [cargo, zeroStockEnabled],
      rules: [baseContext.rules[0], rule("disabled", 0, true, 10)],
    }),
    baseSignature,
  );

  const enabledSignature = historyApi.createOptimalityProblemSignature({
    ...withDisabled,
    rules: [baseContext.rules[0], rule("disabled", 0, true, 1)],
  });
  const requiredSignature = historyApi.createOptimalityProblemSignature({
    ...withDisabled,
    rules: [baseContext.rules[0], rule("disabled", 1, false, 0)],
  });
  const lockedSignature = historyApi.createOptimalityProblemSignature({
    ...withDisabled,
    lockedPlacements: [placement("locked-disabled", "disabled", 5)],
  });
  assert.notEqual(enabledSignature, baseSignature);
  assert.notEqual(requiredSignature, baseSignature);
  assert.notEqual(lockedSignature, baseSignature);

  const nonBindingStockChange = { ...cargo, availableQuantity: 10 };
  assert.equal(
    historyApi.createOptimalityProblemSignature({ ...baseContext, modules: [nonBindingStockChange] }),
    baseSignature,
  );
  const bindingStockChange = { ...cargo, availableQuantity: 5 };
  assert.notEqual(
    historyApi.createOptimalityProblemSignature({ ...baseContext, modules: [bindingStockChange] }),
    baseSignature,
  );
  assert.notEqual(
    historyApi.createOptimalityProblemSignature({ ...baseContext, modules: [module("cargo", 11)] }),
    baseSignature,
  );
  const reshapedCargo = { ...cargo, baseShape: [{ x: 0, y: 0 }, { x: 1, y: 0 }] };
  assert.notEqual(
    historyApi.createOptimalityProblemSignature({ ...baseContext, modules: [reshapedCargo] }),
    baseSignature,
  );
  assert.notEqual(
    historyApi.createOptimalityProblemSignature({ ...baseContext, modules: [{ ...cargo, allowRotation: false }] }),
    baseSignature,
  );
});

test("selects two cross-fingerprint strict-optimal training layouts with compatible geometry and module catalog", () => {
  const storage = new MemoryStorage();
  const cargo = module();
  const ignored = module("ignored", 999);
  const currentContext = {
    board,
    modules: [cargo, ignored],
    rules: [rule("cargo", 0, true, 6), rule("ignored", 0, false, 0)],
    lockedPlacements: [],
  };
  const sourceA = { ...currentContext, rules: [rule("cargo", 1, true, 6)] };
  const sourceB = { ...currentContext, rules: [rule("cargo", 2, true, 6)] };
  const incompatible = {
    ...currentContext,
    modules: [module("cargo", 11)],
    rules: [rule("cargo", 3, true, 6)],
  };
  const currentFingerprint = fingerprintApi.createBuildModelFingerprint(board, currentContext.rules, [], []);
  const fingerprintA = fingerprintApi.createBuildModelFingerprint(board, sourceA.rules, [], []);
  const fingerprintB = fingerprintApi.createBuildModelFingerprint(board, sourceB.rules, [], []);
  const incompatibleFingerprint = fingerprintApi.createBuildModelFingerprint(board, incompatible.rules, [], []);

  historyApi.saveSolutionToHistory(storage, fingerprintA, solution(6), sourceA, "2026-09-05T12:00:00.000Z", { score: 60, bestBound: 60 });
  historyApi.saveSolutionToHistory(storage, fingerprintB, solution(6), sourceB, "2026-09-05T13:00:00.000Z", { score: 60, bestBound: 60 });
  historyApi.saveSolutionToHistory(
    storage,
    incompatibleFingerprint,
    { ...solution(6), totalScore: 66 },
    incompatible,
    "2026-09-05T14:00:00.000Z",
    { score: 66, bestBound: 66 },
  );

  const training = historyApi.loadSoftSkeletonTrainingLayouts(
    storage,
    currentFingerprint,
    currentContext,
  );
  assert.equal(training.length, 2);
  assert.deepEqual(training.map((item) => item.sourceProblemFingerprint), [fingerprintB, fingerprintA]);
  assert.ok(training.every((item) => item.provenScore === 60 && item.bestBound === 60));
  const expectedSignature = solution(6).placements
    .map((item) => `${item.moduleId}@${item.orientation.rotation}:${item.origin.x},${item.origin.y}`)
    .sort()
    .join("|");
  assert.ok(training.every((item) => item.sourceLayoutSignature === expectedSignature && item.layout.length === 6));
});
