import assert from "node:assert/strict";
import { test } from "node:test";
import "./typescript-register.mjs";

const selectionMove = await import("../src/utils/translateBoardSelection.ts");

const board = {
  id: "board-a",
  name: "区域移动测试",
  width: 6,
  height: 5,
  mask: [
    [0, 0, 0, 0, 0, 0],
    [0, 1, 1, 0, 1, 0],
    [0, 1, 1, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
  ],
};

const module = {
  id: "module-a",
  name: "双格模块",
  baseShape: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
  color: "#fff",
  availableQuantity: 2,
  allowRotation: true,
  allowMirror: false,
  baseScore: 0,
  type: "test",
  attributes: {},
};

const placement = {
  instanceId: "placed-1",
  moduleId: module.id,
  origin: { x: 1, y: 1 },
  orientation: { rotation: 0, mirrored: false },
};

const selectedSquare = [
  { x: 1, y: 1 }, { x: 2, y: 1 },
  { x: 1, y: 2 }, { x: 2, y: 2 },
];

test("moves only the selected region and fully contained modules", () => {
  const input = { board, modules: [module], placements: [placement], selectedCells: selectedSquare, deltaX: 0, deltaY: 2 };
  assert.deepEqual(selectionMove.validateBoardSelectionMove(input), { valid: true, error: null });
  const result = selectionMove.translateBoardSelection(input);
  assert.ok(result);
  assert.deepEqual(result.board.mask, [
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 0],
    [0, 0, 0, 0, 0, 0],
    [0, 1, 1, 0, 0, 0],
    [0, 1, 1, 0, 0, 0],
  ]);
  assert.deepEqual(result.placements[0].origin, { x: 1, y: 3 });
});

test("rejects collision with an unselected active cell", () => {
  const validation = selectionMove.validateBoardSelectionMove({
    board,
    modules: [module],
    placements: [],
    selectedCells: [{ x: 1, y: 1 }],
    deltaX: 3,
    deltaY: 0,
  });
  assert.deepEqual(validation, { valid: false, error: "MASK_COLLISION" });
});

test("rejects clipping and partially selected placed modules", () => {
  const clipping = selectionMove.validateBoardSelectionMove({
    board,
    modules: [module],
    placements: [],
    selectedCells: selectedSquare,
    deltaX: -2,
    deltaY: 0,
  });
  assert.deepEqual(clipping, { valid: false, error: "OUT_OF_BOUNDS" });

  const partial = selectionMove.validateBoardSelectionMove({
    board,
    modules: [module],
    placements: [placement],
    selectedCells: [{ x: 1, y: 1 }],
    deltaX: 0,
    deltaY: 1,
  });
  assert.deepEqual(partial, { valid: false, error: "PARTIAL_PLACEMENT" });
});
