/**
 * SRC-161:REQ-007 / T-278: the measured half of the anchored card's inline
 * chrome, split out of the component so the measurement lifecycle is a pure,
 * testable contract instead of a source-string guess.
 *
 * The card mounts BEFORE its content has been measured, and it has to be in the
 * document for the browser to measure it. While `measuredHeight` is still null
 * it is therefore hidden and carries NO height cap: capping it before the first
 * measurement would pin a short card to a stale guess and clip a tall one.
 * From the first measurement on -- and on every ResizeObserver update after it
 * -- the shared placement rule supplies the cap, so the card renders exactly
 * the room the side it landed on actually has, and scrolls internally past it.
 */
export function zaicodeAnchoredCardFrame(
  measuredHeight: number | null,
  placement: { maxHeight: number },
): { maxHeight: number | undefined; visibility: "hidden" | undefined } {
  const measured = measuredHeight !== null;
  return {
    maxHeight: measured ? Math.floor(placement.maxHeight) : undefined,
    visibility: measured ? undefined : "hidden",
  };
}
