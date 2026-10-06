import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ZAICODE_UI_DEFAULT_PREFS, type ZaicodeUiPrefs } from "../src/zaicode/zaicodeUiPrefs.js";
import { zaicodeAutoRetryToggle, zaicodeEffectiveAutoRetry } from "../src/zaicode/zaicodeRetryPolicy.js";
import type { ZaicodeAutoContinueMode } from "../src/zaicode/zaicodeAutoContinue.js";

// SRC-162: "auto retry works badly and unpredictably" and "whatever I switch, the tooltip says
// off forever". The button flipped the bare preference while the sidebar Auto master (or the
// stop-all, or a session Off) held the effective answer off, so no click changed what it showed.

type Gate = { masterOn: boolean; sessionMode?: ZaicodeAutoContinueMode; halted: boolean };

function click(prefs: ZaicodeUiPrefs, gate: Gate): { prefs: ZaicodeUiPrefs; gate: Gate } {
  const effective = zaicodeEffectiveAutoRetry(prefs, "p", "s", gate);
  const toggle = zaicodeAutoRetryToggle(prefs, "p", "s", effective);
  return {
    prefs: { ...prefs, ...toggle.patch },
    gate: {
      ...gate,
      halted: toggle.resumeHalt ? false : gate.halted,
      sessionMode: toggle.clearSessionOff ? undefined : gate.sessionMode,
    },
  };
}

test("SRC-162: every click flips the effective answer, whatever held it off", () => {
  const preferences: Partial<ZaicodeUiPrefs>[] = [
    { autoRetry: true },
    { autoRetry: false },
    { autoRetry: false, autoRetryProjects: { p: true } },
    { autoRetry: true, autoRetryProjects: { p: false } },
    { autoRetry: true, autoRetrySessions: { s: false } },
  ];
  const gates: Gate[] = [];
  for (const masterOn of [false, true]) {
    for (const halted of [false, true]) {
      for (const sessionMode of [undefined, "on", "off"] as const) gates.push({ masterOn, halted, sessionMode });
    }
  }
  for (const preference of preferences) {
    for (const gate of gates) {
      let state = { prefs: { ...ZAICODE_UI_DEFAULT_PREFS, ...preference }, gate };
      let shown = zaicodeEffectiveAutoRetry(state.prefs, "p", "s", state.gate).enabled;
      for (let index = 0; index < 4; index += 1) {
        state = click(state.prefs, state.gate);
        const now = zaicodeEffectiveAutoRetry(state.prefs, "p", "s", state.gate).enabled;
        assert.equal(now, !shown, `click ${index + 1} must flip ${JSON.stringify({ preference, gate })}`);
        shown = now;
      }
    }
  }
});

test("SRC-162: an explicit project ON is not hidden by the sidebar Auto master; the inherited global is", () => {
  const base = { ...ZAICODE_UI_DEFAULT_PREFS, autoRetry: true };
  const off = { masterOn: false, halted: false };
  assert.equal(zaicodeEffectiveAutoRetry(base, "p", "s", off).block, "master-off");
  const pinned = { ...base, autoRetryProjects: { p: true } };
  assert.equal(zaicodeEffectiveAutoRetry(pinned, "p", "s", off).enabled, true);
  assert.equal(zaicodeEffectiveAutoRetry(pinned, "other", "s", off).enabled, false, "other projects keep inheriting");
  assert.equal(zaicodeEffectiveAutoRetry(pinned, "p", "s", { ...off, halted: true }).enabled, false, "stop-all still wins");
  assert.equal(zaicodeEffectiveAutoRetry(pinned, "p", "s", { ...off, sessionMode: "off" }).enabled, false, "a session Off still wins");
});

test("SRC-162: turning ON while only inherited writes a project override, never the global flag", () => {
  const prefs = { ...ZAICODE_UI_DEFAULT_PREFS, autoRetry: true };
  const effective = zaicodeEffectiveAutoRetry(prefs, "p", "s", { masterOn: false, halted: false });
  const toggle = zaicodeAutoRetryToggle(prefs, "p", "s", effective);
  assert.deepEqual(toggle.patch, { autoRetryProjects: { p: true } });
  assert.equal(toggle.next, true);
});

test("SRC-162: the pane banner and the button read one block", () => {
  const pane = readFileSync(new URL("../src/zaicode/zaicodeAutoRetry.ts", import.meta.url), "utf8");
  assert.match(pane, /effective\.block === "session-off" \|\| effective\.block === "master-off"/);
  assert.doesNotMatch(pane, /\(!masterOn && sessionMode !== "on"\)/, "no second derivation of the master gate");
});

test("SRC-162: a double-click on a panel edge never snaps the panel back to its default size", () => {
  const source = readFileSync(new URL("../src/components/ui/resizable.tsx", import.meta.url), "utf8");
  assert.match(source, /function ResizableHandle\(\{ className, disableDoubleClick = true, \.\.\.props \}/);
  assert.match(source, /disableDoubleClick=\{disableDoubleClick\}/);
});

test("SRC-162: two quota pools of one shared account never render as duplicate rows", async () => {
  const { zaicodeWindowFromShared } = await import("@zcode/shared");
  const at = (quotaBucket: string, label: string, vendor?: string) =>
    zaicodeWindowFromShared({ kind: label === "5h" ? "five_hour" : "weekly", label, remainingFraction: 0.5, resetTime: null, quotaBucket }, vendor);
  assert.equal(at("0", "weekly", "antigravity").label, "Gemini weekly");
  assert.equal(at("1", "weekly", "antigravity").label, "Claude & GPT weekly");
  assert.equal(at("1", "5h", "antigravity").label, "Claude & GPT 5h");
  assert.equal(at("0", "5h", "codex").label, "5h", "a single-pool vendor keeps the bare label");
  assert.equal(at("1", "5h", "codex").label, "Pool 2 5h");
  const labels = ["0", "1"].flatMap((pool) => ["weekly", "5h"].map((label) => at(pool, label, "antigravity").label));
  assert.equal(new Set(labels).size, labels.length);
});

test("SRC-162: a hint never anchors to a trigger without a box (no top-left corner tooltips)", async () => {
  const { controlHintTriggerHasBox } = await import("../src/ControlHintTooltip.js");
  const box = (width: number, height: number, isConnected = true) => ({
    isConnected,
    getBoundingClientRect: () => ({ width, height }) as DOMRect,
  });
  assert.equal(controlHintTriggerHasBox(box(24, 24)), true);
  assert.equal(controlHintTriggerHasBox(box(0, 0)), false, "display:none hover-only row action");
  assert.equal(controlHintTriggerHasBox(box(24, 24, false)), false, "detached trigger");
  const source = readFileSync(new URL("../src/ControlHintTooltip.tsx", import.meta.url), "utf8");
  assert.match(source, /hideWhenDetached/);
  assert.match(source, /new ResizeObserver\(check\)/, "an open hint closes when its trigger loses its box");
});

test("SRC-162: a live-run hint expires on the clock even while the project's index stays quiet", async () => {
  const live = await import("../src/zaicode/zaicodeLiveRuns.js");
  live.useZaicodeLiveRuns.setState({ runs: {} });
  live.setZaicodeLiveRun("s-quiet", "V:/proj", true);
  const since = live.useZaicodeLiveRuns.getState().runs["s-quiet"]!.since;
  const other = [{ taskId: "unrelated" }] as never;
  live.reconcileZaicodeLiveRuns(other, since + live.ZAICODE_LIVE_RUN_INDEX_GRACE_MS - 1);
  assert.ok(live.useZaicodeLiveRuns.getState().runs["s-quiet"], "inside the grace window the hint holds");
  live.reconcileZaicodeLiveRuns(other, since + live.ZAICODE_LIVE_RUN_INDEX_GRACE_MS + 1);
  assert.equal(live.useZaicodeLiveRuns.getState().runs["s-quiet"], undefined, "after it, the hint is gone");
  assert.ok(live.ZAICODE_LIVE_RUN_RECONCILE_MS < live.ZAICODE_LIVE_RUN_INDEX_GRACE_MS);
  const sidebar = readFileSync(new URL("../src/WorkspaceSidebar.tsx", import.meta.url), "utf8");
  assert.match(sidebar, /window\.setInterval\(\s*\(\) => reconcileZaicodeLiveRuns\(tasks\),\s*ZAICODE_LIVE_RUN_RECONCILE_MS,/);
});

test("SRC-162: the composer + never sits alone on a blank row", () => {
  const editor = readFileSync(new URL("../src/prompt-editor/ChatPromptEditor.tsx", import.meta.url), "utf8");
  const trailing = /className="([^"]*)"\s*data-composer-trailing-actions/.exec(editor);
  assert.ok(trailing, "the trailing cluster must exist");
  assert.match(trailing![1], /(^|\s)flex-1(\s|$)/, "it takes the rest of the + line");
  assert.match(trailing![1], /(^|\s)min-w-0(\s|$)/, "it may shrink, so it never drops to a new line whole");
  assert.doesNotMatch(trailing![1], /(^|\s)shrink-0(\s|$)/);
  const hook = readFileSync(new URL("../src/prompt-editor/useComposerToolbarFit.ts", import.meta.url), "utf8");
  assert.match(hook, /sameRow: sameRow\(\) && !trailingWraps\(\)/, "an internal wrap still drives the compaction ladder");
});

test("SRC-162: the anchored hover card (limits) stacks above the page", () => {
  const card = readFileSync(new URL("../src/zaicode/ZaicodeAnchoredCard.tsx", import.meta.url), "utf8");
  assert.match(card, /"pointer-events-none fixed z-50 /);
});
