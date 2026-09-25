/**
 * How many leading items of a row fit in `available` pixels. When not all of
 * them fit, room is kept for the overflow ("⋯") button, so the answer never
 * leaves a half-visible, clipped icon (SRC-035: icons must not be cut off).
 */
export function zaicodeOverflowFit(widths: readonly number[], available: number, gap: number, moreWidth: number): number {
  const total = widths.reduce((sum, width, index) => sum + width + (index > 0 ? gap : 0), 0);
  if (total <= available) return widths.length;
  const room = available - moreWidth - gap;
  let used = 0;
  let fit = 0;
  for (const width of widths) {
    const next = used + (fit > 0 ? gap : 0) + width;
    if (next > room) break;
    used = next;
    fit += 1;
  }
  return fit;
}

/** Width assumed for an item that has never been on screen (one icon button). */
export const ZAICODE_OVERFLOW_UNKNOWN_WIDTH = 28;
