/**
 * T-319: the 9router Usage surfaces, the silent live refresh, the scheduler's
 * "Enable project" action and the time picker.
 *
 * The surface contract and the clock maths are pure functions, so they are
 * asserted as behaviour. The two mounted components are rendered with
 * renderToStaticMarkup: no DOM event dispatch exists in this package, so the
 * markup is the strongest evidence a click target is really there.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveWorkspaceKey } from "@zcode/shared";
import {
  formatZaicodeUsageUpdated,
  zaicodeUsageFreshness,
  zaicodeUsageSurface,
  ZAICODE_USAGE_STALE_MS,
} from "../src/zaicode/zaicodeUsage.js";
import {
  formatZaicodeClockMinute,
  formatZaicodeDay,
  parseZaicodeClockText,
  parseZaicodeDayText,
  stepZaicodeClockMinute,
  zaicodeClockParts,
  zaicodeDayOf,
  zaicodeMinuteOf,
  zaicodeMomentOf,
  ZAICODE_PICKER_HOUR_STOPS,
  ZAICODE_PICKER_MINUTE_STOPS,
  ZAICODE_PICKER_MINUTE_STEP,
} from "../src/zaicode/zaicodeClockText.js";
import { zaicodeScheduleEnableKey } from "../src/zaicode/zaicodeAutostart.js";
import { publishZaicodeKnownProjects } from "../src/zaicode/zaicodeScheduler.js";
import { ZaicodeMomentField, ZaicodeTimeField } from "../src/zaicode/ZaicodeTimeFields.js";
import { ZaicodeUsageView } from "../src/zaicode/ZaicodeUsageView.js";

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../src/zaicode/${path}`, import.meta.url)), "utf8");
const layoutSource = readFileSync(
  fileURLToPath(new URL("../src/app-shell/WorkspaceShellLayout.tsx", import.meta.url)),
  "utf8",
);

test("usage surface contract: one host per state, and the two hosts are complementary", () => {
  for (const mode of ["closed", "page", "sidebar"] as const) {
    const layout = zaicodeUsageSurface(mode, true);
    const portal = zaicodeUsageSurface(mode, false);
    assert.equal(layout, mode === "closed" ? "none" : mode);
    assert.equal(portal, mode === "closed" ? "none" : "global");
    if (mode === "closed") {
      // A closed reading is drawn by nobody, never by a leftover copy.
      assert.equal(layout, "none");
      assert.equal(portal, "none");
      continue;
    }
    assert.notEqual(layout, "none", `no host for ${mode}`);
    assert.notEqual(portal, "none", `no host for ${mode}`);
    assert.notEqual(layout, portal, `two hosts for ${mode}`);
  }
});

test("the workspace layout hosts the full page before its own views, so Full page can never be shadowed", () => {
  const chain = /usageSurface === "page"[\s\S]{0,1200}?\) : workspaceMainView === "automations" \? \(/;
  assert.match(layoutSource, chain, "the usage page must win over the view branches");
  assert.match(layoutSource, /usageSurface === "sidebar" \? \(/);
  assert.match(layoutSource, /zaicodeUsageSurface\(usageMode, isWorkspaceVisible && workspaceOwnsPanes\)/);
  assert.match(source("ZaicodeGlobalSidebars.tsx"), /zaicodeUsageSurface\(usageMode, Boolean\(workspaceOpener\)\) === "global"/);
});

test("the fixed global copy keeps its header out of the window drag region", () => {
  assert.match(source("ZaicodeUsageView.tsx"), /\[app-region:no-drag\]/);
});

test("live refresh: freshness is a colour, not a flashing label", () => {
  const now = 1_800_000_000_000;
  assert.equal(zaicodeUsageFreshness(0, now), "unknown");
  assert.equal(zaicodeUsageFreshness(now, now), "fresh");
  assert.equal(zaicodeUsageFreshness(now - ZAICODE_USAGE_STALE_MS, now), "fresh");
  assert.equal(zaicodeUsageFreshness(now - ZAICODE_USAGE_STALE_MS - 1, now), "stale");
  // Minute precision: a background poll must not rewrite the label every second.
  assert.equal(formatZaicodeUsageUpdated(new Date(2026, 9, 13, 14, 5, 59).getTime()), "14:05");
  assert.equal(formatZaicodeUsageUpdated(new Date(2026, 0, 1, 0, 0, 0).getTime()), "00:00");
});

test("live refresh: the first reading is the only one that blanks the panel", () => {
  const view = source("ZaicodeUsageView.tsx");
  assert.doesNotMatch(view, /setLoading/);
  assert.match(view, /if \(hasSnapshot\.current\) setRefreshing\(true\);/);
  assert.match(view, /else setFirstLoad\(true\);/);
  assert.match(view, /setFirstLoad\(false\);\s*setRefreshing\(false\);/);
  assert.match(view, /disabled=\{firstLoad\}/);
  assert.match(view, /formatZaicodeUsageUpdated\(updatedAt\)/);
  assert.match(view, /min-h-\[1rem\]/);
  // A failure keeps the last good snapshot and never invents a timestamp.
  assert.match(view, /setUpdatedAt\(stamp\); setNow\(stamp\); setFailures\(0\);/);
  assert.match(view, /setFailures\(\(count\) => count \+ 1\)/);
  assert.match(view, /Showing the last successful reading\./);
});

test("the mounted usage panel opens in the first-load state with a disabled Refresh", () => {
  const html = renderToStaticMarkup(createElement(ZaicodeUsageView));
  assert.match(html, /data-zaicode-usage-status="loading"/);
  assert.match(html, /Reading usage…/);
  assert.match(html, /disabled/);
  assert.match(html, /data-zaicode-usage-refresh-pending="no"/);
});

test("the scheduler's enable action resolves the same key admission uses, and never for a section", () => {
  publishZaicodeKnownProjects([{ path: "C:\\work\\proj", identity: "proj-id" }]);
  const job = { targetKind: "project", projectPath: "c:\\work\\proj" } as const;
  assert.equal(zaicodeScheduleEnableKey(job), resolveWorkspaceKey({ workspacePath: "C:\\work\\proj", workspaceIdentity: "proj-id" }));
  const unknown = { targetKind: "project", projectPath: "D:\\elsewhere" } as const;
  assert.equal(zaicodeScheduleEnableKey(unknown), resolveWorkspaceKey({ workspacePath: "D:\\elsewhere", workspaceIdentity: undefined }));
  assert.equal(zaicodeScheduleEnableKey({ targetKind: "section", projectPath: "C:\\work\\proj" }), null);
  publishZaicodeKnownProjects([]);
});

test("the scheduler row offers Enable project only for a single switched-off project, and confirms it", () => {
  const panel = source("ZaicodeSchedulerPanel.tsx");
  assert.match(panel, /decision\.state === "waiting-project" && decision\.reason === "project switched off"/);
  assert.match(panel, /setZaicodeProjectDisabled\(enableKey, false\)/);
  assert.match(panel, /isZaicodeProjectDisabled\(enableKey\)/);
  assert.match(panel, /data-zaicode-schedule-enable-project=\{enabling \? "pending" : "ready"\}/);
  assert.match(panel, /role="alert"/);
  // Enabling a project must never fire the schedule or clear its fired events:
  // the whole action lives in its own handler, and only that handler may be
  // free of those calls (the row's other controls legitimately reset them).
  const enableHandler = /const enableProject = \(\) => \{[\s\S]*?\n  \};/.exec(panel)?.[0] ?? "";
  assert.ok(enableHandler.length > 0, "the enable action must be one handler");
  assert.doesNotMatch(enableHandler, /firedEvents/);
  assert.doesNotMatch(enableHandler, /runZaicodeAutostartNow/);
  assert.match(panel, /ZaicodeMomentField value=\{job\.at\}/);
});

test("clock maths: 00:00, 23:59, midnight stepping and the picker dials", () => {
  assert.deepEqual(zaicodeClockParts(0), { hour: 0, minute: 0 });
  assert.deepEqual(zaicodeClockParts(1439), { hour: 23, minute: 59 });
  assert.deepEqual(zaicodeClockParts(-1), { hour: 23, minute: 59 });
  assert.deepEqual(zaicodeClockParts(1440), { hour: 0, minute: 0 });
  assert.equal(stepZaicodeClockMinute(1439, 1), 0);
  assert.equal(stepZaicodeClockMinute(0, -1), 1439);
  assert.equal(ZAICODE_PICKER_MINUTE_STEP, 5);
  assert.equal(ZAICODE_PICKER_MINUTE_STOPS.length, 12);
  assert.equal(ZAICODE_PICKER_MINUTE_STOPS[0], 0);
  assert.equal(ZAICODE_PICKER_MINUTE_STOPS.at(-1), 55);
  assert.equal(ZAICODE_PICKER_HOUR_STOPS.length, 24);
  assert.equal(ZAICODE_PICKER_HOUR_STOPS[0], 0);
  assert.equal(ZAICODE_PICKER_HOUR_STOPS.at(-1), 23);
});

test("clock text: 24-hour parsing, formatting and rejection of impossible times", () => {
  assert.equal(parseZaicodeClockText("00:00"), 0);
  assert.equal(parseZaicodeClockText("23:59"), 1439);
  assert.equal(parseZaicodeClockText("7"), 420);
  assert.equal(parseZaicodeClockText("0730"), 450);
  assert.equal(parseZaicodeClockText("24:00"), null);
  assert.equal(parseZaicodeClockText("12:60"), null);
  assert.equal(parseZaicodeClockText("nonsense"), null);
  assert.equal(formatZaicodeClockMinute(0), "00:00");
  assert.equal(formatZaicodeClockMinute(1439), "23:59");
  assert.equal(formatZaicodeClockMinute(7 * 60), "07:00");
});

test("day maths: month and year boundaries, leap day, and rejection of impossible dates", () => {
  const jan31 = zaicodeDayOf(new Date(2026, 0, 31));
  assert.deepEqual(jan31, { year: 2026, month: 1, day: 31 });
  // The parts round-trip through a stored moment, which is what a schedule holds.
  const stored = zaicodeMomentOf(jan31, 0);
  assert.deepEqual(zaicodeDayOf(new Date(stored)), jan31);
  assert.equal(new Date(stored).getHours(), 0);
  const endDate = new Date(zaicodeMomentOf({ year: 2026, month: 12, day: 31 }, 23 * 60 + 59));
  assert.equal(endDate.getFullYear(), 2026);
  assert.equal(endDate.getMonth(), 11);
  assert.equal(endDate.getDate(), 31);
  assert.equal(endDate.getHours(), 23);
  assert.equal(endDate.getMinutes(), 59);
  // One more minute is the next year: the day the operator typed is kept, and
  // the moment rolls over with the platform, never into a made-up date.
  const nextMinute = new Date(zaicodeMomentOf({ year: 2026, month: 12, day: 31 }, 23 * 60 + 59) + 60_000);
  assert.deepEqual(
    [nextMinute.getFullYear(), nextMinute.getMonth(), nextMinute.getDate()],
    [2027, 0, 1],
  );
  // A day the local clock does not have (spring-forward) still stores its own
  // day: the platform normalises the minute, the operator's date is kept.
  const dst = zaicodeMomentOf({ year: 2026, month: 3, day: 29 }, 150);
  assert.deepEqual(
    { ...zaicodeDayOf(new Date(dst)) },
    { year: 2026, month: 3, day: 29 },
  );
  const leap = zaicodeDayOf(new Date(2028, 1, 29));
  assert.equal(formatZaicodeDay(leap), "29.02.2028");
  assert.equal(zaicodeMinuteOf(new Date(2028, 1, 29, 23, 59)), 1439);
  assert.equal(parseZaicodeDayText("29.02.2027", 2027), null);
  assert.equal(parseZaicodeDayText("31.04.2026", 2026), null);
  assert.equal(formatZaicodeDay(parseZaicodeDayText("2026-09-25", 2026)!), "25.09.2026");
});

test("a new one-time schedule shows today's date without committing it", () => {
  const today = formatZaicodeDay(zaicodeDayOf(new Date()));
  const html = renderToStaticMarkup(createElement(ZaicodeMomentField, { value: null, onChange: () => {} }));
  assert.match(html, new RegExp(`value="${today}"`));
  assert.match(html, /data-zaicode-moment-default="today"/);
  const saved = zaicodeMomentOf(zaicodeDayOf(new Date(2026, 8, 25)), 9 * 60);
  const savedHtml = renderToStaticMarkup(createElement(ZaicodeMomentField, { value: saved, onChange: () => {} }));
  assert.match(savedHtml, /value="25.09.2026"/);
  assert.doesNotMatch(savedHtml, /data-zaicode-moment-default/);
  const field = source("ZaicodeTimeFields.tsx");
  // A displayed default is not a commit: only an explicit or dirty edit writes.
  assert.match(field, /if \(parsedDay && \(dirty \|\| explicit \|\| !defaulted\)\)/);
  assert.match(field, /const defaulted = value === null;/);
});

test("the time picker is opt-in, a draft until Done, and dismissible three ways", () => {
  const closed = renderToStaticMarkup(createElement(ZaicodeTimeField, { minute: null, onChange: () => {} }));
  assert.match(closed, /data-zaicode-time-picker-toggle/);
  assert.doesNotMatch(closed, /data-zaicode-time-picker="open"/);
  const field = source("ZaicodeTimeFields.tsx");
  assert.match(field, /data-zaicode-time-picker-cancel/);
  assert.match(field, /data-zaicode-time-picker-done/);
  // Escape and outside dismissal belong to the shared portalled Popover now;
  // T-335's real browser scenario verifies both without depending on its source spelling.
  assert.match(field, /data-zaicode-time-picker-hour=\{value\}/);
  assert.match(field, /data-zaicode-time-picker-minute=\{value\}/);
  assert.match(field, /ZAICODE_PICKER_HOUR_STOPS\.map/);
  assert.match(field, /ZAICODE_PICKER_MINUTE_STOPS\.map/);
  // The picker never writes by itself: only Done commits the draft.
  assert.match(field, /onCommit=\{\(next\) => \{/);
  assert.doesNotMatch(field, /onChange\(draft\)/);
});
