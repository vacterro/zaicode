import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { attachTaskListRowActivity } from "../src/v4/taskListRowActivity.js";
import { setZaicodeLiveRun, reconcileZaicodeLiveRuns, useZaicodeLiveRuns, ZAICODE_LIVE_RUN_INDEX_GRACE_MS } from "../src/zaicode/zaicodeLiveRuns.js";

afterEach(() => useZaicodeLiveRuns.setState({ runs: {} }));
const inactive = (at: number) => attachTaskListRowActivity({ taskId: "s" } as ZCodeTaskMeta, { phase: "completedSuccess", lastActivityAt: at, hasBackgroundWork: false });

test("SRC-184: mounted running snapshot survives several minutes of a lagging index", () => {
  setZaicodeLiveRun("s", "V:/Project", true, "view-1");
  const since = useZaicodeLiveRuns.getState().runs.s!.since;
  reconcileZaicodeLiveRuns([inactive(since - 5000)], since + 5 * ZAICODE_LIVE_RUN_INDEX_GRACE_MS);
  assert.ok(useZaicodeLiveRuns.getState().runs.s, "a mounted working view must not become idle after60 seconds");
});

test("SRC-184: inactive index cannot override a mounted full running snapshot", () => {
  setZaicodeLiveRun("s", "V:/Project", true, "view-1");
  const since = useZaicodeLiveRuns.getState().runs.s!.since;
  reconcileZaicodeLiveRuns([inactive(since + 100)], since + 200);
  assert.ok(useZaicodeLiveRuns.getState().runs.s, "full live snapshot has stronger running evidence than the conflated index");
});
