import { useCallback, useRef } from "react";
import { isZaicodeProductMode } from "@zcode/shared";

/** CSS property the transcript row reads to keep its right end free for the status dock. */
export const ZAICODE_STATUS_LANE_PROPERTY = "--zaicode-status-lane";

/**
 * Width the status dock (todo gauge, changes, summary panel) occupies from the right edge
 * of its positioned host. The dock is right-aligned inside a full-width overlay, so the
 * overlay's own width says nothing: the lane runs from the leftmost visible child to the
 * host's right edge.
 */
export function measureZaicodeStatusLane(
  hostRight: number,
  children: readonly { left: number; width: number }[],
): number {
  const lefts = children.filter((child) => child.width > 0).map((child) => child.left);
  if (lefts.length === 0) return 0;
  return Math.max(0, Math.ceil(hostRight - Math.min(...lefts)));
}

/**
 * Callback ref for the status dock: publishes its lane on the positioned host it shares
 * with the timeline, so the transcript row (a descendant) reserves exactly that room.
 * Removing the dock removes the property, and the row takes the full width again.
 */
export function useZaicodeStatusLane(): (node: HTMLElement | null) => void {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback((node: HTMLElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    const host = node?.parentElement;
    if (!node || !host || !isZaicodeProductMode() || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const lane = measureZaicodeStatusLane(
        host.getBoundingClientRect().right,
        Array.from(node.children, (child) => child.getBoundingClientRect()),
      );
      host.style.setProperty(ZAICODE_STATUS_LANE_PROPERTY, `${lane}px`);
    };
    const resize = new ResizeObserver(measure);
    const watch = () => {
      resize.disconnect();
      resize.observe(node);
      resize.observe(host);
      for (const child of Array.from(node.children)) resize.observe(child);
      measure();
    };
    const mutation = new MutationObserver(watch);
    mutation.observe(node, { childList: true });
    watch();
    cleanup.current = () => {
      resize.disconnect();
      mutation.disconnect();
      host.style.removeProperty(ZAICODE_STATUS_LANE_PROPERTY);
    };
  }, []);
}
