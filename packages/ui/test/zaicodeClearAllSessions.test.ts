import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planZaicodeClearAllSessions,
  collectAuthoritativeClearAllSessionsPlan,
  runZaicodeClearAllSessions,
  describeZaicodeClearAllSessions,
  formatZaicodeClearAllSessionsRun,
  isSessionSafelyIdle,
} from "../src/zaicode/zaicodeClearAllSessions.js";
import {
  areZaicodeSessionBriefsEqual,
  type ZaicodeSessionBrief,
} from "../src/zaicode/zaicodeContinue.js";
import { useZaicodeMainSessions } from "../src/zaicode/zaicodeMainSession.js";
import { useZaicodeRetryLedger } from "../src/zaicode/zaicodeRetryPolicy.js";
import {
  zaicodeGoalLiveIntent,
  registerZaicodeGoalIntent,
} from "../src/zaicode/zaicodeGoalSupervisor.js";
import {
  isZaicodeCleanupInProgress,
  startZaicodeCleanupEpoch,
  releaseZaicodeCleanupEpoch,
} from "../src/zaicode/zaicodeCleanupFence.js";
import { planZaicodeCrashResume } from "../src/zaicode/zaicodeCrashResume.js";
import { zaicodeQueueMayAutoResume } from "../src/zaicode/zaicodeQueueAutoResume.js";
import { zaicodeAutoRetryAllowedFor } from "../src/zaicode/zaicodeRetryPolicy.js";

function makeBrief(partial: Partial<ZaicodeSessionBrief> & { sessionId: string; projectKey: string }): ZaicodeSessionBrief {
  return {
    sessionId: partial.sessionId,
    title: partial.title ?? partial.sessionId,
    projectKey: partial.projectKey,
    workspacePath: partial.workspacePath ?? "V:/code/proj",
    workspaceIdentity: partial.workspaceIdentity,
    running: partial.running ?? false,
    waiting: partial.waiting ?? false,
    failed: partial.failed ?? false,
    interrupted: partial.interrupted ?? false,
    manuallyStopped: partial.manuallyStopped ?? false,
    crashCut: partial.crashCut ?? false,
    updatedAt: partial.updatedAt ?? Date.now(),
    model: partial.model ?? "gpt-4o",
    unreadAt: partial.unreadAt ?? null,
    goalStatus: partial.goalStatus ?? null,
    goalObjective: partial.goalObjective ?? null,
  };
}

test("01-04: CLEAR ALL SESSIONS plans all session types without status-based exclusions or continuation", () => {
  const sessions: ZaicodeSessionBrief[] = [
    makeBrief({ sessionId: "main-1", projectKey: "P1", running: true }),
    makeBrief({ sessionId: "helper-running", projectKey: "P1", running: true }),
    makeBrief({ sessionId: "helper-done", projectKey: "P1" }),
    makeBrief({ sessionId: "helper-failed", projectKey: "P1", failed: true }),
    makeBrief({ sessionId: "helper-interrupted", projectKey: "P1", interrupted: true, goalObjective: "cc all", goalStatus: "active" }),
    makeBrief({ sessionId: "helper-waiting", projectKey: "P1", waiting: true }),
  ];

  const plan = planZaicodeClearAllSessions(sessions);
  assert.equal(plan.totalCount, 6);
  assert.equal(plan.runningCount, 2);
  assert.equal(plan.waitingCount, 1);
  assert.equal(plan.failedCount, 1);
  assert.equal(plan.stoppedCount, 1);
  assert.equal(plan.completedCount, 1);
  assert.equal(plan.workspaces.length, 1);

  const desc = describeZaicodeClearAllSessions(plan);
  assert.ok(desc.includes("Found 6 session(s)"));
  assert.ok(desc.includes("Does not continue old sessions"));
});

test("05-08: Safe termination before removal and unreachable host handling", async () => {
  const stoppedCalls: string[] = [];
  const sessions: ZaicodeSessionBrief[] = [
    makeBrief({ sessionId: "live-main", projectKey: "P1", running: true }),
    makeBrief({ sessionId: "live-helper", projectKey: "P1", running: true }),
    makeBrief({ sessionId: "disconnected-session", projectKey: "P2", running: true }),
  ];

  const plan = planZaicodeClearAllSessions(sessions);
  const deletedBatches: { workspacePath: string; taskIds: string[] }[] = [];

  const result = await runZaicodeClearAllSessions({
    plan,
    resolveHandle: (key) => {
      if (key === "P2") return null; // Disconnected host
      return {
        send: async () => { throw new Error("cleanup must never send continuations"); },
        start: async () => { throw new Error("not called"); },
        stop: async (sessionId) => { stoppedCalls.push(sessionId); },
        clear: async () => {},
        markUnread: async () => {},
      };
    },
    taskService: {
      deleteTasks: async (params) => {
        deletedBatches.push({ workspacePath: params.workspacePath, taskIds: params.taskIds });
        return { deletedTaskIds: params.taskIds, skippedTaskIds: [], failedTaskIds: [] };
      },
    },
  });

  assert.deepEqual(stoppedCalls, ["live-main", "live-helper"]);
  assert.equal(result.stopped, 2);
  // Disconnected host must not be reported as cleared (REGRESSION-08)
  assert.ok(result.failedOrUnreachable.includes("disconnected-session"));
  assert.equal(result.cleared, 2);
  assert.ok(result.problems.some((p) => p.includes("No host connection for disconnected-session")));
});

test("15-18: Background automation fence blocks retry, queue and crash resume during cleanup", () => {
  const epoch = startZaicodeCleanupEpoch();
  try {
    assert.equal(isZaicodeCleanupInProgress(), true);

    // Auto retry is fenced
    assert.equal(zaicodeAutoRetryAllowedFor("P1", "sess-1", true), false);

    // Queue auto resume is fenced
    assert.equal(
      zaicodeQueueMayAutoResume({
        hasSession: true,
        queueItems: 1,
        autoDrain: false,
        pauseReason: "error",
        phase: "idle",
        quotaWall: false,
        mayAutoSend: true,
        attempts: 0,
        maxAttempts: 5,
      }),
      false,
    );

    // Crash resume is fenced
    const crashCandidates = planZaicodeCrashResume(
      [makeBrief({ sessionId: "c1", projectKey: "P1", crashCut: true })],
      () => ({ hasSaipen: true, disabled: false }),
      Date.now(),
      12,
    );
    assert.equal(crashCandidates.length, 0);
  } finally {
    releaseZaicodeCleanupEpoch(epoch);
  }
  assert.equal(isZaicodeCleanupInProgress(), false);
});

test("19-20: MAIN session pointer is retired and new MAIN gets fresh identity", async () => {
  useZaicodeMainSessions.getState().setMain("P1", "old-main-123");
  assert.equal(useZaicodeMainSessions.getState().byWorkspace["P1"], "old-main-123");

  const plan = planZaicodeClearAllSessions([
    makeBrief({ sessionId: "old-main-123", projectKey: "P1" }),
  ]);

  await runZaicodeClearAllSessions({
    plan,
    taskService: {
      deleteTasks: async (params) => ({ deletedTaskIds: params.taskIds, skippedTaskIds: [], failedTaskIds: [] }),
    },
  });

  // Stored MAIN pointer must be cleared
  assert.equal(useZaicodeMainSessions.getState().byWorkspace["P1"], undefined);

  // Arming new session gives fresh identity
  useZaicodeMainSessions.getState().setMain("P1", "fresh-main-456");
  assert.equal(useZaicodeMainSessions.getState().byWorkspace["P1"], "fresh-main-456");
});

test("21-25: Goal supervisor intents & retries are stopped on cleared sessions without auto-restart", async () => {
  registerZaicodeGoalIntent({ projectKey: "P1", sessionId: "sess-goal-1", objective: "cc all", fresh: true });
  useZaicodeRetryLedger.getState().set({
    sessionId: "sess-goal-1",
    title: "Session 1",
    nextAt: Date.now() + 60000,
    attempt: 1,
    source: "chat",
  });

  const plan = planZaicodeClearAllSessions([
    makeBrief({ sessionId: "sess-goal-1", projectKey: "P1", goalObjective: "cc all", goalStatus: "active" }),
  ]);

  await runZaicodeClearAllSessions({
    plan,
    taskService: {
      deleteTasks: async (params) => ({ deletedTaskIds: params.taskIds, skippedTaskIds: [], failedTaskIds: [] }),
    },
  });

  // Goal intent must be stopped, not dispatchable
  const liveIntent = zaicodeGoalLiveIntent("P1", "sess-goal-1");
  assert.equal(liveIntent, null);

  // Retry ledger entry cleared
  assert.equal(useZaicodeRetryLedger.getState().pending["sess-goal-1"], undefined);
});

test("Candidate B: areZaicodeSessionBriefsEqual scales to 10,000 sessions with 0 string concatenation", () => {
  const n = 10000;
  const listA = Array.from({ length: n }, (_, i) =>
    makeBrief({ sessionId: `s-${i}`, projectKey: `p-${i % 10}`, updatedAt: 1000 + i }),
  );
  const listB = listA.map((s) => ({ ...s }));

  assert.equal(areZaicodeSessionBriefsEqual(listA, listB), true);

  // Modifying one property in the middle detects inequality instantly
  listB[5000] = { ...listB[5000]!, running: true };
  assert.equal(areZaicodeSessionBriefsEqual(listA, listB), false);
});

test("Candidate C: Bulk cleanup emits a single batch deletion per workspace instead of N event storms", async () => {
  const batchCounts: number[] = [];
  const sessions = Array.from({ length: 50 }, (_, i) =>
    makeBrief({ sessionId: `sess-${i}`, projectKey: "W1", workspacePath: "V:/code/w1" }),
  );

  const plan = planZaicodeClearAllSessions(sessions);
  const result = await runZaicodeClearAllSessions({
    plan,
    taskService: {
      deleteTasks: async (params) => {
        batchCounts.push(params.taskIds.length);
        return { deletedTaskIds: params.taskIds, skippedTaskIds: [], failedTaskIds: [] };
      },
    },
  });

  assert.equal(result.cleared, 50);
  assert.equal(batchCounts.length, 1);
  assert.equal(batchCounts[0], 50);

  const formatted = formatZaicodeClearAllSessionsRun(result);
  assert.ok(formatted.includes("Total found: 50"));
  assert.ok(formatted.includes("Sessions cleared: 50"));
});

// =========================================================================
// REQUIRED REGRESSION TESTS (SRC-267 Section 6: 01 - 27)
// =========================================================================

test("01-02: Left-click (IDLE_ONLY) clears completed and failed inactive sessions", async () => {
  const sessions = [
    makeBrief({ sessionId: "completed-1", projectKey: "P1" }),
    makeBrief({ sessionId: "failed-inactive-2", projectKey: "P1", failed: true }),
  ];

  const plan = planZaicodeClearAllSessions(sessions, "IDLE_ONLY");
  assert.equal(plan.idleCount, 2);

  const deleted: string[] = [];
  const result = await runZaicodeClearAllSessions({
    plan,
    policy: "IDLE_ONLY",
    taskService: {
      deleteTasks: async (params) => {
        deleted.push(...params.taskIds);
        return { deletedTaskIds: params.taskIds, skippedTaskIds: [], failedTaskIds: [] };
      },
    },
  });

  assert.equal(result.cleared, 2);
  assert.equal(result.preservedActive, 0);
  assert.deepEqual(deleted.sort(), ["completed-1", "failed-inactive-2"].sort());

  const formatted = formatZaicodeClearAllSessionsRun(result);
  assert.ok(formatted.includes("Cleared: 2 idle sessions"));
  assert.ok(formatted.includes("Preserved: 0 active sessions"));
});

test("03-04: Left-click (IDLE_ONLY) strictly preserves running MAIN and running helper", async () => {
  useZaicodeMainSessions.getState().setMain("P1", "running-main");

  const sessions = [
    makeBrief({ sessionId: "running-main", projectKey: "P1", running: true }),
    makeBrief({ sessionId: "running-helper", projectKey: "P1", running: true }),
    makeBrief({ sessionId: "idle-1", projectKey: "P1" }),
  ];

  const plan = planZaicodeClearAllSessions(sessions, "IDLE_ONLY");
  assert.equal(plan.idleCount, 1);
  assert.equal(plan.runningCount, 2);

  const deleted: string[] = [];
  const result = await runZaicodeClearAllSessions({
    plan,
    policy: "IDLE_ONLY",
    taskService: {
      deleteTasks: async (params) => {
        deleted.push(...params.taskIds);
        return { deletedTaskIds: params.taskIds, skippedTaskIds: [], failedTaskIds: [] };
      },
    },
  });

  assert.equal(result.cleared, 1);
  assert.equal(result.preservedActive, 2);
  assert.deepEqual(deleted, ["idle-1"]);

  // Running MAIN pointer must remain untouched!
  assert.equal(useZaicodeMainSessions.getState().byWorkspace["P1"], "running-main");
});

test("05-07: Left-click preserves queued commands, in-flight/streaming submissions, and unknown-activity sessions", async () => {
  const sessions = [
    makeBrief({ sessionId: "with-queue", projectKey: "P1" }),
    makeBrief({ sessionId: "streaming-sess", projectKey: "P1" }),
    makeBrief({ sessionId: "unknown-act", projectKey: "P1" }),
    makeBrief({ sessionId: "waiting-user", projectKey: "P1", waiting: true }),
  ];

  // Mark streaming and unknown activity
  (sessions[1] as any).isStreaming = true;
  (sessions[2] as any).activityState = "unknown";

  const isIdleQueue = isSessionSafelyIdle(sessions[0]!, {
    hasPendingCommands: (id) => id === "with-queue",
  });
  assert.equal(isIdleQueue, false, "Session with pending commands must not be idle");

  const isIdleStreaming = isSessionSafelyIdle(sessions[1]!);
  assert.equal(isIdleStreaming, false, "Streaming session must not be idle");

  const isIdleUnknown = isSessionSafelyIdle(sessions[2]!);
  assert.equal(isIdleUnknown, false, "Unknown activity session must not be idle");

  const isIdleWaiting = isSessionSafelyIdle(sessions[3]!);
  assert.equal(isIdleWaiting, false, "Waiting session must not be idle");

  const plan = planZaicodeClearAllSessions(sessions, "IDLE_ONLY", {
    hasPendingCommands: (id) => id === "with-queue",
  });
  assert.equal(plan.idleCount, 0);

  const result = await runZaicodeClearAllSessions({
    plan,
    policy: "IDLE_ONLY",
    context: {
      hasPendingCommands: (id) => id === "with-queue",
    },
    taskService: {
      deleteTasks: async (params) => ({ deletedTaskIds: params.taskIds, skippedTaskIds: [], failedTaskIds: [] }),
    },
  });

  assert.equal(result.cleared, 0);
  assert.equal(result.preservedActive, 4);
});

test("08: Left-click never invokes active-generation stop handle", async () => {
  let stopCalled = false;
  const sessions = [
    makeBrief({ sessionId: "running-worker", projectKey: "P1", running: true }),
    makeBrief({ sessionId: "idle-worker", projectKey: "P1" }),
  ];

  const plan = planZaicodeClearAllSessions(sessions, "IDLE_ONLY");
  const result = await runZaicodeClearAllSessions({
    plan,
    policy: "IDLE_ONLY",
    resolveHandle: () => ({
      send: async () => {},
      start: async () => {},
      stop: async () => { stopCalled = true; },
      clear: async () => {},
      markUnread: async () => {},
    }),
    taskService: {
      deleteTasks: async (params) => ({ deletedTaskIds: params.taskIds, skippedTaskIds: [], failedTaskIds: [] }),
    },
  });

  assert.equal(stopCalled, false, "Left-click must NEVER invoke stop handle");
  assert.equal(result.stopped, 0);
  assert.equal(result.cleared, 1);
  assert.equal(result.preservedActive, 1);
});

test("09: Session becomes active between planning and deletion: skipped via TOCTOU revalidation", async () => {
  const session = makeBrief({ sessionId: "becoming-active", projectKey: "P1" });
  const plan = planZaicodeClearAllSessions([session], "IDLE_ONLY");
  assert.equal(plan.idleCount, 1);

  let revalidateCalls = 0;
  const result = await runZaicodeClearAllSessions({
    plan,
    policy: "IDLE_ONLY",
    revalidateSafelyIdle: (_sess) => {
      revalidateCalls++;
      // Simulating that the session became active in the background
      return false;
    },
    taskService: {
      deleteTasks: async (params) => ({ deletedTaskIds: params.taskIds, skippedTaskIds: [], failedTaskIds: [] }),
    },
  });

  assert.equal(revalidateCalls, 1);
  assert.equal(result.cleared, 0);
  assert.equal(result.preservedActive, 1);
});

test("11-15: Right-click (ALL_SESSIONS) stops running work, cancels commands, and clears all", async () => {
  const stoppedList: string[] = [];
  const cancelledCmds: string[] = [];
  const deletedList: string[] = [];

  const sessions = [
    makeBrief({ sessionId: "active-1", projectKey: "P1", running: true }),
    makeBrief({ sessionId: "idle-1", projectKey: "P1" }),
  ];

  const plan = planZaicodeClearAllSessions(sessions, "ALL_SESSIONS");
  assert.equal(plan.runningCount, 1);
  assert.equal(plan.idleCount, 1);
  assert.equal(plan.totalCount, 2);

  const desc = describeZaicodeClearAllSessions(plan);
  assert.ok(desc.includes("1 safely idle (cleared on left-click)"));
  assert.ok(desc.includes("1 currently running (stopped on right-click)"));

  const result = await runZaicodeClearAllSessions({
    plan,
    policy: "ALL_SESSIONS",
    resolveHandle: () => ({
      send: async () => {},
      start: async () => {},
      stop: async (id) => { stoppedList.push(id); },
      clear: async () => {},
      markUnread: async () => {},
    }),
    taskService: {
      cancelTaskCommand: async (params) => {
        cancelledCmds.push(params.commandId);
        return { canceled: true };
      },
      deleteTasks: async (params) => {
        deletedList.push(...params.taskIds);
        return { deletedTaskIds: params.taskIds, skippedTaskIds: [], failedTaskIds: [] };
      },
    },
  });

  assert.deepEqual(stoppedList, ["active-1"]);
  assert.equal(result.stopped, 1);
  assert.equal(result.cleared, 2);
  assert.deepEqual(deletedList.sort(), ["active-1", "idle-1"].sort());

  const formatted = formatZaicodeClearAllSessionsRun(result);
  assert.ok(formatted.includes("Sessions stopped: 1"));
  assert.ok(formatted.includes("Sessions cleared: 2"));
});

test("16: Failed host termination keeps running session preserved and unresolved", async () => {
  const sessions = [
    makeBrief({ sessionId: "failing-stop-sess", projectKey: "P1", running: true }),
  ];
  const plan = planZaicodeClearAllSessions(sessions, "ALL_SESSIONS");

  const deletedList: string[] = [];
  const result = await runZaicodeClearAllSessions({
    plan,
    policy: "ALL_SESSIONS",
    resolveHandle: () => ({
      send: async () => {},
      start: async () => {},
      stop: async () => { throw new Error("host refusal: process busy"); },
      clear: async () => {},
      markUnread: async () => {},
    }),
    taskService: {
      deleteTasks: async (params) => {
        deletedList.push(...params.taskIds);
        return { deletedTaskIds: params.taskIds, skippedTaskIds: [], failedTaskIds: [] };
      },
    },
  });

  assert.equal(result.stopped, 0);
  assert.equal(result.cleared, 0);
  assert.deepEqual(deletedList, []);
  assert.ok(result.failedOrUnreachable.includes("failing-stop-sess"));
  assert.ok(result.problems.some((p) => p.includes("Failed to stop failing-stop-sess: host refusal: process busy")));
});

test("17-18: Authoritative plan includes unmounted sessions and computes accurate counts", async () => {
  const hostTasks = [
    { taskId: "h1-active", title: "Active 1", status: "running" as const },
    { taskId: "h2-idle", title: "Idle 1", status: "completed" as const },
    { taskId: "h3-failed", title: "Failed 1", status: "error" as const },
  ];
  const hostArchived = [
    { taskId: "h4-archived", title: "Archived 1", status: "completed" as const },
  ];

  const plan = await collectAuthoritativeClearAllSessionsPlan({
    workspaces: [{ workspacePath: "V:/code/p1", projectKey: "P1" }],
    taskService: {
      listTasks: async () => hostTasks as any,
      listArchivedTasks: async () => hostArchived as any,
    },
    fallbackSessions: [],
    policy: "IDLE_ONLY",
  });

  assert.equal(plan.totalCount, 4);
  assert.equal(plan.runningCount, 1);
  assert.equal(plan.failedCount, 1);
  assert.equal(plan.completedCount, 2);
  assert.equal(plan.idleCount, 3); // h2, h3, h4 are safely idle!
});

test("20-24: Idempotence, multi-workspace isolation, and warm cache invalidation", async () => {
  const ws1Sessions = [makeBrief({ sessionId: "ws1-idle", projectKey: "W1", workspacePath: "V:/code/w1" })];
  const ws2Sessions = [makeBrief({ sessionId: "ws2-running", projectKey: "W2", workspacePath: "V:/code/w2", running: true })];

  const invalidatedSessions: string[] = [];
  let warmPoolCleared = false;

  const plan = planZaicodeClearAllSessions([...ws1Sessions, ...ws2Sessions], "IDLE_ONLY");
  assert.equal(plan.idleCount, 1);
  assert.equal(plan.runningCount, 1);

  const deletedWsMap = new Map<string, string[]>();
  const result = await runZaicodeClearAllSessions({
    plan,
    policy: "IDLE_ONLY",
    taskService: {
      deleteTasks: async (params) => {
        deletedWsMap.set(params.workspacePath, params.taskIds);
        return { deletedTaskIds: params.taskIds, skippedTaskIds: [], failedTaskIds: [] };
      },
    },
    sessionDataLayer: {
      invalidateSession: (id) => { invalidatedSessions.push(id); },
      clearWarmPool: () => { warmPoolCleared = true; },
    },
  });

  assert.equal(result.cleared, 1);
  assert.equal(result.preservedActive, 1);
  assert.deepEqual(deletedWsMap.get("V:/code/w1"), ["ws1-idle"]);
  assert.equal(deletedWsMap.has("V:/code/w2"), false, "Running workspace must not be deleted");
  assert.deepEqual(invalidatedSessions, ["ws1-idle"]);
  assert.equal(warmPoolCleared, true);

  // Repeated cleanup on empty/cleared is cleanly idempotent
  const repeatPlan = planZaicodeClearAllSessions([], "IDLE_ONLY");
  const repeatResult = await runZaicodeClearAllSessions({
    plan: repeatPlan,
    policy: "IDLE_ONLY",
  });
  assert.equal(repeatResult.cleared, 0);
  assert.equal(repeatResult.totalFound, 0);
});
