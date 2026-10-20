import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { attachTaskListRowActivity } from "../src/v4/taskListRowActivity.js";
import { unionCommittedAndLiveSessionRows } from "../src/zaicode/zaicodeSidebarPrefs.js";
import {
  registerZaicodeProjectContinue,
  useZaicodeSessionBriefs,
  zaicodeSessionBriefOf,
} from "../src/zaicode/zaicodeContinue.js";
import { useZaicodeMainSessions } from "../src/zaicode/zaicodeMainSession.js";
import { startZaicodeInMain } from "../src/zaicode/zaicodeScheduleRun.js";
import { pickZaicodeBackgroundRetrySessions } from "../src/zaicode/zaicodeTurnRetryWatch.js";
import { planZaicodeCrashResume } from "../src/zaicode/zaicodeCrashResume.js";

afterEach(() => {
  useZaicodeSessionBriefs.getState().publish([]);
  useZaicodeMainSessions.setState({ byWorkspace: {} });
});

const target = { key: "V:/background", path: "V:/background", name: "Background" };
function row(
  id: string,
  phase: "error" | "completedSuccess",
  goal: "active" | "complete",
  at: number,
) {
  return attachTaskListRowActivity(
    {
      taskId: id,
      workspacePath: target.path,
      title: id,
      updatedAt: at,
      status: phase === "error" ? "error" : "completed",
      target: { status: goal, objective: "fixture" },
    } as ZCodeTaskMeta,
    { phase, lastActivityAt: at, hasBackgroundWork: false, sessionEnded: true },
  );
}

test("background automation sees a current error and goal instead of a stale completion", () => {
  const old = row("main", "completedSuccess", "complete", 1000);
  const current = row("main", "error", "active", 2000);
  const merged = unionCommittedAndLiveSessionRows([old], [current], target.key, 3000);
  const brief = zaicodeSessionBriefOf(merged[0]!, target.key, { workspacePath: target.path });
  assert.equal(brief.failed, true);
  assert.equal(brief.goalStatus, "active");
  assert.equal(brief.running, false);
});

test("a live-only failed goal reaches automation without entering the working indicator", () => {
  const current = row("outside-visible-page", "error", "active", 2000);
  assert.equal(unionCommittedAndLiveSessionRows([], [current], target.key, 3000).length, 0);
  const forAutomation = unionCommittedAndLiveSessionRows as (...args: unknown[]) => ZCodeTaskMeta[];
  const merged = forAutomation([], [current], target.key, 3000, true);
  assert.equal(
    merged.length,
    1,
    "a failed session outside membership still needs automatic recovery",
  );
  assert.equal(
    zaicodeSessionBriefOf(merged[0]!, target.key, { workspacePath: target.path }).failed,
    true,
  );
});

test("automation union isolates different workspace identities on one path", () => {
  const a = { ...row("main", "error", "active", 2000), workspaceIdentity: "remote:a" };
  const b = { ...row("main", "error", "active", 2000), workspaceIdentity: "remote:b" };
  const forAutomation = unionCommittedAndLiveSessionRows as (...args: unknown[]) => ZCodeTaskMeta[];
  assert.deepEqual(forAutomation([], [a, b], "remote:a", 3000, true), [a]);
});

test("an ACK lost after acceptance preserves MAIN and never starts a second session", async () => {
  useZaicodeSessionBriefs
    .getState()
    .publish([
      zaicodeSessionBriefOf(row("main", "completedSuccess", "active", 2000), target.key, {
        workspacePath: target.path,
      }),
    ]);
  useZaicodeMainSessions.getState().setMain(target.key, "main");
  let accepted = 0;
  let created = 0;
  const release = registerZaicodeProjectContinue(target.key, {
    send: async () => {
      accepted++;
      throw Error("ACK connection lost after host acceptance");
    },
    start: async () => {
      created++;
      return "replacement";
    },
    stop: async () => {},
  });
  try {
    const outcome = await startZaicodeInMain({ prompt: "/goal fixture" }, [target], 3000);
    assert.equal(accepted, 1);
    assert.equal(created, 0);
    assert.equal(useZaicodeMainSessions.getState().byWorkspace[target.key], "main");
    assert.equal(outcome.runs.length, 0, "unacknowledged sends are not reported as started");
    assert.match(outcome.lines.join("\n"), /ACK connection lost/);
  } finally {
    release();
  }
});

test("a project with no bound MAIN still permits one fresh session", async () => {
  let created = 0;
  const release = registerZaicodeProjectContinue(target.key, {
    send: async () => {
      throw Error("must not send to missing MAIN");
    },
    start: async () => {
      created++;
      return "new-main";
    },
    stop: async () => {},
  });
  try {
    const outcome = await startZaicodeInMain({ prompt: "/goal fixture" }, [target], 3000);
    assert.equal(created, 1);
    assert.equal(useZaicodeMainSessions.getState().byWorkspace[target.key], "new-main");
    assert.equal(outcome.runs.length, 1);
  } finally {
    release();
  }
});

test("HUNT-007: excluded deleted/archived/pinned rows never re-enter the automation feed while visible-page omissions do", () => {
  const visible = row("visible-active", "completedSuccess", "complete", 1000);
  const omittedSlice = row("omitted-slice", "error", "active", 2000);
  const deletedSession = row("deleted-tombstone", "error", "complete", 2000);
  const archivedSession = row("archived-session", "completedSuccess", "complete", 2000);
  const deletedGoalSession = row("deleted-goal", "completedSuccess", "active", 2000);

  const excluded = new Set(["deleted-tombstone", "archived-session", "deleted-goal"]);
  const liveRows = [omittedSlice, deletedSession, archivedSession, deletedGoalSession];

  const merged = unionCommittedAndLiveSessionRows(
    [visible],
    liveRows,
    target.key,
    3000,
    true,
    excluded,
  );

  const mergedIds = merged.map((item) => item.taskId);
  assert.ok(mergedIds.includes("visible-active"), "committed visible session is present");
  assert.ok(mergedIds.includes("omitted-slice"), "sliced-out failed session still reaches automation");
  assert.ok(!mergedIds.includes("deleted-tombstone"), "deleted tombstone session must NOT re-enter");
  assert.ok(!mergedIds.includes("archived-session"), "archived session must NOT re-enter");
  assert.ok(!mergedIds.includes("deleted-goal"), "deleted session with active goal must NOT re-enter");

  const briefs = merged.map((item) =>
    zaicodeSessionBriefOf(item, target.key, { workspacePath: target.path }),
  );

  const retried = pickZaicodeBackgroundRetrySessions(briefs, {
    isLocal: () => false,
    isProjectDisabled: () => false,
    attemptsOf: () => 0,
    maxAttempts: 3,
    isQuotaWall: () => false,
  });
  assert.ok(retried.some((brief) => brief.sessionId === "omitted-slice"));
  assert.ok(!retried.some((brief) => brief.sessionId === "deleted-tombstone"));

  const resumeSteps = planZaicodeCrashResume(
    briefs,
    () => ({ hasSaipen: true, disabled: false }),
    3000,
    24,
  );
  assert.ok(!resumeSteps.some((step) => step.sessionId === "deleted-goal"));
});
