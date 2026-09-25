import assert from "node:assert/strict";
import test from "node:test";
import type { ZaicodeEngineAccount, ZaicodeLimitSnapshot, ZaicodeLimitWindow } from "@zcode/shared";
import {
  isZaicodeEngineShown,
  normalizeZaicodeMeterPrefs,
  zaicodeAvailabilityTint,
  zaicodeEngineHasUsage,
  zaicodeEngineUsableNow,
  zaicodeMeterFillPercent,
  ZAICODE_METER_DEFAULT_PREFS,
} from "../src/zaicode/zaicodeMeterPrefs.js";
import {
  cascadeZaicodeWindowRect,
  clampZaicodeWindowRect,
  evenZaicodeSplitSizes,
  layoutZaicodeSplit,
  magnetZaicodeRect,
  normalizeZaicodeSplitSizes,
  resizeZaicodeSplit,
  zaicodeSnapZoneAt,
  zaicodeSnapZoneRect,
} from "../src/zaicode/zaicodeWorkerLayout.js";
import {
  dockZaicodeWorker,
  duplicateZaicodeWorker,
  floatZaicodeWorker,
  focusZaicodeWorker,
  hideZaicodeWorkersPanel,
  minimizeZaicodeWorker,
  openZaicodeShellWorker,
  readZaicodeWorkers,
  removeZaicodeWorker,
  zaicodePanelWorkers,
  zaicodeTrayWorkers,
  zaicodeWindowWorkers,
  zaicodeWorkerTitle,
} from "../src/zaicode/zaicodeWorkers.js";
import { normalizeZaicodeWorkerPrefs, zaicodeWorkerFontFamily } from "../src/zaicode/zaicodeWorkerPrefs.js";
import { normalizeZaicodeUiPrefs } from "../src/zaicode/zaicodeUiPrefs.js";
import { ZAICODE_TEAM_PRESETS, zaicodeTeamMemberInput } from "../src/zaicode/ZaicodeTeamPresets.js";
import { defaultZaicodeHotkeySettings, findZaicodeHotkeyConflicts, ZAICODE_HOTKEY_ACTIONS } from "../src/zaicode/zaicodeHotkeys.js";

const NOW = Date.UTC(2026, 8, 25, 12, 0);

function window(key: string, remaining: number | null, extra: Partial<ZaicodeLimitWindow> = {}): ZaicodeLimitWindow {
  const minutes: Record<string, number> = { five_hour: 300, weekly: 10080 };
  return {
    key,
    label: key === "five_hour" ? "5h" : key,
    group: "",
    groupLabel: "",
    remainingPercent: remaining,
    resetsAt: NOW + 3_600_000,
    durationMinutes: minutes[key] ?? null,
    gatedBy: null,
    assumedFull: false,
    ...extra,
  };
}

function snapshot(windows: ZaicodeLimitWindow[]): ZaicodeLimitSnapshot {
  return { accountId: "a", windows, plan: null, fetchedAt: NOW, checkedAt: NOW, error: null, source: "test" };
}

const account = (id: string): ZaicodeEngineAccount => ({
  id,
  vendor: "claude",
  short: id.toUpperCase(),
  label: id,
  source: id,
  home: null,
  isDefaultHome: true,
  cli: "claude",
  status: "ready",
  statusDetail: "",
  fixCommand: null,
});

// --- AI limit meters ----------------------------------------------------------

test("0% used: untouched windows hide, any spend shows, no reading stays unknown", () => {
  assert.equal(zaicodeEngineHasUsage(snapshot([window("five_hour", 100), window("weekly", 100)]), NOW), false);
  assert.equal(zaicodeEngineHasUsage(snapshot([window("five_hour", 100), window("weekly", 97)]), NOW), true);
  assert.equal(zaicodeEngineHasUsage(undefined, NOW), null);
  assert.equal(zaicodeEngineHasUsage(snapshot([window("five_hour", null)]), NOW), null);
  // A window whose reset passed reads full by assumption: that is not usage.
  const reset = window("five_hour", 40, { resetsAt: NOW - 1000 });
  assert.equal(zaicodeEngineHasUsage(snapshot([reset, window("weekly", 100)]), NOW), false);
});

test("usable now = the 5h window has quota; a spent weekly gates it; one Antigravity pool is enough", () => {
  assert.equal(zaicodeEngineUsableNow(snapshot([window("five_hour", 0), window("weekly", 90)]), NOW), false, "5h spent");
  assert.equal(zaicodeEngineUsableNow(snapshot([window("five_hour", 60), window("weekly", 0)]), NOW), false, "weekly spent gates 5h");
  assert.equal(zaicodeEngineUsableNow(snapshot([window("five_hour", 5), window("weekly", 40)]), NOW), true);
  assert.equal(zaicodeEngineUsableNow(snapshot([window("monthly", 30)]), NOW), true, "no 5h window: its own window decides");
  const gemini = window("five_hour", 0, { group: "gemini" });
  const claude = window("five_hour", 70, { group: "claude" });
  assert.equal(zaicodeEngineUsableNow(snapshot([gemini, claude]), NOW), true);
  assert.equal(zaicodeEngineUsableNow(undefined, NOW), false, "no reading = not usable");
  // A per-model weekly window never decides.
  assert.equal(zaicodeEngineUsableNow(snapshot([window("five_hour", 50), window("weekly_sonnet", 0)]), NOW), true);
});

test("meter rules apply per surface; per-engine hide is meter only", () => {
  const prefs = { ...ZAICODE_METER_DEFAULT_PREFS, hideZeroUsage: true, onlyUsable5h: true, meterHidden: ["c2"] };
  const idle = snapshot([window("five_hour", 100), window("weekly", 100)]);
  const spent = snapshot([window("five_hour", 0), window("weekly", 50)]);
  const busy = snapshot([window("five_hour", 60), window("weekly", 70)]);
  assert.equal(isZaicodeEngineShown(account("a1"), idle, prefs, "meter", NOW), false);
  assert.equal(isZaicodeEngineShown(account("a1"), spent, prefs, "meter", NOW), false);
  assert.equal(isZaicodeEngineShown(account("a1"), busy, prefs, "meter", NOW), true);
  assert.equal(isZaicodeEngineShown(account("c2"), busy, prefs, "meter", NOW), false, "hidden from the meter");
  assert.equal(isZaicodeEngineShown(account("c2"), busy, prefs, "tiles", NOW), true, "but not from the tiles");
  assert.equal(isZaicodeEngineShown(account("a1"), idle, prefs, "tiles", NOW), true, "rules skip the tiles by default");
  assert.equal(isZaicodeEngineShown(account("a1"), idle, { ...prefs, filterTiles: true }, "tiles", NOW), false);
});

test("meter prefs heal bad values; fill runs both ways; tint is off at 0", () => {
  const prefs = normalizeZaicodeMeterPrefs({ fill: "sideways", availabilityTint: 500, meterHidden: ["x", "x", 3] });
  assert.equal(prefs.fill, "remaining");
  assert.equal(prefs.availabilityTint, 60);
  assert.deepEqual(prefs.meterHidden, ["x"]);
  assert.equal(zaicodeMeterFillPercent(24, "remaining"), 24);
  assert.equal(zaicodeMeterFillPercent(24, "used"), 76);
  assert.equal(zaicodeMeterFillPercent(2, "remaining"), 6, "a nearly spent bar keeps a visible sliver");
  assert.equal(zaicodeMeterFillPercent(null, "used"), 0);
  assert.equal(zaicodeAvailabilityTint("#4f9a2f", 0), undefined);
  assert.match(zaicodeAvailabilityTint("#4f9a2f", 18) ?? "", /color-mix\(in srgb, #4f9a2f 18%, transparent\)/);
});

// --- worker geometry ----------------------------------------------------------

test("split sizes: wrong length resets to even; a divider moves only its neighbours", () => {
  assert.deepEqual(normalizeZaicodeSplitSizes([0.5, 0.5], 3), evenZaicodeSplitSizes(3));
  assert.deepEqual(normalizeZaicodeSplitSizes([2, 2], 2), [0.5, 0.5]);
  const moved = resizeZaicodeSplit([0.25, 0.25, 0.5], 0, 0.1);
  assert.ok(Math.abs(moved[0]! - 0.35) < 1e-9 && Math.abs(moved[1]! - 0.15) < 1e-9 && moved[2] === 0.5);
  const clamped = resizeZaicodeSplit([0.5, 0.5], 0, 0.9);
  assert.ok(clamped[1]! >= 0.08 - 1e-9, "a pane never collapses to nothing");
});

test("split layout: side by side, stacked, and a grid whose last row stretches", () => {
  assert.deepEqual(layoutZaicodeSplit(2, "row", [0.25, 0.75]).map((rect) => [rect.x, rect.width]), [[0, 25], [25, 75]]);
  assert.deepEqual(layoutZaicodeSplit(2, "column", [0.5, 0.5]).map((rect) => [rect.y, rect.height]), [[0, 50], [50, 50]]);
  const grid = layoutZaicodeSplit(3, "grid", []);
  assert.equal(grid.length, 3);
  assert.deepEqual(grid.map((rect) => [rect.x, rect.y, rect.width, rect.height]), [[0, 0, 50, 50], [50, 0, 50, 50], [0, 50, 100, 50]]);
});

test("snap zones: halves, quarters, maximize, dock; none in the middle", () => {
  const area = { x: 0, y: 44, width: 1600, height: 900 };
  assert.equal(zaicodeSnapZoneAt({ x: 2, y: 500 }, area), "left");
  assert.equal(zaicodeSnapZoneAt({ x: 1599, y: 60 }, area), "top-right");
  assert.equal(zaicodeSnapZoneAt({ x: 1, y: 930 }, area), "bottom-left");
  assert.equal(zaicodeSnapZoneAt({ x: 800, y: 46 }, area), "maximize");
  assert.equal(zaicodeSnapZoneAt({ x: 800, y: 940 }, area), "dock");
  assert.equal(zaicodeSnapZoneAt({ x: 800, y: 500 }, area), null);
  assert.deepEqual(zaicodeSnapZoneRect("right", area), { x: 800, y: 44, width: 800, height: 900 });
  assert.deepEqual(zaicodeSnapZoneRect("bottom-left", area), { x: 0, y: 494, width: 800, height: 450 });
  assert.equal(zaicodeSnapZoneRect("dock", area), null);
});

test("magnetic edges stick within the distance; windows stay reachable", () => {
  const area = { x: 0, y: 44, width: 1600, height: 900 };
  const other = { x: 100, y: 100, width: 400, height: 300 };
  const moved = magnetZaicodeRect({ x: 508, y: 104, width: 300, height: 200 }, [other], area, 12);
  assert.equal(moved.x, 500, "left edge sticks to the other window's right edge");
  assert.equal(moved.y, 100, "top edges line up");
  const far = magnetZaicodeRect({ x: 700, y: 400, width: 300, height: 200 }, [other], area, 12);
  assert.deepEqual([far.x, far.y], [700, 400]);
  const lost = clampZaicodeWindowRect({ x: 5000, y: -300, width: 100, height: 50 }, area);
  assert.ok(lost.x <= area.width - 120 && lost.y >= area.y && lost.width >= 360 && lost.height >= 180);
  const second = cascadeZaicodeWindowRect(area, 1);
  const first = cascadeZaicodeWindowRect(area, 0);
  assert.equal(second.y - first.y, 28, "new windows cascade");
});

// --- worker store ---------------------------------------------------------------

test("workers: docked by default, float and dock back, minimize to a named chip, remove", () => {
  const a = openZaicodeShellWorker("C:\\work\\_FastPrompter");
  const b = openZaicodeShellWorker("C:\\work\\_SAIPEN");
  assert.equal(zaicodeWorkerTitle(a), "PS · _FastPrompter");
  assert.deepEqual(zaicodePanelWorkers().map((worker) => worker.id), [a.id, b.id]);
  assert.equal(readZaicodeWorkers().open, true, "starting a worker shows the panel");

  floatZaicodeWorker(a.id);
  assert.deepEqual(zaicodeWindowWorkers().map((worker) => worker.id), [a.id]);
  assert.ok(readZaicodeWorkers().workers.find((worker) => worker.id === a.id)?.window, "a window got geometry");

  minimizeZaicodeWorker(a.id);
  assert.deepEqual(zaicodeTrayWorkers(readZaicodeWorkers(), true).map((worker) => worker.id), [a.id]);
  focusZaicodeWorker(a.id);
  assert.deepEqual(zaicodeWindowWorkers().map((worker) => worker.id), [a.id], "a chip restores to its window");

  dockZaicodeWorker(a.id);
  assert.equal(readZaicodeWorkers().activeId, a.id);
  hideZaicodeWorkersPanel();
  assert.deepEqual(
    zaicodeTrayWorkers(readZaicodeWorkers(), true).map((worker) => worker.id).sort(),
    [a.id, b.id].sort(),
    "a hidden panel's workers show as chips",
  );
  assert.deepEqual(zaicodeTrayWorkers(readZaicodeWorkers(), false), [], "unless that is switched off");

  const copy = duplicateZaicodeWorker(b.id);
  assert.ok(copy && copy.id !== b.id && copy.projectPath === b.projectPath);
  // The store replaces its array on every change, so iterating this snapshot is safe.
  for (const worker of readZaicodeWorkers().workers) removeZaicodeWorker(worker.id);
  assert.equal(readZaicodeWorkers().workers.length, 0);
  assert.equal(readZaicodeWorkers().activeId, null);
});

test("worker prefs heal; Terminus is the default face", () => {
  const prefs = normalizeZaicodeWorkerPrefs({ trayAnchor: "top", panelHeight: 5, font: "comic" });
  assert.equal(prefs.trayAnchor, "bottom-right");
  assert.equal(prefs.panelHeight, 120);
  assert.equal(prefs.font, "terminus");
  assert.match(zaicodeWorkerFontFamily(prefs) ?? "", /Terminus/);
  assert.equal(zaicodeWorkerFontFamily({ font: "profile", customFont: "" }), undefined);
  assert.equal(normalizeZaicodeWorkerPrefs(null).defaultPlacement, "panel", "docked, not floating, by default");
});

// --- home screen, teams, hotkeys --------------------------------------------------

test("home screen: the Empty marker and the empty SAIMAIL line move to off once", () => {
  const legacy = normalizeZaicodeUiPrefs({ showEmptyMarker: true, saimailHomeShowEmpty: true, showGreeting: false });
  assert.equal(legacy.showEmptyMarker, false);
  assert.equal(legacy.saimailHomeShowEmpty, false);
  assert.equal(legacy.showGreeting, false, "other choices are kept");
  const chosen = normalizeZaicodeUiPrefs({ ...legacy, showEmptyMarker: true });
  assert.equal(chosen.showEmptyMarker, true, "after the move, the operator's choice sticks");
});

test("team presets map to templates and pools; a missing pool leaves the agent without one", () => {
  const templates = [
    { id: "zaicode-template:saipen-operator", name: "SAIPEN Operator", role: "implementer" as const, description: "", instructions: "build", toolPolicy: { permissionMode: "yolo" as const } },
    { id: "zaicode-template:auditor", name: "Auditor", role: "auditor" as const, description: "", instructions: "review", toolPolicy: {} },
  ];
  const groups = [
    { providerId: "sairoute", providerLabel: "SAIRoute", isRouter: true, options: [{ providerId: "sairoute", providerLabel: "SAIRoute", modelId: "SAIOPP", reasoningLevels: [], hintId: null }] },
  ];
  const preset = ZAICODE_TEAM_PRESETS.find((item) => item.id === "builder-reviewer")!;
  const [builder, reviewer] = preset.members.map((member) => zaicodeTeamMemberInput(member, templates, groups));
  assert.equal(builder?.name, "Builder");
  assert.deepEqual(builder?.modelSelection, { providerId: "sairoute", modelId: "SAIOPP" });
  assert.equal(builder?.backend, "sairoute");
  assert.equal(reviewer?.modelSelection, undefined, "SAIFREN is not configured here");
  assert.equal(zaicodeTeamMemberInput({ templateId: "nope", name: "X", pool: "SAIOPP" }, templates, groups), null);
});

test("worker hotkeys exist and the defaults stay conflict-free", () => {
  const ids = ZAICODE_HOTKEY_ACTIONS.map((action) => action.id);
  for (const id of ["ui.workers", "workers.next", "workers.prev", "workers.float", "workers.minimize", "workers.layout", "workers.even"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.deepEqual(findZaicodeHotkeyConflicts(defaultZaicodeHotkeySettings()), []);
});
