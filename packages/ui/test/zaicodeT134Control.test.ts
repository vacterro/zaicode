import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  defaultZaicodeUpdateAuto,
  mergeZaicodeUpdateComponents,
  normalizeZaicodeUpdateAuto,
  parseZaicodeUpdateReport,
  zaicodeUpdatesDue,
  type ZaicodeUpdateComponent,
} from "@zcode/shared";
import {
  describeZaicodeSoundConditions,
  normalizeZaicodeSoundConditions,
  zaicodeSoundConditionsAllow,
  type ZaicodeSoundConditionContext,
} from "../src/zaicode/zaicodeSoundConditions.js";
import { ZAICODE_SOUND_EVENTS, defaultZaicodeSoundSettings, normalizeZaicodeSoundSettings } from "../src/zaicode/zaicodeSoundSettingsModel.js";
import {
  ZAICODE_FOOTER_TOOLS,
  ZAICODE_HEADER_TOOLS,
  ZAICODE_NAV_ITEMS,
  isZaicodeLayoutEntryShown,
  normalizeZaicodeLayoutList,
} from "../src/zaicode/zaicodeLayoutPrefs.js";
import { ZAICODE_ICON_SLOT_IDS } from "../src/zaicode/zaicodeIconSlots.js";
import { ZAICODE_FOOTER_ICON_SLOTS, ZaicodeHeaderToolsEditor, ZaicodeNavItemsEditor } from "../src/zaicode/ZaicodeLayoutListEditor.js";
import { ZaicodeSoundConditionRow } from "../src/settings/ZaicodeSoundConditionControls.js";
import { zaicodeUpdateCue } from "../src/zaicode/zaicodeUpdatesStore.js";

/**
 * T-134 (SRC-097): "even more control over practically every element, icon,
 * sound (where there is none yet), placement, conditions", and ZAICODE +
 * SAIPEN + SAIMAIL as one whole whose parts update on their own.
 */

const source = (path: string) => readFileSync(join(import.meta.dirname, "../src", path), "utf8").replace(/\r\n/g, "\n");

const context = (patch: Partial<ZaicodeSoundConditionContext> = {}): ZaicodeSoundConditionContext => ({
  focused: false,
  quietNow: false,
  whenFocusedGlobal: true,
  now: 100_000,
  lastPlayedAt: 0,
  ...patch,
});

test("C1 a sound row without conditions follows the master rules exactly as before", () => {
  assert.deepEqual(zaicodeSoundConditionsAllow({}, context()), { play: true });
  assert.deepEqual(zaicodeSoundConditionsAllow({}, context({ quietNow: true })), { play: false, reason: "quiet" });
  assert.deepEqual(zaicodeSoundConditionsAllow({}, context({ focused: true, whenFocusedGlobal: false })), { play: false, reason: "focused" });
  assert.deepEqual(zaicodeSoundConditionsAllow({}, context({ focused: true })), { play: true });
});

test("C2 background-only / front-only rows, through quiet hours, and a cooldown", () => {
  assert.equal(zaicodeSoundConditionsAllow({ when: "background" }, context({ focused: true })).play, false);
  assert.equal(zaicodeSoundConditionsAllow({ when: "background" }, context({ focused: false })).play, true);
  assert.equal(zaicodeSoundConditionsAllow({ when: "foreground" }, context({ focused: false })).play, false);
  // An explicit "in front" wins over the master switch that keeps the others quiet while focused.
  assert.equal(zaicodeSoundConditionsAllow({ when: "foreground" }, context({ focused: true, whenFocusedGlobal: false })).play, true);
  assert.equal(zaicodeSoundConditionsAllow({ throughQuiet: true }, context({ quietNow: true })).play, true);
  assert.deepEqual(zaicodeSoundConditionsAllow({ cooldownSec: 30 }, context({ now: 100_000, lastPlayedAt: 80_000 })), { play: false, reason: "cooldown" });
  assert.equal(zaicodeSoundConditionsAllow({ cooldownSec: 30 }, context({ now: 100_000, lastPlayedAt: 60_000 })).play, true);
  assert.equal(zaicodeSoundConditionsAllow({ cooldownSec: 30 }, context({ lastPlayedAt: 0 })).play, true);
});

test("C3 stored conditions are cleaned, kept through the settings normalizer, and shown as a short tag", () => {
  assert.deepEqual(normalizeZaicodeSoundConditions({ when: "sometimes", throughQuiet: "yes", cooldownSec: -4 }), {});
  assert.deepEqual(normalizeZaicodeSoundConditions({ when: "background", throughQuiet: true, cooldownSec: 99999 }), {
    when: "background",
    throughQuiet: true,
    cooldownSec: 3600,
  });
  const base = defaultZaicodeSoundSettings();
  const stored = { ...base, events: { ...base.events, "agent.update": { ...base.events["agent.update"]!, when: "background", cooldownSec: 60 } } };
  const round = normalizeZaicodeSoundSettings(JSON.parse(JSON.stringify(stored)));
  assert.equal(round.events["agent.update"]!.when, "background");
  assert.equal(round.events["agent.update"]!.cooldownSec, 60);
  assert.equal(round.events["agent.done"]!.when, undefined, "an untouched row stays without conditions");
  assert.equal(describeZaicodeSoundConditions({ when: "background", throughQuiet: true, cooldownSec: 60 }), "bg !q 1m");
  assert.equal(describeZaicodeSoundConditions({}), "");
});

test("C4 the sound engine asks the row's conditions; a sound waiting in line keeps its quiet-hours pass", () => {
  const engine = source("zaicode/zaicodeSoundEvents.ts");
  assert.match(engine, /const verdict = zaicodeSoundConditionsAllow\(row, \{/);
  assert.match(engine, /isZaicodeSoundQuietNow\(\) && now\.events\[id\]\?\.throughQuiet !== true/);
  const html = renderToStaticMarkup(
    createElement(ZaicodeSoundConditionRow, {
      event: ZAICODE_SOUND_EVENTS.find((event) => event.id === "agent.human")!,
      row: { ...defaultZaicodeSoundSettings().events["agent.human"]!, throughQuiet: true },
    }),
  );
  for (const label of ["Always", "Only in the background", "Only in front", "also in quiet hours", "once per 30 s", "reset"]) {
    assert.ok(html.includes(label), label);
  }
});

test("S1 moments that had no voice have one now: free models ready, a new free model, updates", () => {
  const ids = new Set(ZAICODE_SOUND_EVENTS.map((event) => event.id));
  for (const id of ["free.ready", "free.newModel", "update.available", "update.applied", "update.failed"]) assert.ok(ids.has(id), id);
  assert.equal(ids.size, ZAICODE_SOUND_EVENTS.length, "event ids stay unique");
  const setup = source("zaicode/useZaicodeRouterAutoSetup.ts");
  assert.match(setup, /playZaicodeSound\("free\.ready"\)/);
  assert.match(setup, /playZaicodeSound\("free\.newModel"\)/);
});

test("L1 a layout entry can wait for a moment: while working, while idle, on hover", () => {
  const list = normalizeZaicodeLayoutList(
    [
      { id: "search", visible: true, when: "hover" },
      { id: "timers", visible: true, when: "working" },
      { id: "help", visible: true, when: "whenever" },
    ],
    ZAICODE_HEADER_TOOLS,
  );
  assert.equal(list.find((entry) => entry.id === "search")!.when, "hover");
  assert.equal(list.find((entry) => entry.id === "timers")!.when, "working");
  assert.equal(list.find((entry) => entry.id === "help")!.when, undefined, "an unknown condition falls back to always");
  const shown = (when: "always" | "working" | "idle" | "hover", working: number, hover: boolean) =>
    isZaicodeLayoutEntryShown({ visible: true, when }, { working, hover });
  assert.deepEqual([shown("always", 0, false), shown("working", 0, false), shown("working", 2, false)], [true, false, true]);
  assert.deepEqual([shown("idle", 0, false), shown("idle", 1, false), shown("hover", 3, false), shown("hover", 0, true)], [true, false, false, true]);
  assert.equal(isZaicodeLayoutEntryShown({ visible: false, when: "hover" }, { working: 1, hover: true }), false, "unticked stays hidden");
});

test("L2 the header, the footer, the menu and the meter all apply the condition", () => {
  assert.match(source("zaicode/ZaicodeHeaderToolbar.tsx"), /isZaicodeLayoutEntryShown\(tool, \{ working, hover \}\)/);
  assert.match(source("zaicode/ZaicodeFooterTools.tsx"), /isZaicodeLayoutEntryShown\(tool, \{ working, hover \}\)/);
  assert.match(source("zaicode/ZaicodeSidebarNavBlock.tsx"), /isZaicodeLayoutEntryShown\(item, \{ working, hover \}\)/);
  assert.match(source("zaicode/ZaicodeSidebarHeaderTools.tsx"), /isZaicodeLayoutEntryShown\(entry, \{ working: sessions\.length, hover: true \}\)/);
});

test("I1 every sidebar header / footer button and every menu line draws a swappable icon slot", () => {
  const slots = new Set<string>(ZAICODE_ICON_SLOT_IDS);
  const own = new Set(["meter"]);
  for (const def of [...ZAICODE_HEADER_TOOLS, ...ZAICODE_FOOTER_TOOLS]) {
    if (own.has(def.id)) continue;
    const slot = def.id === "settings" && ZAICODE_FOOTER_TOOLS.includes(def as never) ? ZAICODE_FOOTER_ICON_SLOTS.settings! : `tool.${def.id === "cycleArrows" ? "next" : def.id}`;
    assert.ok(slots.has(slot), `${def.id} -> ${slot}`);
  }
  for (const def of ZAICODE_NAV_ITEMS) {
    if (def.id === "newTask") continue; // upstream's own New task control
    assert.ok(slots.has(`nav.${def.id}`), def.id);
  }
  // No fixed lucide icon is left on those rows.
  assert.doesNotMatch(source("zaicode/ZaicodeCommonTools.tsx"), /<(House|Crosshair|AlarmClock|CircleHelp|Palette|SquareTerminal|Volume2|VolumeX) className/);
  assert.doesNotMatch(source("zaicode/ZaicodeSidebarNavBlock.tsx"), /<(House|Search|Blocks|AlarmClock|CircleHelp|SquareTerminal|Settings) className/);
  assert.doesNotMatch(source("zaicode/ZaicodeHeaderToolbar.tsx"), /<(ArrowLeftIcon|ArrowRightIcon|Search|MessageCirclePlus|Settings) className/);
});

test("I2 the layout editor shows each row's icon and its when-condition", () => {
  const header = renderToStaticMarkup(createElement(ZaicodeHeaderToolsEditor));
  assert.match(header, /aria-label="Icon of Search"/);
  assert.match(header, /aria-label="When Search shows"/);
  for (const option of ["always", "working", "idle", "hover"]) assert.ok(header.includes(`>${option}</option>`), option);
  const nav = renderToStaticMarkup(createElement(ZaicodeNavItemsEditor));
  assert.match(nav, /aria-label="Icon of SCHEDULER"/);
});

const part = (patch: Partial<ZaicodeUpdateComponent> & Pick<ZaicodeUpdateComponent, "id" | "status">): ZaicodeUpdateComponent => ({
  title: patch.id,
  dir: "",
  branch: "main",
  version: "1",
  head: "a".repeat(40),
  remote: "b".repeat(40),
  behind: 0,
  ahead: 0,
  dirty: false,
  detail: "",
  subjects: [],
  ...patch,
});

test("U1 the update report of Update-ZAICODE.ps1 -Json parses, noise before it included", () => {
  const report = parseZaicodeUpdateReport(
    [
      "WARNING: something a tool printed",
      JSON.stringify({
        schema: 1,
        managed: true,
        mode: "check",
        log: "C:\\z\\install\\logs\\update-check.log",
        // PowerShell 5.1 writes a one-element array as the element itself.
        components: { id: "saipen", title: "SAIPEN", status: "available", behind: 2, subjects: "feat: one" },
      }),
    ].join("\r\n"),
  );
  assert.ok(report);
  assert.equal(report.managed, true);
  assert.equal(report.components.length, 1);
  assert.deepEqual([report.components[0]!.id, report.components[0]!.status, report.components[0]!.behind], ["saipen", "available", 2]);
  assert.deepEqual(report.components[0]!.subjects, ["feat: one"]);
  assert.equal(parseZaicodeUpdateReport("no json at all"), null);
});

test("U2 installed parts update by themselves by default; a developer checkout only reports", () => {
  assert.deepEqual(defaultZaicodeUpdateAuto(true), { workspace: true, app: true, saipen: true, saimail: true });
  assert.deepEqual(defaultZaicodeUpdateAuto(false), { workspace: false, app: false, saipen: false, saimail: false });
  assert.deepEqual(normalizeZaicodeUpdateAuto({ app: false, saipen: "yes" }, true), { workspace: true, app: false, saipen: true, saimail: true });
  const components = [part({ id: "app", status: "available" }), part({ id: "saipen", status: "available" }), part({ id: "saimail", status: "current" })];
  assert.deepEqual(zaicodeUpdatesDue({ workspace: true, app: false, saipen: true, saimail: true }, components), ["saipen"]);
  const merged = mergeZaicodeUpdateComponents(components, [part({ id: "saipen", status: "updated" })]);
  assert.deepEqual(merged.map((entry) => [entry.id, entry.status]), [["app", "available"], ["saipen", "updated"], ["saimail", "current"]]);
});

test("U3 update sounds: news once, an installed part, a failure first", () => {
  const before = [part({ id: "app", status: "current" }), part({ id: "saipen", status: "current" })];
  assert.equal(zaicodeUpdateCue(before, before), null);
  assert.equal(zaicodeUpdateCue(before, [part({ id: "app", status: "available" }), before[1]!]), "update.available");
  assert.equal(zaicodeUpdateCue(before, [part({ id: "app", status: "updated" }), part({ id: "saipen", status: "failed" })]), "update.failed");
  assert.equal(zaicodeUpdateCue([part({ id: "app", status: "available" })], [part({ id: "app", status: "updated" })]), "update.applied");
});

test("U4 Settings -> ZAICODE opens with the Updates card", () => {
  const section = source("settings/ZaicodeSettingsSection.tsx");
  assert.match(section, /<div className="flex flex-col gap-4">\n\s+<ZaicodeUpdatesSettings \/>/);
  assert.match(source("zaicode/ZaicodeAppRuntime.tsx"), /useZaicodeUpdatesBridge\(\);/);
});

test("F1 a first install nags about nothing: a Claude / Codex login never set up here is an offer, not 'needs you'", async () => {
  const { zaicodeHomeActionItems, zaicodeHomeLimitRows, zaicodeHomeRouting } = await import("../src/zaicode/home/zaicodeHomeModel.js");
  const { ZAICODE_METER_DEFAULT_PREFS } = await import("../src/zaicode/zaicodeEngines.js");
  const base = { vendor: "claude" as const, source: "~\\.claude", home: null, isDefaultHome: true, cli: "claude.exe", fixCommand: null };
  const fresh = { ...base, id: "A1", short: "A1", label: "Claude 1", status: "login-required" as const, statusDetail: "Optional: sign in any time", optional: true };
  const broken = { ...base, id: "A2", short: "A2", label: "Claude 2", status: "login-required" as const, statusDetail: "Not signed in (~\\.claude-account2)." };
  const rows = zaicodeHomeLimitRows({ accounts: [fresh, broken], hiddenAccounts: [], limits: {}, meterPrefs: ZAICODE_METER_DEFAULT_PREFS, showAll: true, now: 1 }).rows;
  assert.deepEqual(rows.map((row) => [row.account.id, row.needsAttention]), [["A1", null], ["A2", "sign-in required"]]);
  const routing = zaicodeHomeRouting({ status: "up", message: "", host: null, combos: [{ id: "1", name: "SAIFREN", models: ["m"], kind: null, strategy: "fallback" }], connections: [], lastScanAt: null });
  const items = zaicodeHomeActionItems({ routing, limitRows: rows, projects: [], waitingSessions: 0, schedules: [], statsSources: [], statsError: null });
  assert.deepEqual(items.map((item) => item.id), ["engine-A2"], "only the login that was set up and broke asks for you");
  const engines = source("../../desktop/src/main/zaicodeEngines.ts");
  assert.match(engines, /if \(isDefault && !loggedIn && !isDirectory\(dir\)\) \{\n\s+account\.optional = true;/);
  assert.match(engines, /if \(isDefault && !isFile\(join\(dir, "auth\.json"\)\) && !isDirectory\(dir\)\) \{\n\s+account\.optional = true;/);
});

test("F2 once the free pools exist SAIHOME reads the router again, so a first start shows no stale 'no SAIFREN pool'", () => {
  const setup = source("zaicode/useZaicodeRouterAutoSetup.ts");
  const stored = setup.indexOf("useZaicodeRouterSetup.setState({ last: result, lastKind: kind, appStep, host: result.host });");
  const refresh = setup.indexOf("void useZaicodeRouter.getState().refresh()", stored);
  assert.ok(stored > 0 && refresh > stored, "the routing card is refreshed right after the setup result is stored");
});
