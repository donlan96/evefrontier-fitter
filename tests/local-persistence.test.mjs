import assert from "node:assert/strict";
import { test } from "node:test";
import "./typescript-register.mjs";

const [persistence, jsonApi, { exampleBoard }, { exampleModules }] = await Promise.all([
  import("../src/persistence/localWorkspace.ts"),
  import("../src/utils/fittingJson.ts"),
  import("../src/data/exampleBoard.ts"),
  import("../src/data/exampleModules.ts"),
]);

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

function snapshot(name, savedAt, lastResult = null) {
  const document = jsonApi.createFittingDocument({ ...exampleBoard, name }, exampleModules, []);
  return persistence.createWorkspaceSnapshot(document, {
    rules: exampleModules.map((module) => ({ moduleId: module.id, requiredCount: 0, enabled: false, maxCount: module.availableQuantity })),
    scope: "fill-current",
    timeLimitMs: 30_000,
    searchWorkers: { mode: "standard" },
    lockedPlacementIds: [],
    lastResult,
    lastResultFingerprint: lastResult ? "model-fingerprint-a" : null,
  }, {
    activeFittingId: lastResult ? "saved-fitting-a" : null,
    name: `${name}配装`,
    description: "测试备注",
  }, savedAt);
}

test("saves and restores the current workspace in the in-memory document", () => {
  const storage = new MemoryStorage();
  const second = snapshot("第二版", "2026-07-25T00:01:00.000Z");
  persistence.saveWorkspaceSnapshot(storage, second);
  assert.equal(persistence.loadWorkspaceSnapshot(storage).snapshot.document.board.name, "第二版");
  assert.equal(persistence.loadWorkspaceSnapshot(storage).fromBackup, false);
});

test("restores the last solver result until a later result replaces it", () => {
  const storage = new MemoryStorage();
  const result = {
    jobId: "test-job",
    status: "completed",
    bestSolution: null,
    score: 327,
    bestBound: 327,
    optimalityGap: 0,
    elapsedMs: 125,
    solverStatus: "OPTIMAL",
    provenOptimal: true,
    infeasibleReasons: [],
    errors: [],
  };
  persistence.saveWorkspaceSnapshot(storage, snapshot("保留求解结果", "2026-07-25T00:02:00.000Z", result));

  const restored = persistence.loadWorkspaceSnapshot(storage).snapshot;
  assert.deepEqual(restored.solver.lastResult, result);
  assert.equal(restored.solver.lastResultFingerprint, "model-fingerprint-a");
  assert.equal(restored.fitting.activeFittingId, "saved-fitting-a");
  assert.equal(restored.fitting.description, "测试备注");
});

test("rejects obsolete workspace snapshots instead of migrating changed game data", () => {
  const stored = snapshot("旧存档", "2026-07-25T00:03:00.000Z");
  stored.snapshotVersion = 1;
  assert.throws(() => persistence.parseWorkspaceSnapshot(JSON.stringify(stored)), /不支持的本地存档版本/);
});

test("restores legacy worker settings as standard eight and persists custom settings", () => {
  const legacy = snapshot("旧线程设置", "2026-07-25T00:04:00.000Z");
  delete legacy.solver.searchWorkers;
  const restoredLegacy = persistence.parseWorkspaceSnapshot(JSON.stringify(legacy));
  assert.deepEqual(restoredLegacy.solver.searchWorkers, { mode: "standard" });

  const custom = snapshot("自定义线程", "2026-07-25T00:05:00.000Z");
  custom.solver.searchWorkers = { mode: "custom", value: 12 };
  assert.deepEqual(persistence.parseWorkspaceSnapshot(JSON.stringify(custom)).solver.searchWorkers, { mode: "custom", value: 12 });

  const backendNormalized = snapshot("后端标准线程", "2026-07-25T00:06:00.000Z");
  backendNormalized.solver.searchWorkers = { mode: "standard", value: null };
  assert.deepEqual(persistence.parseWorkspaceSnapshot(JSON.stringify(backendNormalized)).solver.searchWorkers, { mode: "standard" });
});
