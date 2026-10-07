import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import "./typescript-register.mjs";

const [persistence, bootstrap, validation] = await Promise.all([
  import("../src/persistence/filePersistence.ts"),
  import("../src/persistence/persistenceBootstrap.ts"),
  import("../src/persistence/fitterDataValidation.ts"),
]);
const BOARD_STORAGE_KEY = "eve-frontier-grid-fitting.boards.v3";
const FITTING_STORAGE_KEY = "eve-frontier-grid-fitting.fittings.v3";

function emptyDocument() {
  return {
    schemaVersion: 1,
    revision: 0,
    savedAt: null,
    boards: { version: 3, savedBoards: [], history: [] },
    fittings: { version: 3, entries: [] },
    solutionHistory: { version: 3, models: {} },
    workspace: null,
  };
}

function boardEntry(id) {
  return { board: { id, name: id, width: 1, height: 1, mask: [[1]] }, savedAt: "now" };
}

test("failed initial read sends no PUT and a later read keeps the disk workspace", async () => {
  let reads = 0;
  let puts = 0;
  const disk = emptyDocument();
  disk.revision = 4;
  disk.boards.savedBoards = [boardEntry("disk-board")];
  const load = async () => {
    reads += 1;
    if (reads === 1) throw new Error("service unavailable");
    return { document: disk, source: "primary" };
  };
  const save = async (body) => { puts += 1; return body; };

  await assert.rejects(bootstrap.readPersistenceBaseline(() => {}, load, save), /unavailable/);
  assert.equal(puts, 0);
  const recovered = await bootstrap.readPersistenceBaseline(() => {}, load, save);
  assert.equal(puts, 0);
  assert.equal(recovered.source, "primary");
  assert.equal(recovered.savedBoards[0].board.id, "disk-board");
});

test("serializes saves and assigns strictly increasing revisions", async () => {
  const requests = [];
  let releaseFirst;
  const save = async (body) => {
    requests.push(body);
    if (requests.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
    return body;
  };
  const states = [];
  const storage = new persistence.FilePersistenceStorage(emptyDocument(), (state) => states.push(state.status), save);
  storage.setItem(BOARD_STORAGE_KEY, JSON.stringify({ version: 3, savedBoards: [boardEntry("a")], history: [] }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  storage.setItem(BOARD_STORAGE_KEY, JSON.stringify({ version: 3, savedBoards: [boardEntry("b")], history: [] }));
  releaseFirst();
  await storage.flush();

  assert.deepEqual(requests.map((item) => item.revision), [1, 2]);
  assert.equal(requests[0].boards.savedBoards[0].board.id, "a");
  assert.equal(requests[1].boards.savedBoards[0].board.id, "b");
  assert.equal(states.at(-1), "saved");
});

test("keeps failed data in memory and retries the same revision", async () => {
  const requests = [];
  let fail = true;
  let serverDocument = emptyDocument();
  const save = async (body) => {
    requests.push(body);
    if (body.revision === serverDocument.revision + 1) serverDocument = structuredClone(body);
    if (fail) throw new Error("response lost");
    if (body.revision === serverDocument.revision && JSON.stringify(body) === JSON.stringify(serverDocument)) return body;
    throw new Error("unexpected retry payload");
  };
  const states = [];
  const storage = new persistence.FilePersistenceStorage(emptyDocument(), (state) => states.push(state.status), save);
  const boards = { version: 3, savedBoards: [boardEntry("retained")], history: [] };
  storage.setItem(BOARD_STORAGE_KEY, JSON.stringify(boards));
  await assert.rejects(storage.flush(), /response lost/);
  assert.equal(JSON.parse(storage.getItem(BOARD_STORAGE_KEY)).savedBoards[0].board.id, "retained");

  fail = false;
  await storage.flush();
  assert.deepEqual(requests.map((item) => item.revision), [1, 1]);
  assert.equal(states.at(-1), "saved");
});

test("two clients stop retrying after a revision conflict", async () => {
  let serverDocument = emptyDocument();
  let secondClientRequests = 0;
  const save = async (body, second = false) => {
    if (second) secondClientRequests += 1;
    if (body.revision === serverDocument.revision + 1) {
      serverDocument = structuredClone(body);
      return body;
    }
    throw new persistence.RevisionConflictError(serverDocument.revision, "conflict");
  };
  const first = new persistence.FilePersistenceStorage(emptyDocument(), () => {}, (body) => save(body));
  const secondStates = [];
  const second = new persistence.FilePersistenceStorage(emptyDocument(), (state) => secondStates.push(state), (body) => save(body, true));

  first.setItem(BOARD_STORAGE_KEY, JSON.stringify({ version: 3, savedBoards: [boardEntry("first-page")], history: [] }));
  await first.flush();
  second.setItem(BOARD_STORAGE_KEY, JSON.stringify({ version: 3, savedBoards: [{ board: { id: "other", name: "other", width: 1, height: 1, mask: [[1]] }, savedAt: "now" }], history: [] }));
  await assert.rejects(second.flush(), /conflict/);
  await assert.rejects(second.flush(), /conflict/);

  assert.equal(secondClientRequests, 1);
  assert.equal(secondStates.at(-1).conflict, true);
  assert.equal(JSON.parse(second.getItem(BOARD_STORAGE_KEY)).savedBoards[0].board.id, "other");
});

test("batches synchronous multi-partition changes into one consistent revision", async () => {
  const initial = emptyDocument();
  initial.boards.savedBoards = [{ board: { id: "board-a", name: "A", width: 1, height: 1, mask: [[1]] }, savedAt: "now" }];
  initial.fittings.entries = [{
    id: "fit-a", boardId: "board-a", name: "fit", description: "", createdAt: "now", updatedAt: "now", placements: [],
    solverSettings: { rules: [], scope: "fill-current", timeLimitMs: 30000, lockedPlacementIds: [] },
  }];
  const requests = [];
  const storage = new persistence.FilePersistenceStorage(initial, () => {}, async (body) => {
    requests.push(structuredClone(body));
    return body;
  });

  storage.setItem(BOARD_STORAGE_KEY, JSON.stringify({ version: 3, savedBoards: [], history: [] }));
  storage.setItem(FITTING_STORAGE_KEY, JSON.stringify({ version: 3, entries: [] }));
  await storage.flush();

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].boards.savedBoards, []);
  assert.deepEqual(requests[0].fittings.entries, []);
});

test("does not save or increment revision when only workspace timestamps change", async () => {
  const initial = emptyDocument();
  initial.revision = 7;
  initial.workspace = {
    snapshotVersion: 3,
    savedAt: "first",
    document: { version: 3, board: { id: "board-a" }, modules: [], build: { placements: [] } },
    fitting: { activeFittingId: null, name: "fit", description: "" },
    solver: { rules: [], scope: "fill-current", timeLimitMs: 30000, lockedPlacementIds: [], lastResult: null, lastResultFingerprint: null },
  };
  const requests = [];
  const storage = new persistence.FilePersistenceStorage(initial, () => {}, async (body) => {
    requests.push(body);
    return body;
  });
  const timestampOnly = structuredClone(initial.workspace);
  timestampOnly.savedAt = "second";

  storage.setItem("eve-frontier-grid-fitting.workspace.v3", JSON.stringify(timestampOnly));
  await storage.flush();

  assert.equal(requests.length, 0);
  assert.equal(storage.getItem("eve-frontier-grid-fitting.workspace.v3"), JSON.stringify(timestampOnly));
});

test("rejects unsupported top-level schema versions", () => {
  assert.throws(
    () => new persistence.FilePersistenceStorage({ ...emptyDocument(), schemaVersion: 2 }, () => {}, async (value) => value),
    /schemaVersion/,
  );
});

test("accepts backend-normalized standard worker settings with a null value", () => {
  const document = emptyDocument();
  document.fittings.entries = [{
    id: "fit-a",
    boardId: "board-a",
    name: "fit",
    description: "",
    createdAt: "now",
    updatedAt: "now",
    placements: [],
    solverSettings: {
      rules: [],
      scope: "fill-current",
      timeLimitMs: 30_000,
      searchWorkers: { mode: "standard", value: null },
      lockedPlacementIds: [],
    },
  }];
  assert.doesNotThrow(() => validation.parseFitterDataDocument(document));
  document.fittings.entries[0].solverSettings.searchWorkers.value = 8;
  assert.throws(() => validation.parseFitterDataDocument(document), /仅可用于自定义模式/);
});

test("rejects nested workspace corruption before publishing storage", () => {
  const document = emptyDocument();
  document.workspace = { snapshotVersion: 3, savedAt: "now", document: null };
  assert.throws(
    () => new persistence.FilePersistenceStorage(document, () => {}, async (value) => value),
    /document|存档|工作区/,
  );
});

test("runtime application never reads or writes browser LocalStorage", () => {
  const application = fs.readFileSync(new URL("../src/ShipFitterApp.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(application, /localStorage/i);
  assert.doesNotMatch(application, /finally\s*\{[\s\S]{0,200}setPersistenceReady\(true\)/);
  assert.match(application, /setPersistenceReadError\(message\)[\s\S]{0,200}setPersistenceReady\(false\)/);
  assert.match(application, /inert=\{persistenceReadBlocked \? true : undefined\}/);
  assert.match(application, />重新读取</);
  assert.match(application, />重新载入磁盘存档</);
});
