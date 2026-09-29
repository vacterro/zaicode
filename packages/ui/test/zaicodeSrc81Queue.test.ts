import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { zaicodeQueueMayAutoResume, type ZaicodeQueueResumeFacts } from "../src/zaicode/zaicodeQueueAutoResume.js";

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
