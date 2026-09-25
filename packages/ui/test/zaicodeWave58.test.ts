import assert from "node:assert/strict";
import test from "node:test";
import { isZaicodeMetricsOnlyAccount, parseFreebuffSession, zaicodeBottleneck, type ZCodeTaskMeta } from "@zcode/shared";
import { nextZaicodeCombo } from "../src/zaicode/zaicodeCombo.js";
import {
  ZAICODE_HIGHLIGHT_DEFAULTS,
  ZAICODE_WORKING_COMBO_TRANSFORM,
  ZAICODE_WORKING_ICON_DEFAULTS,
  normalizeZaicodeLights,
  zaicodeHighlightAttrs,
  zaicodeWorkingIconStyle,
  zaicodeWorkingMotionsReach,
} from "../src/zaicode/zaicodeHighlights.js";
import { ZAICODE_MOTION_CSS } from "../src/zaicode/zaicodeMotionCss.js";
import { ZAICODE_CRISP_CSS } from "../src/zaicode/zaicodePalettes.js";
import {
  decideZaicodeSessionContinue,
  nextZaicodeDoneSession,
  planZaicodeContinueAll,
  zaicodeDoneUnseen,
  zaicodeSessionBriefOf,
  type ZaicodeContinueProject,
  type ZaicodeSessionBrief,
} from "../src/zaicode/zaicodeContinue.js";
import { useZaicodeSessionNav } from "../src/zaicode/zaicodeSessionNav.js";
import { assembleZaicodeProjectRuntime } from "../src/zaicode/zaicodeProjectRuntime.js";
import { zaicodeProductivityColor } from "../src/zaicode/ZaicodeTopbarClock.js";

type Style = Record<string, unknown>;

// --- Shift-combining --------------------------------------------------------

test("combo: click picks one, Shift adds / removes, the neutral value clears, the last one stays", () => {
  assert.deepEqual(nextZaicodeCombo(["pulse"], "blink", false, { neutral: "steady" }), ["blink"]);
  assert.deepEqual(nextZaicodeCombo(["pulse"], "blink", true, { neutral: "steady" }), ["pulse", "blink"]);
  assert.deepEqual(nextZaicodeCombo(["pulse", "blink"], "pulse", true, { neutral: "steady" }), ["blink"]);
  assert.deepEqual(nextZaicodeCombo(["blink"], "blink", true, { neutral: "steady" }), ["steady"], "taking out the last falls back to neutral");
  assert.deepEqual(nextZaicodeCombo(["steady"], "flicker", true, { neutral: "steady" }), ["flicker"], "neutral never mixes");
  assert.deepEqual(nextZaicodeCombo(["pulse", "blink"], "steady", true, { neutral: "steady" }), ["steady"]);
  assert.deepEqual(nextZaicodeCombo(["glow"], "glow", true), ["glow"], "no neutral: the last one cannot be taken out");
  assert.deepEqual(nextZaicodeCombo(["a", "b", "c"], "d", true, { max: 3 }), ["b", "c", "d"], "the oldest drops out beyond max");
});

// --- highlights: mixes -------------------------------------------------------

test("highlights: several effects run together on their own channels; shapes draw together", () => {
  const rule = { ...ZAICODE_HIGHLIGHT_DEFAULTS.sessionWorking, enabled: true, effects: ["pulse" as const, "flicker" as const], shapes: ["glow" as const, "box" as const], seconds: 2 };
  const lights = zaicodeHighlightAttrs("sessionWorking", rule)!;
  assert.equal((lights.style as Style)["--zh-anim"], "zh-pulse 2s ease-in-out infinite, zh-flicker 2s ease-in-out infinite");
  assert.equal(lights["data-zh-shape"], "glow box");
  // The CSS multiplies every effect channel into --zh-k and matches shapes one by one.
  assert.match(ZAICODE_MOTION_CSS, /@property --zh-e-pulse \{ syntax: "<number>"; inherits: false; initial-value: 1; \}/);
  assert.match(ZAICODE_MOTION_CSS, /--zh-k: calc\(var\(--zh-e-pulse\) \* var\(--zh-e-breathe\) \* var\(--zh-e-heartbeat\) \* var\(--zh-e-blink\) \* var\(--zh-e-strobe\) \* var\(--zh-e-flicker\)\)/);
  assert.match(ZAICODE_MOTION_CSS, /@keyframes zh-flicker \{ 0% \{ --zh-e-flicker: 1; \}/);
  assert.doesNotMatch(ZAICODE_MOTION_CSS, /@keyframes zh-[a-z]+ \{[^}]*--zh-k:/, "no effect writes --zh-k directly any more");
  assert.match(ZAICODE_MOTION_CSS, /\[data-zh-shape~="box"\]/);
  // Underline and side bar share box-shadow: one declaration carries both.
  assert.match(ZAICODE_MOTION_CSS, /box-shadow: var\(--zh-underline, 0 0 transparent\), var\(--zh-bar, 0 0 transparent\) !important/);
});

test("highlights: a pre-SRC-043 single effect / shape is read as a one-item mix; steady never mixes", () => {
  const lights = normalizeZaicodeLights({
    highlights: {
      sessionWaiting: { effect: "blink", shape: "underline" },
      sessionOpen: { effects: ["steady", "pulse", "pulse", "disco"], shapes: [] },
    },
    working: { image: "orbit", motion: "blink" },
  });
  assert.deepEqual(lights.highlights.sessionWaiting.effects, ["blink"]);
  assert.deepEqual(lights.highlights.sessionWaiting.shapes, ["underline"]);
  assert.deepEqual(lights.highlights.sessionOpen.effects, ["pulse"], "duplicates, unknown ids and steady-in-a-mix drop out");
  assert.deepEqual(lights.highlights.sessionOpen.shapes, ZAICODE_HIGHLIGHT_DEFAULTS.sessionOpen.shapes, "an empty shape list falls back");
  assert.deepEqual(lights.working.images, ["orbit"]);
  assert.deepEqual(lights.working.motions, ["blink"]);
  const stack = normalizeZaicodeLights({ working: { images: ["saipen", "orbit", "cog", "fan"], motions: ["none", "spin"] } }).working;
  assert.deepEqual(stack.images, ["orbit", "cog", "fan"], "at most three stacked pictures, newest kept");
  assert.deepEqual(stack.motions, ["spin"]);
});

// --- Working icon: opacity, reach, mixes ------------------------------------

test("working icon: the Opacity slider survives blink and breathe (it is a filter, not the animated property)", () => {
  for (const motion of ["blink", "breathe"] as const) {
    const style = zaicodeWorkingIconStyle({ ...ZAICODE_WORKING_ICON_DEFAULTS, motions: [motion], opacity: 25 }) as Style;
    assert.equal(style.opacity, undefined, `${motion}: the animated opacity property is left to the keyframes`);
    assert.equal(style.filter, "opacity(0.25)", `${motion}: the resting opacity still applies`);
  }
  const glowing = zaicodeWorkingIconStyle({ ...ZAICODE_WORKING_ICON_DEFAULTS, opacity: 50, glow: true, amplitude: 50 }) as Style;
  assert.equal(glowing.filter, "opacity(0.5) drop-shadow(0 0 3px var(--zw-color))");
  const full = zaicodeWorkingIconStyle(ZAICODE_WORKING_ICON_DEFAULTS) as Style;
  assert.equal(full.filter, undefined, "100 % adds nothing");
});

test("working icon: Reach sets how dark blink goes, and the slider is offered for blink", () => {
  assert.equal((zaicodeWorkingIconStyle({ ...ZAICODE_WORKING_ICON_DEFAULTS, motions: ["blink"], amplitude: 5 }) as Style)["--zw-blink-low"], "0.95");
  assert.equal((zaicodeWorkingIconStyle({ ...ZAICODE_WORKING_ICON_DEFAULTS, motions: ["blink"], amplitude: 100 }) as Style)["--zw-blink-low"], "0");
  assert.match(ZAICODE_MOTION_CSS, /@keyframes zw-blink \{ 0%, 49\.9% \{ opacity: 1; \} 50%, 100% \{ opacity: var\(--zw-blink-low, 0\.15\); \} \}/);
  assert.equal(zaicodeWorkingMotionsReach(["blink"]), true);
  assert.equal(zaicodeWorkingMotionsReach(["spin"]), false);
  assert.equal(zaicodeWorkingMotionsReach(["spin", "pulse"]), true);
});

test("working icon: mixed motions animate their own channels and one transform reads them all", () => {
  const style = zaicodeWorkingIconStyle({ ...ZAICODE_WORKING_ICON_DEFAULTS, motions: ["spin", "pulse", "blink"], seconds: 3 }) as Style;
  assert.equal(style["--zw-anim"], "zwc-spin 3s linear infinite normal, zwc-pulse 3s ease-in-out infinite normal, zwc-blink 3s ease-in-out infinite normal");
  assert.equal(style.transform, ZAICODE_WORKING_COMBO_TRANSFORM);
  assert.equal(style.opacity, "calc(var(--zw-o1) * var(--zw-o2))");
  for (const channel of ["--zw-r1", "--zw-s", "--zw-o2", "--zw-ty", "--zw-ry"]) {
    assert.match(ZAICODE_MOTION_CSS, new RegExp(`@property ${channel} \\{`));
  }
  const single = zaicodeWorkingIconStyle({ ...ZAICODE_WORKING_ICON_DEFAULTS, motions: ["spin"] }) as Style;
  assert.equal(single.transform, undefined, "one motion keeps the plain (compositor) keyframes");
});

// --- clock colours and black-on-black ------------------------------------------------

test("clock: FastPrompter's countdown colours; body text never falls back to black", () => {
  assert.equal(zaicodeProductivityColor({ phase: "work", state: "running", alarmPending: false }), "#6aa9ff");
  assert.equal(zaicodeProductivityColor({ phase: "break", state: "running", alarmPending: false }), "#e0a03c");
  assert.equal(zaicodeProductivityColor({ phase: "work", state: "paused", alarmPending: false }), "#888888");
  assert.equal(zaicodeProductivityColor({ phase: "work", state: "running", alarmPending: true }), "#e05555");
  assert.match(ZAICODE_CRISP_CSS, /html\.zaicode-fonts body \{\s*color: var\(--color-foreground\);/);
});

// --- continue / done ------------------------------------------------------------------

function brief(patch: Partial<ZaicodeSessionBrief> & { sessionId: string; projectKey: string }): ZaicodeSessionBrief {
  return {
    title: patch.sessionId,
    workspacePath: `C:/p/${patch.projectKey}`,
    running: false,
    waiting: false,
    failed: false,
    unreadAt: null,
    goalStatus: null,
    goalObjective: null,
    ...patch,
  };
}

function project(patch: Partial<ZaicodeContinueProject> & { key: string }): ZaicodeContinueProject {
  return { name: patch.key, disabled: false, hasSaipen: true, state: "done", mainSessionId: null, ...patch };
}

test("continue one session: goal taken up again, cc / continue, a waiting one opens, a running one is left", () => {
  const goal = decideZaicodeSessionContinue(brief({ sessionId: "s", projectKey: "a", goalStatus: "paused", goalObjective: "cc all" }), true);
  assert.deepEqual(goal, { action: "send", command: { kind: "goal", objective: "cc all" }, why: "its goal was stopped" });
  assert.deepEqual(decideZaicodeSessionContinue(brief({ sessionId: "s", projectKey: "a" }), true), {
    action: "send",
    command: { kind: "text", text: "cc" },
    why: "continue where it stopped",
  });
  const plain = decideZaicodeSessionContinue(brief({ sessionId: "s", projectKey: "a", goalStatus: "complete", goalObjective: "x" }), false);
  assert.deepEqual(plain.action === "send" ? plain.command : null, { kind: "text", text: "continue" }, "a finished goal is not re-run");
  assert.equal(decideZaicodeSessionContinue(brief({ sessionId: "s", projectKey: "a", waiting: true }), true).action, "open");
  assert.equal(decideZaicodeSessionContinue(brief({ sessionId: "s", projectKey: "a", running: true }), true).action, "none");
});

test("CONTINUE ALL: stopped goals and failed turns, SAIPEN work via MAIN or a new MAIN; finished / off / waiting left alone", () => {
  const plan = planZaicodeContinueAll(
    [
      project({ key: "goal" }),
      project({ key: "failed", hasSaipen: false, state: null }),
      project({ key: "open", state: "pending", mainSessionId: "m1" }),
      project({ key: "fresh", state: "pending" }),
      project({ key: "off", disabled: true, state: "pending" }),
      project({ key: "done" }),
      project({ key: "busy", state: "pending", mainSessionId: "m2" }),
    ],
    [
      brief({ sessionId: "g1", projectKey: "goal", goalStatus: "paused", goalObjective: "cc all" }),
      brief({ sessionId: "g2", projectKey: "goal", goalStatus: "budget_limited", goalObjective: "x" }),
      brief({ sessionId: "f1", projectKey: "failed", failed: true }),
      brief({ sessionId: "w1", projectKey: "failed", waiting: true, failed: true }),
      brief({ sessionId: "m1", projectKey: "open", goalStatus: "complete", goalObjective: "cc all" }),
      brief({ sessionId: "o1", projectKey: "off", goalStatus: "paused", goalObjective: "cc all" }),
      brief({ sessionId: "d1", projectKey: "done", unreadAt: 5 }),
      brief({ sessionId: "m2", projectKey: "busy", running: true }),
    ],
  );
  const summary = plan.steps.map((step) =>
    step.kind === "start"
      ? `start:${step.projectKey}:${step.command.kind === "goal" ? step.command.objective : ""}`
      : `${step.sessionId}:${step.command.kind === "goal" ? `goal ${step.command.objective}` : step.command.text}`,
  );
  assert.deepEqual(summary, ["g1:goal cc all", "f1:continue", "m1:goal cc all", "start:fresh:cc all"]);
  assert.deepEqual(plan.skipped, [
    { name: "failed", why: "1 session(s) wait for your answer" },
    { name: "off", why: "switched off" },
  ]);
});

test("DONE: finished, unseen, oldest first; the open one is skipped; opening marks it seen", () => {
  const sessions = [
    brief({ sessionId: "new", projectKey: "a", unreadAt: 300, title: "b" }),
    brief({ sessionId: "old", projectKey: "a", unreadAt: 100 }),
    brief({ sessionId: "seen", projectKey: "a" }),
    brief({ sessionId: "work", projectKey: "a", unreadAt: 50, running: true }),
    brief({ sessionId: "err", projectKey: "a", unreadAt: 40, failed: true }),
    brief({ sessionId: "ask", projectKey: "a", unreadAt: 30, waiting: true }),
  ];
  const done = zaicodeDoneUnseen(sessions);
  assert.deepEqual(done.map((session) => session.sessionId), ["old", "new"]);
  assert.equal(nextZaicodeDoneSession(done, null)?.sessionId, "old");
  assert.equal(nextZaicodeDoneSession(done, "old")?.sessionId, "new");
  assert.equal(nextZaicodeDoneSession([], null), null);
});

test("session brief: live phase decides failed; the goal comes from the task's target", () => {
  const task = {
    taskId: "t1",
    title: "",
    status: "error",
    unreadAt: 7,
    target: { status: "paused", objective: " cc all " },
  } as unknown as ZCodeTaskMeta;
  const facts = zaicodeSessionBriefOf(task, "k", { workspacePath: "C:/p" });
  assert.equal(facts.failed, true, "no live activity: the persisted status decides");
  assert.equal(facts.title, "t1");
  assert.equal(facts.unreadAt, 7);
  assert.equal(facts.goalStatus, "paused");
  assert.equal(facts.goalObjective, "cc all");
  assert.equal(facts.running, false);
});

// --- sidebar lag: stable publications -----------------------------------------------

test("session nav: an unchanged waiting / recent list keeps its identity (no re-render storm)", () => {
  const nav = useZaicodeSessionNav.getState();
  nav.publish({ waiting: [{ sessionId: "a", title: "A", workspacePath: "C:/p" }], recent: [] });
  const before = useZaicodeSessionNav.getState().waiting;
  useZaicodeSessionNav.getState().publish({ waiting: [{ sessionId: "a", title: "A", workspacePath: "C:/p" }], activeTaskId: "x" });
  assert.equal(useZaicodeSessionNav.getState().waiting, before, "same content, same array");
  assert.equal(useZaicodeSessionNav.getState().activeTaskId, "x", "other fields still update");
  useZaicodeSessionNav.getState().publish({ waiting: [{ sessionId: "a", title: "A2", workspacePath: "C:/p" }] });
  assert.notEqual(useZaicodeSessionNav.getState().waiting, before, "a real change still lands");
});

test("project runtime from lists still counts this project's sessions and live workers only", () => {
  const snapshot = assembleZaicodeProjectRuntime({
    projectPath: "C:\\P\\One",
    saipen: null,
    running: [{ workspacePath: "c:/p/one/" }, { workspacePath: "C:/P/Two" }],
    waiting: [{ workspacePath: "C:/P/One" }],
    workers: [
      { projectPath: "C:/P/One", exitCode: null },
      { projectPath: "C:/P/One", exitCode: 0 },
    ],
  });
  assert.deepEqual(snapshot.sessions, { running: 1, waiting: 1 });
  assert.deepEqual(snapshot.workers, { running: 1 });
});

// --- Freebuff: metrics only -------------------------------------------------------

test("Freebuff: Freebucks day pool is REMAINING of limit; wallet goes to the plan line; legacy pools stay apart", () => {
  const freebucks = parseFreebuffSession({
    freebucks: { planId: "starter", daily: { remaining: 42, limit: 105, resetAt: "2026-09-25T21:00:00.000Z" }, wallet: { balance: 15 } },
  });
  assert.equal(freebucks.error, null);
  assert.equal(freebucks.plan, "starter · 42/105 FB today · wallet 15 FB");
  assert.equal(freebucks.windows.length, 1);
  assert.equal(Math.round(freebucks.windows[0]!.remainingPercent! * 10) / 10, 40);
  assert.equal(freebucks.windows[0]!.resetsAt, Date.parse("2026-09-25T21:00:00.000Z"));

  const legacy = parseFreebuffSession({
    subscription: { tierId: "pro", usage: { dayUsed: 10, dayLimit: 10, monthUsed: 5, monthLimit: 100 } },
    freeWindows: { dayUsed: 1, dayLimit: 4, weekUsed: 1, weekLimit: 10 },
  });
  assert.deepEqual(legacy.windows.map((window) => window.key), ["day@plan", "month@plan", "day@free", "week@free"]);
  assert.equal(legacy.plan, "pro");
  // A spent plan pool does not zero the free one: the engine is as good as its best pool.
  assert.equal(zaicodeBottleneck(legacy.windows)?.group, "free");

  assert.match(parseFreebuffSession({ status: "ok" }).error ?? "", /neither Freebucks nor session quota/);
  assert.match(parseFreebuffSession(null).error ?? "", /did not return an object/);
  assert.equal(parseFreebuffSession({ freebucks: { daily: { remaining: 5, limit: 0 } } }).windows.length, 0, "a zero limit is not a quota");
});

test("Freebuff is measured, never launched", () => {
  assert.equal(isZaicodeMetricsOnlyAccount({ vendor: "freebuff" }), true);
  assert.equal(isZaicodeMetricsOnlyAccount({ vendor: "claude" }), false);
});

// --- profiles keep everything of their own ---------------------------------------------

test("profiles: a bundle captures every preference (null = unset), restores it, and never carries live facts", async () => {
  const { ZAICODE_PROFILE_KEYS, applyZaicodeProfileBundle, captureZaicodeProfileBundle, parseZaicodeProfileBundle } = await import(
    "../src/zaicode/zaicodeProfileBundles.js"
  );
  const store = new Map<string, string>([
    ["zaicode-palette", "amber"],
    ["zcode-theme", "dark"],
    ["zaicode-hotkeys-v1", "{\"a\":1}"],
    ["zaicode-main-sessions-v1", "{\"byWorkspace\":{}}"],
  ]);
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  const bundle = captureZaicodeProfileBundle(storage);
  assert.equal(bundle.values["zaicode-palette"], "amber");
  assert.equal(bundle.values["zcode-theme"], "dark", "upstream appearance travels with the profile");
  assert.equal(bundle.values["zaicode-lights-v1"], null, "an unset preference is recorded as unset");
  for (const live of ["zaicode-main-sessions-v1", "zaicode-timers-v1", "zaicode-autostart-v1", "zaicode-profiles", "zaicode-todo-progress-v2"]) {
    assert.equal(ZAICODE_PROFILE_KEYS.includes(live), false, `${live} is shared by every profile`);
  }
  // The other profile: different palette, no hotkeys of its own.
  store.set("zaicode-palette", "green");
  store.delete("zcode-theme");
  const other = captureZaicodeProfileBundle(storage);
  applyZaicodeProfileBundle(storage, bundle);
  assert.equal(store.get("zaicode-palette"), "amber");
  assert.equal(store.get("zcode-theme"), "dark");
  assert.equal(store.get("zaicode-main-sessions-v1"), "{\"byWorkspace\":{}}", "live facts are untouched");
  applyZaicodeProfileBundle(storage, other);
  assert.equal(store.get("zaicode-palette"), "green");
  assert.equal(store.has("zcode-theme"), false, "unset in that profile = removed, the default applies");
  assert.deepEqual(parseZaicodeProfileBundle(JSON.stringify(bundle)), bundle);
  assert.equal(parseZaicodeProfileBundle("{\"version\":2,\"values\":{}}"), null);
  assert.equal(parseZaicodeProfileBundle("not json"), null);
});
