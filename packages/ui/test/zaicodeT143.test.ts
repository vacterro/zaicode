import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import {
  isThoughtLevelSwitch,
  isZaicodeRealReset,
  isZaicodeRollingWindow,
  markZaicodeWindowsStartingOnUse,
  parseAntigravityUsage,
  parseZcodeQuota,
  selectableThoughtLevels,
  strongestThinkingLevel,
  type ZaicodeLimitWindow,
} from "@zcode/shared";
import { resolveModelThoughtOption } from "../src/lib/modelThoughtOption.js";
import { zaicodeNextUsefulReset, zaicodeResetRows } from "../src/zaicode/ZaicodeResetTimer.js";

/**
 * T-143 (SRC-109): three operator corrections.
 *   1. no thought on/off for models that do not support it out of the box -- thinking is always on.
 *   2. the Antigravity / ZCode 5 h window runs continuously from exactly 0% consumed.
 *   3. the delete-folder dialog text stays inside the frame.
 */

type Globals = { __ZAICODE_PRODUCT_MODE__?: boolean };
const globals = globalThis as Globals;
let savedMode: boolean | undefined;
beforeEach(() => {
  savedMode = globals.__ZAICODE_PRODUCT_MODE__;
  globals.__ZAICODE_PRODUCT_MODE__ = true;
});
afterEach(() => {
  if (savedMode === undefined) delete globals.__ZAICODE_PRODUCT_MODE__;
  else globals.__ZAICODE_PRODUCT_MODE__ = savedMode;
});

const HOUR = 3_600_000;
const FIVE_HOURS = 5 * HOUR;

function viewOf(values: string[]) {
  return {
    providers: [
      {
        providerId: "p",
        models: [{ modelId: "m", config: { optionSpecs: { reasoningLevel: { values, map: "{}" } } } }],
      },
    ],
  } as unknown as Parameters<typeof resolveModelThoughtOption>[0]["modelSelectionView"];
}

// --- 1. thought is always on ------------------------------------------------

test("a model whose only thought levels are on/off gets no thought control", () => {
  for (const values of [["disabled", "enabled"], ["on", "off"], ["true", "false"], ["enable", "disable"]]) {
    assert.equal(isThoughtLevelSwitch(values), true, values.join("/"));
    assert.equal(
      resolveModelThoughtOption({ modelSelectionView: viewOf(values), providerId: "p", modelId: "m" }),
      null,
      `a bare switch must render no control: ${values.join("/")}`,
    );
  }
});

test("a real effort scale keeps its control", () => {
  const option = resolveModelThoughtOption({
    modelSelectionView: viewOf(["low", "medium", "high"]),
    providerId: "p",
    modelId: "m",
    currentValue: "high",
  });
  assert.ok(option, "low/medium/high is a real scale and stays selectable");
  assert.deepEqual(option.options.map((entry) => entry.value), ["low", "medium", "high"]);
  assert.equal(option.currentValue, "high");
});

test("a scale that also lists an off marker never offers or keeps the off state", () => {
  assert.deepEqual(selectableThoughtLevels(["none", "low", "medium", "high", "xhigh"]), [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.equal(strongestThinkingLevel(["disabled", "high", "max"]), "max");
  const option = resolveModelThoughtOption({
    modelSelectionView: viewOf(["disabled", "high", "max"]),
    providerId: "p",
    modelId: "m",
    currentValue: "disabled",
  });
  assert.deepEqual(option?.options.map((entry) => entry.value), ["high", "max"]);
  // A session parked on "disabled" is not a valid choice any more; the runtime re-pins it.
  assert.equal(option?.currentValue, "");
});

// --- 2. the 5 h window never stands still ------------------------------------

function idleWindow(readAt: number, key = "five_hour", at = 0): ZaicodeLimitWindow {
  return {
    key,
    label: "5h",
    group: "",
    groupLabel: "",
    remainingPercent: 100,
    resetsAt: readAt + FIVE_HOURS + at,
    durationMinutes: 300,
    gatedBy: null,
    assumedFull: false,
  };
}

test("an unstarted 5 h window starts at exactly 0% consumed and counts down", () => {
  const readAt = Date.parse("2026-10-01T09:00:00Z");
  const [window] = markZaicodeWindowsStartingOnUse([idleWindow(readAt)], readAt);
  assert.ok(window);
  assert.equal(window.startsOnUse, true, "the vendor still has not seen a request");
  assert.equal(isZaicodeRollingWindow(window), true);
  assert.equal(window.remainingPercent, 100, "the window opens at 0% consumption");
  assert.equal(window.resetsAt, readAt + FIVE_HOURS, "and runs a full 5 h from the first read");
  assert.equal(isZaicodeRealReset(window, readAt), true, "a real coming refill, so the timer counts it down");
});

test("the countdown is anchored, not restarted by the next sweep", () => {
  const first = Date.parse("2026-10-01T09:00:00Z");
  const later = first + 4 * 60_000;
  const [opened] = markZaicodeWindowsStartingOnUse([idleWindow(first)], first);
  assert.ok(opened);
  const [swept] = markZaicodeWindowsStartingOnUse([idleWindow(later)], later, null, [opened]);
  assert.equal(swept.resetsAt, first + FIVE_HOURS, "the vendor sliding its reset must not slide ours");
  assert.equal(swept.rollingFrom, first);
});

test("a window the vendor really started is no longer local", () => {
  const readAt = Date.parse("2026-10-01T09:00:00Z");
  const started: ZaicodeLimitWindow = { ...idleWindow(readAt), resetsAt: readAt + 2 * HOUR, remainingPercent: 80 };
  const [window] = markZaicodeWindowsStartingOnUse([started], readAt, { at: readAt - 60_000, ok: true, detail: "ok" });
  assert.equal(window.startsOnUse, false);
  assert.equal(isZaicodeRollingWindow(window), false);
  assert.equal(window.resetsAt, readAt + 2 * HOUR, "the vendor's own reset is left alone");
});

test("ZCode reports a 0-of-0 5 h window as a full window instead of dropping it", () => {
  const parsed = parseZcodeQuota({
    success: true,
    data: {
      limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, currentValue: 0, remaining: 0, nextResetTime: 1_800_000_000_000 }],
    },
  });
  const five = parsed.windows.find((window) => window.key === "five_hour");
  assert.ok(five, "a window nobody used is still a window");
  assert.equal(five.remainingPercent, 100);
  assert.equal(parsed.error, null);
});

test("Antigravity keeps a bucket that has a reset time but no fraction yet", () => {
  const windows = parseAntigravityUsage({
    command: {
      data: {
        groups: [
          {
            name: "Gemini",
            buckets: [{ window: "5h", reset_time: "2026-10-01T14:00:00Z" }],
          },
        ],
      },
    },
  });
  const five = windows.find((window) => window.key.startsWith("five_hour"));
  assert.ok(five, "no fraction means not consumed yet, not unknown");
  assert.equal(five.remainingPercent, 100);
  assert.ok(five.resetsAt !== null);
});

test("the title timer counts down a rolling 5 h window instead of standing still", () => {
  const readAt = Date.parse("2026-10-01T09:00:00Z");
  const [window] = markZaicodeWindowsStartingOnUse([idleWindow(readAt)], readAt);
  assert.ok(window);
  const rows = zaicodeResetRows(
    [{ id: "antigravity:default", short: "AG", label: "Antigravity", vendor: "antigravity" }],
    { "antigravity:default": { accountId: "antigravity:default", windows: [window], plan: null, fetchedAt: readAt, checkedAt: readAt, error: null, source: "agy" } },
    readAt,
  );
  assert.equal(rows[0]?.kind, "reset", "no 'on first use' row above the real resets");
  assert.equal(rows[0]?.rolling, true);
  assert.equal(zaicodeNextUsefulReset(rows)?.at, readAt + FIVE_HOURS);
});

// --- 3. the delete-folder dialog text stays inside the frame -----------------

function sourceOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

test("the confirm dialog wraps anywhere and clips to its own frame", () => {
  const dialog = sourceOf("../src/ConfirmDialog.tsx");
  assert.match(dialog, /"gap-5 overflow-hidden rounded-2xl/, "the frame clips what does not fit");
  // break-words alone leaves min-content at the longest word, which is what spilled out.
  assert.match(dialog, /overflow-wrap:anywhere/, "long unbroken names wrap instead of widening the dialog");
  const cancel = dialog.match(/variant=\{compact \? "outline" : "secondary"\}[\s\S]{0,600}?className=\{cn\(([\s\S]{0,300}?)\)\}/);
  assert.ok(cancel, "the cancel button is still rendered");
  assert.match(cancel[1] ?? "", /whitespace-normal/, "the cancel button inherits whitespace-nowrap from Button");
  assert.match(cancel[1] ?? "", /min-h-9/, "it grows instead of pushing the row wider");
});

test("the shared dialog header and footer may shrink inside the grid content", () => {
  const dialog = sourceOf("../src/components/ui/dialog.tsx");
  assert.match(dialog, /data-slot="dialog-header" className=\{cn\("flex min-w-0/, "grid items default to min-width:auto");
  assert.match(dialog, /"flex min-w-0 flex-col-reverse/, "same for the button row");
});
