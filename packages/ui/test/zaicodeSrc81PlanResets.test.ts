import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { zaicodePlanResetOpportunity } from "../src/zaicode/ZaicodeCodingPlanResets.js";

// SRC-081: "show the resets for ZCode Coding Plans too, and let me reset right from there".

const source = (path: string) => readFileSync(join(import.meta.dirname, "../src", path), "utf8");
const controller = (count: number, visible = true, processing = false, expiresAt: number | null = 5_000) => ({
  entry: { status: "available", opportunityCount: count, opportunityExpiresAt: expiresAt, startedAt: null, completedAt: null, observedAt: null, quotaOverridePending: false, nextResetAt: null, idempotencyKey: null, error: null } as never,
  opportunityVisible: visible,
  processing,
});

test("an opportunity is listed with its count and expiry, and only while one exists", () => {
  const listed = zaicodePlanResetOpportunity("session", controller(2), false);
  assert.deepEqual(listed, { kind: "session", count: 2, expiresAt: 5_000, processing: false, quotaFull: false });
  assert.equal(zaicodePlanResetOpportunity("weekly", controller(0), false), null, "none left: nothing listed");
  assert.equal(zaicodePlanResetOpportunity("weekly", controller(3, false), false), null, "the server says it is not offered");
  assert.equal(zaicodePlanResetOpportunity("session", controller(1, true, true), false)?.processing, true);
  assert.equal(zaicodePlanResetOpportunity("session", controller(1), true)?.quotaFull, true, "a full window gains nothing from a reset");
});

test("the title-bar reset timer carries the plan resets, and a reset is asked for before it is spent", () => {
  const timer = source("zaicode/ZaicodeResetTimer.tsx");
  assert.match(timer, /useZaicodePlanResets\(\)/);
  assert.match(timer, /<ZaicodePlanResetsSection resets=\{planResets\} now=\{now\} \/>/);
  assert.match(timer, /data-zaicode-plan-resets-badge/);
  assert.match(timer, /planResets\.total === 0\) return null/, "the timer shows for a plan with resets even when no other limit row exists");
  const plan = source("zaicode/ZaicodeCodingPlanResets.tsx");
  // ZCode's own controller does the reset; nothing is re-implemented here.
  assert.match(plan, /useCodingPlanQuotaResetUi\(\{/);
  assert.match(plan, /resetUi\.week\.reset\(\)/);
  // T-128: the app's own confirmation dialog replaced the operating system's; it is still asked before the reset is spent.
  const confirmAt = plan.indexOf("requestConfirmation({");
  const resetAt = plan.indexOf("await resets.reset(kind)");
  assert.ok(confirmAt > 0 && resetAt > confirmAt, "confirm comes first");
});
