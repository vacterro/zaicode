// The soak's own PASS rules, exercised without spending a day on a run.
//
// Run: node --test scripts/zaicode-soak-verdict.test.mjs
// Not wired into verify:pre-push; cite it as ticket evidence instead.
import assert from "node:assert/strict";
import test from "node:test";

import { buildVerdict } from "./zaicode-soak-verdict.mjs";

/** One healthy sample of a rendered ZAICODE surface. */
function sample(elapsedSeconds, overrides = {}) {
  return {
    at: new Date().toISOString(),
    elapsedSeconds,
    phase: "churn",
    rssBytes: 300 * 1048576,
    fps: 60,
    longFrames: 0,
    nodes: 1800,
    heapUsedBytes: 40 * 1048576,
    heapTotalBytes: 60 * 1048576,
    blank: false,
    visibleTextLength: 400,
    health: null,
    ...overrides,
  };
}

const CHURNED = { churnMinutes: 2, soakHours: 0, churnActions: { "project-row": 40 }, churnErrors: 0 };

test("a rendered surface that churned and held its frame rate passes", () => {
  const timeline = [0, 15, 30, 45, 60].map((second) => sample(second));
  const verdict = buildVerdict(timeline, CHURNED);
  assert.equal(verdict.verdict, "PASS");
  assert.equal(verdict.medianNodes, 1800);
  assert.equal(verdict.churnTotal, 40);
});

test("a run that never painted the product is not a pass", () => {
  // The recorded failure: a packaged shell answering CDP with ~11 nodes while fps and heap
  // look perfect. This used to report PASS with blankSurfaceSamples 0.
  const timeline = [0, 15, 30].map((second) => sample(second, { nodes: 11, visibleTextLength: 0, blank: true }));
  assert.equal(buildVerdict(timeline, CHURNED).verdict, "FAIL_SURFACE_NOT_RENDERED");
});

test("a run whose probes all failed has nothing to judge", () => {
  const verdict = buildVerdict([{ at: "x", elapsedSeconds: 15, probeError: "detached" }], CHURNED);
  assert.equal(verdict.verdict, "FAIL_NO_SAMPLES");
  assert.equal(verdict.samples, 0);
});

test("a requested churn that clicked nothing is not a pass", () => {
  const timeline = [0, 15, 30, 45, 60].map((second) => sample(second));
  const verdict = buildVerdict(timeline, { ...CHURNED, churnActions: {}, churnTotal: 0 });
  assert.equal(verdict.verdict, "FAIL_NO_CHURN");
});

test("a surface that painted a tree but stayed empty fails as blank", () => {
  // The node count is healthy, so the render floor is satisfied; what SRC-116 names is the
  // surface converging to nothing readable. Only the text check can catch that.
  const timeline = [0, 15, 30, 45, 60].map((second) => sample(second, { blank: true, visibleTextLength: 0 }));
  assert.equal(buildVerdict(timeline, CHURNED).verdict, "FAIL_BLANK_SURFACE");
});

test("SRC-116's symptom, half the baseline frame rate, still fails as degraded", () => {
  const timeline = [
    sample(0),
    sample(900),
    sample(1800),
    sample(2700, { fps: 2, longFrames: 60 }),
    sample(3600, { fps: 1, longFrames: 90 }),
  ];
  assert.equal(buildVerdict(timeline, { ...CHURNED, soakHours: 1 }).verdict, "FAIL_DEGRADED");
});