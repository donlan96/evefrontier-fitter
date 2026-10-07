import assert from "node:assert/strict";
import { test } from "node:test";
import "./typescript-register.mjs";

const boardStorage = await import("../src/persistence/boardStorage.ts");

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

function board(name = "船体 A") {
  return { id: "board-a", name, width: 4, height: 4, mask: Array.from({ length: 4 }, () => [1, 1, 1, 1]) };
}

const placement = {
  instanceId: "placed-1",
  moduleId: "module-a",
  origin: { x: 0, y: 0 },
  orientation: { rotation: 0, mirrored: false },
};

test("saves, updates and creates distinct boards in the local board library", () => {
  const storage = new MemoryStorage();
  boardStorage.saveBoardToLibrary(storage, board(), false, "2026-07-25T00:00:00.000Z");
  boardStorage.saveBoardToLibrary(storage, board("船体 A 更新"), false, "2026-07-25T00:01:00.000Z");
  let saved = boardStorage.loadSavedBoards(storage);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].board.name, "船体 A 更新");

  const copied = boardStorage.saveBoardToLibrary(storage, saved[0].board, true, "2026-07-25T00:02:00.000Z");
  saved = copied.savedBoards;
  assert.equal(saved.length, 2);
  assert.notEqual(copied.board.id, "board-a");
});

test("records recoverable board and placement snapshots without duplicating the latest state", () => {
  const storage = new MemoryStorage();
  boardStorage.recordBoardHistory(storage, board(), [placement], [placement.instanceId], "2026-07-25T00:00:00.000Z");
  boardStorage.recordBoardHistory(storage, board(), [placement], [placement.instanceId], "2026-07-25T00:01:00.000Z");
  let history = boardStorage.loadBoardHistory(storage);
  assert.equal(history.length, 1);
  assert.equal(history[0].placements[0].instanceId, placement.instanceId);
  assert.deepEqual(history[0].lockedPlacementIds, [placement.instanceId]);

  for (let index = 1; index <= 21; index += 1) {
    boardStorage.recordBoardHistory(storage, board(`版本 ${index}`), [], [], `2026-07-25T00:${String(index).padStart(2, "0")}:00.000Z`);
  }
  history = boardStorage.loadBoardHistory(storage);
  assert.equal(history.length, 20);
  assert.equal(history[0].board.name, "版本 21");
});
