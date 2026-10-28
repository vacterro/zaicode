/**
 * Placement for the ZAICODE hand-rolled hover cards (SRC-151:R010 + R012).
 *
 * Two reports, one cause. Every card that was rolled by hand positioned itself
 * with an inline `Math.max(8, Math.min(...))` against a hardcoded pixel width,
 * and clamped ONE axis only:
 *
 *   - R010 "spawns in the top-left corner instead of its place": the clamp has
 *     no anchor validation. A `DOMRect` with no box -- an anchor that is
 *     hidden, `display:none`, or measured before layout -- collapses `left` to
 *     the 8px margin and `top` to `rect.bottom + 6`, which is the top-left
 *     corner exactly. Nothing was wrong with the anchor; the placement had no
 *     way to say "I do not know where this is".
 *   - R012 "giant tooltips": the card had a width but no height ceiling, so a
 *     long todo item or a long mailbox preview grew past the window.
 *
 * The rule, in one place: a card is placed against an anchor that HAS a box,
 * on whichever side fits, always inside the viewport, and is capped in height
 * by whatever room is left on the side it landed on. No anchor box means no
 * card -- never a card in the corner.
 */

/** Distance from the anchor, and the minimum distance kept from the viewport edge. */
export const ZAICODE_TOOLTIP_GAP = 6;
export const ZAICODE_TOOLTIP_MARGIN = 8;

export interface ZaicodeTooltipAnchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface ZaicodeTooltipViewport {
  width: number;
  height: number;
}

export interface ZaicodeTooltipSize {
  width: number;
  height: number;
}

export type ZaicodeTooltipSide = "top" | "bottom";

export interface ZaicodeTooltipPlacement {
  left: number;
  top: number;
  /** What to cap the card's own `max-height` at; never larger than the viewport. */
  maxHeight: number;
  /** Which side it actually landed on. Flipped when the first one did not fit. */
  side: ZaicodeTooltipSide;
  /** True when the card does not fit above AND below, so it scrolls internally. */
  scroll: boolean;
}

/**
 * The first half of the anchor contract, in one place (SRC-161:REQ-003).
 *
 * Every surface that positions itself against a measured rect asks this first:
 * an anchor that is missing, un-finite, or has no box is not an anchor, and a
 * caller that gets `null` back must close or not render. That is what keeps a
 * detached or pre-layout trigger from becoming a card at the origin.
 */
export function zaicodeAnchorBox(
  anchor: ZaicodeTooltipAnchor | null | undefined,
): ZaicodeTooltipAnchor | null {
  if (!anchor) return null;
  if (!Number.isFinite(anchor.left) || !Number.isFinite(anchor.top)) return null;
  if (!(anchor.width > 0) || !(anchor.height > 0)) return null;
  if (!Number.isFinite(anchor.right) || !Number.isFinite(anchor.bottom)) return null;
  return anchor;
}

/**
 * Centre the card on the anchor, then keep it inside the viewport.
 *
 * `size.height` is the card's natural height; pass 0 when it is not known yet
 * (nothing measured) -- the card then gets the room available on its side,
 * which is what stops the unbounded growth in R012.
 */
export function zaicodeTooltipPlacement(
  anchor: ZaicodeTooltipAnchor,
  size: ZaicodeTooltipSize,
  viewport: ZaicodeTooltipViewport,
  preferred: ZaicodeTooltipSide = "top",
): ZaicodeTooltipPlacement | null {
  // No box, no card. This is the whole of R010: a card with nowhere to be is
  // not drawn at the origin.
  if (!zaicodeAnchorBox(anchor)) return null;
  const viewportWidth = Math.max(0, viewport.width);
  const viewportHeight = Math.max(0, viewport.height);
  if (viewportWidth <= 0 || viewportHeight <= 0) return null;

  const cardWidth = Math.max(0, Math.min(size.width, viewportWidth - ZAICODE_TOOLTIP_MARGIN * 2));
  const maxLeft = Math.max(ZAICODE_TOOLTIP_MARGIN, viewportWidth - cardWidth - ZAICODE_TOOLTIP_MARGIN);
  const left = Math.min(Math.max(ZAICODE_TOOLTIP_MARGIN, anchor.left + anchor.width / 2 - cardWidth / 2), maxLeft);

  const room = (side: ZaicodeTooltipSide) =>
    side === "top"
      ? anchor.top - ZAICODE_TOOLTIP_MARGIN - ZAICODE_TOOLTIP_GAP
      : viewportHeight - anchor.bottom - ZAICODE_TOOLTIP_MARGIN - ZAICODE_TOOLTIP_GAP;

  const wanted = Math.max(0, size.height);
  const first = preferred;
  // Flip only when the first side genuinely cannot show the card. A card that
  // is taller than both sides still opens on the preferred one and scrolls.
  const side: ZaicodeTooltipSide = wanted > room(first) && room(first === "top" ? "bottom" : "top") > room(first)
    ? first === "top"
      ? "bottom"
      : "top"
    : first;

  const available = Math.max(0, room(side));
  const scroll = wanted > available;
  const maxHeight = Math.min(wanted || Number.POSITIVE_INFINITY, available);
  const top =
    side === "top"
      ? anchor.top - ZAICODE_TOOLTIP_GAP - Math.min(wanted || available, available)
      : anchor.bottom + ZAICODE_TOOLTIP_GAP;
  const minTop = ZAICODE_TOOLTIP_MARGIN;
  const maxTop = Math.max(minTop, viewportHeight - Math.min(wanted || available, available) - ZAICODE_TOOLTIP_MARGIN);

  return { left, top: Math.min(Math.max(minTop, top), maxTop), maxHeight, side, scroll };
}

/**
 * The corner-anchored sibling of the rule above (SRC-161:REQ-003).
 *
 * Some surfaces hang off the trigger's bottom-right corner instead of centring
 * on it -- a panel reads as a wing of the control that opened it, not as a label
 * floating over it. They used to roll their own `Math.max(8, Math.min(...))`,
 * which is exactly the clamp that drew a panel in the top-left corner: with no
 * anchor box, `left` collapsed to the 8px margin and `top` to `bottom + gap`.
 *
 * Same contract as `zaicodeTooltipPlacement`, so a caller can swap between them
 * without re-learning the rules: no anchor box, no panel; always inside the
 * viewport; flips to the side that has room; capped by the room it landed on.
 */
export function zaicodeTooltipCornerPlacement(
  anchor: ZaicodeTooltipAnchor,
  size: ZaicodeTooltipSize,
  viewport: ZaicodeTooltipViewport,
  align: "start" | "end" = "end",
): ZaicodeTooltipPlacement | null {
  const box = zaicodeAnchorBox(anchor);
  if (!box) return null;
  const viewportWidth = Math.max(0, viewport.width);
  const viewportHeight = Math.max(0, viewport.height);
  if (viewportWidth <= 0 || viewportHeight <= 0) return null;

  const cardWidth = Math.max(0, Math.min(size.width, viewportWidth - ZAICODE_TOOLTIP_MARGIN * 2));
  const maxLeft = Math.max(ZAICODE_TOOLTIP_MARGIN, viewportWidth - cardWidth - ZAICODE_TOOLTIP_MARGIN);
  const wantedLeft = align === "end" ? box.right - cardWidth : box.left;
  const left = Math.min(Math.max(ZAICODE_TOOLTIP_MARGIN, wantedLeft), maxLeft);

  const roomBottom = viewportHeight - box.bottom - ZAICODE_TOOLTIP_MARGIN - ZAICODE_TOOLTIP_GAP;
  const roomTop = box.top - ZAICODE_TOOLTIP_MARGIN - ZAICODE_TOOLTIP_GAP;
  const wanted = Math.max(0, size.height);
  const side: ZaicodeTooltipSide = wanted > roomBottom && roomTop > roomBottom ? "top" : "bottom";
  const available = Math.max(0, side === "top" ? roomTop : roomBottom);
  const shown = Math.min(wanted || available, available);
  const top = side === "top" ? box.top - ZAICODE_TOOLTIP_GAP - shown : box.bottom + ZAICODE_TOOLTIP_GAP;

  return { left, top, maxHeight: Math.min(wanted || Number.POSITIVE_INFINITY, available), side, scroll: wanted > available };
}

/**
 * Snap a coordinate to a whole device pixel. The pixel fonts here have no
 * antialiasing, so a card landing on a half pixel renders its own text blurred
 * (SRC-048).
 */
export function zaicodeTooltipPixel(value: number, ratio: number): number {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(ratio) || ratio <= 0) return Math.round(value);
  return Math.round(value * ratio) / ratio;
}
/**
 * One stacking order for the ZAICODE surfaces that leave the document flow
 * (SRC-151:R009 -- "buttons can overlap each other").
 *
 * Everything that positions itself with `position: fixed` and no layout parent
 * is its own island: nothing reflows it, so two of them that pick the same
 * corner of the window draw on top of each other and neither can be reached.
 * The two that really did collide were the workers tray and the todo column,
 * both `fixed z-40` with independent geometry -- same layer, same corners.
 *
 * So the layer is named once here and every fixed surface takes its band from
 * this table. Bands are spaced so an island can be inserted without renumbering
 * its neighbours, and a surface that must sit ABOVE another (the docked todo
 * list opens over the gauge) says so here rather than in a class string.
 */
export const ZAICODE_LAYERS = Object.freeze({
  /** In-flow content the layout owns. Never fixed. */
  content: 0,
  /** Floating surfaces docked to a window corner: the workers tray. */
  tray: 30,
  /** The composer-anchored todo column; below the tray so a tray stays clickable. */
  gauge: 35,
  /** Docked windows the user can drag: the todo dock. */
  dock: 90,
  /** Hover cards. Always above whatever they describe. */
  card: 200,
  /** Debug/inspection overlays. */
  overlay: 210,
} as const);

export type ZaicodeLayer = keyof typeof ZAICODE_LAYERS;

/** The Tailwind `z-*` class for a band, so no caller hardcodes a number again. */
export function zaicodeLayerClass(layer: ZaicodeLayer): string {
  return `z-[${ZAICODE_LAYERS[layer]}]`;
}
