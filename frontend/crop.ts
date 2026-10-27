import type { CropPosition } from "./domain.js";

export type CropRect = { x: number; y: number; width: number; height: number };
export type CropGeometry = { sourceWidth: number; sourceHeight: number; outputWidth: number; outputHeight: number };
export type CropCorner = "nw" | "ne" | "sw" | "se";
export const MIN_CROP_SCALE = 0.1;

/** Pixel edges use nearest-even rounding, matching the image pipeline's convention. */
function nearestEven(value: number): number {
  const lower = Math.floor(value);
  if (value - lower === 0.5) return lower + lower % 2;
  return Math.round(value);
}

/** Source pixels retained by a centered fill, before resizing to the output. */
export function centerCrop(sourceWidth: number, sourceHeight: number, outputWidth: number, outputHeight: number): CropRect | null {
  if (![sourceWidth, sourceHeight, outputWidth, outputHeight].every(value => Number.isSafeInteger(value) && value > 0)) return null;
  const sourceRatio = sourceWidth / sourceHeight;
  const outputRatio = outputWidth / outputHeight;
  const fractions = [Math.min(1, outputRatio / sourceRatio), Math.min(1, sourceRatio / outputRatio)];
  const [x, y] = [sourceWidth, sourceHeight].map((length, axis) => nearestEven((length - length * fractions[axis]!) / 2));
  const width = sourceWidth - 2 * x!;
  const height = sourceHeight - 2 * y!;
  return width > 0 && height > 0 ? { x: x!, y: y!, width, height } : null;
}

/** Source pixels used by a positioned fill crop, optionally reduced in size. */
export function positionedCrop(
  sourceWidth: number, sourceHeight: number, outputWidth: number, outputHeight: number,
  position: CropPosition = { x: 0.5, y: 0.5 },
): CropRect | null {
  if (!position || ![position.x, position.y].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)) return null;
  const scale = position.scale === undefined ? 1 : position.scale;
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale < MIN_CROP_SCALE || scale > 1) return null;
  const crop = centerCrop(sourceWidth, sourceHeight, outputWidth, outputHeight);
  if (!crop) return null;
  const width = Math.max(1, nearestEven(crop.width * scale));
  const height = Math.max(1, nearestEven(crop.height * scale));
  return {
    x: nearestEven((sourceWidth - width) * position.x),
    y: nearestEven((sourceHeight - height) * position.y),
    width, height,
  };
}

/** Resize along the fixed-aspect diagonal while keeping the opposite corner fixed. */
export function resizeCrop(
  geometry: CropGeometry, position: CropPosition, corner: CropCorner, deltaX: number, deltaY: number,
): CropPosition | null {
  const { sourceWidth, sourceHeight, outputWidth, outputHeight } = geometry;
  const crop = positionedCrop(sourceWidth, sourceHeight, outputWidth, outputHeight, position);
  const base = centerCrop(sourceWidth, sourceHeight, outputWidth, outputHeight);
  if (!crop || !base || !["nw", "ne", "sw", "se"].includes(corner) || !Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return null;
  if (deltaX === 0 && deltaY === 0) return { ...position };
  const directionX = corner.endsWith("e") ? 1 : -1;
  const directionY = corner.startsWith("s") ? 1 : -1;
  const anchorX = directionX > 0 ? crop.x : crop.x + crop.width;
  const anchorY = directionY > 0 ? crop.y : crop.y + crop.height;
  const availableWidth = directionX > 0 ? sourceWidth - anchorX : anchorX;
  const availableHeight = directionY > 0 ? sourceHeight - anchorY : anchorY;
  // Project the pointer onto the crop's aspect-ratio diagonal. Perpendicular
  // motion cannot distort the aspect ratio or move the stationary corner.
  const change = (directionX * deltaX * base.width + directionY * deltaY * base.height) / (base.width ** 2 + base.height ** 2);
  const maximum = Math.min(1, availableWidth / base.width, availableHeight / base.height);
  const scale = Math.max(MIN_CROP_SCALE, Math.min(maximum, (position.scale ?? 1) + change));
  const width = Math.max(1, nearestEven(base.width * scale));
  const height = Math.max(1, nearestEven(base.height * scale));
  const left = directionX > 0 ? anchorX : anchorX - width;
  const top = directionY > 0 ? anchorY : anchorY - height;
  return {
    x: sourceWidth > width ? left / (sourceWidth - width) : 0.5,
    y: sourceHeight > height ? top / (sourceHeight - height) : 0.5,
    ...(scale !== 1 ? { scale } : {}),
  };
}
