/**
 * T-224 / SRC-154:R002 — the composer converges instead of jittering.
 *
 * The report: the composer shifts left/right continuously and looks blurred
 * from repeated movement. The failure class is a measurement/state loop —
 * layout measurement changes the compact state, the compact state changes the
 * measured geometry, the new geometry reverses the decision.
 *
 * These tests exercise the boundary width directly against the pure decision
 * (`composerFitDecision.ts`), driving it the way the hook does: measure the
 * full-layout overflow ladder, decide, apply, repeat. The simulated container
 * width wobbles by fractions of a pixel between passes (sidebar drag frames,
 * DPI rounding, sub-pixel ResizeObserver callbacks), which is exactly what the
 * live row sees.
 *
 * The RED control replays the old rule — raw fractional overflow against a
 * 0.5px threshold, no quantization, no hysteresis — and must alternate forever.
 * The GREEN cases run the shipped rule and must converge: bounded transitions,
 * one eventual mode, no compact/full loop, stable neighbors.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  COMPOSER_FIT_HYSTERESIS_PX,
  quantizeFitPx,
  resolveComposerCompactCount,
} from "@/prompt-editor/composerFitDecision.js";

interface SimRow {
  content: number;
  trailing: number;
  gap: number;
  /** Pixels the full layout sheds when the first k rungs collapse. */
  savings: number[];
}

/** Raw (fractional, unquantized) overflow with the first `depth` rungs collapsed. */
function rawOverflow(containerWidth: number, row: SimRow, depth: number): number {
  const shed = depth <= 0 ? 0 : row.savings[Math.min(depth, row.savings.length) - 1];
  return row.content + row.trailing + row.gap - shed - containerWidth;
}

/** The quantized ladder the hook measures from its hidden probe. */
function rungLadder(containerWidth: number, row: SimRow): number[] {
  const ladder: number[] = [];
  for (let depth = 0; depth <= row.savings.length; depth += 1) {
    ladder.push(quantizeFitPx(rawOverflow(containerWidth, row, depth)));
  }
  return ladder;
}

/**
 * The old shipped rule, replayed exactly: reset to the full layout every pass,
 * compare RAW fractional overflow against 0.5px, collapse rungs until it fits.
 * No quantization, no hysteresis, no memory of the live state.
 */
function oldRuleDepth(containerWidth: number, row: SimRow): number {
  for (let depth = 0; depth <= row.savings.length; depth += 1) {
    if (rawOverflow(containerWidth, row, depth) <= 0.5) return depth;
  }
  return row.savings.length;
}

/** Drive one rule to a fixed point (or to the transition cap) on a wobbling container. */
function drive(
  decide: (containerWidth: number, live: number) => number,
  containers: number[],
  start: number,
  cap = 40,
): { depths: number[]; transitions: number } {
  const depths: number[] = [start];
  let live = start;
  let transitions = 0;
  for (let pass = 0; pass < cap; pass += 1) {
    const next = decide(containers[pass % containers.length], live);
    if (next !== live) {
      transitions += 1;
      live = next;
      depths.push(live);
    } else if (pass >= containers.length - 1) {
      break;
    }
  }
  return { depths, transitions };
}

/**
 * A 301px-class row at the boundary: full layout overflows by a fraction of a
 * pixel, and the first rung sheds far more than the overflow. The container
 * alternates between two fractional widths the way ResizeObserver frames do
 * while a sidebar settles.
 */
const BOUNDARY_ROW: SimRow = {
  content: 187.4,
  trailing: 102.2,
  gap: 12,
  savings: [96.8, 24.5, 18.1],
};
const WOBBLE = [301.4, 300.7];

test("R002 RED: the old fractional-threshold rule alternates forever at the boundary", () => {
  const { depths, transitions } = drive((width) => oldRuleDepth(width, BOUNDARY_ROW), WOBBLE, 0);
  assert.ok(transitions >= 10, `the old rule must keep flipping (saw ${transitions} transitions)`);
  const tail = depths.slice(-6);
  const compact = new Set(tail);
  assert.ok(compact.size > 1, `the old rule never settles: ${tail.join(" -> ")}`);
  assert.ok(
    tail.every((depth, index) => index === 0 || depth !== tail[index - 1]),
    `the old rule alternates every pass: ${tail.join(" -> ")}`,
  );
});

test("R002: the shipped rule converges at the same boundary and stays there", () => {
  const { depths, transitions } = drive(
    (width, live) =>
      resolveComposerCompactCount({ rungOverflowsPx: rungLadder(width, BOUNDARY_ROW), liveCount: live }),
    WOBBLE,
    0,
  );
  assert.ok(transitions <= BOUNDARY_ROW.savings.length + 1, `bounded transitions (saw ${transitions})`);
  const settled = depths[depths.length - 1];
  // Once settled, every wobble frame re-decides the same depth: a fixed point.
  for (const width of WOBBLE) {
    assert.equal(
      resolveComposerCompactCount({ rungOverflowsPx: rungLadder(width, BOUNDARY_ROW), liveCount: settled }),
      settled,
      `wobble width ${width}px must not move the settled depth ${settled}`,
    );
  }
});

test("R002: convergence holds from a fully-collapsed start too", () => {
  const { depths, transitions } = drive(
    (width, live) =>
      resolveComposerCompactCount({ rungOverflowsPx: rungLadder(width, BOUNDARY_ROW), liveCount: live }),
    WOBBLE,
    BOUNDARY_ROW.savings.length,
  );
  assert.ok(transitions <= BOUNDARY_ROW.savings.length + 1, `bounded transitions (saw ${transitions})`);
  const settled = depths[depths.length - 1];
  for (const width of WOBBLE) {
    assert.equal(
      resolveComposerCompactCount({ rungOverflowsPx: rungLadder(width, BOUNDARY_ROW), liveCount: settled }),
      settled,
    );
  }
});

test("R002: neighboring widths are stable — no rung flapping across 0.5px steps", () => {
  const settledAt = (width: number): number => {
    const { depths } = drive(
      (w, live) =>
        resolveComposerCompactCount({ rungOverflowsPx: rungLadder(w, BOUNDARY_ROW), liveCount: live }),
      [width],
      0,
    );
    return depths[depths.length - 1];
  };
  let last = settledAt(296);
  for (let width = 296.5; width <= 308; width += 0.5) {
    const settled = settledAt(width);
    assert.ok(
      Math.abs(settled - last) <= 1,
      `${width}px settles at ${settled} rungs, previous ${last}: neighbors must not jump`,
    );
    last = settled;
  }
});

test("R002: the decision is idempotent — deciding twice changes nothing", () => {
  const widths = [300.2, 301.4, 320, 900, 1366];
  for (const width of widths) {
    for (let live = 0; live <= BOUNDARY_ROW.savings.length; live += 1) {
      const once = resolveComposerCompactCount({ rungOverflowsPx: rungLadder(width, BOUNDARY_ROW), liveCount: live });
      const twice = resolveComposerCompactCount({ rungOverflowsPx: rungLadder(width, BOUNDARY_ROW), liveCount: once });
      assert.equal(twice, once, `${width}px from ${live}: second decision must be a no-op`);
    }
  }
});

test("R002: release needs real slack — the hysteresis band holds the compact side", () => {
  // Full layout overflows by 3px: naive says 1 rung, live is 1 rung, hold.
  assert.equal(
    resolveComposerCompactCount({ rungOverflowsPx: [3, -94], liveCount: 1 }),
    1,
    "3px of overflow must not release the rung",
  );
  // Full layout fits with 8px to spare: release.
  assert.equal(
    resolveComposerCompactCount({ rungOverflowsPx: [-8, -104], liveCount: 1 }),
    0,
    "8px of slack releases the rung",
  );
  // 7px of slack: still inside the band, hold.
  assert.equal(
    resolveComposerCompactCount({ rungOverflowsPx: [-7, -103], liveCount: 1 }),
    1,
    "7px of slack must not release yet",
  );
  assert.equal(COMPOSER_FIT_HYSTERESIS_PX, 8);
});

test("R002: collapse is never delayed — any overflow adds rungs immediately", () => {
  assert.equal(resolveComposerCompactCount({ rungOverflowsPx: [1, -95], liveCount: 0 }), 1);
  assert.equal(resolveComposerCompactCount({ rungOverflowsPx: [120, 40, -10], liveCount: 0 }), 2);
  assert.equal(resolveComposerCompactCount({ rungOverflowsPx: [400, 300, 200], liveCount: 0 }), 2, "exhausted ladder pins at the deepest rung");
});

test("R002: quantization kills the fractional flip-flop before it decides", () => {
  assert.equal(quantizeFitPx(0.5), 1 - 0, "rounds half pixels deterministically");
  assert.equal(quantizeFitPx(0.49), 0);
  assert.equal(quantizeFitPx(-0.49), -0 + 0);
  assert.equal(quantizeFitPx(Number.NaN), 0, "a detached row reads as fits, never as collapse-everything");
  assert.equal(quantizeFitPx(Number.POSITIVE_INFINITY), 0);
});

test("R002: out-of-range live counts clamp instead of corrupting the plan", () => {
  assert.equal(resolveComposerCompactCount({ rungOverflowsPx: [-5, -100], liveCount: 99 }), 1, "live clamps to the deepest rung, and 5px of slack holds it there");
  assert.equal(resolveComposerCompactCount({ rungOverflowsPx: [50, 40], liveCount: -4 }), 1);
  assert.equal(resolveComposerCompactCount({ rungOverflowsPx: [], liveCount: 0 }), 0, "no ladder, no rungs");
});

test("R002: the product rows converge — sidebar open/closed, attachment, SAIFREN, narrow, fractional", () => {
  const rows: { name: string; row: SimRow; containers: number[] }[] = [
    { name: "wide composer, sidebar closed", row: { content: 620.3, trailing: 210.6, gap: 12, savings: [96.8, 24.5] }, containers: [1366.2, 1365.8] },
    { name: "composer with left sidebar open", row: { content: 540.7, trailing: 210.6, gap: 12, savings: [96.8, 24.5] }, containers: [900.4, 899.6] },
    { name: "composer with right sidebar open", row: { content: 512.2, trailing: 238.9, gap: 12, savings: [96.8, 24.5] }, containers: [880.1, 879.5] },
    { name: "attachment chip present (extra rung)", row: { content: 402.6, trailing: 210.6, gap: 12, savings: [96.8, 48.2, 24.5] }, containers: [640.3, 639.7] },
    { name: "SAIFREN controls present", row: { content: 402.6, trailing: 268.4, gap: 12, savings: [96.8, 24.5, 18.1] }, containers: [700.2, 699.8] },
    { name: "narrow 1366-class window", row: { content: 260.5, trailing: 190.3, gap: 12, savings: [96.8, 24.5] }, containers: [420.4, 419.6] },
    { name: "very narrow row", row: { content: 187.4, trailing: 150.8, gap: 12, savings: [96.8, 24.5, 18.1] }, containers: [320.2, 319.7] },
    { name: "fractional DPI width", row: { content: 333.35, trailing: 175.15, gap: 12.5, savings: [96.8, 24.5] }, containers: [520.9, 520.4] },
  ];
  for (const { name, row, containers } of rows) {
    for (const start of [0, row.savings.length]) {
      const { depths, transitions } = drive(
        (width, live) =>
          resolveComposerCompactCount({ rungOverflowsPx: rungLadder(width, row), liveCount: live }),
        containers,
        start,
      );
      assert.ok(
        transitions <= row.savings.length + 1,
        `${name} from ${start}: bounded transitions (saw ${transitions}: ${depths.join(" -> ")})`,
      );
      const settled = depths[depths.length - 1];
      for (const width of containers) {
        assert.equal(
          resolveComposerCompactCount({ rungOverflowsPx: rungLadder(width, row), liveCount: settled }),
          settled,
          `${name} at ${width}px must hold depth ${settled}`,
        );
      }
    }
  }
});

test("R002: the hook decides through the hysteresis module and never repaints a converged row", () => {
  const hookSrc = readFileSync(join(import.meta.dirname, "../src/prompt-editor/useComposerToolbarFit.ts"), "utf8");
  assert.match(hookSrc, /from "\.\/composerFitDecision\.js"/, "the decision lives in the tested module");
  assert.match(hookSrc, /resolveComposerCompactCount\(\{ rungOverflowsPx/, "the ladder resolves through it");
  assert.match(hookSrc, /quantizeFitPx\(/, "measurements quantize before they decide");
  assert.match(hookSrc, /requestAnimationFrame/, "observer bursts batch per frame");
  assert.match(hookSrc, /cancelAnimationFrame/, "the batch is disposed with the row");
});
