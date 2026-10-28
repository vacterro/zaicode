/**
 * T-188: fullness is the rounded number the surfaces PRINT, not the vendor's raw
 * fraction. `ZaicodeLimitViews` and `ZaicodeEngineBar` both render
 * `Math.round(remainingPercent)`, so admission that reads the raw value can refuse
 * to start a window the operator is looking at as 100% full.
 *
 * The two fractions below are the ones the live Antigravity profile reported at
 * 2026-10-04T20:04:48Z (`zaicode-engines-cache.json`, source `agy -p /usage`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { zaicodeWindowIsFull, type ZaicodeLimitWindow } from "@zcode/shared";

const NOW = Date.UTC(2026, 9, 4, 20, 7);
/** five_hour@gemini_models at 20:04:48Z, untouched since the 15:01Z cycle rolled over. */
const VENDOR_TOUCHED_BUT_DISPLAYED_FULL = 99.82404112815857;
/** five_hour@claude_and_gpt_models at 20:04:48Z, mid-cycle and spent. */
const VENDOR_SPENT = 43.52897107601166;

function window(remainingPercent: number | null): ZaicodeLimitWindow {
  return {
    key: "five_hour@gemini_models",
    label: "5h",
    group: "gemini_models",
    groupLabel: "",
    remainingPercent,
    resetsAt: NOW,
    durationMinutes: 300,
    gatedBy: null,
    assumedFull: false,
    startsOnUse: false,
  };
}

test("fullness is the rounded number the UI prints, not the vendor's raw fraction", () => {
  assert.equal(Math.round(VENDOR_TOUCHED_BUT_DISPLAYED_FULL), 100, "the engine tile rendered this window as 100%");
  assert.equal(zaicodeWindowIsFull(window(VENDOR_TOUCHED_BUT_DISPLAYED_FULL)), true);
  assert.equal(zaicodeWindowIsFull(window(VENDOR_SPENT)), false);
  assert.equal(zaicodeWindowIsFull(window(null)), true, "an unread percentage is not evidence of spend");
});

test("one rounding, one meaning across every surface that shows a window", () => {
  // The 99.5 boundary is what makes this a rounding and not a threshold: below it
  // the tile prints 99, above it 100, and the admission test has to agree with
  // whichever the operator is actually reading.
  assert.equal(Math.round(99.4999), 99);
  assert.equal(zaicodeWindowIsFull(window(99.4999)), false);
  assert.equal(Math.round(99.5), 100);
  assert.equal(zaicodeWindowIsFull(window(99.5)), true);
});