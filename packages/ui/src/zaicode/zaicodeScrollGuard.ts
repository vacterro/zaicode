/**
 * The sidebar never scrolls sideways. An element with `overflow: hidden` is
 * still a scroll container: focusing a wide child (inline rename, a long
 * title, a menu trigger) or a narrow window after a zone snap could leave the
 * sidebar shifted left with its first 100 px cut off, and no scrollbar to
 * bring it back. One capture listener puts any such horizontal offset back
 * to 0 the moment it happens; real horizontal scrollers (overflow-x: auto /
 * scroll with a visible bar) are left alone.
 */
const GUARDED_ROOTS = '[data-testid="sidebar"], [data-zaicode-no-hscroll]';

let installed = false;

export function shouldResetHorizontalScroll(overflowX: string): boolean {
  return overflowX === "hidden" || overflowX === "clip" || overflowX === "visible";
}

export function installZaicodeHorizontalScrollGuard(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener(
    "scroll",
    (event) => {
      const element = event.target;
      if (!(element instanceof HTMLElement) || element.scrollLeft === 0) return;
      // Inside the sidebar, or one of the panels that hold it.
      if (!element.closest(GUARDED_ROOTS) && !element.querySelector('[data-testid="sidebar"]')) return;
      const overflowX = getComputedStyle(element).overflowX;
      if (shouldResetHorizontalScroll(overflowX) || element.scrollWidth - element.clientWidth <= 1) {
        element.scrollLeft = 0;
      }
    },
    true,
  );
}
