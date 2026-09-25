import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceZaicodeTimer,
  chooseZaicodeTimerSound,
  collectDueZaicodeTimers,
  createZaicodeTimer,
  describeZaicodeTimer,
  formatZaicodeRemaining,
  healZaicodeTimer,
  healZaicodeVolume,
  loadZaicodeTimers,
  nextDueZaicodeTimer,
  snoozeZaicodeTimer,
  zaicodeTemperatureColor,
  zaicodeTimerDaysInMonth,
  zaicodeTimerOccursOn,
} from "../src/zaicode/zaicodeTimers.js";
import { parseZaicodeDuration, parseZaicodeWhen, resolveZaicodeTarget } from "../src/zaicode/zaicodeDuration.js";
import {
  createZaicodeProductivity,
  skipZaicodeProductivityPhase,
  startZaicodeProductivity,
  tickZaicodeProductivity,
  toggleZaicodeProductivity,
} from "../src/zaicode/zaicodeProductivity.js";
import {
  healZaicodeIntervalRule,
  loadZaicodeIntervalRules,
  tickZaicodeIntervalRules,
  zaicodeIntervalRemaining,
} from "../src/zaicode/zaicodeIntervalRules.js";
import {
  canonicalZaicodeBinding,
  findZaicodeHotkeyConflicts,
  defaultZaicodeHotkeySettings,
  matchZaicodeBinding,
  normalizeZaicodeHotkeySettings,
  zaicodeAccelerator,
  zaicodeBindingFromEvent,
} from "../src/zaicode/zaicodeHotkeys.js";
import {
  moveZaicodeLayoutEntry,
  normalizeZaicodeLayoutList,
  placeZaicodeLayoutEntry,
  ZAICODE_HEADER_TOOLS,
  ZAICODE_NAV_ITEMS,
} from "../src/zaicode/zaicodeLayoutPrefs.js";
import { nextZaicodeRingSession, zaicodeSessionRing } from "../src/zaicode/zaicodeSessionNav.js";
import { categorizeZaicodeSound, formatZaicodeSoundLength, listZaicodeSoundCatalog } from "../src/zaicode/zaicodeSoundCatalog.js";
import { isZaicodeQuietTime, normalizeZaicodeNotifySettings } from "../src/zaicode/zaicodeNotifications.js";
import { detectZaicodeWindowRefills } from "../src/zaicode/zaicodeLimitRefills.js";
import { zaicodeRemainingTextColor } from "../src/zaicode/zaicodeEngines.js";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

// --- timers ---------------------------------------------------------------

test("a daily timer closed for a week lands in the future and fires once", () => {
  const timer = createZaicodeTimer({ name: "Check in", target: at(2026, 9, 1, 19), repeat: "daily" });
  const now = at(2026, 9, 8, 12);
  const due = collectDueZaicodeTimers([timer], now);
  assert.equal(due.fired.length, 1);
  assert.equal(due.timers[0]!.target, at(2026, 9, 8, 19));
  assert.equal(collectDueZaicodeTimers(due.timers, now).fired.length, 0);
});

test("monthly keeps the anchor day: 31 Jan -> 28 Feb -> 31 Mar", () => {
  let timer = createZaicodeTimer({ name: "Rent", target: at(2026, 1, 31, 9), repeat: "monthly", repeatAnchor: "2026-01-31" });
  timer = advanceZaicodeTimer(timer, at(2026, 1, 31, 10));
  assert.equal(timer.target, at(2026, 2, 28, 9));
  timer = advanceZaicodeTimer(timer, at(2026, 2, 28, 10));
  assert.equal(timer.target, at(2026, 3, 31, 9));
});

test("interval timer rolls by whole periods from its anchor moment", () => {
  const timer = createZaicodeTimer({ name: "Claude 5h", target: at(2026, 9, 25, 10), repeat: "interval", intervalMinutes: 300 });
  assert.equal(advanceZaicodeTimer(timer, at(2026, 9, 25, 16)).target, at(2026, 9, 25, 20));
  assert.equal(advanceZaicodeTimer(timer, at(2026, 9, 25, 15)).target, at(2026, 9, 25, 20), "exactly on a boundary moves past it");
});

test("snooze always pushes later, never closer", () => {
  const now = at(2026, 9, 25, 10);
  const counting = createZaicodeTimer({ name: "x", target: at(2026, 9, 25, 12) });
  assert.equal(snoozeZaicodeTimer(counting, 10, now).target, at(2026, 9, 25, 12, 10));
  const fired = { ...counting, target: at(2026, 9, 25, 9), fired: true };
  const snoozed = snoozeZaicodeTimer(fired, 10, now);
  assert.equal(snoozed.target, at(2026, 9, 25, 10, 10));
  assert.equal(snoozed.fired, false);
});

test("one-shot deleteAfterFire disappears; plain one-shot stays as done", () => {
  const now = at(2026, 9, 25, 10);
  const gone = createZaicodeTimer({ name: "a", target: now - 1000, deleteAfterFire: true });
  const kept = createZaicodeTimer({ name: "b", target: now - 1000 });
  const due = collectDueZaicodeTimers([gone, kept], now);
  assert.equal(due.fired.length, 2);
  assert.deepEqual(due.timers.map((timer) => [timer.name, timer.fired]), [["b", true]]);
});

test("healing: corrupt entries skipped, legacy volume 0-10, duplicate ids renamed", () => {
  assert.equal(healZaicodeTimer({ name: 5, target: 1 }), null);
  assert.equal(healZaicodeTimer({ target: "soon" }), null);
  assert.equal(healZaicodeVolume(7), 0.7);
  assert.equal(healZaicodeVolume("0.25"), 0.25);
  assert.equal(healZaicodeVolume(true), null);
  const list = loadZaicodeTimers([{ id: "a", target: 1 }, { id: "a", target: 2 }, "junk"]);
  assert.equal(list.length, 2);
  assert.notEqual(list[0]!.id, list[1]!.id);
});

test("temperature warms from blue to red; remaining formats like FastPrompter", () => {
  assert.equal(zaicodeTemperatureColor(3 * 86_400), "#4a90d9");
  assert.equal(zaicodeTemperatureColor(0), "#e05555");
  assert.equal(formatZaicodeRemaining(4 * 86_400 + 11 * 3600 + 300), "4d 11h");
  assert.equal(formatZaicodeRemaining(4 * 86_400 + 11 * 3600 + 300, { minutes: true }), "4d 11h 05m");
  assert.equal(formatZaicodeRemaining(2 * 3600 + 5 * 60), "2h 05m");
  assert.equal(formatZaicodeRemaining(61), "1m 01s");
  assert.equal(formatZaicodeRemaining(0), "now");
});

test("next due skips paused, fired and top-bar-hidden timers on request", () => {
  const a = createZaicodeTimer({ name: "a", target: 300, showInTopBar: false });
  const b = createZaicodeTimer({ name: "b", target: 500 });
  const c = createZaicodeTimer({ name: "c", target: 100, enabled: false });
  assert.equal(nextDueZaicodeTimer([a, b, c])?.name, "a");
  assert.equal(nextDueZaicodeTimer([a, b, c], { topBarOnly: true })?.name, "b");
  assert.match(describeZaicodeTimer(b, 0), /^b - now|^b - in/);
});

test("calendar occurrences follow the anchor, not the rolled target", () => {
  const weekly = createZaicodeTimer({ name: "w", target: at(2026, 9, 1, 9), repeat: "weekly", repeatAnchor: "2026-09-01" });
  const rolled = advanceZaicodeTimer(weekly, at(2026, 9, 20));
  assert.ok(zaicodeTimerOccursOn(rolled, new Date(2026, 8, 8)), "history is not rewritten by advancing");
  assert.deepEqual(zaicodeTimerDaysInMonth(rolled, 2026, 8), [1, 8, 15, 22, 29]);
});

test("sound pool: eligible rows by time window, silence when none", () => {
  const timer = createZaicodeTimer({
    name: "p",
    target: 0,
    soundMode: "pool",
    soundRules: [
      { sound: "day", enabled: true, allDay: false, startMinute: 9 * 60, endMinute: 18 * 60, volume: null },
      { sound: "night", enabled: true, allDay: false, startMinute: 22 * 60, endMinute: 6 * 60, volume: 0.1 },
    ],
  });
  assert.deepEqual(chooseZaicodeTimerSound(timer, new Date(2026, 8, 25, 10), () => 0), { sound: "day", volume: 0.5 });
  assert.deepEqual(chooseZaicodeTimerSound(timer, new Date(2026, 8, 25, 23), () => 0), { sound: "night", volume: 0.1 });
  assert.equal(chooseZaicodeTimerSound(timer, new Date(2026, 8, 25, 20)), null);
});

// --- duration -------------------------------------------------------------

test("durations people type", () => {
  assert.equal(parseZaicodeDuration("4 days 11 hours"), (4 * 86_400 + 11 * 3600) * 1000);
  assert.equal(parseZaicodeDuration("1h30"), 5400 * 1000);
  assert.equal(parseZaicodeDuration("1h 30"), 5400 * 1000);
  assert.equal(parseZaicodeDuration("45"), 2700 * 1000);
  assert.equal(parseZaicodeDuration("2 недели 3 дня"), (14 + 3) * 86_400 * 1000);
  assert.equal(parseZaicodeDuration("45 мин"), 2700 * 1000);
  assert.equal(parseZaicodeDuration("4 blah 2h"), null);
  assert.equal(parseZaicodeDuration("4 5"), null);
});

test("clock times: past means tomorrow, ISO dates stay put", () => {
  const now = new Date(2026, 8, 25, 20, 0);
  assert.equal(parseZaicodeWhen("18:30", now)?.getTime(), new Date(2026, 8, 26, 18, 30).getTime());
  assert.equal(parseZaicodeWhen("21:15", now)?.getTime(), new Date(2026, 8, 25, 21, 15).getTime());
  assert.equal(parseZaicodeWhen("завтра 09:00", now)?.getTime(), new Date(2026, 8, 26, 9, 0).getTime());
  assert.equal(parseZaicodeWhen("2026-09-20 11:00", now)?.getTime(), new Date(2026, 8, 20, 11, 0).getTime());
  assert.equal(parseZaicodeWhen("25:00", now), null);
  assert.equal(resolveZaicodeTarget("5h", now, true)?.getTime(), new Date(2026, 8, 25, 15, 0).getTime());
});

// --- productivity ---------------------------------------------------------

test("productivity: a long stall carries through phases and counts rounds", () => {
  let timer = startZaicodeProductivity(createZaicodeProductivity({ workSeconds: 60, breakSeconds: 30 }));
  const result = tickZaicodeProductivity(timer, 100);
  assert.deepEqual(result.ended, ["work", "break"]);
  assert.equal(result.timer.phase, "work");
  assert.equal(result.timer.remaining, 50);
  assert.equal(result.timer.completedCycles, 1);
  assert.equal(result.timer.alarmPending, true);
  timer = toggleZaicodeProductivity(result.timer);
  assert.equal(timer.state, "paused");
  assert.equal(tickZaicodeProductivity(timer, 999).ended.length, 0, "paused never counts");
});

test("productivity: no breaks stops after work; skip jumps phases", () => {
  const timer = startZaicodeProductivity(createZaicodeProductivity({ workSeconds: 10, breaksEnabled: false }));
  const result = tickZaicodeProductivity(timer, 10);
  assert.equal(result.timer.state, "paused");
  assert.equal(result.timer.phase, "work");
  assert.equal(skipZaicodeProductivityPhase(startZaicodeProductivity(createZaicodeProductivity())).phase, "break");
});

// --- interval reminders ---------------------------------------------------

test("interval clock rules fire once per boundary; topmost wins a collision", () => {
  const rules = loadZaicodeIntervalRules([
    { id: "a", name: "A", minutes: 60, enabled: true },
    { id: "b", name: "B", minutes: 30, enabled: true },
  ]);
  const first = tickZaicodeIntervalRules(rules, new Date(2026, 8, 25, 14, 0, 3));
  assert.equal(first.fire?.id, "a");
  const again = tickZaicodeIntervalRules(first.rules, new Date(2026, 8, 25, 14, 0, 40));
  assert.equal(again.fire, null, "same minute never fires twice");
  const half = tickZaicodeIntervalRules(again.rules, new Date(2026, 8, 25, 14, 30, 1));
  assert.equal(half.fire?.id, "b");
});

test("interval active hours wrap past midnight; top-bar countdown respects them", () => {
  const night = healZaicodeIntervalRule({ id: "n", minutes: 60, allDay: false, startMinute: 22 * 60, endMinute: 6 * 60, showInTopBar: true })!;
  assert.equal(tickZaicodeIntervalRules([night], new Date(2026, 8, 25, 12, 0)).fire, null);
  assert.equal(tickZaicodeIntervalRules([night], new Date(2026, 8, 25, 23, 0)).fire?.id, "n");
  assert.equal(zaicodeIntervalRemaining(night, new Date(2026, 8, 25, 12, 10)), null);
  assert.equal(zaicodeIntervalRemaining(night, new Date(2026, 8, 25, 22, 30)), 30 * 60);
});

test("elapsed interval arms on first sight, then fires after N minutes", () => {
  const rule = healZaicodeIntervalRule({ id: "e", minutes: 25, alignMode: "elapsed" })!;
  const armed = tickZaicodeIntervalRules([rule], new Date(2026, 8, 25, 10, 0));
  assert.equal(armed.fire, null);
  assert.equal(tickZaicodeIntervalRules(armed.rules, new Date(2026, 8, 25, 10, 24)).fire, null);
  assert.equal(tickZaicodeIntervalRules(armed.rules, new Date(2026, 8, 25, 10, 25)).fire?.id, "e");
});

// --- hotkeys --------------------------------------------------------------

const key = (code: string, keyValue: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({
  code,
  key: keyValue,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

test("bindings record and match by physical key on any layout", () => {
  assert.equal(zaicodeBindingFromEvent(key("KeyQ", "й", { ctrlKey: true })), "Ctrl+Q");
  assert.equal(zaicodeBindingFromEvent(key("ArrowDown", "ArrowDown", { altKey: true })), "Alt+Down");
  assert.equal(zaicodeBindingFromEvent(key("ControlLeft", "Control", { ctrlKey: true })), null);
  assert.ok(matchZaicodeBinding("Ctrl+Q", key("KeyQ", "й", { ctrlKey: true })));
  assert.ok(!matchZaicodeBinding("Ctrl+Q", key("KeyQ", "a", { ctrlKey: true })), "AZERTY Ctrl+A is not Ctrl+Q");
  assert.ok(!matchZaicodeBinding("Ctrl+Q", key("KeyQ", "q", { ctrlKey: true, shiftKey: true })), "modifiers must match exactly");
  assert.equal(canonicalZaicodeBinding(" shift + ctrl + t "), "Ctrl+Shift+T");
  assert.equal(canonicalZaicodeBinding("Ctrl+Nope"), "");
  assert.equal(zaicodeAccelerator("Ctrl+Shift+Numpad1"), "Ctrl+Shift+num1");
  assert.equal(zaicodeAccelerator("Win+Esc"), "Super+Escape");
});

test("hotkey conflicts: duplicates, F-keys block and upstream defaults are reported", () => {
  const settings = defaultZaicodeHotkeySettings();
  assert.deepEqual(findZaicodeHotkeyConflicts(settings), [], "defaults are conflict-free");
  const clash = normalizeZaicodeHotkeySettings({
    ...settings,
    fKeys: "projects",
    bindings: { ...settings.bindings, "timers.open": ["Ctrl+K", ""], "sounds.mute": ["Alt+Down", ""] },
  });
  const conflicts = findZaicodeHotkeyConflicts(clash);
  const byBinding = new Map(conflicts.map((conflict) => [conflict.binding, conflict]));
  assert.equal(byBinding.get("Ctrl+K")?.upstream, "openCommandCenter");
  assert.deepEqual(byBinding.get("Alt+Down")?.actions, ["session.next", "sounds.mute"]);
  assert.ok(byBinding.get("F1")?.actions.includes("ui.help"), "Help F1 collides with the F-keys block");
});

// --- layout ---------------------------------------------------------------

test("layout lists keep the stored order, drop unknown ids, place new ones after their predecessor", () => {
  const list = normalizeZaicodeLayoutList(
    [{ id: "search", visible: false }, { id: "ghost", visible: true }, { id: "back", visible: true }],
    ZAICODE_HEADER_TOOLS,
  );
  const ids = list.map((entry) => entry.id);
  assert.ok(ids.indexOf("search") < ids.indexOf("back"), "stored entries keep their order");
  assert.equal(list.find((entry) => entry.id === "search")!.visible, false);
  assert.equal(ids.includes("ghost" as never), false);
  // SRC-038: a new id sits right after the definition that precedes it ("newTask" follows "search").
  assert.equal(ids[ids.indexOf("search") + 1], "newTask");
  assert.equal(list.length, ZAICODE_HEADER_TOOLS.length);
  const nav = normalizeZaicodeLayoutList(null, ZAICODE_NAV_ITEMS);
  assert.deepEqual(
    nav.filter((entry) => entry.visible).map((entry) => entry.id),
    ["saihome", "newTask", "subchat", "zaicode", "scheduler"],
    "SAIHOME (T-56) + New task + SUBCHAT (T-51) + ZAICODE + SCHEDULER (SRC-038) by default",
  );
  assert.deepEqual(moveZaicodeLayoutEntry(nav, "zaicode", -1).slice(2, 4).map((entry) => entry.id), ["zaicode", "subchat"]);
  assert.equal(placeZaicodeLayoutEntry(nav, "settings", 0)[0]!.id, "settings");
});

// --- session cycling ------------------------------------------------------

test("session ring: waiting first, then working; recent only when idle; wraps both ways", () => {
  const s = (sessionId: string) => ({ sessionId, title: sessionId });
  const ring = zaicodeSessionRing([s("r1"), s("w1"), s("r2")], [s("w1")], [s("old")]);
  assert.deepEqual(ring.map((entry) => entry.sessionId), ["w1", "r1", "r2"]);
  assert.equal(nextZaicodeRingSession(ring, "r2", 1)?.sessionId, "w1");
  assert.equal(nextZaicodeRingSession(ring, "w1", -1)?.sessionId, "r2");
  assert.equal(nextZaicodeRingSession(ring, "elsewhere", 1)?.sessionId, "w1");
  assert.equal(nextZaicodeRingSession(ring, "elsewhere", -1)?.sessionId, "r2");
  assert.deepEqual(zaicodeSessionRing([], [], [s("old")]).map((entry) => entry.sessionId), ["old"]);
  assert.equal(nextZaicodeRingSession([], null, 1), null);
});

// --- sounds ---------------------------------------------------------------

test("sound kinds split by length and folder; the vault duplicate is hidden", () => {
  assert.equal(categorizeZaicodeSound("click_soft.wav", 0.2), "click");
  assert.equal(categorizeZaicodeSound("pop.wav", 0.8), "alert");
  assert.equal(categorizeZaicodeSound("QUEST.wav", 5.97), "long");
  assert.equal(categorizeZaicodeSound("rain.wav", 54), "ambience");
  assert.equal(categorizeZaicodeSound("LOOPMINE.wav", 2.6), "ambience");
  assert.equal(categorizeZaicodeSound("_vault/fvox/bell.wav", 0.6), "voice");
  assert.equal(formatZaicodeSoundLength(0.42), "0.4s");
  assert.equal(formatZaicodeSoundLength(72.7), "1:13");
  const catalog = listZaicodeSoundCatalog();
  assert.ok(catalog.length > 1200);
  assert.ok(!catalog.some((entry) => entry.folder === "_vault/cs_style"));
  assert.ok(catalog.some((entry) => entry.kind === "ambience" && entry.seconds > 15));
});

// --- notifications --------------------------------------------------------

test("quiet hours wrap past midnight; unknown scenario rows are ignored", () => {
  const quiet = { quietEnabled: true, quietFrom: 23 * 60, quietTo: 7 * 60 };
  assert.ok(isZaicodeQuietTime(quiet, new Date(2026, 8, 25, 23, 30)));
  assert.ok(isZaicodeQuietTime(quiet, new Date(2026, 8, 26, 6, 59)));
  assert.ok(!isZaicodeQuietTime(quiet, new Date(2026, 8, 26, 7, 0)));
  const settings = normalizeZaicodeNotifySettings({ scenarios: { ghost: { toast: true }, "limits.refill": { seconds: 9999 } } });
  assert.equal(settings.scenarios.ghost, undefined);
  assert.equal(settings.scenarios["limits.refill"]!.seconds, 600);
  assert.equal(settings.scenarios["limits.refill"]!.highlight, true);
});

test("window refill = a near-full climb, named per window; the first read is silent", () => {
  const windows = (fiveHour: number | null, weekly: number | null) => [
    { key: "five_hour", label: "5h", remainingPercent: fiveHour },
    { key: "weekly", label: "weekly", remainingPercent: weekly },
  ];
  const seen = new Map();
  assert.deepEqual(detectZaicodeWindowRefills("c1", windows(3, 40), seen), []);
  assert.deepEqual(detectZaicodeWindowRefills("c1", windows(100, 41), seen).map((refill) => refill.label), ["5h"]);
  assert.deepEqual(detectZaicodeWindowRefills("c1", windows(100, 70), seen), [], "a partial climb is not a reset");
  assert.deepEqual(detectZaicodeWindowRefills("c1", windows(80, 99), seen).map((refill) => refill.key), ["weekly"]);
});

// --- readable percentages -------------------------------------------------

test("percent text colours stay readable on the dark theme (0% is not dark red)", () => {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  for (const value of [0, 5, 30, 80, null]) {
    assert.ok(luminance(zaicodeRemainingTextColor(value)) > 0.35, `text for ${value} must be bright enough`);
  }
});
