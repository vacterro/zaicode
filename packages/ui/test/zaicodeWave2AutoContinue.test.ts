import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ZAICODE_AUTO_CONTINUE_MODES,
  nextZaicodeAutoContinueMode,
  zaicodeAutoContinueAllowed,
  type ZaicodeAutoContinueMode,
} from "@/zaicode/zaicodeAutoContinue.js";
import { planZaicodeCrashResume, type ZaicodeCrashResumeStep } from "@/zaicode/zaicodeCrashResume.js";
import type { ZaicodeSessionBrief } from "@/zaicode/zaicodeContinue.js";

/**
 * Wave 2, part C: per-session auto-continue. The decision that matters is
 * "may THIS session continue itself", so it lives in the pure planner and in
 * one resolver -- not in the global switch and not in a second global.
 */

function brief(overrides: Partial<ZaicodeSessionBrief> & { sessionId: string }): ZaicodeSessionBrief {
  return {
    projectKey: "p",
    workspacePath: "/w",
    title: overrides.sessionId,
    updatedAt: Date.now(),
    running: false,
    waiting: false,
    crashCut: true,
    ...overrides,
  } as ZaicodeSessionBrief;
}

const noProjects = () => null;

function installStorage(): Map<string, string> {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  });
  return values;
}

test("Wave 2 C: an explicit On / Off beats the global switch; Default follows it", () => {
  assert.equal(zaicodeAutoContinueAllowed("default", true), true);
  assert.equal(zaicodeAutoContinueAllowed("default", false), false);
  assert.equal(zaicodeAutoContinueAllowed(undefined, true), true, "a session with no decision follows the global");
  assert.equal(zaicodeAutoContinueAllowed("on", false), true, "On continues even when the global switch is off");
  assert.equal(zaicodeAutoContinueAllowed("off", true), false, "Off never continues, whatever the global says");
  assert.equal(zaicodeAutoContinueAllowed("off", false), false);
});

test("Wave 2 C: the three states walk in order and come back round", () => {
  let mode: ZaicodeAutoContinueMode = "default";
  const seen: ZaicodeAutoContinueMode[] = [mode];
  for (let i = 0; i < 3; i += 1) {
    mode = nextZaicodeAutoContinueMode(mode);
    seen.push(mode);
  }
  assert.deepEqual(seen, ["default", "on", "off", "default"]);
  assert.deepEqual([...ZAICODE_AUTO_CONTINUE_MODES], ["default", "on", "off"]);
});

test("Wave 2 C: the planner drops only the sessions that said Off", () => {
  const sessions = [brief({ sessionId: "inherits" }), brief({ sessionId: "forced" }), brief({ sessionId: "silent" })];
  const modes: Record<string, ZaicodeAutoContinueMode> = { forced: "on", silent: "off" };
  // Global switch on: Default inherits it, On is in, Off is out.
  const allowed = (sessionId: string) => zaicodeAutoContinueAllowed(modes[sessionId], true);

  const steps = planZaicodeCrashResume(sessions, noProjects, Date.now(), 12, allowed);
  assert.deepEqual(
    steps.map((step) => step.sessionId).sort(),
    ["forced", "inherits"],
    "a session left on Default follows the global switch; Off is out; On is in",
  );
  // Global switch off: the same three sessions, only the explicit On survives.
  const offAllowed = (sessionId: string) => zaicodeAutoContinueAllowed(modes[sessionId], false);
  assert.deepEqual(
    planZaicodeCrashResume(sessions, noProjects, Date.now(), 12, offAllowed).map((step) => step.sessionId),
    ["forced"],
  );
});

test("Wave 2 C: with the global switch off, only an explicit On is continued", () => {
  const sessions = [brief({ sessionId: "a" }), brief({ sessionId: "b" })];
  const steps = planZaicodeCrashResume(sessions, noProjects, Date.now(), 12, (id) => zaicodeAutoContinueAllowed(id === "b" ? "on" : "default", false));
  assert.deepEqual(steps.map((step: ZaicodeCrashResumeStep) => step.sessionId), ["b"]);
});

test("Wave 2 C: a per-session decision never overrides the other safety rules", () => {
  // "On" is permission, not a command: a stopped, live, waiting, stale or
  // disabled-project session is still not a candidate.
  const old = Date.now() - 40 * 3_600_000;
  const sessions = [
    brief({ sessionId: "operator-stopped", crashCut: false }),
    brief({ sessionId: "already-running", running: true }),
    brief({ sessionId: "waiting-on-a-human", waiting: true }),
    brief({ sessionId: "too-old", updatedAt: old }),
    brief({ sessionId: "project-disabled", projectKey: "off-project" }),
  ];
  const project = (key: string) => ({ hasSaipen: true, disabled: key === "off-project" });
  const steps = planZaicodeCrashResume(sessions, project, Date.now(), 12, () => true);
  assert.deepEqual(steps, [], "permission does not make an unsafe session a candidate");
});

test("Wave 2 C: a decision is per session and survives a restart, and Default is not a stored decision", async () => {
  const values = installStorage();
  const first = await import(`../src/zaicode/zaicodeAutoContinue.js?instance=${Date.now()}`);
  const store = first.useZaicodeAutoContinue.getState();
  assert.equal(store.modeFor("session-a"), "default");

  store.setMode("session-a", "off");
  store.setMode("session-b", "on");
  store.setMode("session-c", "default");

  const reloaded = (await import(`../src/zaicode/zaicodeAutoContinue.js?instance=${Date.now()}-b`)).useZaicodeAutoContinue.getState();
  assert.equal(reloaded.modeFor("session-a"), "off", "a decision survives a restart");
  assert.equal(reloaded.modeFor("session-b"), "on");
  assert.equal(reloaded.modeFor("session-c"), "default");
  assert.equal(reloaded.modeFor("session-d"), "default", "and does not leak into another session");
  assert.equal(reloaded.modeFor(""), "default");
  assert.ok(values.has("zaicode-auto-continue-v1"));

  // The global switch moving does not touch an explicit decision.
  assert.equal(zaicodeAutoContinueAllowed(reloaded.modeFor("session-a"), true), false);
  assert.equal(zaicodeAutoContinueAllowed(reloaded.modeFor("session-b"), false), true);
  assert.equal(zaicodeAutoContinueAllowed(reloaded.modeFor("session-c"), true), true, "Default follows the global");

  reloaded.clear("session-a");
  assert.equal(reloaded.modeFor("session-a"), "default", "clearing hands the session back to the global switch");
});
