/**
 * In-page probe expressions for scripts/zaicode-soak.mjs.
 *
 * These are source strings, not modules the soak runner imports at runtime: they are
 * evaluated inside the packaged renderer's page, so they must stay self-contained
 * (no closure, no imports) and must only touch DOM / performance globals.
 */

export const PROBE = `(async () => {
  const root = document.querySelector("#root") ?? document.body;
  const frames = [];
  await new Promise((resolve) => {
    let last = performance.now();
    const started = last;
    const tick = (now) => {
      frames.push(now - last);
      last = now;
      if (now - started >= 2000) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const long = frames.filter((d) => d > 50).length;
  const heap = performance.memory;
  const health = window.__ZAICODE_RUNTIME_HEALTH__ ? window.__ZAICODE_RUNTIME_HEALTH__() : null;
  const text = (root?.textContent ?? "").trim();
  return {
    fps: Math.round((frames.length / 2) * 100) / 100,
    longFrames: long,
    nodes: document.getElementsByTagName("*").length,
    heapUsedBytes: heap ? heap.usedJSHeapSize : null,
    heapTotalBytes: heap ? heap.totalJSHeapSize : null,
    // SRC-116 的不变量：一个 valid project 选中后必须收敛到 loaded / loading / 明确错误，
    // 而不是永久空白。空白 = 几乎没有可见文本，也没有可见的子树。
    blank: (document.getElementsByTagName("*").length < 5 && text.length < 8),
    visibleTextLength: text.length,
    health,
  };
})()`;

export const CHURN = `(async () => {
  const click = (el) => { if (el) { el.click(); return true; } return false; };
  const actions = [];
  const rows = Array.from(document.querySelectorAll('[data-zaicode-project-row], [data-zaicode-home-project]'));
  if (rows.length > 0) { click(rows[Math.floor(Math.random() * rows.length)]); actions.push("project-row"); }
  const search = document.querySelector('input[type="search"], input[data-zaicode-search], input[placeholder*="earch"]');
  if (search) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(search, "a" + Math.floor(Math.random() * 1000));
    search.dispatchEvent(new Event("input", { bubbles: true }));
    actions.push("search");
    await new Promise((r) => setTimeout(r, 400));
    setter.call(search, "");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const back = document.querySelector('[data-zaicode-home-back], [aria-label="Back"]');
  if (back) { click(back); actions.push("back"); }
  return actions;
})()`;