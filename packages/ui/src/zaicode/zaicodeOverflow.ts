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

/**
 * Which items of a row go into "⋯" when not all of them fit in `available`
 * pixels. The lowest `keep` goes first (the caller's default is the trailing
 * items first, which is `zaicodeOverflowFit`), until what is left and the "⋯"
 * button fit. The row's order never changes; only the chosen items leave it.
 */
export function zaicodeOverflowHidden(
  widths: readonly number[],
  keep: readonly number[],
  available: number,
  gap: number,
  moreWidth: number,
): boolean[] {
  const hidden = widths.map(() => false);
  const shownWidth = () => {
    let total = 0;
    let count = 0;
    widths.forEach((width, index) => {
      if (hidden[index]) return;
      total += width + (count > 0 ? gap : 0);
      count += 1;
    });
    return { total, count };
  };
  if (shownWidth().total <= available) return hidden;
  const order = widths.map((_, index) => index).sort((a, b) => (keep[a] ?? 0) - (keep[b] ?? 0) || b - a);
  for (const index of order) {
    hidden[index] = true;
    const { total, count } = shownWidth();
    if (total + (count > 0 ? gap : 0) + moreWidth <= available) break;
  }
  return hidden;
}

/** Width assumed for an item that has never been on screen (one icon button). */
export const ZAICODE_OVERFLOW_UNKNOWN_WIDTH = 28;
