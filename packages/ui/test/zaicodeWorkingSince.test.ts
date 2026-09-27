import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { attachTaskListRowActivity } from "../src/v4/taskListRowActivity.js";
import { projectLiveOf } from "../src/zaicode/zaicodeSidebarPrefs.js";

// SRC-058 regression. Only the pre-existing projectLiveOf(tasks, ratios)
// signature is used, so this same test runs against the pre-fix code, where
// "working for" was measured from the session's createdAt.

const DAY = 86_400_000;

function session(taskId: string, createdAt: number, working: boolean, lastActivityAt: number): ZCodeTaskMeta {
  const meta = {
    taskId,
    title: taskId,
    workspacePath: "C:/p/a",
    createdAt,
    updatedAt: lastActivityAt,
    mode: "build",
    traceId: "t",
  } as ZCodeTaskMeta;
  return attachTaskListRowActivity(meta, {
    phase: working ? "running" : "completedSuccess",
    lastActivityAt,
    hasBackgroundWork: false,
  });
}

test("a days-old session that started working five minutes ago reads five minutes, not its age", () => {
  const now = Date.now();
  const startedWork = now - 5 * 60_000;
  const live = projectLiveOf([session("working-since-old-main", now - 3 * DAY, true, startedWork)], []);
  assert.equal(live.running, 1);
  assert.equal(live.since, startedWork);
});

test("re-reading the same run later keeps the start of the run, not the time of the read", () => {
  const now = Date.now();
  const startedWork = now - 40 * 60_000;
  const first = projectLiveOf([session("working-since-reread", now - DAY, true, startedWork)], []);
  // Later feed frame: the run is still going and its last activity moved on.
  const later = projectLiveOf([session("working-since-reread", now - DAY, true, now - 1_000)], []);
  assert.equal(first.since, startedWork);
  assert.equal(later.since, startedWork);
});

test("an idle project reports no working start", () => {
  const now = Date.now();
  const live = projectLiveOf([session("working-since-idle", now - DAY, false, now - 60_000)], []);
  assert.equal(live.running, 0);
  assert.equal(live.since, 0);
});
