import type { GridPoint } from "../models/board";
import type { ModuleDefinition, ModuleShape, Rotation } from "../models/module";
import { getShapeBounds, normalizeShape, shapeKey } from "./normalizeShape";

export function rotateShapeClockwise(shape: ModuleShape): ModuleShape {
  return normalizeShape(shape.map((point) => ({ x: -point.y, y: point.x })));
}

export function rotateShape(shape: ModuleShape, rotation: Rotation): ModuleShape {
  let result = normalizeShape(shape);
  for (let turns = 0; turns < rotation / 90; turns += 1) result = rotateShapeClockwise(result);
  return result;
}

export function getOrientedShape(module: ModuleDefinition, rotation: Rotation): ModuleShape {
  return rotateShape(module.baseShape, module.allowRotation ? rotation : 0);
}

export function getUniqueRotations(module: ModuleDefinition): Rotation[] {
  const candidates: Rotation[] = module.allowRotation ? [0, 90, 180, 270] : [0];
  const seen = new Set<string>();
  return candidates.filter((rotation) => {
    const key = shapeKey(getOrientedShape(module, rotation));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function rotateAnchor(
  anchor: GridPoint,
  shape: ModuleShape,
  clockwise: boolean,
): GridPoint {
  const { width, height } = getShapeBounds(shape);
  return clockwise
    ? { x: height - 1 - anchor.y, y: anchor.x }
    : { x: anchor.y, y: width - 1 - anchor.x };
}

export function nextRotation(rotation: Rotation, clockwise: boolean): Rotation {
  const value = (rotation + (clockwise ? 90 : 270)) % 360;
  return value as Rotation;
}
