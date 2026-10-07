import assert from "node:assert/strict";
import { test } from "node:test";
import "./typescript-register.mjs";

const api = await import("../src/services/dataApi.ts");

test("maps HTTP 409 to a revision conflict error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    detail: { message: "current data revision is 7", currentRevision: 7 },
  }), { status: 409, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(
      api.saveFitterData({}),
      (error) => error instanceof api.RevisionConflictError && error.currentRevision === 7,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("includes FastAPI validation paths in HTTP 422 errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    detail: [{
      type: "extra_forbidden",
      loc: ["body", "fittings", "entries", 0, "solverSettings", "searchWorkers"],
      msg: "Extra inputs are not permitted",
    }],
  }), { status: 422, statusText: "Unprocessable Content", headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(
      api.saveFitterData({}),
      (error) => error instanceof Error
        && error.message === "fittings.entries[0].solverSettings.searchWorkers: Extra inputs are not permitted",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
