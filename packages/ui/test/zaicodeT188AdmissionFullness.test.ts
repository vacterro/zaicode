/**
 * T-188: admission reads the percentage the surfaces RENDER, and recognises the
 * rolling shape Antigravity actually reports.
 *
 * The frozen nine-case oracle (test/zaicodeT188WindowStart.test.ts) builds every
 * window as a literal 100% with a reset a full window ahead — the starts-on-use
 * shape. That is why it stayed green while live admission was unreachable:
 * Antigravity reports `resetsAt = last real start + window length` and never a
 * literal 100 again after the first bounded request. A frozen oracle cannot catch
 * a defect its fixtures cannot express, so this file pins the real numbers.
 *
 * Both fixtures below are read out of the live cache the running app wrote at
 * 2026-10-04T20:04:48Z (`zaicode-engines-cache.json`, source `agy -p /usage`).
 *
 * Nothing here imports anything the pre-fix commit lacked, on purpose: this file
 * is the SAME verifier run against 0cda0488 and against the fix, so it carries the
 * red and the green of one regression pair rather than a suite that cannot even
 * load on the subject it is meant to convict. The new `zaicodeWindowIsFull`
 * export is pinned separately in zaicodeWindowIsFull.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  markZaicodeWindowsStartingOnUse,
  zaicodeIdleWindowToStart,
  zaicodeWindowShowsLiveCountdown,
  type ZaicodeLimitWindow,
  type ZaicodeLimitSnapshot,
} from "@zcode/shared";

const NOW = Date.UTC(2026, 9, 4, 20, 7);
const HOUR = 3_600_000;

/** five_hour@gemini_models at 20:04:48Z, untouched since the 15:01Z cycle rolled over. */
const VENDOR_TOUCHED_BUT_DISPLAYED_FULL = 99.82404112815857;
/** five_hour@claude_and_gpt_models at 20:04:48Z, mid-cycle and spent. */
const VENDOR_SPENT = 43.52897107601166;

function window(remainingPercent: number, resetsAt: number): ZaicodeLimitWindow {
  return {
    key: "five_hour@gemini_models",
    label: "5h",
    group: "gemini_models",
    groupLabel: "",
    remainingPercent,
    resetsAt,
    durationMinutes: 300,
    gatedBy: null,
    assumedFull: false,
    startsOnUse: false,
  };
}
function snapshot(windows: ZaicodeLimitWindow[]): ZaicodeLimitSnapshot {
  return { accountId: "antigravity:default", windows, plan: null, fetchedAt: NOW, checkedAt: NOW, error: null, source: "agy -p /usage" };
}
const account = { id: "antigravity:default", vendor: "antigravity" as const, status: "ready" as const };
const config = { keepWindowsRolling: true, hiddenAccounts: [] };

test("a rolled-over window the vendor still reports as full is admitted for a real starter", () => {
  // The rolling shape: the vendor's reset has passed and nothing has been spent
  // since. Neither the starts-on-use shape nor the local anchor can see this.
  const rolled = window(VENDOR_TOUCHED_BUT_DISPLAYED_FULL, NOW - 60_000);
  const windows = markZaicodeWindowsStartingOnUse([rolled], NOW);
  assert.equal(
    zaicodeIdleWindowToStart({ account, snapshot: snapshot(windows), config, now: NOW })?.key,
    "five_hour@gemini_models",
    "a window displayed as 100% refused to start: the exact defect T-188 names",
  );
  assert.equal(zaicodeWindowShowsLiveCountdown(windows[0]!, NOW), false, "an admitted idle window owes no countdown");
});

test("a genuinely spent window stays out of admission", () => {
  const windows = markZaicodeWindowsStartingOnUse([window(VENDOR_SPENT, NOW - 60_000)], NOW);
  assert.equal(zaicodeIdleWindowToStart({ account, snapshot: snapshot(windows), config, now: NOW }), null);
});

test("a rounded-full window that already has a real start is not started twice", () => {
  // Live shape of a started cycle: resetsAt = start + the window length, ahead.
  const start = { at: NOW - HOUR, ok: true, detail: "completed one bounded Antigravity request", windowKey: "five_hour@gemini_models" };
  const windows = markZaicodeWindowsStartingOnUse([window(VENDOR_TOUCHED_BUT_DISPLAYED_FULL, start.at + 5 * HOUR)], NOW, start);
  assert.equal(
    zaicodeIdleWindowToStart({ account, snapshot: snapshot(windows), config, now: NOW }),
    null,
    "a successful start inside the current window must survive the looser fullness test",
  );
  assert.equal(zaicodeWindowShowsLiveCountdown(windows[0]!, NOW), true);
});