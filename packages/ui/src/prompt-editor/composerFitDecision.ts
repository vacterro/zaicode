/**
 * T-224 / SRC-154:R002 — the composer toolbar converges instead of jittering.
 *
 * Root cause of the oscillation: the fit ladder re-decided from raw,
 * fractional geometry on every ResizeObserver pass. Collapsing a rung changes
 * the measured extents by whole pixels, but the *decision boundary* sat at a
 * fractional threshold (`overflow <= 0.5`), so a row whose full-layout
 * overflow hovered around half a pixel flipped compact/full on every pass —
 * the measurement changed the state, the state changed the geometry, the new
 * geometry reversed the decision. The blur is that flip-flop repainting the
 * row continuously.
 *
 * The fix has three parts, all in this DOM-free module so the boundary can be
 * exercised directly:
 *
 *  1. Quantize every measurement to whole pixels before deciding. Sub-pixel
 *     noise is invisible and must never flip a rung.
 *  2. Decide from the full-layout overflow ladder, then apply hysteresis on
 *     RELEASE only: collapsing happens the moment anything overflows (a rung
 *     must never clip), but a rung comes back only when the full layout fits
 *     with `HYSTERESIS_PX` to spare. A row at the boundary therefore sticks to
 *     the compact side instead of alternating.
 *  3. The hook (useComposerToolbarFit) skips DOM writes when the decided plan
 *     equals the live one and batches observer callbacks, so a converged row
 *     stops touching the layout entirely.
 *
 * No CSS transition, no debounce-only delay, no blur removal: the state itself
 * converges.
 */

/** Full-layout slack required before a collapsed rung is released. */
export const COMPOSER_FIT_HYSTERESIS_PX = 8;

/**
 * Whole pixels, always. Non-finite measurements (a detached row, a zero-size
 * probe) quantize to 0, which reads as "fits" — a hidden row must never
 * trigger a collapse cascade it cannot measure.
 */
export function quantizeFitPx(value: number): number {
  if (!Number.isFinite(value)) return 0;
  // Math.round(-0.49) is -0, and -0 !== 0 under strict equality: collapse it.
  const quantized = Math.round(value);
  return quantized === 0 ? 0 : quantized;
}

/**
 * How many leading rungs stay collapsed.
 *
 * `rungOverflowsPx` is the quantized overflow measured from the full layout
 * with 0, 1, 2, ... rungs applied (`rungOverflowsPx[k]` = overflow with the
 * first k rungs collapsed). `liveCount` is how many rungs are collapsed right
 * now. Returns the count to apply: the first rung depth that fits, held at the
 * live depth when releasing would land inside the hysteresis band.
 */
/**
 * SRC-161:REQ-008 (T-240) — a wrapped toolbar row IS an overflow, even when the
 * two clusters' widths would have fitted side by side.
 *
 * `extent(leading) + extent(trailing)` measures both clusters as if they shared one
 * line. When the browser has actually wrapped the trailing cluster onto its own row
 * — leaving the attachment `+` alone on a strip of blank space — that sum can read
 * "fits" while the row is visibly two rows tall. That false fit is why the packaged
 * composer kept its broken row: every rung reported "fits" from a measurement that
 * had already wrapped. `sameRow` is the caller's live check that both clusters still
 * overlap vertically; when they do not, the row has already failed and the ladder
 * must keep collapsing.
 */
export const COMPOSER_WRAPPED_ROW_OVERFLOW_PX = 1;

export function composerRowOverflowPx(args: {
  leadingExtent: number;
  trailingExtent: number;
  width: number;
  gap: number;
  sameRow: boolean;
}): number {
  const sideBySide = quantizeFitPx(
    Math.max(0, args.leadingExtent + args.trailingExtent + args.gap - args.width),
  );
  if (args.sameRow) return sideBySide;
  // Already wrapped: report the smallest positive overflow, so every rung from here
  // reads "does not fit" and no rung is ever satisfied by the broken row.
  return Math.max(sideBySide, COMPOSER_WRAPPED_ROW_OVERFLOW_PX);
}

export function resolveComposerCompactCount(args: {
  rungOverflowsPx: readonly number[];
  liveCount: number;
  hysteresisPx?: number;
}): number {
  const { rungOverflowsPx, hysteresisPx = COMPOSER_FIT_HYSTERESIS_PX } = args;
  const rungCount = rungOverflowsPx.length - 1;
  if (rungCount < 0) return 0;
  const live = Math.min(Math.max(0, Math.floor(args.liveCount)), rungCount);
  let naive = rungCount;
  for (let depth = 0; depth <= rungCount; depth += 1) {
    // The ladder always carries rungCount + 1 entries; the fallback only
    // satisfies the type system and reads a hole as "does not fit".
    if ((rungOverflowsPx[depth] ?? Number.POSITIVE_INFINITY) <= 0) {
      naive = depth;
      break;
    }
  }
  if (naive >= live) return naive;
  // Releasing rungs: only when the full layout fits with room to spare.
  // Otherwise the next pass would measure the same boundary overflow and
  // collapse again — the alternating compact/full loop from the report.
  const fullOverflow = rungOverflowsPx[0] ?? 0;
  if (fullOverflow <= -hysteresisPx) return naive;
  return live;
}
