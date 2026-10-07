import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./typescript-register.mjs";

const [{ parseFitterDataDocument }, { FilePersistenceStorage }, { loadSolutionHistory }] = await Promise.all([
  import("../src/persistence/fitterDataValidation.ts"),
  import("../src/persistence/filePersistence.ts"),
  import("../src/persistence/solutionHistory.ts"),
]);

const document = parseFitterDataDocument(JSON.parse(readFileSync(process.argv[2], "utf8")));
const storage = new FilePersistenceStorage(document, () => {}, async (value) => value);
const entries = loadSolutionHistory(storage, "cross-layer", {
  board: { id: "board", name: "board", width: 1, height: 1, mask: [[1]] },
  modules: [],
  rules: [],
  lockedPlacements: [],
});

assert.equal(entries.length, 1);
assert.equal(entries[0].valid, true);
assert.equal(entries[0].entry.optimalityProof, null);
process.stdout.write("cross-layer-history-ok");
