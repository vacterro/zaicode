/**
 * Crisp text after any resize (SRC-038). ZAICODE draws with a pixel font and
 * no antialiasing; a centred column whose free space is an odd number of
 * pixels starts on a half pixel, and every glyph in it turns to mush. The
 * chat column and the message box are centred by the browser (mx-auto,
 * justify-center), so dragging the sidebar or the window edge flips them
 * between crisp and blurred at every other pixel.
 *
 * The fix measures where those columns really start and moves each by the
 * sub-pixel remainder using layout offsets, so text is rasterized at the
 * corrected position rather than moving a composited text bitmap.
 */

/** Elements that are centred by layout and carry text. */
export const ZAICODE_PIXEL_SNAP_SELECTOR =
  '[data-v4-timeline-content-column="true"], [data-v4-composer-dock-content="true"], [data-zaicode-pixel-snap]';

/**
 * The `translate` (CSS px) that puts an element's left edge on a whole device
 * pixel. `left` is the measured edge including the correction already applied
 * (`applied`), so repeated calls converge instead of drifting.
 */
export function zaicodeSnapOffset(left: number, applied: number, devicePixelRatio: number): number {
  const ratio = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  const natural = (left - applied) * ratio;
  const offset = (Math.round(natural) - natural) / ratio;
  // Below 1/64 px the browser already rounds it away; keep the style untouched.
  return Math.abs(offset) < 1 / 64 ? 0 : Math.round(offset * 1000) / 1000;
}

/**
 * A position (CSS px) on a whole device pixel. Pop-ups placed from a measured
 * rect (a todo cell is a fraction of the bar wide, its centre lands on x.5)
 * go through this, or their text renders soft (SRC-048: the todo tooltip).
 */
export function zaicodeDevicePx(value: number, devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio): number {
  const ratio = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  return Math.round(value * ratio) / ratio;
}

interface SnapEntry { x: number; y: number; position: string; left: string; top: string }
const APPLIED = new Map<HTMLElement, SnapEntry>();

function restore(element: HTMLElement, entry: SnapEntry): void {
  element.style.position = entry.position;
  element.style.left = entry.left;
  element.style.top = entry.top;
}

function snapAll(): void {
  const ratio = window.devicePixelRatio || 1;
  for (const [element, entry] of APPLIED) {
    if (!element.isConnected || !element.matches(ZAICODE_PIXEL_SNAP_SELECTOR)) {
      restore(element, entry);
      APPLIED.delete(element);
    }
  }
  for (const element of Array.from(document.querySelectorAll<HTMLElement>(ZAICODE_PIXEL_SNAP_SELECTOR))) {
    const applied = APPLIED.get(element) ?? { x: 0, y: 0, position: element.style.position, left: element.style.left, top: element.style.top };
    const rect = element.getBoundingClientRect();
    // `data-zaicode-pixel-snap="xy"` also snaps the vertical edge (SRC-048); scrolled columns keep x only,
    // their top moves with every scroll step and a stale vertical nudge would shake them.
    const x = zaicodeSnapOffset(rect.left, applied.x, ratio);
    const y = element.dataset.zaicodePixelSnap === "xy" ? zaicodeSnapOffset(rect.top, applied.y, ratio) : 0;
    if (x === applied.x && y === applied.y) continue;
    APPLIED.set(element, { ...applied, x, y });
    // translate 会把位图文字移到合成层，产生截图里的随机模糊；相对布局偏移保留文字栅格。
    if (getComputedStyle(element).position === "static") element.style.position = "relative";
    element.style.left = x === 0 ? applied.left : `calc(${applied.left || "0px"} + ${x}px)`;
    element.style.top = y === 0 ? applied.top : `calc(${applied.top || "0px"} + ${y}px)`;
  }
}

let installed = false;

/**
 * Keeps centred columns on whole pixels: after every window or panel resize,
 * after width transitions end, and on a slow heartbeat for columns that
 * mount later (a new chat, the settings page closing).
 */
export function installZaicodePixelSnap(): () => void {
  if (installed || typeof window === "undefined") return () => undefined;
  installed = true;
  let frame: number | null = null;
  const schedule = () => {
    if (frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      snapAll();
    });
  };
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  const observeShell = () => {
    const shell = document.querySelector('[data-workspace-shell="true"]');
    if (shell && observer) observer.observe(shell);
    for (const element of document.querySelectorAll(ZAICODE_PIXEL_SNAP_SELECTOR)) observer?.observe(element);
  };
  observeShell();
  window.addEventListener("resize", schedule);
  document.addEventListener("transitionend", schedule, true);
  const mutations = new MutationObserver(() => { observeShell(); schedule(); });
  mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "data-zaicode-pixel-snap"] });
  void document.fonts?.ready.then(schedule);
  const heartbeat = window.setInterval(() => {
    observeShell();
    schedule();
  }, 1500);
  schedule();
  return () => {
    installed = false;
    window.removeEventListener("resize", schedule);
    document.removeEventListener("transitionend", schedule, true);
    window.clearInterval(heartbeat);
    observer?.disconnect();
    mutations.disconnect();
    if (frame !== null) window.cancelAnimationFrame(frame);
    for (const [element, entry] of APPLIED) restore(element, entry);
    APPLIED.clear();
  };
}
