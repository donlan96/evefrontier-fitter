import assert from "node:assert/strict";
import { test } from "node:test";
import "./typescript-register.mjs";

const [jsonApi, { exampleBoard }, { exampleModules }] = await Promise.all([
  import("../src/utils/fittingJson.ts"),
  import("../src/data/exampleBoard.ts"),
  import("../src/data/exampleModules.ts"),
]);

test("round-trips a fitting document as plain JSON", () => {
  const placements = [{
    instanceId: "cargo-1",
    moduleId: "module-cargo",
    origin: { x: 4, y: 0 },
    orientation: { rotation: 0, mirrored: false },
  }];
  const source = jsonApi.createFittingDocument(exampleBoard, exampleModules, placements);
  const parsed = jsonApi.parseFittingDocument(jsonApi.serializeFittingDocument(source));
  assert.deepEqual(parsed, source);
});

test("recognizes an imported layout that belongs to the current board and module definitions", () => {
  const imported = jsonApi.createFittingDocument(exampleBoard, exampleModules, [{
    instanceId: "reactor-1",
    moduleId: "module-reactor",
    origin: { x: 4, y: 0 },
    orientation: { rotation: 0, mirrored: false },
  }]);
  assert.equal(jsonApi.hasMatchingFittingDefinitions(exampleBoard, exampleModules, imported), true);

  const changedBoard = { ...exampleBoard, mask: exampleBoard.mask.map((row) => [...row]) };
  changedBoard.mask[0][0] = changedBoard.mask[0][0] === 1 ? 0 : 1;
  assert.equal(jsonApi.hasMatchingFittingDefinitions(changedBoard, exampleModules, imported), false);

  const changedModules = exampleModules.map((module, index) => index === 0
    ? { ...module, baseScore: module.baseScore + 1 }
    : module);
  assert.equal(jsonApi.hasMatchingFittingDefinitions(exampleBoard, changedModules, imported), true);

  const changedShapeModules = exampleModules.map((module, index) => index === 0
    ? { ...module, baseShape: module.baseShape.slice(0, -1) }
    : module);
  assert.equal(jsonApi.hasMatchingFittingDefinitions(exampleBoard, changedShapeModules, imported), false);
});

test("rejects overlapping and mirrored imported placements", () => {
  const source = jsonApi.createFittingDocument(exampleBoard, exampleModules, [{
    instanceId: "cargo-1",
    moduleId: "module-cargo",
    origin: { x: 4, y: 0 },
    orientation: { rotation: 0, mirrored: false },
  }]);
  const overlapping = structuredClone(source);
  overlapping.build.placements.push({
    ...structuredClone(overlapping.build.placements[0]),
    instanceId: "cargo-2",
  });
  assert.throws(() => jsonApi.parseFittingDocument(JSON.stringify(overlapping)), /OVERLAP/);

  const mirrored = structuredClone(source);
  mirrored.build.placements[0].orientation.mirrored = true;
  assert.throws(() => jsonApi.parseFittingDocument(JSON.stringify(mirrored)), /不允许导入镜像模块/);
});
