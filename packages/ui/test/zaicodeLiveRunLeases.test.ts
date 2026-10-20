import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { attachTaskListRowActivity } from "../src/v4/taskListRowActivity.js";
import { setZaicodeLiveRun, releaseZaicodeLiveRunView, clearZaicodeLiveRunsIn, reconcileZaicodeLiveRuns, useZaicodeLiveRuns, ZAICODE_LIVE_RUN_INDEX_GRACE_MS } from "../src/zaicode/zaicodeLiveRuns.js";

afterEach(() => useZaicodeLiveRuns.setState({ runs: {} }));
const stale = () => [attachTaskListRowActivity({ taskId: "s" } as ZCodeTaskMeta, { phase: "completedSuccess", lastActivityAt: 1, hasBackgroundWork: false })];

test("last view release returns to bounded observation grace without resetting the start", () => {
  setZaicodeLiveRun("s", "V:/Project", true, "one");
  const start = useZaicodeLiveRuns.getState().runs.s!.since;
  releaseZaicodeLiveRunView("s", "one");
  const run = useZaicodeLiveRuns.getState().runs.s!;
  assert.equal(run.since, start);
  assert.equal(run.views?.length, 0);
  reconcileZaicodeLiveRuns(stale(), run.observedAt! + 1);
  assert.ok(useZaicodeLiveRuns.getState().runs.s);
  reconcileZaicodeLiveRuns(stale(), run.observedAt! + ZAICODE_LIVE_RUN_INDEX_GRACE_MS + 1);
  assert.equal(useZaicodeLiveRuns.getState().runs.s, undefined);
});

test("one view release cannot retire another mounted view", () => {
  setZaicodeLiveRun("s", "V:/Project", true, "one");
  setZaicodeLiveRun("s", "v:\\project\\", true, "two");
  releaseZaicodeLiveRunView("s", "one");
  reconcileZaicodeLiveRuns(stale(), Date.now() + 10 * ZAICODE_LIVE_RUN_INDEX_GRACE_MS);
  assert.deepEqual(useZaicodeLiveRuns.getState().runs.s?.views, ["two"]);
});

test("terminal snapshot and runtime invalidation clear leased evidence immediately", () => {
  setZaicodeLiveRun("s", "V:/Project", true, "one");
  setZaicodeLiveRun("s", "V:/Project", false, "one");
  assert.equal(useZaicodeLiveRuns.getState().runs.s, undefined);
  setZaicodeLiveRun("s", "V:/Project", true, "one");
  setZaicodeLiveRun("neighbor", "V:/Other", true, "two");
  clearZaicodeLiveRunsIn("v:\\project\\");
  releaseZaicodeLiveRunView("s", "one");
  assert.deepEqual(Object.keys(useZaicodeLiveRuns.getState().runs), ["neighbor"]);
});
