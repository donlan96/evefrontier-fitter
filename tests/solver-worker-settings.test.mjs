import assert from "node:assert/strict";
import { test } from "node:test";
import "./typescript-register.mjs";

const workers = await import("../src/models/solver.ts");

test("defaults to standard eight without changing the stored mode", () => {
  assert.equal(workers.DEFAULT_SOLVER_WORKERS, 8);
  assert.deepEqual(workers.createDefaultSolverWorkerSetting(), { mode: "standard" });
});

test("clamps custom workers to the browser-visible logical thread range", () => {
  assert.deepEqual(workers.clampSolverWorkerSetting({ mode: "custom", value: 0 }, 16), { mode: "custom", value: 1 });
  assert.deepEqual(workers.clampSolverWorkerSetting({ mode: "custom", value: 12 }, 16), { mode: "custom", value: 12 });
  assert.deepEqual(workers.clampSolverWorkerSetting({ mode: "custom", value: 64 }, 16), { mode: "custom", value: 16 });
  assert.deepEqual(workers.clampSolverWorkerSetting({ mode: "custom", value: Number.NaN }, 16), { mode: "custom", value: 8 });
});

test("standard and all-thread modes do not retain a stale custom value", () => {
  assert.deepEqual(workers.clampSolverWorkerSetting({ mode: "standard", value: 12 }, 16), { mode: "standard" });
  assert.deepEqual(workers.clampSolverWorkerSetting({ mode: "all", value: 12 }, 16), { mode: "all" });
});
