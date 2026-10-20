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

interface SnapEntry {
  x: number;
  y: number;
  position: string;
  left: string;
  top: string;
  baseLeft: string;
  baseTop: string;
  writtenLeft: string;
  writtenTop: string;
  writtenPosition: string;
  writtenStyle: string;
  relative: boolean;
}
const APPLIED = new Map<HTMLElement, SnapEntry>();

function restore(element: HTMLElement, entry: SnapEntry): void {
  element.style.position = entry.position;
  element.style.left = entry.left;
  element.style.top = entry.top;
}

function snapAll(elements: Iterable<HTMLElement>): void {
  const ratio = window.devicePixelRatio || 1;
  const writes: (() => void)[] = [];
  for (const element of elements) {
    if (!element.isConnected) continue;
    const computed = getComputedStyle(element);
    const inset = (value: string) => value === "auto" ? "0px" : value;
    const applied = APPLIED.get(element) ?? {
      x: 0, y: 0, position: element.style.position, left: element.style.left, top: element.style.top,
      baseLeft: inset(computed.left), baseTop: inset(computed.top),
      writtenLeft: element.style.left, writtenTop: element.style.top,
      writtenPosition: element.style.position, writtenStyle: element.style.cssText,
      relative: computed.position === "static",
    };
    // React/锚点重新定位后，新的内联坐标才是基准；不能把旧偏移再扣一次。
    if (element.style.left !== applied.writtenLeft) {
      applied.x = 0;
      applied.left = element.style.left;
      applied.baseLeft = inset(computed.left);
    }
    if (element.style.top !== applied.writtenTop) {
      applied.y = 0;
      applied.top = element.style.top;
      applied.baseTop = inset(computed.top);
    }
    if (element.style.position !== applied.writtenPosition) {
      applied.position = element.style.position;
      applied.relative = computed.position === "static";
    }
    const rect = element.getBoundingClientRect();
    // `data-zaicode-pixel-snap="xy"` also snaps the vertical edge (SRC-048); scrolled columns keep x only,
    // their top moves with every scroll step and a stale vertical nudge would shake them.
    const x = zaicodeSnapOffset(rect.left, applied.x, ratio);
    const y = element.dataset.zaicodePixelSnap === "xy" ? zaicodeSnapOffset(rect.top, applied.y, ratio) : 0;
    if (x === applied.x && y === applied.y) continue;
    writes.push(() => {
      // 先批量读取再写入；保留样式表的定位基值，不能把 10.5px 错写成 0.5px。
      const next = { ...applied, x, y };
      element.style.position = applied.relative && (x !== 0 || y !== 0) ? "relative" : applied.position;
      element.style.left = x === 0 ? applied.left : `calc(${applied.baseLeft} + ${x}px)`;
      element.style.top = y === 0 ? applied.top : `calc(${applied.baseTop} + ${y}px)`;
      next.writtenLeft = element.style.left;
      next.writtenTop = element.style.top;
      next.writtenPosition = element.style.position;
      next.writtenStyle = element.style.cssText;
      APPLIED.set(element, next);
    });
  }
  for (const write of writes) write();
}

let installed = false;

/**
 * Keeps centred columns on whole pixels: after every window or panel resize,
 * after relevant layout changes and when a target mounts. Unrelated DOM
 * churn and an idle page perform no target measurement or periodic polling.
 */
export function installZaicodePixelSnap(): () => void {
  if (installed || typeof window === "undefined") return () => undefined;
  installed = true;
  let disposed = false;
  let frame: number | null = null;
  const targets = new Set<HTMLElement>();
  const dirty = new Set<HTMLElement>();
  const observed = new Set<Element>();
  const schedule = () => {
    if (disposed || frame !== null || dirty.size === 0) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      const batch = [...dirty];
      dirty.clear();
      snapAll(batch);
    });
  };
  const markRelated = (changed: Element) => {
    for (const target of targets) {
      if (changed === target || changed.contains(target)) dirty.add(target);
    }
    schedule();
  };
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
    for (const entry of entries) markRelated(entry.target);
  });
  const syncObserved = () => {
    const next = new Set<Element>();
    for (const target of targets) {
      // 居中的列自身宽度可能不变；侧栏拖动改变的是父级可用宽度。
      for (let ancestor: Element | null = target; ancestor; ancestor = ancestor.parentElement) {
        next.add(ancestor);
        if (ancestor === document.body) break;
      }
    }
    for (const previous of observed) if (!next.has(previous)) observer?.unobserve(previous);
    for (const element of next) if (!observed.has(element)) observer?.observe(element);
    observed.clear();
    for (const element of next) observed.add(element);
  };
  const register = (element: HTMLElement) => {
    if (targets.has(element)) return;
    targets.add(element);
    dirty.add(element);
  };
  const discover = (root: Element) => {
    if (root instanceof HTMLElement && root.matches(ZAICODE_PIXEL_SNAP_SELECTOR)) register(root);
    // 初次仅扫描一次；随后只检查新增子树，绝不因别处刷新重扫整个 document。
    if (root.childElementCount > 0) {
      for (const element of root.querySelectorAll<HTMLElement>(ZAICODE_PIXEL_SNAP_SELECTOR)) register(element);
    }
  };
  const prune = () => {
    for (const element of targets) {
      if (element.isConnected && element.matches(ZAICODE_PIXEL_SNAP_SELECTOR)) continue;
      const applied = APPLIED.get(element);
      if (applied) restore(element, applied);
      APPLIED.delete(element);
      targets.delete(element);
      dirty.delete(element);
    }
  };
  const scheduleAll = () => {
    for (const target of targets) dirty.add(target);
    schedule();
  };
  const geometryChanged = (event: Event) => {
    if (event.target instanceof Element) markRelated(event.target);
    else scheduleAll();
  };
  discover(document.body);
  syncObserved();
  window.addEventListener("resize", scheduleAll);
  document.addEventListener("transitionend", geometryChanged, true);
  document.addEventListener("scroll", geometryChanged, true);
  const mutations = new MutationObserver((records) => {
    const previousCount = targets.size;
    for (const record of records) {
      if (record.type === "childList") {
        for (const added of record.addedNodes) if (added instanceof Element) discover(added);
        for (const target of targets) if (target.parentElement === record.target) dirty.add(target);
      } else if (record.target instanceof HTMLElement) {
        // 自己的校正写入不触发下一轮；外部锚点/布局的 style 更新仍须重新测量。
        if (record.attributeName === "style" && APPLIED.get(record.target)?.writtenStyle === record.target.style.cssText) continue;
        if (record.target.matches(ZAICODE_PIXEL_SNAP_SELECTOR)) register(record.target);
        markRelated(record.target);
      }
    }
    prune();
    if (previousCount !== targets.size || records.some(record => record.type === "childList")) syncObserved();
    schedule();
  });
  mutations.observe(document.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ["class", "style", "data-zaicode-pixel-snap", "data-v4-timeline-content-column", "data-v4-composer-dock-content"],
  });
  void document.fonts?.ready.then(scheduleAll);
  schedule();
  return () => {
    disposed = true;
    installed = false;
    window.removeEventListener("resize", scheduleAll);
    document.removeEventListener("transitionend", geometryChanged, true);
    document.removeEventListener("scroll", geometryChanged, true);
    observer?.disconnect();
    mutations.disconnect();
    if (frame !== null) window.cancelAnimationFrame(frame);
    for (const [element, entry] of APPLIED) restore(element, entry);
    APPLIED.clear();
    targets.clear();
    dirty.clear();
    observed.clear();
  };
}
