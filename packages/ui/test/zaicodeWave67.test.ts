import assert from "node:assert/strict";
import test from "node:test";
import {
  ZAICODE_NOW_STEP_MINUTE_MS,
  ZAICODE_NOW_STEP_SECOND_MS,
  zaicodeNowBucketChanged,
  zaicodeNowStepMs,
} from "../src/zaicode/zaicodeNowGate.js";

// T-67 (SRC-049): the change-gated 1-second tick. Same timer accuracy, but a
// minute-granularity display renders once a minute instead of 60 times.

test("zaicodeNowStepMs: showSeconds forces the second step", () => {
  const now = 1_700_000_000_000;
  assert.equal(zaicodeNowStepMs({ showSeconds: true, secondTargets: [] }, now), ZAICODE_NOW_STEP_SECOND_MS);
  assert.equal(
    zaicodeNowStepMs({ showSeconds: true, secondTargets: [now + 5 * 60_000] }, now),
    ZAICODE_NOW_STEP_SECOND_MS,
  );
});

test("zaicodeNowStepMs: a countdown inside the last hour needs seconds (formatZaicodeRemaining shows them)", () => {
  const now = 1_700_000_000_000;
  assert.equal(
    zaicodeNowStepMs({ showSeconds: false, secondTargets: [now + 59 * 60_000] }, now),
    ZAICODE_NOW_STEP_SECOND_MS,
  );
  assert.equal(
    zaicodeNowStepMs({ showSeconds: false, secondTargets: [now + 61 * 60_000] }, now),
    ZAICODE_NOW_STEP_MINUTE_MS,
  );
  // Several targets: the nearest one decides.
  assert.equal(
    zaicodeNowStepMs({ showSeconds: false, secondTargets: [now + 61 * 60_000, now + 30_000] }, now),
    ZAICODE_NOW_STEP_SECOND_MS,
  );
  assert.equal(zaicodeNowStepMs({ showSeconds: false, secondTargets: [] }, now), ZAICODE_NOW_STEP_MINUTE_MS);
});

test("gated tick: a minute display renders once a minute, not 60 times (T-67 before/after)", () => {
  const start = 1_700_000_000_000; // a minute boundary
  let now = start;
  let renders = 0;
  const advance = (next: number) => {
    // what useZaicodeGatedNow's setState does on each 1s tick
    if (zaicodeNowBucketChanged(now, next, zaicodeNowStepMs({ showSeconds: false, secondTargets: [] }, next))) {
      now = next;
      renders += 1;
    }
  };
  for (let second = 1; second <= 60; second += 1) advance(start + second * 1000);
  assert.equal(renders, 1, "one render per minute for a minute-granularity clock");
});

test("gated tick: a seconds display still renders every second", () => {
  const start = 1_700_000_000_000;
  let now = start;
  let renders = 0;
  for (let second = 1; second <= 60; second += 1) {
    const next = start + second * 1000;
    if (zaicodeNowBucketChanged(now, next, zaicodeNowStepMs({ showSeconds: true, secondTargets: [] }, next))) {
      now = next;
      renders += 1;
    }
  }
  assert.equal(renders, 60);
});

test("gated tick: stepping into the last hour switches to seconds without freezing", () => {
  const start = 1_700_000_000_000;
  const due = start + 61 * 60_000;
  let now = start;
  let renders = 0;
  const advance = (at: number) => {
    if (zaicodeNowBucketChanged(now, at, zaicodeNowStepMs({ showSeconds: false, secondTargets: [due] }, at))) {
      now = at;
      renders += 1;
    }
  };
  for (let second = 1; second <= 120; second += 1) advance(start + second * 1000);
  // minute renders until the hour line, second renders after it: never frozen
  assert.ok(renders >= 2, `expected renders across the granularity switch, got ${renders}`);
});

test("T-67: ZAICODE stores are visible to the 60s memory diagnostics (counters registered)", async () => {
  const { uiMemoryDiagnosticsRegistry } = await import("../src/lib/memoryDiagnostics.js");
  // Importing the modules performs the registrations; providers must be pure reads.
  await import("../src/zaicode/zaicodeTimerStore.js");
  await import("../src/zaicode/zaicodeAuditStore.js");
  await import("../src/zaicode/zaicodeNotifications.js");
  const counters = uiMemoryDiagnosticsRegistry.collect();
  assert.equal(counters["zaicodeTimers.timers"], 0);
  assert.equal(counters["zaicodeAudits.campaigns"], 0);
  assert.equal(counters["zaicodeNotifications.toasts"], 0);
  assert.ok(Number.isFinite(counters["zaicodeTimers.intervalRules"]));
});
