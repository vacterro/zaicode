import { useLayoutEffect, useRef } from "react";
import {
  composerRowOverflowPx,
  quantizeFitPx,
  resolveComposerCompactCount,
} from "./composerFitDecision.js";

interface ComposerFitPlan {
  compact: boolean[];
  providerCompact: boolean;
  modelIcon: boolean;
  modelMaxWidth: string | null;
}

/** 仅拥有 DOM 布局投影；权限、Plan 和 CUA 业务状态仍由原有 hooks 管理。 */
function fitComposerToolbar(root: HTMLElement, liveCount: number): ComposerFitPlan | null {
  const content = root.querySelector<HTMLElement>("[data-composer-leading-content]");
  const trailing = root.querySelector<HTMLElement>("[data-composer-trailing-actions]");
  if (!content || !trailing) return null;
  const controls = Array.from(
    root.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]"),
  ).sort(
    (a, b) =>
      Number(a.dataset.composerCollapsePriority) - Number(b.dataset.composerCollapsePriority),
  );
  // 每次从完整布局测量，避免各按钮独立 observer 互相抢空间，也覆盖语言与异步入口变化。
  delete root.dataset.composerModelIcon;
  root.style.removeProperty("--composer-model-max-width");
  delete root.dataset.composerProviderCompact;
  for (const control of controls) delete control.dataset.composerCompact;
  const prefixLine = root.querySelector<HTMLElement>(".composer-provider-prefix")?.parentElement;
  const providerCompact =
    Boolean(prefixLine) && prefixLine!.scrollWidth > prefixLine!.clientWidth;
  if (providerCompact) {
    root.dataset.composerProviderCompact = "true";
  }
  // 整行才是可用宽度：只比较左侧内容与左侧容器，会在右侧簇本身过宽时永远认为
  // 左侧「放得下」，阶梯走到头仍然溢出——正是 SRC-151:R002 报的按钮装不下。
  const gap = Number.parseFloat(getComputedStyle(root).columnGap) || 12;
  // SRC-151:R009 (media/010, 301px row): a wrapped child keeps its own
  // min-content width past its cluster's box (83px box, 187px Switch mode),
  // so the box-width sum reads "fits" while the child draws 92px over the
  // trailing buttons. Measure each cluster to its furthest child edge.
  const extent = (element: HTMLElement) => {
    const box = element.getBoundingClientRect();
    let furthest = box.width;
    for (const child of element.querySelectorAll("*")) {
      const edge = child.getBoundingClientRect().right - box.left;
      if (edge > furthest) furthest = edge;
    }
    return Math.max(0, furthest);
  };
  // T-224 / SRC-154:R002: every measurement is quantized before it decides.
  // Fractional ResizeObserver frames must never flip a rung: the ladder below
  // is whole pixels, and the release side additionally holds inside the
  // hysteresis band (composerFitDecision.ts), so a stable row converges to one
  // plan and stops touching the layout.
  // SRC-161:REQ-008 (T-240): a row that has ALREADY wrapped (the attachment `+`
  // left alone on a blank full-width strip, trailing cluster pushed to the next
  // line) must not be measured as if the two clusters shared a line — that sum
  // reads "fits" on a visibly broken row, which is how the packaged composer kept
  // it. Two clusters are on one row when their boxes still overlap vertically.
  const sameRow = () => {
    const leading = content.getBoundingClientRect();
    const trail = trailing.getBoundingClientRect();
    if (leading.height <= 0 || trail.height <= 0 || leading.width <= 0) return true;
    return trail.top < leading.bottom - 1 && leading.top < trail.bottom - 1;
  };
  // SRC-162: the trailing cluster now wraps its own buttons instead of dropping to a new line
  // whole, so its box always "fits". A cluster whose buttons sit on more than one line has
  // still run out of room, and the ladder keeps compacting before it accepts the wrap.
  const trailingWraps = () => {
    const tops = Array.from(trailing.children)
      .map((child) => child.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0)
      .map((box) => box.top + box.height / 2);
    if (tops.length < 2) return false;
    const first = trailing.children[0]?.getBoundingClientRect();
    const tolerance = Math.max(4, (first?.height ?? 0) / 2);
    return Math.max(...tops) - Math.min(...tops) > tolerance;
  };
  const overflowPx = () =>
    composerRowOverflowPx({
      leadingExtent: extent(content),
      trailingExtent: extent(trailing),
      width: root.getBoundingClientRect().width,
      gap,
      sameRow: sameRow() && !trailingWraps(),
    });
  const rungOverflowsPx: number[] = [overflowPx()];
  for (const control of controls) {
    control.dataset.composerCompact = "true";
    rungOverflowsPx.push(overflowPx());
  }
  const compactCount = resolveComposerCompactCount({ rungOverflowsPx, liveCount });
  for (const [index, control] of controls.entries()) {
    if (index < compactCount) control.dataset.composerCompact = "true";
    else delete control.dataset.composerCompact;
  }
  if (overflowPx() <= 0) {
    return {
      compact: controls.map((_, index) => index < compactCount),
      providerCompact,
      modelIcon: false,
      modelMaxWidth: null,
    };
  }
  // 全部 rung 用尽仍放不下：压模型名。发送键与取消键永不收起，再窄时整行由
  // CSS 换行，不静默裁掉按钮（UI.md Predictability #1/#2）。
  const model = root.querySelector<HTMLElement>(".composer-model-trigger");
  if (!model) {
    return {
      compact: controls.map((_, index) => index < compactCount),
      providerCompact,
      modelIcon: false,
      modelMaxWidth: null,
    };
  }
  const modelWidth = Math.max(28, quantizeFitPx(model.getBoundingClientRect().width) - overflowPx());
  if (modelWidth < 80) {
    root.dataset.composerModelIcon = "true";
    return {
      compact: controls.map((_, index) => index < compactCount),
      providerCompact,
      modelIcon: true,
      modelMaxWidth: null,
    };
  }
  const modelMaxWidth = `${modelWidth}px`;
  root.style.setProperty("--composer-model-max-width", modelMaxWidth);
  return {
    compact: controls.map((_, index) => index < compactCount),
    providerCompact,
    modelIcon: false,
    modelMaxWidth,
  };
}

export function useComposerToolbarFit() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    let frame = 0;
    const applyPlan = (plan: ComposerFitPlan) => {
      // A converged row stops touching the layout: writing the same datasets
      // back would resize nothing, but it would keep the observer busy and the
      // row repainting — the blur in the report.
      let changed = false;
      if (plan.providerCompact) {
        if (root.dataset.composerProviderCompact !== "true") {
          root.dataset.composerProviderCompact = "true";
          changed = true;
        }
      } else if (root.dataset.composerProviderCompact !== undefined) {
        delete root.dataset.composerProviderCompact;
        changed = true;
      }
      if (plan.modelIcon) {
        if (root.dataset.composerModelIcon !== "true") {
          root.dataset.composerModelIcon = "true";
          changed = true;
        }
      } else if (root.dataset.composerModelIcon !== undefined) {
        delete root.dataset.composerModelIcon;
        changed = true;
      }
      const liveMaxWidth = root.style.getPropertyValue("--composer-model-max-width");
      if ((plan.modelMaxWidth ?? "") !== liveMaxWidth) {
        if (plan.modelMaxWidth) root.style.setProperty("--composer-model-max-width", plan.modelMaxWidth);
        else root.style.removeProperty("--composer-model-max-width");
        changed = true;
      }
      // The live row is matched in the same priority order the probe decided in:
      // document order and collapse order are not the same thing.
      const live = Array.from(
        root.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]"),
      ).sort(
        (a, b) =>
          Number(a.dataset.composerCollapsePriority) - Number(b.dataset.composerCollapsePriority),
      );
      live.forEach((control, index) => {
        const want = plan.compact[index] ?? false;
        const has = control.dataset.composerCompact === "true";
        if (want === has) return;
        if (want) control.dataset.composerCompact = "true";
        else delete control.dataset.composerCompact;
        changed = true;
      });
      return changed;
    };
    const update = () => {
      if (!root.parentElement || root.getBoundingClientRect().width <= 0) return;
      // The live collapsed depth is the hysteresis memory: releasing a rung
      // needs real slack, so the boundary cannot alternate compact/full.
      const liveCount = root.querySelectorAll<HTMLElement>(
        "[data-composer-collapse-priority][data-composer-compact]",
      ).length;
      // 在不可见副本上尝试展开，避免真实按钮测量时来回移动、丢失 hover 或关闭 Tooltip。
      const probe = root.cloneNode(true) as HTMLElement;
      probe.setAttribute("aria-hidden", "true");
      probe.inert = true;
      Object.assign(probe.style, {
        position: "absolute",
        visibility: "hidden",
        pointerEvents: "none",
        width: `${quantizeFitPx(root.getBoundingClientRect().width)}px`,
        left: "0",
        top: "0",
      });
      root.parentElement.append(probe);
      try {
        const plan = fitComposerToolbar(probe, liveCount);
        if (plan) applyPlan(plan);
      } finally {
        probe.remove();
      }
    };
    // ResizeObserver can fire several fractional frames per settle; coalesce
    // them into one decision per frame instead of deciding mid-wobble.
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    const observe = () => {
      resize?.disconnect();
      resize?.observe(root);
      for (const element of root.querySelectorAll<HTMLElement>(
        "[data-composer-leading-actions], [data-composer-leading-content], [data-composer-trailing-actions]",
      ))
        resize?.observe(element);
      schedule();
    };
    // 不观察布局属性自身，防止写 data-composer-compact 引起递归测量。
    const mutations = new MutationObserver(observe);
    mutations.observe(root, { childList: true, subtree: true, characterData: true });
    observe();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize?.disconnect();
      mutations.disconnect();
    };
  }, []);
  return ref;
}
