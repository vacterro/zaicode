import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  attachTaskListRowActivity,
  getTaskListRowActivity,
  type TaskListRowActivity,
} from "../src/v4/taskListRowActivity.js";
import {
  runningSessionsOf,
  selectReconcileRows,
  unionCommittedAndLiveSessionRows,
} from "../src/zaicode/zaicodeSidebarPrefs.js";
import {
  reconcileZaicodeLiveRuns,
  releaseZaicodeLiveRunView,
  setZaicodeLiveRun,
  useZaicodeLiveRuns,
  ZAICODE_LIVE_RUN_INDEX_GRACE_MS,
} from "../src/zaicode/zaicodeLiveRuns.js";

// T-294: a project doing real work must stay visibly running while the
// operator looks at another project. The sidebar derives running-ness from
// committed task-list cache rows; the live sessions-index can already hold
// newer authoritative activity (single-flight commit discard, membership
// caching, slicing). The union below is the contract under test.
afterEach(() => useZaicodeLiveRuns.setState({ runs: {} }));

const NOW = 1_800_000_000_000;
const T_OLD = NOW - 3_600_000;
const T_LIVE = NOW - 5_000;
const T_NEW = NOW - 1_000;

function row(taskId: string, workspacePath: string): ZCodeTaskMeta {
  return { taskId, workspacePath } as ZCodeTaskMeta;
}

function getUnionActivity(task: ZCodeTaskMeta): TaskListRowActivity {
  const activity = getTaskListRowActivity(task);
  assert.ok(activity, "union row must carry live activity");
  return activity;
}

function live(
  taskId: string,
  workspacePath: string,
  activity: TaskListRowActivity,
): ZCodeTaskMeta {
  return attachTaskListRowActivity(row(taskId, workspacePath), activity);
}

const runningLive = (at: number): TaskListRowActivity => ({
  phase: "running",
  lastActivityAt: at,
  hasBackgroundWork: false,
});

const staleCompleted = (at: number): TaskListRowActivity => ({
  phase: "completedSuccess",
  lastActivityAt: at,
  hasBackgroundWork: false,
  sessionEnded: true,
});

test("T-294: live running session missing from committed groups joins the union", () => {
  const union = unionCommittedAndLiveSessionRows(
    [],
    [live("sB", "V:/B", runningLive(T_LIVE))],
    "V:/B",
    NOW,
  );
  assert.equal(union.length, 1);
  const running = runningSessionsOf("V:/B", union, {}, undefined, NOW);
  assert.deepEqual(running.map((session) => session.sessionId), ["sB"]);
});

test("T-294: fresher live running row overrides stale committed completed row", () => {
  const union = unionCommittedAndLiveSessionRows(
    [live("sB", "V:/B", staleCompleted(T_OLD))],
    [live("sB", "V:/B", runningLive(T_LIVE))],
    "V:/B",
    NOW,
  );
  assert.equal(union.length, 1);
  const running = runningSessionsOf("V:/B", union, {}, undefined, NOW);
  assert.deepEqual(running.map((session) => session.sessionId), ["sB"]);
});

test("T-294: fresher live terminal row overrides stale committed running row", () => {
  const union = unionCommittedAndLiveSessionRows(
    [live("sB", "V:/B", runningLive(T_OLD))],
    [live("sB", "V:/B", staleCompleted(T_NEW))],
    "V:/B",
    NOW,
  );
  assert.equal(union.length, 1);
  const running = runningSessionsOf("V:/B", union, {}, undefined, NOW);
  assert.deepEqual(running, [], "a genuine stop must clear even unfocused");
});

test("T-294: committed-only rows pass through untouched when the index is silent", () => {
  const committed = [live("sB", "V:/B", runningLive(T_LIVE))];
  const union = unionCommittedAndLiveSessionRows(committed, [], "V:/B", NOW);
  assert.deepEqual(union, committed);
});

test("T-294: background project stays running past hint grace on live evidence", () => {
  // Operator viewed B, switched to A: the mounted view released its hint.
  setZaicodeLiveRun("sB", "V:/B", true, "view-b");
  const switchedAt = NOW - 10 * ZAICODE_LIVE_RUN_INDEX_GRACE_MS;
  releaseZaicodeLiveRunView("sB", "view-b");
  // Committed cache froze at the previous turn's completion; the live index
  // kept producing running activity B's refresh never committed.
  const staleGroups = [live("sB", "V:/B", staleCompleted(T_OLD))];
  const liveItems = [live("sB", "V:/B", runningLive(T_LIVE))];
  reconcileZaicodeLiveRuns(staleGroups, switchedAt + 2 * ZAICODE_LIVE_RUN_INDEX_GRACE_MS);
  assert.equal(
    useZaicodeLiveRuns.getState().runs.sB,
    undefined,
    "stale rows alone must not pin the hint past grace",
  );
  const union = unionCommittedAndLiveSessionRows(staleGroups, liveItems, "V:/B", NOW);
  const running = runningSessionsOf("V:/B", union, {}, undefined, NOW);
  assert.deepEqual(running.map((session) => session.sessionId), ["sB"]);
});

test("T-294: genuine stop while unfocused clears the indicator", () => {
  setZaicodeLiveRun("sB", "V:/B", true, "view-b");
  releaseZaicodeLiveRunView("sB", "view-b");
  const stopped = [live("sB", "V:/B", staleCompleted(T_NEW))];
  reconcileZaicodeLiveRuns(stopped, NOW);
  const union = unionCommittedAndLiveSessionRows(stopped, stopped, "V:/B", NOW);
  const running = runningSessionsOf("V:/B", union, {}, undefined, NOW);
  assert.deepEqual(running, []);
});

test("T-294: quiet background work stays running, dead background does not", () => {
  const quietFourHours: TaskListRowActivity = {
    phase: "running",
    lastActivityAt: NOW - 4 * 3_600_000,
    hasBackgroundWork: true,
  };
  const unionQuiet = unionCommittedAndLiveSessionRows(
    [],
    [live("sQ", "V:/B", quietFourHours)],
    "V:/B",
    NOW,
  );
  assert.deepEqual(
    runningSessionsOf("V:/B", unionQuiet, {}, undefined, NOW).map((s) => s.sessionId),
    ["sQ"],
    "legitimate quiet background work must not go falsely inactive",
  );
  const zombieSixHours: TaskListRowActivity = {
    phase: "running",
    lastActivityAt: NOW - 6 * 3_600_000,
    hasBackgroundWork: true,
  };
  const unionZombie = unionCommittedAndLiveSessionRows(
    [],
    [live("sZ", "V:/B", zombieSixHours)],
    "V:/B",
    NOW,
  );
  assert.deepEqual(
    runningSessionsOf("V:/B", unionZombie, {}, undefined, NOW),
    [],
    "a dead session must not stay permanently running",
  );
});

test("T-294: session present on both sides appears exactly once", () => {
  const union = unionCommittedAndLiveSessionRows(
    [live("sB", "V:/B", runningLive(T_OLD))],
    [live("sB", "V:/B", runningLive(T_LIVE))],
    "V:/B",
    NOW,
  );
  assert.equal(union.length, 1);
});

test("T-294: another project's live rows never leak into this project", () => {
  const unionA = unionCommittedAndLiveSessionRows(
    [live("sA", "V:/A", staleCompleted(T_OLD))],
    [
      live("sA", "V:/A", staleCompleted(T_NEW)),
      live("sB", "V:/B", runningLive(T_LIVE)),
    ],
    "V:/A",
    NOW,
  );
  assert.deepEqual(
    runningSessionsOf("V:/A", unionA, {}, undefined, NOW),
    [],
    "A stays idle while B runs",
  );
});

test("T-295A: equal timestamps let a stale committed running row override live terminal", () => {
  const at = NOW - 60_000;
  const union = unionCommittedAndLiveSessionRows(
    [live("sB", "V:/B", { phase: "running", lastActivityAt: at, hasBackgroundWork: false })],
    [live("sB", "V:/B", staleCompleted(at))],
    "V:/B",
    NOW,
  );
  const running = runningSessionsOf("V:/B", union, {}, undefined, NOW);
  assert.deepEqual(running, [], "terminal at the same stamp must retire running");
});

test("T-295A: equal timestamps let a resumed live run displace stale committed terminal", () => {
  const at = NOW - 60_000;
  const union = unionCommittedAndLiveSessionRows(
    [live("sB", "V:/B", staleCompleted(at))],
    [live("sB", "V:/B", runningLive(at))],
    "V:/B",
    NOW,
  );
  const running = runningSessionsOf("V:/B", union, {}, undefined, NOW);
  assert.deepEqual(
    running.map((session) => session.sessionId),
    ["sB"],
    "resumed run at the same stamp must displace stale terminal",
  );
});

test("T-295A: committed row without activity never outranks live evidence", () => {
  const bare = row("sB", "V:/B");
  const union = unionCommittedAndLiveSessionRows(
    [bare],
    [live("sB", "V:/B", runningLive(T_LIVE))],
    "V:/B",
    NOW,
  );
  assert.equal(union.length, 1);
  assert.equal(getUnionActivity(union[0]).lastActivityAt, T_LIVE);
});

test("T-295B: stale committed rows keep a hint alive past authoritative live terminal", () => {
  // What WorkspaceSidebar passes to reconcileZaicodeLiveRuns today:
  // committed group items only.
  setZaicodeLiveRun("sB", "V:/B", true, "view-b");
  releaseZaicodeLiveRunView("sB", "view-b");
  const hint = useZaicodeLiveRuns.getState().runs.sB;
  assert.ok(hint && hint.views?.length === 0);
  // Committed cache froze on a running row stamped after the view release;
  // the live index has since reported terminal (authoritative stop B's
  // refresh never committed). The sidebar reconciles the union rows, so the
  // terminal event clears the hint without opening the project.
  const reconcileAt = hint.observedAt! + 2 * ZAICODE_LIVE_RUN_INDEX_GRACE_MS;
  const stoppedAt = hint.observedAt! + 5_000;
  const groups = [
    {
      workspacePath: "V:/B",
      items: [live("sB", "V:/B", runningLive(hint.observedAt! + 1_000))],
    },
  ];
  const liveTerminal = [live("sB", "V:/B", staleCompleted(stoppedAt))];
  reconcileZaicodeLiveRuns(
    selectReconcileRows(groups, liveTerminal, reconcileAt),
    reconcileAt,
  );
  assert.equal(
    useZaicodeLiveRuns.getState().runs.sB,
    undefined,
    "authoritative live terminal must clear the hint without opening the project",
  );
});

test("T-295B-guard: live running evidence keeps the hint (no over-clearing)", () => {
  setZaicodeLiveRun("sB", "V:/B", true, "view-b");
  releaseZaicodeLiveRunView("sB", "view-b");
  const hint = useZaicodeLiveRuns.getState().runs.sB;
  const union = unionCommittedAndLiveSessionRows(
    [live("sB", "V:/B", runningLive(hint!.observedAt! - 1_000))],
    [live("sB", "V:/B", runningLive(T_LIVE))],
    "V:/B",
    NOW,
  );
  reconcileZaicodeLiveRuns(union, NOW);
  assert.ok(useZaicodeLiveRuns.getState().runs.sB, "running evidence must keep the hint");
});

test("T-295C: live-only terminal row never enters the derivation", () => {
  const union = unionCommittedAndLiveSessionRows(
    [],
    [live("sB", "V:/B", staleCompleted(T_NEW))],
    "V:/B",
    NOW,
  );
  assert.deepEqual(union, [], "terminal without liveness must not join");
});

test("T-295C: live-only dead session never enters the derivation", () => {
  const zombie: TaskListRowActivity = {
    phase: "running",
    lastActivityAt: NOW - 6 * 3_600_000,
    hasBackgroundWork: false,
  };
  const union = unionCommittedAndLiveSessionRows([], [live("sB", "V:/B", zombie)], "V:/B", NOW);
  assert.deepEqual(union, [], "stalled rows must not join even when absent from groups");
});

test("T-295C: deleted session without live detail cannot resurrect", () => {
  const union = unionCommittedAndLiveSessionRows([], [], "V:/B", NOW);
  assert.deepEqual(
    runningSessionsOf("V:/B", union, {}, undefined, NOW),
    [],
    "no rows anywhere means no running entries",
  );
});
