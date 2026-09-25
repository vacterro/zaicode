/**
 * Worker window geometry, pure: the split of the WORKERS panel, snapping of
 * worker windows (screen halves / quarters, maximize, dock back into the
 * panel, magnetic edges) and clamping. No DOM, no React, so every rule is a
 * test.
 */

export interface ZaicodeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ZaicodeSplitDirection = "row" | "column" | "grid";

/** Fractions summing to 1; a wrong length (panes added / removed) resets to even. */
export function normalizeZaicodeSplitSizes(sizes: readonly number[] | undefined, count: number): number[] {
  if (count <= 0) return [];
  if (!sizes || sizes.length !== count || sizes.some((size) => !(size > 0))) return evenZaicodeSplitSizes(count);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return sizes.map((size) => size / total);
}

export function evenZaicodeSplitSizes(count: number): number[] {
  return count > 0 ? Array.from({ length: count }, () => 1 / count) : [];
}

export const ZAICODE_SPLIT_MIN_FRACTION = 0.08;

/** Moves the divider after pane `index` by `delta` (a fraction of the panel); neighbours only. */
export function resizeZaicodeSplit(
  sizes: readonly number[],
  index: number,
  delta: number,
  minFraction: number = ZAICODE_SPLIT_MIN_FRACTION,
): number[] {
  const next = [...sizes];
  const first = next[index];
  const second = next[index + 1];
  if (first === undefined || second === undefined) return next;
  const pair = first + second;
  const min = Math.min(minFraction, pair / 2);
  const moved = Math.min(pair - min, Math.max(min, first + delta));
  next[index] = moved;
  next[index + 1] = pair - moved;
  return next;
}

/** Pane rectangles in percent of the panel body, in pane order. */
export function layoutZaicodeSplit(
  count: number,
  direction: ZaicodeSplitDirection,
  sizes: readonly number[],
): ZaicodeRect[] {
  if (count <= 0) return [];
  if (direction === "grid") {
    const columns = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / columns);
    const rects: ZaicodeRect[] = [];
    for (let index = 0; index < count; index += 1) {
      const row = Math.floor(index / columns);
      const inRow = row === rows - 1 ? count - row * columns : columns;
      const column = index - row * columns;
      rects.push({ x: (column / inRow) * 100, y: (row / rows) * 100, width: 100 / inRow, height: 100 / rows });
    }
    return rects;
  }
  const fractions = normalizeZaicodeSplitSizes(sizes, count);
  let offset = 0;
  return fractions.map((fraction) => {
    const start = offset * 100;
    offset += fraction;
    return direction === "row"
      ? { x: start, y: 0, width: fraction * 100, height: 100 }
      : { x: 0, y: start, width: 100, height: fraction * 100 };
  });
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

export type ZaicodeSnapZone =
  | "left"
  | "right"
  | "maximize"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "dock";

/**
 * The zone a window being dragged would snap to when released with the
 * pointer at (x, y) inside `bounds`: the side edges give halves, their
 * corners quarters, the top edge maximizes, the bottom edge docks it into
 * the WORKERS panel. Null = drop where it is.
 */
export function zaicodeSnapZoneAt(
  pointer: { x: number; y: number },
  bounds: ZaicodeRect,
  edge = 10,
  corner = 120,
): ZaicodeSnapZone | null {
  const left = pointer.x <= bounds.x + edge;
  const right = pointer.x >= bounds.x + bounds.width - edge;
  const top = pointer.y <= bounds.y + edge;
  const bottom = pointer.y >= bounds.y + bounds.height - edge;
  const nearTop = pointer.y <= bounds.y + corner;
  const nearBottom = pointer.y >= bounds.y + bounds.height - corner;
  if (left) return nearTop ? "top-left" : nearBottom ? "bottom-left" : "left";
  if (right) return nearTop ? "top-right" : nearBottom ? "bottom-right" : "right";
  if (top) return "maximize";
  if (bottom) return "dock";
  return null;
}

/** Where a snap zone puts the window (the dock zone has no window rect). */
export function zaicodeSnapZoneRect(zone: ZaicodeSnapZone, bounds: ZaicodeRect): ZaicodeRect | null {
  const halfW = Math.round(bounds.width / 2);
  const halfH = Math.round(bounds.height / 2);
  const { x, y, width, height } = bounds;
  switch (zone) {
    case "left":
      return { x, y, width: halfW, height };
    case "right":
      return { x: x + halfW, y, width: width - halfW, height };
    case "maximize":
      return { ...bounds };
    case "top-left":
      return { x, y, width: halfW, height: halfH };
    case "top-right":
      return { x: x + halfW, y, width: width - halfW, height: halfH };
    case "bottom-left":
      return { x, y: y + halfH, width: halfW, height: height - halfH };
    case "bottom-right":
      return { x: x + halfW, y: y + halfH, width: width - halfW, height: height - halfH };
    case "dock":
      return null;
  }
}

/** The nearest candidate within `threshold` of either edge; 0 when none. */
function magnetShift(start: number, end: number, candidates: readonly number[], threshold: number): number {
  let best = 0;
  let bestDistance = threshold + 1;
  for (const candidate of candidates) {
    for (const edge of [start, end]) {
      const distance = Math.abs(candidate - edge);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate - edge;
      }
    }
  }
  return bestDistance <= threshold ? best : 0;
}

/**
 * Magnetic move: the window's edges stick to the work area's edges and to the
 * edges of the other windows when they come within `threshold` pixels.
 */
export function magnetZaicodeRect(
  rect: ZaicodeRect,
  others: readonly ZaicodeRect[],
  bounds: ZaicodeRect,
  threshold: number,
): ZaicodeRect {
  const xs = [bounds.x, bounds.x + bounds.width, ...others.flatMap((other) => [other.x, other.x + other.width])];
  const ys = [bounds.y, bounds.y + bounds.height, ...others.flatMap((other) => [other.y, other.y + other.height])];
  return {
    ...rect,
    x: rect.x + magnetShift(rect.x, rect.x + rect.width, xs, threshold),
    y: rect.y + magnetShift(rect.y, rect.y + rect.height, ys, threshold),
  };
}

/** Magnetic resize from the bottom-right: the right and bottom edges stick. */
export function magnetZaicodeResize(
  rect: ZaicodeRect,
  others: readonly ZaicodeRect[],
  bounds: ZaicodeRect,
  threshold: number,
): ZaicodeRect {
  const xs = [bounds.x + bounds.width, ...others.flatMap((other) => [other.x, other.x + other.width])];
  const ys = [bounds.y + bounds.height, ...others.flatMap((other) => [other.y, other.y + other.height])];
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const dx = magnetShift(right, right, xs, threshold);
  const dy = magnetShift(bottom, bottom, ys, threshold);
  return { ...rect, width: rect.width + dx, height: rect.height + dy };
}

export const ZAICODE_WORKER_WINDOW_MIN = { width: 360, height: 180 } as const;

/** Keeps a window at least its minimum size and its title bar inside the work area. */
export function clampZaicodeWindowRect(rect: ZaicodeRect, bounds: ZaicodeRect): ZaicodeRect {
  const width = Math.min(Math.max(ZAICODE_WORKER_WINDOW_MIN.width, rect.width), Math.max(ZAICODE_WORKER_WINDOW_MIN.width, bounds.width));
  const height = Math.min(Math.max(ZAICODE_WORKER_WINDOW_MIN.height, rect.height), Math.max(ZAICODE_WORKER_WINDOW_MIN.height, bounds.height));
  const x = Math.min(Math.max(bounds.x - width + 120, rect.x), bounds.x + bounds.width - 120);
  const y = Math.min(Math.max(bounds.y, rect.y), bounds.y + bounds.height - 28);
  // SRC-038: whole pixels only -- a terminal on a half pixel is drawn blurred.
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/** A new window: 55% x 50% of the work area, cascaded 28 px per window already open. */
export function cascadeZaicodeWindowRect(bounds: ZaicodeRect, openCount: number): ZaicodeRect {
  const width = Math.max(ZAICODE_WORKER_WINDOW_MIN.width, Math.round(bounds.width * 0.55));
  const height = Math.max(ZAICODE_WORKER_WINDOW_MIN.height, Math.round(bounds.height * 0.5));
  const step = (openCount % 8) * 28;
  return clampZaicodeWindowRect(
    { x: bounds.x + bounds.width - width - 24 - step, y: bounds.y + 24 + step, width, height },
    bounds,
  );
}
