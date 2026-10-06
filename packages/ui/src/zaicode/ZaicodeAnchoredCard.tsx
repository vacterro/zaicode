import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ZAICODE_TOOLTIP_MARGIN,
  zaicodeAnchorBox,
  zaicodeTooltipPlacement,
  zaicodeTooltipPixel,
  type ZaicodeTooltipAnchor,
  type ZaicodeTooltipSide,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";

/**
 * The one hover card in ZAICODE that is not Radix (SRC-151:R010 + R012).
 *
 * Both hand-rolled cards in the tree now come through here: it validates the
 * anchor, places the card against it inside the viewport, flips to the other
 * side when the preferred one does not fit, and caps the height by the room it
 * actually has. Nothing here can draw a card in the top-left corner, because
 * an anchor with no box produces no card at all.
 *
 * SRC-161:REQ-003: pass `anchorEl` when the trigger is still in the tree. The
 * card then re-reads it on every move/resize, so the card follows a trigger
 * that scrolled or shifted instead of staying where it opened, and it closes
 * itself the moment the trigger detaches or collapses to a zero box.
 */
export function ZaicodeAnchoredCard({
  anchor,
  anchorEl,
  width,
  side = "top",
  children,
  className,
  ariaLabel,
}: {
  /** The trigger's rect, read at the moment the card opened. */
  anchor: ZaicodeTooltipAnchor | null;
  /**
   * The trigger itself, when it is still mounted. Preferred over a snapshot:
   * a snapshot goes stale, this one is re-read and goes to nothing instead.
   */
  anchorEl?: HTMLElement | null;
  /** Natural width of the card. Clamped to the viewport. */
  width: number;
  side?: ZaicodeTooltipSide;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  const [viewport, setViewport] = useState(() => ({
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  }));
  const [live, setLive] = useState<ZaicodeTooltipAnchor | null>(anchor);
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

  // A card is fixed to the viewport, so a resize has to re-place it or it
  // stays where the window used to be. The trigger can move without the
  // window changing at all, so it is re-read on the same passes -- but only
  // when it actually moved: re-rendering on every scroll tick for an identical
  // box is the churn this card exists to avoid.
  useEffect(() => {
    const sameBox = (a: ZaicodeTooltipAnchor | null, b: ZaicodeTooltipAnchor | null) =>
      a === b ||
      (a !== null &&
        b !== null &&
        a.left === b.left &&
        a.top === b.top &&
        a.width === b.width &&
        a.height === b.height);
    const measure = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      if (!anchorEl) return;
      setLive((current) => {
        const next = zaicodeAnchorBox(anchorEl.getBoundingClientRect());
        return sameBox(current, next) ? current : next;
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchorEl]);

  const placement = zaicodeTooltipPlacement(
    (anchorEl ? live : anchor) ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    { width, height: 0 },
    viewport,
    side,
  );
  if (!placement || typeof document === "undefined") return null;

  // SRC-161:REQ-007: the same clamp the placement used for `left`, applied to
  // the width the card actually renders at. Without it the card asked for a
  // 436px lane on a 380px window, so the box the placement had already kept
  // inside the viewport overflowed it again on the right.
  const renderedWidth = Math.max(0, Math.min(width, viewport.width - ZAICODE_TOOLTIP_MARGIN * 2));

  return createPortal(
    <div
      role="tooltip"
      aria-label={ariaLabel}
      data-zaicode-anchored-card={placement.side}
      className={cn(
        // SRC-162: a card painted under the page ("Do your best." showed through the limits
        // card) is unreadable; it stacks with the other hover layers.
        "pointer-events-none fixed z-50 overflow-y-auto border border-[var(--zaicode-highlight,var(--color-border))] bg-tooltip text-ui-xs text-tooltip-foreground shadow-md",
        className,
      )}
      style={{
        left: zaicodeTooltipPixel(placement.left, ratio),
        top: zaicodeTooltipPixel(placement.top, ratio),
        width: renderedWidth,
        // Height is the point of R012: whatever room this side has, never more.
        maxHeight: Math.floor(placement.maxHeight),
      }}
    >
      {children}
    </div>,
    document.body,
  );
}