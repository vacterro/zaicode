import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IServiceAccessor } from "@zcode/services";
import { resolveZaicodeServices } from "../src/zaicode/zaicodeServices.js";
import { ZaicodeHomeNow, type ZaicodeHomeNowFacts } from "../src/zaicode/home/ZaicodeHomeCards.js";
import { ZaicodeHeaderProjectTitle } from "../src/zaicode/ZaicodeHeaderProjectTitle.js";
import { ZaicodeWrappedPath } from "../src/settings/ZaicodeCustomSoundsStrip.js";
import { presetDateLabel } from "../src/zaicode/zaicodePresetLabels.js";
import { dayTitle, zaicodeCount } from "../src/zaicode/home/ZaicodeHomeStatsCards.js";
import { zaicodeHomeActionItems, zaicodeHomeRouting } from "../src/zaicode/home/zaicodeHomeModel.js";
import { isZaicodeRouterErrorRecent } from "@zcode/shared";

/**
 * T-133 (SRC-096, "keep catching bugs and polish what exists"): defects found by running the packaged app and reading
 * the operator's own logs, each pinned here so it cannot come back.
 */

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const source = (path: string): string => readFileSync(join(srcRoot, path), "utf8").replace(/\r\n/g, "\n");

function accessorWith(services: Record<string, unknown>): IServiceAccessor {
  return services as unknown as IServiceAccessor;
}

test("B1 the same services resolve to the same object, so an effect that lists them runs once, not on every render", () => {
  const agents = { name: "agents" };
  const jobs = { name: "jobs" };
  const audits = { name: "audits" };
  const modelSelection = { name: "model-selection" };
  const first = resolveZaicodeServices(accessorWith({ zaicodeAgentService: agents, zaicodeJobService: jobs, zaicodeAuditService: audits, modelSelectionService: modelSelection }));
  // A render builds the accessor again; the services inside are the same instances.
  const again = resolveZaicodeServices(accessorWith({ zaicodeAgentService: agents, zaicodeJobService: jobs, zaicodeAuditService: audits, modelSelectionService: modelSelection }));
  assert.ok(first);
  assert.equal(again, first, "an identical bundle is the same object (Settings -> ZAICODE re-fetched 650 times a second)");

  const otherJobs = { name: "jobs 2" };
  const changed = resolveZaicodeServices(accessorWith({ zaicodeAgentService: agents, zaicodeJobService: otherJobs, zaicodeAuditService: audits, modelSelectionService: modelSelection }));
  assert.notEqual(changed, first, "a service that really changed gives a new bundle");
  assert.equal(changed!.jobs, otherJobs);
  assert.equal(resolveZaicodeServices(accessorWith({ zaicodeJobService: jobs })), null, "no agent service: unavailable");
});

test("B1b Settings -> ZAICODE keeps loading its lists in an effect keyed on the resolved services only", () => {
  const text = source("settings/ZaicodeSettingsSection.tsx");
  assert.match(text, /const services = resolveZaicodeServices\(accessor\);/);
  assert.match(text, /services\.agents\.list\(\),[\s\S]*?\}, \[services\]\);/, "the effect's only dependency is the stable bundle");
});

const idleFacts: ZaicodeHomeNowFacts = {
  sessionsRunning: 0,
  sessionsWaiting: 0,
  workersRunning: 0,
  projectsWorking: 0,
  queue: { running: 0, ready: 0, waiting: 0, blocked: 0 },
  today: { tokens: 0, jobsDone: 0, jobsFailed: 0, agentMs: 0, truth: "measured" },
  nextReset: null,
  nextSchedule: null,
  problems: 3,
  now: Date.parse("2026-09-30T01:00:00Z"),
};

test("B2 SAIHOME Now: a value wraps inside its tile instead of losing its end ('0 run · 0 r...', 'none pendi...')", () => {
  const html = renderToStaticMarkup(createElement(ZaicodeHomeNow, { facts: idleFacts }));
  const values = [...html.matchAll(/data-zaicode-home-stat="([A-Z ]+)"[^>]*>(?:(?!<\/div>)[\s\S])*?<span class="([^"]*)">[^<]*<\/span>\s*<span class="([^"]*)"/g)];
  assert.equal(values.length, 6, "six tiles");
  for (const [, label, , valueClass] of values) {
    assert.ok(!/\btruncate\b/.test(valueClass!), `${label} value is not cut off`);
    assert.match(valueClass!, /\bbreak-words\b/, `${label} value wraps`);
  }
  assert.match(html, /0 run · 0 ready/);
  assert.match(html, /none pending/);
  assert.match(html, /min-w-\[112px\]/, "a tile is wide enough for a short value on one line");
});

test("B3 the title-bar project name shrinks with an ellipsis instead of running under the clock", () => {
  const html = renderToStaticMarkup(
    createElement(ZaicodeHeaderProjectTitle, { projectName: "zaicode-explore-proj", workspacePath: "C:\\tmp\\zaicode-explore-proj", placement: "start" }),
  );
  const wrapper = /^<div class="([^"]*)"/.exec(html)?.[1] ?? "";
  assert.match(wrapper, /\bmin-w-0\b/, "the flex item may shrink below the name's width");
  assert.match(html, /data-zaicode-header-project=""/);
  assert.match(html, /class="[^"]*\btruncate\b[^"]*"[^>]*data-zaicode-header-project/, "and the name itself ends in an ellipsis");
  assert.match(
    source("WorkspaceHeaderSections.tsx"),
    /isZaicodeProductMode\(\) && "\[flex-shrink:4\]"/,
    "the session title, also in the sidebar, gives way first",
  );
});

test("B4 in a narrow session header the clock gives up the date and the part of day; the time stays, SAIHOME keeps it all", () => {
  const text = source("zaicode/ZaicodeTopbarClock.tsx");
  assert.match(text, /const NARROW_HEADER_HIDDEN = "@max-\[760px\]\/workspace-header:hidden";/);
  assert.match(text, /const narrowHidden = yieldToTitle \? NARROW_HEADER_HIDDEN : undefined;/, "only where names need the room");
  assert.match(text, /<span className=\{timePart \? narrowHidden : undefined\}>\s*\{datePart\}/, "the date hides only when a time is shown");
  assert.match(text, /\{timePart\}\s*\{daypart \?/, "the time itself is never hidden");
  assert.ok(!/head\.join\(" · "\)/.test(text), "not one unbreakable string any more");
  assert.match(source("WorkspaceHeaderSections/WorkspaceHeaderActionSection.tsx"), /<ZaicodeTopbarClock [^>]*yieldToTitle=\{variant === "task"\}/);
});

test("B5 a draft with no project picked has no SAIPEN strip (INIT SAIPEN 'in this project' had no project)", () => {
  const text = source("prompt-editor/ChatPromptEditor.tsx");
  assert.match(text, /\{showSaipenControls && workspacePath\.trim\(\) \? \(\s*<ZaicodeSaipenControls/);
});

test("B7 the sounds folder path breaks after a separator, never inside a name ('customization\\sound' / 's')", () => {
  const html = renderToStaticMarkup(createElement(ZaicodeWrappedPath, { path: "C:\\Users\\op\\AppData\\Local\\Temp\\zaicode\\customization\\sounds" }));
  assert.equal(html, "C:\\<wbr/>Users\\<wbr/>op\\<wbr/>AppData\\<wbr/>Local\\<wbr/>Temp\\<wbr/>zaicode\\<wbr/>customization\\<wbr/>sounds");
  assert.equal(renderToStaticMarkup(createElement(ZaicodeWrappedPath, { path: "/home/op/sounds" })), "/<wbr/>home/<wbr/>op/<wbr/>sounds");
  assert.ok(!/break-all/.test(source("settings/ZaicodeCustomSoundsStrip.tsx")), "no break inside a word");
});

test("B8 an empty alarm time is a prompt, not an error; only unreadable text turns orange", () => {
  const text = source("zaicode/ZaicodeTimersAlarms.tsx");
  assert.match(text, /className=\{preview \|\| !draft\.when\.trim\(\) \? "text-foreground-subtle" : "text-\[#ff9a66\]"\}/);
});

test("B9 a preset's date and the statistics export's file name are the operator's calendar day, not UTC's", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "Europe/Tallinn";
    assert.equal(presetDateLabel("2026-09-29T22:45:00.000Z"), "30 Sep 2026", "saved at 01:45 on 30 Sep in Tallinn");
    process.env.TZ = "America/New_York";
    assert.equal(presetDateLabel("2026-09-30T02:00:00.000Z"), "29 Sep 2026", "22:00 on 29 Sep in New York");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
  const exportSource = source("zaicode/home/ZaicodeHomeSettings.tsx");
  assert.match(exportSource, /zaicode-statistics-\$\{new Date\(\)\.toLocaleDateString\("sv-SE"\)\}\.json/);
  assert.ok(!/toISOString\(\)\.slice\(0, 10\)/.test(exportSource));
});

test("B10 SAIHOME Activity's day line counts in words that agree ('1 turn', not '1 turns')", () => {
  const totals = {
    tokens: 43_466, input: 43_000, output: 3, cacheRead: 153, cacheWrite: 0, reasoning: 0, requests: 2, failedRequests: 1, turns: 1,
    jobsDone: 0, jobsFailed: 0, jobsCancelled: 0, jobsRecovered: 0, modelMs: 7000, agentMs: 0, workerSessions: 1,
  };
  const line = dayTitle({ date: "2026-09-30", totals } as unknown as Parameters<typeof dayTitle>[0], "activity");
  assert.match(line, /· 2 requests · 1 turn · 0 tasks done · 1 worker session · runtime/);
  assert.equal(zaicodeCount(0, "turn"), "0 turns");
});

test("B11 SAIHOME Routing counts only recent provider errors; old ones stayed red for weeks", () => {
  const now = Date.parse("2026-09-30T01:00:00Z");
  const connection = (index: number, lastErrorAt: string | null, lastError: string | null = "[502]: fetch connect timeout") => ({
    id: `c${index}`, provider: `p${index}`, name: `P${index}`, authType: null, isActive: true, priority: null, testStatus: "unavailable",
    lastError, lastErrorAt, baseUrl: null, prefix: null,
  });
  const combos = [{ id: "1", name: "SAIFREN", models: ["m"], kind: null, strategy: "fallback" }];
  const route = (connections: ReturnType<typeof connection>[]) =>
    zaicodeHomeRouting({ status: "up", message: "", host: null, combos, connections, lastScanAt: null, now });
  // The operator's router on 30.09: 57 active, 41 carrying errors from 15.09-29.09, none from the last hour.
  const old = Array.from({ length: 41 }, (_, index) => connection(index, "2026-09-15T18:29:56.309Z"));
  const fine = Array.from({ length: 16 }, (_, index) => connection(100 + index, null, null));
  const calm = route([...old, ...fine]);
  assert.equal(calm.state, "healthy", "two-week-old errors are history");
  assert.equal(calm.headline, "Router healthy");
  assert.deepEqual(zaicodeHomeActionItems({ routing: calm, limitRows: [], projects: [], waitingSessions: 0, schedules: [], statsSources: [], statsError: null }), []);

  const twoRecent = route([...old, ...fine.slice(2), connection(200, "2026-09-30T00:40:00Z"), connection(201, "2026-09-30T00:10:00Z")]);
  assert.equal(twoRecent.state, "healthy", "a pool routes around two of 57");
  assert.match(twoRecent.headline, /2 provider\(s\) erred in the last hour/);

  const many = [...Array.from({ length: 20 }, (_, index) => connection(300 + index, "2026-09-30T00:30:00Z")), connection(400, "2026-09-30T00:55:00Z", "[429]: newest"), ...fine];
  const degraded = route(many);
  assert.equal(degraded.state, "degraded");
  assert.match(degraded.headline, /21 of 37 provider\(s\) failed in the last hour/);
  const item = zaicodeHomeActionItems({ routing: degraded, limitRows: [], projects: [], waitingSessions: 0, schedules: [], statsSources: [], statsError: null })[0]!;
  assert.equal(item.why, "[429]: newest", "the newest error explains it");

  assert.equal(isZaicodeRouterErrorRecent({ lastError: "x", lastErrorAt: null }, now), true, "no time: cannot be shown to be old");
  assert.equal(isZaicodeRouterErrorRecent({ lastError: null, lastErrorAt: "2026-09-30T00:59:00Z" }, now), false);
});

test("B12 the sidebar's icon-only Group / Project tabs carry a hint and an accessible name in ZAICODE", () => {
  const text = source("WorkspaceSidebar.tsx");
  for (const id of ["workspaceSidebar.organizeGrouped", "workspaceSidebar.organizeByProject"]) {
    const at = text.indexOf(`title: intl.formatMessage({ id: "${id}" })`);
    assert.ok(at > 0, `${id} has a title`);
    assert.ok(text.indexOf(`"aria-label": intl.formatMessage({ id: "${id}" })`, at) > at, `${id} has an aria-label`);
  }
});

test("B6 SAIHOME Projects: the name column gets the larger share of the row", () => {
  assert.match(source("zaicode/home/ZaicodeHomeFleet.tsx"), /grid-cols-\[4px_minmax\(80px,3fr\)_46px_minmax\(0,2fr\)_auto\]/);
});
