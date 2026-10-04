import assert from "node:assert/strict";
import { test } from "node:test";
import {
  markZaicodeWindowsStartingOnUse,
  isZaicodeWindowWaitingForFirstUse,
  zaicodeIdleWindowToStart,
  zaicodeWindowShowsLiveCountdown,
  type ZaicodeLimitWindow,
  type ZaicodeLimitSnapshot,
} from "@zcode/shared";

const NOW = Date.UTC(2026, 9, 3, 12);
const HOUR = 3_600_000;
function window(key = "five_hour@gemini_models", patch: Partial<ZaicodeLimitWindow> = {}): ZaicodeLimitWindow {
  return { key, label: "5h", group: key.split("@")[1] ?? "", groupLabel: "", remainingPercent: 100, resetsAt: NOW + 5 * HOUR, durationMinutes: 300, gatedBy: null, assumedFull: false, startsOnUse: false, ...patch };
}
function snapshot(windows: ZaicodeLimitWindow[], patch: Partial<ZaicodeLimitSnapshot> = {}): ZaicodeLimitSnapshot {
  return { accountId: "ag", windows, plan: null, fetchedAt: NOW, checkedAt: NOW, error: null, source: "agy", ...patch };
}
const account = { id: "ag", vendor: "antigravity" as const, status: "ready" as const };
const config = { keepWindowsRolling: true, hiddenAccounts: [] };
const start = { at: NOW, ok: true, detail: "real completion", windowKey: "five_hour@gemini_models" };

test("idle live quota remains eligible for a real starter and supplies no fabricated countdown", () => {
  const windows = markZaicodeWindowsStartingOnUse([window()], NOW);
  assert.equal(isZaicodeWindowWaitingForFirstUse(windows[0]!), true);
  assert.equal(windows[0]!.rollingFrom, undefined);
  assert.equal(zaicodeWindowShowsLiveCountdown(windows[0]!, NOW), false);
  assert.equal(zaicodeIdleWindowToStart({ account, snapshot: snapshot(windows), config, now: NOW })?.key, window().key);
});

test("historical local anchors are not evidence that a vendor window started", () => {
  const cached = [window(undefined, { startsOnUse: true, rollingFrom: NOW - HOUR })];
  const windows = markZaicodeWindowsStartingOnUse([window()], NOW, null, cached);
  assert.equal(windows[0]!.rollingFrom, undefined);
  assert.equal(zaicodeWindowShowsLiveCountdown(windows[0]!, NOW), false);
});

test("a matching real attempt and fixed vendor reset keep the rounded-full window live", () => {
  const windows = markZaicodeWindowsStartingOnUse([window()], NOW + 20_000, start);
  assert.equal(isZaicodeWindowWaitingForFirstUse(windows[0]!), false);
  assert.equal(windows[0]!.rollingFrom, NOW);
  assert.equal(windows[0]!.resetsAt, NOW + 5 * HOUR);
  assert.equal(zaicodeWindowShowsLiveCountdown(windows[0]!, NOW + 20_000), true);
});

test("failed and foreign-pool attempts cannot prove a live reset", () => {
  for (const record of [{ ...start, ok: false }, { ...start, windowKey: "five_hour@claude_and_gpt_models" }]) {
    const windows = markZaicodeWindowsStartingOnUse([window()], NOW + 20_000, record);
    assert.equal(isZaicodeWindowWaitingForFirstUse(windows[0]!), true);
    assert.equal(windows[0]!.rollingFrom, undefined);
    assert.equal(zaicodeWindowShowsLiveCountdown(windows[0]!, NOW + 20_000), false);
  }
});

test("a successful transport with a still sliding vendor reset stays unstarted", () => {
  const readAt = NOW + 60_000;
  const windows = markZaicodeWindowsStartingOnUse([window(undefined, { resetsAt: readAt + 5 * HOUR })], readAt, start);
  assert.equal(isZaicodeWindowWaitingForFirstUse(windows[0]!), true);
  assert.equal(windows[0]!.rollingFrom, undefined);
});

test("an expired real anchor does not fabricate the next vendor window", () => {
  const later = NOW + 5 * HOUR + 60_000;
  const old = [window(undefined, { startsOnUse: true, rollingFrom: NOW })];
  const windows = markZaicodeWindowsStartingOnUse([window(undefined, { resetsAt: later + 5 * HOUR })], later, start, old);
  assert.equal(windows[0]!.rollingFrom, undefined);
  assert.equal(isZaicodeWindowWaitingForFirstUse(windows[0]!), true);
});

test("persisted per-window results survive another pool's later failed attempt", () => {
  const key = window().key;
  const failedOther = { ...start, at: NOW + 10_000, ok: false, windowKey: "five_hour@claude_and_gpt_models" };
  const ledger = { [key]: start, [failedOther.windowKey]: failedOther };
  const windows = markZaicodeWindowsStartingOnUse([window()], NOW + 20_000, failedOther, null, ledger);
  assert.equal(windows[0]!.rollingFrom, NOW);
  assert.equal(zaicodeWindowShowsLiveCountdown(windows[0]!, NOW + 20_000), true);
});

test("independent pools retain their own successful admission through sweeps and restart", () => {
  const gemini = window(undefined, { startsOnUse: true });
  const claude = window("five_hour@claude_and_gpt_models", { startsOnUse: true });
  const record = { ...start, at: NOW + 1000, windowKey: claude.key };
  const current = snapshot([gemini, claude], { windowStart: record, windowStarts: { [gemini.key]: start, [claude.key]: record } });
  const restarted = JSON.parse(JSON.stringify(current)) as ZaicodeLimitSnapshot;
  assert.equal(zaicodeIdleWindowToStart({ account, snapshot: restarted, config, now: NOW + HOUR }), null, "successful windows must not send another paid request each sweep");
  assert.equal(zaicodeIdleWindowToStart({ account, snapshot: restarted, config, now: NOW + 5 * HOUR + 2000 })?.key, gemini.key);
});

test("failure admission blocks sibling windows in that pool but leaves another pool available", () => {
  const gemini = window(undefined, { startsOnUse: true });
  const weekly = window("weekly@gemini_models", { startsOnUse: true, durationMinutes: 10080, resetsAt: NOW + 7 * 24 * HOUR });
  const other = window("five_hour@claude_and_gpt_models", { startsOnUse: true });
  const failed = { ...start, ok: false };
  const current = snapshot([weekly, gemini, other], { windowStart: failed, windowStarts: { [gemini.key]: failed, [weekly.key]: { ...failed, windowKey: weekly.key } } });
  assert.equal(zaicodeIdleWindowToStart({ account, snapshot: current, config, now: NOW + 60_000 })?.key, other.key);
});
