import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { zaicodeQueueAutoSendAllowed, zaicodeQueueMayAutoResume, type ZaicodeQueueResumeFacts } from "../src/zaicode/zaicodeQueueAutoResume.js";
import { zaicodeEffectiveAutoRetry } from "../src/zaicode/zaicodeRetryPolicy.js";

// SRC-081: "The queue was paused because the response failed: none of the promised autonomy,
// no auto-continue in that case."

const facts = (patch: Partial<ZaicodeQueueResumeFacts> = {}): ZaicodeQueueResumeFacts => ({
  hasSession: true,
  queueItems: 1,
  autoDrain: false,
  pauseReason: "error",
  phase: "completedSuccess",
  quotaWall: false,
  mayAutoSend: true,
  attempts: 0,
  maxAttempts: 5,
  ...patch,
});

test("an error-paused queue resumes by itself when Auto allows it and the session is idle", () => {
  assert.equal(zaicodeQueueMayAutoResume(facts()), true);
});

test("it does not resume when a person stopped it, when it is running, empty or already draining", () => {
  assert.equal(zaicodeQueueMayAutoResume(facts({ pauseReason: "stopped" })), false, "the operator's Stop is never undone");
  assert.equal(zaicodeQueueMayAutoResume(facts({ pauseReason: null })), false);
  assert.equal(zaicodeQueueMayAutoResume(facts({ phase: "running" })), false);
  assert.equal(zaicodeQueueMayAutoResume(facts({ phase: "prewarming" })), false);
  assert.equal(zaicodeQueueMayAutoResume(facts({ queueItems: 0 })), false);
  assert.equal(zaicodeQueueMayAutoResume(facts({ autoDrain: true })), false);
  assert.equal(zaicodeQueueMayAutoResume(facts({ hasSession: false })), false);
});

test("the leash: Auto OFF, a usage-limit wall and a spent budget all keep it paused", () => {
  assert.equal(zaicodeQueueMayAutoResume(facts({ mayAutoSend: false })), false);
  assert.equal(zaicodeQueueMayAutoResume(facts({ quotaWall: true })), false);
  assert.equal(zaicodeQueueMayAutoResume(facts({ attempts: 5 })), false);
  assert.equal(zaicodeQueueMayAutoResume(facts({ attempts: 4 })), true);
});

test("the session pane runs the hook with the queue, the phase and the error class", () => {
  const pane = readFileSync(join(import.meta.dirname, "../src/v4/SessionPane.tsx"), "utf8");
  assert.match(pane, /useZaicodeQueueAutoResume\(\{/);
  assert.match(pane, /pauseReason: snapshot\?\.queue\.pauseReason \?\? null/);
  assert.match(pane, /resume: handleResumeQueue/);
  assert.match(pane, /zaicodeRetryClassOf\(controlLastError\) === "quota"/);
});

test("audit: the queue asks the same effective retry projection as every other automatic send", () => {
  const prefs = { autoRetry: false, autoRetryScope: "global" as const, autoRetryProjects: {} as Record<string, boolean>, autoRetrySessions: {} as Record<string, boolean> };
  // The pre-fix second gate (zaicodeMayAutoSend, deleted) let an explicit session On win even
  // with the retry preference off; the one effective projection does not.
  assert.equal(
    zaicodeEffectiveAutoRetry({ ...prefs, autoRetry: true }, "p", "s", { masterOn: true, sessionMode: "on", halted: false }).enabled,
    true,
    "the projection is what the queue asks, and it says yes here...",
  );
  assert.equal(
    zaicodeEffectiveAutoRetry(prefs, "p", "s", { masterOn: true, sessionMode: "on", halted: false }).enabled,
    false,
    "...unless the operator turned the retry preference off for this project/session/globally",
  );
  assert.equal(
    zaicodeQueueAutoSendAllowed({ enabled: true, halted: false, projectKey: "p", sessionId: "s", prefs, masterOn: true, sessionMode: "on" }),
    false,
    "the effective projection: an explicit retry OFF is honoured, session On included",
  );
  // An explicit per-project ON was invisible to the old global-only gate.
  assert.equal(
    zaicodeQueueAutoSendAllowed({ enabled: true, halted: false, projectKey: "p", sessionId: "s", prefs: { ...prefs, autoRetryProjects: { p: true } }, masterOn: true, sessionMode: undefined }),
    true,
  );
  // The leash is otherwise unchanged.
  assert.equal(zaicodeQueueAutoSendAllowed({ enabled: false, halted: false, projectKey: "p", sessionId: "s", prefs: { ...prefs, autoRetry: true }, masterOn: true, sessionMode: "on" }), false, "not the target surface");
  assert.equal(zaicodeQueueAutoSendAllowed({ enabled: true, halted: true, projectKey: "p", sessionId: "s", prefs: { ...prefs, autoRetry: true }, masterOn: true, sessionMode: "on" }), false, "one halt stops every automatic send");
  assert.equal(zaicodeQueueAutoSendAllowed({ enabled: true, halted: false, projectKey: "p", sessionId: "s", prefs: { ...prefs, autoRetry: true }, masterOn: true, sessionMode: "off" }), false, "an explicit session Off always wins");
  assert.equal(zaicodeQueueAutoSendAllowed({ enabled: true, halted: false, projectKey: "p", sessionId: "s", prefs: { ...prefs, autoRetry: true }, masterOn: false, sessionMode: undefined }), false, "Auto OFF");
  assert.equal(zaicodeQueueAutoSendAllowed({ enabled: true, halted: false, projectKey: "p", sessionId: "s", prefs: { ...prefs, autoRetry: true }, masterOn: false, sessionMode: "on" }), true, "a session set to On still continues itself");
});

test("audit wiring: the hook gates on the projector and the pane names the project", () => {
  const hook = readFileSync(join(import.meta.dirname, "../src/zaicode/zaicodeQueueAutoResume.js".replace(".js", ".ts")), "utf8");
  // A *call* to the old gate is what made the second answer; prose about it is fine.
  assert.doesNotMatch(hook, /zaicodeMayAutoSend\s*\(/, "the second answer to the same question is gone");
  assert.match(hook, /zaicodeEffectiveAutoRetry\(input\.prefs, input\.projectKey, input\.sessionId/);
  const pane = readFileSync(join(import.meta.dirname, "../src/v4/SessionPane.tsx"), "utf8");
  assert.match(pane, /useZaicodeQueueAutoResume\(\{[\s\S]{0,120}?projectKey: workspaceKey/);
});
