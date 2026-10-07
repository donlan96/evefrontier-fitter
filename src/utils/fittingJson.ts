import type { BoardCell, BoardDefinition } from "../models/board";
import type { FittingDocument } from "../models/fittingDocument";
import { FITTING_DOCUMENT_TYPE, FITTING_DOCUMENT_VERSION } from "../models/fittingDocument";
import type { ModuleDefinition, Rotation } from "../models/module";
import type { PlacedModuleData } from "../models/placement";
import { isConnectedShape, normalizeShape, pointKey } from "./normalizeShape";
import { validatePlacement } from "./validatePlacement";
import { validateModuleScore } from "../core/scoring";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} 必须是非空字符串。`);
  return value;
}

function requireInteger(value: unknown, field: string, minimum?: number): number {
  if (!Number.isInteger(value) || (minimum !== undefined && (value as number) < minimum)) {
    throw new Error(`${field} 必须是${minimum !== undefined ? `不小于 ${minimum} 的` : ""}整数。`);
  }
  return value as number;
}

function parseBoard(value: unknown): BoardDefinition {
  if (!isRecord(value)) throw new Error("board 必须是对象。");
  const width = requireInteger(value.width, "board.width", 1);
  const height = requireInteger(value.height, "board.height", 1);
  if (!Array.isArray(value.mask) || value.mask.length !== height) throw new Error("board.mask 的行数与 height 不一致。");
  const mask = value.mask.map((row, y) => {
    if (!Array.isArray(row) || row.length !== width) throw new Error(`board.mask 第 ${y + 1} 行宽度不正确。`);
    return row.map((cell, x) => {
      if (cell !== 0 && cell !== 1) throw new Error(`board.mask[${y}][${x}] 只能是 0 或 1。`);
      return cell as BoardCell;
    });
  });
  return { id: requireString(value.id, "board.id"), name: requireString(value.name, "board.name"), width, height, mask };
}

function parseModule(value: unknown, index: number): ModuleDefinition {
  if (!isRecord(value)) throw new Error(`modules[${index}] 必须是对象。`);
  if (!Array.isArray(value.baseShape) || value.baseShape.length === 0) throw new Error(`modules[${index}].baseShape 不能为空。`);
  const shape = normalizeShape(value.baseShape.map((point, pointIndex) => {
    if (!isRecord(point)) throw new Error(`modules[${index}].baseShape[${pointIndex}] 必须是坐标对象。`);
    return {
      x: requireInteger(point.x, `modules[${index}].baseShape[${pointIndex}].x`),
      y: requireInteger(point.y, `modules[${index}].baseShape[${pointIndex}].y`),
    };
  }));
  if (new Set(shape.map(pointKey)).size !== value.baseShape.length) throw new Error(`modules[${index}] 包含重复格子。`);
  if (!isConnectedShape(shape)) throw new Error(`modules[${index}] 的格子没有全部相连。`);
  const quantity = requireInteger(value.availableQuantity, `modules[${index}].availableQuantity`, 0);
  const score = validateModuleScore(value.baseScore, `modules[${index}].baseScore`);
  const attributes = isRecord(value.attributes)
    ? Object.fromEntries(Object.entries(value.attributes).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])))
    : {};
  return {
    id: requireString(value.id, `modules[${index}].id`),
    name: requireString(value.name, `modules[${index}].name`),
    type: requireString(value.type, `modules[${index}].type`),
    baseShape: shape,
    color: requireString(value.color, `modules[${index}].color`),
    availableQuantity: quantity,
    allowRotation: value.allowRotation === true,
    allowMirror: value.allowMirror === true,
    baseScore: score,
    attributes,
  };
}

function parsePlacement(value: unknown, index: number): PlacedModuleData {
  if (!isRecord(value) || !isRecord(value.origin) || !isRecord(value.orientation)) {
    throw new Error(`build.placements[${index}] 结构不正确。`);
  }
  const rotation = requireInteger(value.orientation.rotation, `build.placements[${index}].orientation.rotation`) as Rotation;
  if (![0, 90, 180, 270].includes(rotation)) throw new Error(`build.placements[${index}] 的旋转角度无效。`);
  if (value.orientation.mirrored === true) throw new Error("当前版本不允许导入镜像模块。");
  return {
    instanceId: requireString(value.instanceId, `build.placements[${index}].instanceId`),
    moduleId: requireString(value.moduleId, `build.placements[${index}].moduleId`),
    origin: {
      x: requireInteger(value.origin.x, `build.placements[${index}].origin.x`),
      y: requireInteger(value.origin.y, `build.placements[${index}].origin.y`),
    },
    orientation: { rotation, mirrored: false },
  };
}

export function createFittingDocument(
  board: BoardDefinition,
  modules: ModuleDefinition[],
  placements: PlacedModuleData[],
): FittingDocument {
  return {
    documentType: FITTING_DOCUMENT_TYPE,
    schemaVersion: FITTING_DOCUMENT_VERSION,
    board: { ...board, mask: board.mask.map((row) => [...row]) },
    modules: modules.map((module) => ({
      ...module,
      baseShape: module.baseShape.map((point) => ({ ...point })),
      attributes: { ...module.attributes },
    })),
    build: {
      id: "current-build",
      name: `${board.name} 配装`,
      boardId: board.id,
      placements: placements.map((placement) => ({
        ...placement,
        origin: { ...placement.origin },
        orientation: { ...placement.orientation },
      })),
    },
  };
}

export function serializeFittingDocument(document: FittingDocument): string {
  return JSON.stringify(document, null, 2);
}

function boardLayoutSignature(board: BoardDefinition): string {
  return JSON.stringify({
    id: board.id,
    width: board.width,
    height: board.height,
    mask: board.mask,
  });
}

function moduleShapeSignature(module: ModuleDefinition): string {
  return JSON.stringify({
    id: module.id,
    baseShape: [...module.baseShape].sort((left, right) => left.y - right.y || left.x - right.x),
    allowRotation: module.allowRotation,
  });
}

export function hasMatchingFittingDefinitions(
  currentBoard: BoardDefinition,
  currentModules: ModuleDefinition[],
  imported: FittingDocument,
): boolean {
  if (boardLayoutSignature(currentBoard) !== boardLayoutSignature(imported.board)) return false;

  const currentModuleMap = new Map(currentModules.map((module) => [module.id, module]));
  const importedModuleMap = new Map(imported.modules.map((module) => [module.id, module]));
  const accepted: PlacedModuleData[] = [];
  for (const placement of imported.build.placements) {
    const currentModule = currentModuleMap.get(placement.moduleId);
    const importedModule = importedModuleMap.get(placement.moduleId);
    if (!currentModule || !importedModule
      || moduleShapeSignature(currentModule) !== moduleShapeSignature(importedModule)) return false;
    const validation = validatePlacement({
      board: currentBoard,
      module: currentModule,
      origin: placement.origin,
      rotation: placement.orientation.rotation,
      placements: accepted,
      modules: currentModules,
      isNew: true,
    });
    if (!validation.valid) return false;
    accepted.push(placement);
  }
  return true;
}

export function parseFittingDocument(json: string): FittingDocument {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("文件不是有效的 JSON。");
  }
  if (!isRecord(value)) throw new Error("配装文件根节点必须是对象。");
  if (value.documentType !== FITTING_DOCUMENT_TYPE) throw new Error("不是受支持的舰装格局文件。");
  if (value.schemaVersion !== FITTING_DOCUMENT_VERSION) throw new Error(`不支持 schemaVersion ${String(value.schemaVersion)}。`);
  const board = parseBoard(value.board);
  if (!Array.isArray(value.modules)) throw new Error("modules 必须是数组。");
  const modules = value.modules.map(parseModule);
  if (new Set(modules.map((module) => module.id)).size !== modules.length) throw new Error("模块 ID 不能重复。");
  if (!isRecord(value.build) || !Array.isArray(value.build.placements)) throw new Error("build 结构不正确。");
  const placements = value.build.placements.map(parsePlacement);
  if (new Set(placements.map((placement) => placement.instanceId)).size !== placements.length) throw new Error("模块实例 ID 不能重复。");
  if (value.build.boardId !== board.id) throw new Error("build.boardId 与 board.id 不一致。");

  const accepted: PlacedModuleData[] = [];
  for (const placement of placements) {
    const module = modules.find((item) => item.id === placement.moduleId);
    if (!module) throw new Error(`找不到模块定义 ${placement.moduleId}。`);
    if (!module.allowRotation && placement.orientation.rotation !== 0) throw new Error(`模块“${module.name}”不允许旋转。`);
    const validation = validatePlacement({
      board,
      module,
      origin: placement.origin,
      rotation: placement.orientation.rotation,
      placements: accepted,
      modules,
      isNew: true,
    });
    if (!validation.valid) throw new Error(`模块“${module.name}”的摆放无效：${validation.errors.join(", ")}。`);
    accepted.push(placement);
  }

  return {
    documentType: FITTING_DOCUMENT_TYPE,
    schemaVersion: FITTING_DOCUMENT_VERSION,
    board,
    modules,
    build: {
      id: requireString(value.build.id, "build.id"),
      name: requireString(value.build.name, "build.name"),
      boardId: board.id,
      placements: accepted,
    },
  };
}
