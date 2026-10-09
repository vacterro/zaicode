// T-266 -- the second limit meter lags the first when a quota window ends:
// both meters render one shared snapshot on a 30s poll, so the sidebar tile
// keeps showing spent/old data until the next tick. useZaicodeResetRefresh
// schedules an exact refresh at the soonest window reset. These tests pin the
// reset-detection that decides when that refresh fires.

import assert from "node:assert/strict";
import test from "node:test";
import { earliestPendingReset } from "../src/zaicode/zaicodeEngines.js";
import { normalizeZaicodeEnginesConfig, type ZaicodeEnginesState, type ZaicodeLimitSnapshot, type ZaicodeLimitWindow } from "@zcode/shared";


const NOW = 1_800_000_000_000;
const win = (patch: Partial<ZaicodeLimitWindow> = {}): ZaicodeLimitWindow => ({
  key: "five_hour",
  label: "5h",
  group: "",
  groupLabel: "",
  remainingPercent: 0,
  resetsAt: NOW + 60_000,
  durationMinutes: 300,
  gatedBy: null,
  assumedFull: false,
  startsOnUse: false,
  ...patch,
});
const snap = (accountId: string, windows: ZaicodeLimitWindow[]): ZaicodeLimitSnapshot => ({
  accountId,
  windows,
  fetchedAt: NOW,
  plan: null,
  error: null,
});
const state = (limits: Record<string, ZaicodeLimitSnapshot>): ZaicodeEnginesState => ({
  accounts: [],
  limits,
  sweeping: false,
  probing: [],
  lastSweepAt: null,
  nextSweepAt: null,
  config: normalizeZaicodeEnginesConfig(null),
});

test("picks the soonest upcoming reset across engines", () => {
  const s = state({
    a: snap("a", [win({ resetsAt: NOW + 120_000 })]),
    b: snap("b", [win({ resetsAt: NOW + 30_000 })]),
    c: snap("c", [win({ resetsAt: NOW + 90_000 })]),
  });
  assert.equal(earliestPendingReset(s, NOW), NOW + 30_000);
});

test("ignores resets already past and windows with no reset time", () => {
  const s = state({
    a: snap("a", [win({ resetsAt: NOW - 1_000 })]), // already reset
    b: snap("b", [win({ resetsAt: null })]),
    c: snap("c", [win({ resetsAt: NOW + 45_000 })]),
  });
  assert.equal(earliestPendingReset(s, NOW), NOW + 45_000);
});

test("returns null when no snapshot has a live upcoming reset", () => {
  assert.equal(earliestPendingReset(state({ a: snap("a", [win({ resetsAt: NOW - 5_000 })]) }), NOW), null);
  assert.equal(earliestPendingReset(state({}), NOW), null);
});

test("a spent window (0%) whose reset is imminent triggers a refresh", () => {
  // The exact T-266 case: window at 0%, reset crossing now -> must be selected.
  const s = state({
    a: snap("a", [win({ remainingPercent: 0, resetsAt: NOW + 1_000 })]),
  });
  assert.equal(earliestPendingReset(s, NOW), NOW + 1_000);
});
