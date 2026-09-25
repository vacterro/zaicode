import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyZaicodeStatsTotals,
  shiftZaicodeDate,
  zaicodeIntensity,
  zaicodeLocalDayHour,
  zaicodePeriodRange,
  zaicodeStreaks,
  zaicodeWeekStart,
  type ZaicodeEngineAccount,
  type ZaicodeLimitSnapshot,
} from "@zcode/shared";
import {
  ZAICODE_HOME_PRESETS,
  normalizeZaicodeHomePrefs,
  normalizeZaicodeHomeWidgets,
  zaicodeHomeLayout,
  zaicodeStartupMainView,
} from "../src/zaicode/home/zaicodeHomePrefs.js";
import {
  formatZaicodeRatio,
  formatZaicodeRuntime,
  zaicodeHomeActionItems,
  zaicodeHomeLimitRows,
  zaicodeHomeQueueCounts,
  zaicodeHomeRouting,
} from "../src/zaicode/home/zaicodeHomeModel.js";
import { zaicodeClockAngles } from "../src/zaicode/home/ZaicodeAnalogClock.js";
import { zaicodeWorkerSession } from "../src/zaicode/home/zaicodeHomeFeed.js";
import { ZAICODE_NAV_ITEMS, normalizeZaicodeLayoutList } from "../src/zaicode/zaicodeLayoutPrefs.js";
import { ZAICODE_METER_DEFAULT_PREFS } from "../src/zaicode/zaicodeMeterPrefs.js";

test("SAIHOME is the default first view; startup preference is honoured", () => {
  const fresh = normalizeZaicodeHomePrefs(null);
  assert.equal(fresh.startup, "home");
  assert.equal(zaicodeStartupMainView(fresh), "saihome");
  assert.equal(zaicodeStartupMainView({ startup: "newTask", lastView: "home" }), "chat");
  assert.equal(zaicodeStartupMainView({ startup: "last", lastView: "zaicode" }), "zaicode");
  assert.equal(zaicodeStartupMainView({ startup: "last", lastView: "home" }), "saihome");
  assert.equal(normalizeZaicodeHomePrefs({ startup: "garbage" }).startup, "home");
});

test("SAIHOME menu line lands first in an older stored menu", () => {
  const stored = [
    { id: "newTask", visible: true },
    { id: "zaicode", visible: true },
  ];
  const list = normalizeZaicodeLayoutList(stored, ZAICODE_NAV_ITEMS);
  assert.equal(list[0]!.id, "saihome");
  assert.equal(list[0]!.visible, true);
  assert.equal(list[1]!.id, "newTask");
});

test("layout presets and the custom arrangement", () => {
  const prefs = normalizeZaicodeHomePrefs(null);
  assert.deepEqual(zaicodeHomeLayout({ ...prefs, preset: "minimal" }).map((entry) => entry.id), [...ZAICODE_HOME_PRESETS.minimal.widgets]);
  const custom = normalizeZaicodeHomeWidgets([{ id: "stats", visible: true, size: "large" }, { id: "clock", visible: false }, { id: "nope" }]);
  assert.equal(custom[0]!.id, "stats");
  assert.equal(custom[0]!.size, "large");
  assert.equal(custom.find((entry) => entry.id === "clock")!.visible, false);
  assert.ok(custom.some((entry) => entry.id === "activity"), "a widget missing from storage comes back");
  assert.ok(!custom.some((entry) => (entry.id as string) === "nope"));
  const visible = zaicodeHomeLayout({ preset: "custom", custom }).map((entry) => entry.id);
  assert.ok(!visible.includes("clock"), "hidden widgets stay hidden");
  assert.equal(normalizeZaicodeHomePrefs({ gridDays: 5000, refreshSeconds: 1 }).gridDays, 371);
  assert.equal(normalizeZaicodeHomePrefs({ refreshSeconds: 1 }).refreshSeconds, 15);
});

test("analog clock angles: exact, ticking or smooth", () => {
  const date = new Date(2026, 8, 25, 3, 30, 15, 500);
  const tick = zaicodeClockAngles(date, false);
  assert.equal(tick.second, 90);
  assert.equal(tick.minute, 30 * 6 + 15 * 0.1);
  assert.equal(Math.round(tick.hour * 1000) / 1000, Math.round((3 * 30 + (30 + 15 / 60) / 2) * 1000) / 1000);
  assert.equal(zaicodeClockAngles(date, true).second, 93);
  assert.equal(zaicodeClockAngles(new Date(2026, 8, 25, 0, 0, 0), false).hour, 0);
});

test("calendar: week starts, month / year rollover, DST-safe day steps", () => {
  assert.equal(zaicodeWeekStart("2026-09-24", 1), "2026-09-21"); // Thu -> Mon
  assert.equal(zaicodeWeekStart("2026-09-24", 0), "2026-09-20"); // Thu -> Sun
  assert.equal(zaicodeWeekStart("2026-09-21", 1), "2026-09-21");
  assert.deepEqual(zaicodePeriodRange("month", "2026-10-01", 1), ["2026-10-01", "2026-10-01"]);
  assert.deepEqual(zaicodePeriodRange("yesterday", "2027-01-01", 1), ["2026-12-31", "2026-12-31"]);
  assert.deepEqual(zaicodePeriodRange("last7", "2026-03-01", 1), ["2026-02-23", "2026-03-01"]);
  assert.equal(shiftZaicodeDate("2026-10-25", 1), "2026-10-26");
  assert.equal(shiftZaicodeDate("2028-02-28", 1), "2028-02-29");
  // A time zone decides the day: 23:30 UTC is already tomorrow in Tallinn, still today in New York.
  const at = Date.UTC(2026, 8, 24, 23, 30);
  assert.equal(zaicodeLocalDayHour(at, "Europe/Tallinn").date, "2026-09-25");
  assert.equal(zaicodeLocalDayHour(at, "America/New_York").date, "2026-09-24");
  assert.equal(zaicodeLocalDayHour(at, "Asia/Kathmandu").hour, 5); // +05:45
});

test("streaks: current survives an empty today; longest spans gaps correctly", () => {
  assert.deepEqual(zaicodeStreaks(["2026-09-22", "2026-09-23", "2026-09-24"], "2026-09-24"), { current: 3, longest: 3 });
  assert.deepEqual(zaicodeStreaks(["2026-09-22", "2026-09-23"], "2026-09-24"), { current: 2, longest: 2 });
  assert.deepEqual(zaicodeStreaks(["2026-09-20", "2026-09-23"], "2026-09-25"), { current: 0, longest: 1 });
  assert.deepEqual(zaicodeStreaks(["2026-12-30", "2026-12-31", "2027-01-01", "2026-06-01"], "2027-01-01"), { current: 3, longest: 3 });
  assert.deepEqual(zaicodeStreaks([], "2026-09-24"), { current: 0, longest: 0 });
  assert.equal(zaicodeIntensity(0, 10), 0);
  assert.equal(zaicodeIntensity(1, 10), 1);
  assert.equal(zaicodeIntensity(10, 10), 4);
});

function account(id: string, status: ZaicodeEngineAccount["status"] = "ready"): ZaicodeEngineAccount {
  return { id, vendor: "claude", short: id, label: id, source: id, home: null, isDefaultHome: true, cli: "claude", status, statusDetail: status === "ready" ? "" : "Sign in" } as ZaicodeEngineAccount;
}

function snapshot(accountId: string, fetchedAt: number, remaining: number, error: string | null = null): ZaicodeLimitSnapshot {
  return {
    accountId,
    windows: [{ key: "five_hour", label: "5h", group: "", groupLabel: "", remainingPercent: remaining, resetsAt: fetchedAt + 5 * 3_600_000, durationMinutes: 300, gatedBy: null, assumedFull: false }],
    plan: null,
    fetchedAt,
    checkedAt: fetchedAt,
    error,
    source: "test",
  };
}

test("limits wall: filters, temporary show-all, sign-in always visible, stale marked", () => {
  const now = 10_000_000;
  const input = {
    accounts: [account("A1"), account("A2"), account("C1", "login-required"), account("H")],
    hiddenAccounts: ["H"],
    limits: { A1: snapshot("A1", now - 60_000, 40), A2: snapshot("A2", now - 60_000, 100), C1: snapshot("C1", now, 0) },
    meterPrefs: { ...ZAICODE_METER_DEFAULT_PREFS, hideZeroUsage: true, filterMeter: true },
    showAll: false,
    now,
  };
  const filtered = zaicodeHomeLimitRows(input);
  assert.deepEqual(filtered.rows.map((row) => row.account.id), ["A1", "C1"]);
  assert.equal(filtered.filtered, 1);
  assert.equal(filtered.rows[1]!.needsAttention, "sign-in required");
  const all = zaicodeHomeLimitRows({ ...input, showAll: true });
  assert.deepEqual(all.rows.map((row) => row.account.id), ["A1", "A2", "C1"]);
  const stale = zaicodeHomeLimitRows({ ...input, limits: { A1: snapshot("A1", now - 3_600_000, 40, "timeout") } });
  assert.equal(stale.rows[0]!.truth, "stale");
  assert.equal(zaicodeHomeLimitRows({ ...input, limits: {} }).rows[0]!.truth, "unavailable");
});

test("routing: healthy, degraded, down, not known yet", () => {
  const combos = [
    { id: "1", name: "SAIFREN", models: ["a", "b"], kind: null, strategy: "fallback" as const },
    { id: "2", name: "SAIOPP", models: ["c"], kind: null, strategy: "fallback" as const },
  ];
  const base = { message: "", host: null, combos, connections: [], lastScanAt: null };
  assert.equal(zaicodeHomeRouting({ ...base, status: "up" }).state, "healthy");
  assert.equal(zaicodeHomeRouting({ ...base, status: "down", message: "ECONNREFUSED" }).state, "down");
  assert.equal(zaicodeHomeRouting({ ...base, status: "loading" }).state, "checking");
  const degraded = zaicodeHomeRouting({ ...base, status: "up", combos: [{ ...combos[0]!, models: [] }, combos[1]!] });
  assert.equal(degraded.state, "degraded");
  assert.match(degraded.headline, /SAIFREN has no model/);
  // A paid pool without a subscription yet is no fault (fresh profile).
  assert.equal(zaicodeHomeRouting({ ...base, status: "up", combos: [combos[0]!, { ...combos[1]!, models: [] }] }).state, "healthy");
});

test("NEEDS YOU: problems only, blocking first, disabled projects ignored", () => {
  const routing = zaicodeHomeRouting({ status: "down", message: "", host: null, combos: [], connections: [], lastScanAt: null });
  const items = zaicodeHomeActionItems({
    routing,
    limitRows: [],
    projects: [
      { path: "V:\\a", name: "a", state: "blocked", reason: "needs key", disabled: false },
      { path: "V:\\b", name: "b", state: "blocked", reason: "x", disabled: true },
    ],
    waitingSessions: 0,
    schedules: [{ id: "s", name: "night", problem: "missed 25.09" }],
    statsSources: [],
    statsError: null,
  });
  assert.deepEqual(items.map((item) => item.id), ["router-down", "project-V:\\a", "schedule-s"]);
  assert.ok(items.every((item) => item.what && item.why && item.impact && item.action.label));
  const healthy = zaicodeHomeActionItems({
    routing: zaicodeHomeRouting({ status: "up", message: "", host: null, combos: [{ id: "1", name: "SAIFREN", models: ["m"], kind: null, strategy: "fallback" }], connections: [], lastScanAt: null }),
    limitRows: [],
    projects: [],
    waitingSessions: 0,
    schedules: [],
    statsSources: [],
    statsError: null,
  });
  assert.equal(healthy.length, 0);
});

test("queue counts and honest formatting", () => {
  const midnight = new Date(2026, 8, 25).getTime();
  const job = (status: string, finishedAt?: number) => ({ status, ...(finishedAt ? { finishedAt } : {}) }) as never;
  const counts = zaicodeHomeQueueCounts([job("running"), job("queued"), job("blocked"), job("completed", midnight + 1), job("completed", midnight - 1), job("failed", midnight + 5)], midnight);
  assert.deepEqual(counts, { running: 1, ready: 1, waiting: 0, blocked: 1, doneToday: 1, failedToday: 1 });
  assert.equal(zaicodeHomeQueueCounts(null, midnight), null, "unknown is not zero");
  assert.equal(formatZaicodeRatio(null), "not enough data");
  assert.equal(formatZaicodeRatio(2), "×2.0");
  assert.equal(formatZaicodeRatio(0.6), "−40%");
  assert.equal(formatZaicodeRuntime(null), "—");
  assert.equal(formatZaicodeRuntime(3_723_000), "1h 02m");
  assert.equal(emptyZaicodeStatsTotals().tokens, 0);
});

test("worker sessions: only subscription workers, only once they ended", () => {
  const worker = { id: "w", kind: "worker", short: "A1", projectPath: "V:\\p", startedAt: 100, endedAt: null, exitCode: null } as never;
  assert.equal(zaicodeWorkerSession(worker, null), null);
  assert.deepEqual(zaicodeWorkerSession(worker, 500), { id: "w", startedAt: 100, endedAt: 500, project: "V:\\p", engine: "A1", exitCode: null });
  assert.equal(zaicodeWorkerSession({ ...(worker as object), kind: "shell" } as never, 500), null);
});

test("recent timeline: runs, worker sessions and journal events, newest first", async () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  const { recordZaicodeHomeEvent, useZaicodeHomeJournal, clearZaicodeHomeJournal } = await import("../src/zaicode/home/zaicodeHomeJournal.js");
  const { zaicodeHomeTimeline } = await import("../src/zaicode/home/ZaicodeHomeStatsCards.js");
  recordZaicodeHomeEvent("limits.refill", "A1 5h refilled", "", 3000);
  recordZaicodeHomeEvent("timer.fire", "tea", "", 4000); // personal: not journaled
  recordZaicodeHomeEvent("autostart.missed", "night run", "", 1000);
  assert.equal(useZaicodeHomeJournal.getState().events.length, 2);
  const lines = zaicodeHomeTimeline(
    [{ id: "job:1:1", kind: "job.finished", at: 2000, durationMs: 60_000, project: "V:/p/_X", jobId: "1", engine: null, result: "completed", failure: null, recovered: true }],
    useZaicodeHomeJournal.getState().events,
  );
  assert.deepEqual(lines.map((line) => line.at), [3000, 2000, 1000]);
  assert.match(lines[1]!.text, /run recovered · _X/);
  assert.equal(lines[2]!.bad, true);
  clearZaicodeHomeJournal();
  assert.equal(useZaicodeHomeJournal.getState().events.length, 0);
});
