import assert from "node:assert/strict";
import { test } from "node:test";
import {
  shouldAutoDrainV4QueueHead,
  zaicodeQueueDrainsPastGoal,
} from "../src/zcode-protocol-v4/queue-auto-drain.js";

const idle = { autoDrain: true, dispatchState: "queued" as const, sessionBusy: false };

test("upstream keeps the queue behind an unfinished goal", () => {
  assert.equal(shouldAutoDrainV4QueueHead({ ...idle, targetStatus: "active" }), false);
  assert.equal(shouldAutoDrainV4QueueHead({ ...idle, targetStatus: "paused" }), false);
  assert.equal(shouldAutoDrainV4QueueHead({ ...idle, targetStatus: "complete" }), true);
  assert.equal(shouldAutoDrainV4QueueHead({ ...idle, targetStatus: null }), true);
});

test("ZAICODE: a queued input on an idle session runs even while a goal is active or paused (SRC-044)", () => {
  for (const targetStatus of ["active", "paused", "budget_limited"] as const) {
    assert.equal(shouldAutoDrainV4QueueHead({ ...idle, targetStatus, drainPastGoal: true }), true, targetStatus);
  }
});

test("ZAICODE still never drains into a busy session or a queue the operator paused", () => {
  assert.equal(shouldAutoDrainV4QueueHead({ ...idle, sessionBusy: true, targetStatus: "active", drainPastGoal: true }), false);
  assert.equal(shouldAutoDrainV4QueueHead({ ...idle, autoDrain: false, targetStatus: null, drainPastGoal: true }), false);
  assert.equal(
    shouldAutoDrainV4QueueHead({ ...idle, dispatchState: "reserved", targetStatus: null, drainPastGoal: true }),
    false,
  );
});

test("the drain-past-goal switch follows ZAICODE mode", () => {
  assert.equal(zaicodeQueueDrainsPastGoal({ ZCODE_ZAICODE_MODE: "1" } as NodeJS.ProcessEnv), true);
  assert.equal(zaicodeQueueDrainsPastGoal({} as NodeJS.ProcessEnv), false);
});
