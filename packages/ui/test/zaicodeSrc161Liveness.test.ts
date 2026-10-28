import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { attachTaskListRowActivity } from "../src/v4/taskListRowActivity.js";
import {
  ZAICODE_LIVE_RUN_INDEX_GRACE_MS,
  reconcileZaicodeLiveRuns,
  setZaicodeLiveRun,
  useZaicodeLiveRuns,
} from "../src/zaicode/zaicodeLiveRuns.js";

// SRC-161:REQ-006 — "project looks like it is still working, but it is not, without ever
// opening the project". The open chat's live-run hint (SRC-048) is a *hint*, and before this
// change it was trusted until the sessions-index said otherwise; a runtime that died right
// after publishing the claim never moved the index again, so the row stayed "working" until
// an app restart. These cases pin the bounded contract.

afterEach(() => {
  useZaicodeLiveRuns.setState({ runs: {} });
});

function quietTask(taskId: string): ZCodeTaskMeta {
  return { taskId } as ZCodeTaskMeta;
}

function inactiveTask(taskId: string, lastActivityAt: number): ZCodeTaskMeta {
  return attachTaskListRowActivity(quietTask(taskId), {
    phase: "completedSuccess",
    lastActivityAt,
    hasBackgroundWork: false,
  });
}

function activeTask(taskId: string, lastActivityAt: number): ZCodeTaskMeta {
  return attachTaskListRowActivity(quietTask(taskId), {
    phase: "completedSuccess",
    lastActivityAt,
    hasBackgroundWork: true,
  });
}

function sinceOf(taskId: string): number {
  const run = useZaicodeLiveRuns.getState().runs[taskId];
  assert.ok(run, `${taskId} should carry a live-run hint`);
  return run.since;
}

test("REQ-006: the index has been heard from and says the session is inactive — the hint clears at once, grace or not", () => {
  setZaicodeLiveRun("session-heard", "V:/Projects/Alpha", true);
  const since = sinceOf("session-heard");
  // Index heard from *after* the claim but reporting no activity: the index decides alone,
  // so the grace window must not keep a claim the authoritative projection has already denied.
  reconcileZaicodeLiveRuns([inactiveTask("session-heard", since + 1)], since + 2);
  assert.deepEqual(useZaicodeLiveRuns.getState().runs, {});
});

test("REQ-006: an active index row keeps the hint — agreement is not expiry", () => {
  setZaicodeLiveRun("session-active", "V:/Projects/Alpha", true);
  const since = sinceOf("session-active");
  reconcileZaicodeLiveRuns([activeTask("session-active", since + 1)], since + 2);
  assert.ok(useZaicodeLiveRuns.getState().runs["session-active"], "background work keeps it working");
  // Long after any grace window: still working while the index still proves it.
  reconcileZaicodeLiveRuns([activeTask("session-active", since + 1)], since + 10 * ZAICODE_LIVE_RUN_INDEX_GRACE_MS);
  assert.ok(useZaicodeLiveRuns.getState().runs["session-active"]);
});

test("REQ-006: a runtime that died right after the claim cannot pin the row forever (the unbounded exemption)", () => {
  setZaicodeLiveRun("session-dead", "V:/Projects/Alpha", true);
  const since = sinceOf("session-dead");
  // lastActivityAt sits *before* the claim and never advances again — the exact shape of the
  // old `lastActivityAt < run.since` exemption, which kept the hint forever.
  const frozen = inactiveTask("session-dead", since - 5_000);
  // Red control: inside the window the claim is still trusted (the index may simply lag).
  reconcileZaicodeLiveRuns([frozen], since + 1);
  assert.ok(useZaicodeLiveRuns.getState().runs["session-dead"], "fresh claim survives a lagging index");

  reconcileZaicodeLiveRuns([frozen], since + ZAICODE_LIVE_RUN_INDEX_GRACE_MS + 1);
  assert.deepEqual(useZaicodeLiveRuns.getState().runs, {});
});

test("REQ-006: a session absent from the projection expires on the same window, and an empty projection is not an observation", () => {
  setZaicodeLiveRun("session-gone", "V:/Projects/Alpha", true);
  const since = sinceOf("session-gone");

  // An empty list means the sidebar has nothing to look at yet (a transient projection gap).
  // Never let it wipe every hint.
  reconcileZaicodeLiveRuns([], since + ZAICODE_LIVE_RUN_INDEX_GRACE_MS * 10);
  assert.ok(useZaicodeLiveRuns.getState().runs["session-gone"], "empty projection is not a denial");

  reconcileZaicodeLiveRuns([inactiveTask("session-unrelated", since + 1)], since + 1);
  assert.ok(useZaicodeLiveRuns.getState().runs["session-gone"], "still inside the window");

  reconcileZaicodeLiveRuns([inactiveTask("session-unrelated", since + 1)], since + ZAICODE_LIVE_RUN_INDEX_GRACE_MS + 1);
  assert.deepEqual(useZaicodeLiveRuns.getState().runs, {});
});

test("REQ-006: one expiring hint does not take its neighbours with it", () => {
  setZaicodeLiveRun("session-keep", "V:/Projects/Beta", true);
  setZaicodeLiveRun("session-drop", "V:/Projects/Beta", true);
  const keepSince = sinceOf("session-keep");
  const now = keepSince + ZAICODE_LIVE_RUN_INDEX_GRACE_MS * 5;
  // The survivor is far past the grace window, but the index still proves it working;
  // the other session is simply not in the projection any more.
  reconcileZaicodeLiveRuns([activeTask("session-keep", keepSince + 1)], now);
  assert.deepEqual(Object.keys(useZaicodeLiveRuns.getState().runs), ["session-keep"]);
});
