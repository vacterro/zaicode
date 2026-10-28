/**
 * T-224 / SRC-154:R001 — one presentation contract for sidebar controls.
 *
 * The compact project sidebar is a VERTICAL rail: its controls have to read as
 * a vertical stack. Every control in that rail used to carry its own hand-picked
 * geometry (h-8 here, h-10 there, h-7 for the two at the bottom, a badge pinned
 * at `right-0 top-0`, a live strip at `left-0`), so the row heights disagreed,
 * the MAIN marker sat on the corner where it could overlap the glyph, and every
 * new control needed its own offsets to look right.
 *
 * This module owns the decision as DATA — which axis the sidebar presents, what
 * the control box is on that axis, whether the label fits beside the icon, and
 * when the stack must scroll instead of squeezing hit targets below the floor —
 * so the answer is testable without a DOM and identical for every control.
 */

import { ZAICODE_SIDEBAR_RAIL_WIDTH } from "./zaicodeSidebarWidth.js";

export type ZaicodeSidebarAxis = "vertical" | "horizontal";

/** Below this a hit target stops being reliably clickable. */
export const ZAICODE_RAIL_MIN_HIT_PX = 28;
/** The icon slot; icon-only presentation keeps exactly this much room. */
export const ZAICODE_RAIL_ICON_PX = 16;
export const ZAICODE_RAIL_GAP_PX = 4;
/** Padding around the rail's inner column, both axes. */
export const ZAICODE_RAIL_PADDING_PX = 4;

/**
 * The axis the sidebar presents at a given panel width. The compact rail is the
 * vertical one; anything wider is the full sidebar, whose controls sit in rows.
 * It reads the live width, so dragging across the boundary re-presents the
 * controls in the same frame — no reload, no remount.
 */
export function zaicodeSidebarAxisFor(
  panelWidthPx: number,
  railWidthPx = ZAICODE_SIDEBAR_RAIL_WIDTH,
): ZaicodeSidebarAxis {
  if (!Number.isFinite(panelWidthPx)) return "horizontal";
  return panelWidthPx <= railWidthPx ? "vertical" : "horizontal";
}

export interface ZaicodeRailControlLayout {
  axis: ZaicodeSidebarAxis;
  /** Height of a control in the stack (vertical) or its row height (horizontal). */
  hitSizePx: number;
  iconSizePx: number;
  gapPx: number;
  /**
   * Where the control's label goes. The rail is icon-only because the label
   * cannot fit: the accessible name and tooltip stay available regardless, so
   * nothing is lost but pixels.
   */
  labelPlacement: "hidden" | "beside";
  /** Corner radius step, shared so the rail's controls are one family. */
  radiusPx: number;
}

const VERTICAL_CONTROL_LAYOUT: ZaicodeRailControlLayout = {
  axis: "vertical",
  hitSizePx: 32,
  iconSizePx: ZAICODE_RAIL_ICON_PX,
  gapPx: ZAICODE_RAIL_GAP_PX,
  labelPlacement: "hidden",
  radiusPx: 4,
};

const HORIZONTAL_CONTROL_LAYOUT: ZaicodeRailControlLayout = {
  axis: "horizontal",
  hitSizePx: 28,
  iconSizePx: ZAICODE_RAIL_ICON_PX,
  gapPx: ZAICODE_RAIL_GAP_PX,
  labelPlacement: "beside",
  radiusPx: 4,
};

/** The control metrics for an axis. One family: same icon, gap and corners. */
export function zaicodeRailControlLayout(axis: ZaicodeSidebarAxis): ZaicodeRailControlLayout {
  return axis === "vertical" ? VERTICAL_CONTROL_LAYOUT : HORIZONTAL_CONTROL_LAYOUT;
}

/** Total height the controls need, including the gaps and the rail's padding. */
export function zaicodeRailStackHeightPx(controlCount: number, axis: ZaicodeSidebarAxis): number {
  const count = Math.max(0, Math.floor(controlCount));
  if (count === 0) return ZAICODE_RAIL_PADDING_PX * 2;
  const layout = zaicodeRailControlLayout(axis);
  return ZAICODE_RAIL_PADDING_PX * 2 + count * layout.hitSizePx + (count - 1) * layout.gapPx;
}

/**
 * Whether the stack needs to scroll. It scrolls rather than shrinking: a
 * squeezed hit target under `ZAICODE_RAIL_MIN_HIT_PX` is a control the operator
 * cannot reliably click, which is worse than a scrollbar.
 */
export function zaicodeRailOverflows(
  availableHeightPx: number,
  controlCount: number,
  axis: ZaicodeSidebarAxis = "vertical",
): boolean {
  if (!Number.isFinite(availableHeightPx)) return false;
  return zaicodeRailStackHeightPx(controlCount, axis) > availableHeightPx;
}

/**
 * How many controls the rail shows before it scrolls. The pinned count is
 * always shown, so the rail's primary entry points can never be scrolled out of
 * reach by a long project list in a short window.
 */
export function zaicodeRailFit(
  availableHeightPx: number,
  controlCount: number,
  pinnedCount = 0,
  axis: ZaicodeSidebarAxis = "vertical",
): { visible: number; scrolls: boolean } {
  const total = Math.max(0, Math.floor(controlCount));
  const pinned = Math.min(Math.max(0, Math.floor(pinnedCount)), total);
  if (!Number.isFinite(availableHeightPx)) return { visible: total, scrolls: false };
  if (!zaicodeRailOverflows(availableHeightPx, total, axis)) return { visible: total, scrolls: false };
  const layout = zaicodeRailControlLayout(axis);
  const usable = availableHeightPx - ZAICODE_RAIL_PADDING_PX * 2;
  const fits = Math.max(0, Math.floor((usable + layout.gapPx) / (layout.hitSizePx + layout.gapPx)));
  return { visible: Math.max(pinned, Math.min(fits, total)), scrolls: true };
}

/** The badge sits inside the control box: a corner offset would overlap the glyph at rail width. */
export function zaicodeRailBadgePlacement(axis: ZaicodeSidebarAxis): "inline" | "corner" {
  return axis === "vertical" ? "inline" : "corner";
}
