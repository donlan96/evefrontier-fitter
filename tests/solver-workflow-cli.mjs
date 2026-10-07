import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./typescript-register.mjs";

const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const [history, result, layout] = await Promise.all([
  import("../src/persistence/solutionHistory.ts"), import("../src/core/solverResult.ts"),
  import("../src/core/solverLayout.ts"),
]);
if (input.action === "signature") {
  process.stdout.write(history.createOptimalityProblemSignature(input.context));
} else {
  const storage = { data: new Map(), getItem(key) { return this.data.get(key) ?? null; }, setItem(key, value) { this.data.set(key, value); } };
  history.saveSolutionToHistory(storage, "workflow", input.initialSolution, input.initialContext,
    "2026-10-02", input.initialProof);
  const before = storage.getItem(history.SOLUTION_HISTORY_STORAGE_KEY);
  const entries = history.loadSolutionHistory(storage, "workflow", input.context);
  const merged = result.reconcileSolverSnapshot(input.snapshot, entries[0]?.currentSolution ?? null, input.context).snapshot;
  assert.equal(layout.validateSolverLayout(input.context, merged.bestSolution.placements).valid, true);
  assert.equal(storage.getItem(history.SOLUTION_HISTORY_STORAGE_KEY), before);
  process.stdout.write(JSON.stringify({ historyValid: entries[0]?.valid, historyProven: entries[0]?.provenOptimal,
    score: merged.score, provenOptimal: merged.provenOptimal, moduleCounts: merged.bestSolution.moduleCounts }));
}
