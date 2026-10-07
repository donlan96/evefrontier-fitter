import assert from "node:assert/strict";
import { test } from "node:test";
import "./typescript-register.mjs";

const [library, { exampleBoard }, { exampleModules }] = await Promise.all([
  import("../src/persistence/fittingLibrary.ts"),
  import("../src/data/exampleBoard.ts"),
  import("../src/data/exampleModules.ts"),
]);

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

function input(name, activeFittingId = null) {
  return {
    activeFittingId,
    boardId: exampleBoard.id,
    name,
    description: "极简其他装备，优先扩大采矿容量",
    placements: [],
    solverSettings: {
      rules: exampleModules.map((module, index) => ({
        moduleId: module.id,
        requiredCount: index === 0 ? 1 : 0,
        enabled: index !== 0,
        maxCount: module.availableQuantity,
      })),
      scope: "rearrange-unlocked",
      timeLimitMs: 300_000,
      searchWorkers: { mode: "standard" },
      lockedPlacementIds: [],
    },
  };
}

test("saves, updates, duplicates and deletes named fitting profiles", () => {
  const storage = new MemoryStorage();
  const first = library.saveFittingToLibrary(storage, input("轻型采矿"), false, "2026-07-25T01:00:00.000Z");
  assert.equal(first.entries.length, 1);
  assert.equal(first.entry.solverSettings.scope, "rearrange-unlocked");
  assert.equal(first.entry.boardId, exampleBoard.id);

  const updatedInput = input("轻型采矿·改", first.entry.id);
  const updated = library.saveFittingToLibrary(storage, updatedInput, false, "2026-07-25T01:01:00.000Z");
  assert.equal(updated.entries.length, 1);
  assert.equal(updated.entry.id, first.entry.id);
  assert.equal(updated.entry.name, "轻型采矿·改");
  assert.equal(updated.entry.createdAt, first.entry.createdAt);

  const copied = library.saveFittingToLibrary(storage, updatedInput, true, "2026-07-25T01:02:00.000Z");
  assert.equal(copied.entries.length, 2);
  assert.notEqual(copied.entry.id, first.entry.id);

  const remaining = library.deleteSavedFitting(storage, first.entry.id);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, copied.entry.id);
});

test("profile signatures include name, description, layout and solver settings", () => {
  const base = input("均衡配置");
  assert.equal(library.createFittingContentSignature(base), library.createFittingContentSignature({ ...base }));
  assert.notEqual(
    library.createFittingContentSignature(base),
    library.createFittingContentSignature({ ...base, description: "战斗配置" }),
  );
  assert.notEqual(
    library.createFittingContentSignature(base),
    library.createFittingContentSignature({
      ...base,
      solverSettings: { ...base.solverSettings, rules: base.solverSettings.rules.map((rule, index) => index === 0 ? { ...rule, requiredCount: 0 } : rule) },
    }),
  );
  assert.notEqual(
    library.createFittingContentSignature(base),
    library.createFittingContentSignature({
      ...base,
      solverSettings: { ...base.solverSettings, searchWorkers: { mode: "custom", value: 12 } },
    }),
  );
});

test("restores old profiles without worker settings as standard eight", () => {
  const storage = new MemoryStorage();
  const saved = library.saveFittingToLibrary(storage, input("旧线程配置"));
  const raw = JSON.parse(storage.getItem(library.FITTING_LIBRARY_STORAGE_KEY));
  delete raw.entries[0].solverSettings.searchWorkers;
  storage.setItem(library.FITTING_LIBRARY_STORAGE_KEY, JSON.stringify(raw));
  assert.deepEqual(library.loadSavedFittings(storage)[0].solverSettings.searchWorkers, { mode: "standard" });
  assert.equal(saved.entry.solverSettings.searchWorkers.mode, "standard");

  raw.entries[0].solverSettings.searchWorkers = { mode: "standard", value: null };
  storage.setItem(library.FITTING_LIBRARY_STORAGE_KEY, JSON.stringify(raw));
  assert.deepEqual(library.loadSavedFittings(storage)[0].solverSettings.searchWorkers, { mode: "standard" });
});

test("filters named fittings by their owning board", () => {
  const storage = new MemoryStorage();
  library.saveFittingToLibrary(storage, input("轻型采矿"));
  library.saveFittingToLibrary(storage, { ...input("重型运输"), boardId: "board-heavy" });
  const currentBoardEntries = library.loadSavedFittingsForBoard(storage, exampleBoard.id);
  assert.deepEqual(currentBoardEntries.map((entry) => entry.name), ["轻型采矿"]);
});

test("editing fitting profile does not save unsaved layout changes", () => {
  const storage = new MemoryStorage();
  const saved = library.saveFittingToLibrary(storage, input("均衡配置"));
  const edited = library.updateSavedFittingProfile(storage, saved.entry.id, "均衡配置·改名", "只修改说明");
  assert.equal(edited.entry.name, "均衡配置·改名");
  assert.equal(edited.entry.description, "只修改说明");
  assert.deepEqual(edited.entry.placements, saved.entry.placements);
  assert.deepEqual(edited.entry.solverSettings, saved.entry.solverSettings);
});

test("ignores corrupted fitting entries without discarding valid profiles", () => {
  const storage = new MemoryStorage();
  const saved = library.saveFittingToLibrary(storage, input("有效配装"));
  const raw = JSON.parse(storage.getItem(library.FITTING_LIBRARY_STORAGE_KEY));
  raw.entries.push({ id: "broken", name: "损坏配装" });
  storage.setItem(library.FITTING_LIBRARY_STORAGE_KEY, JSON.stringify(raw));
  const restored = library.loadSavedFittings(storage);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, saved.entry.id);
});
