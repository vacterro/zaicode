import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SessionDataLayer,
  RetiredSessionError,
  isRetiredSessionError,
} from "../src/v4/sessionDataLayer.js";
import {
  isSessionRetired,
  retireSessions,
  subscribeSessionRetirement,
  notifySessionRetirement,
} from "../src/zaicode/zaicodeCleanupFence.js";
import {
  reconcileRetiredSessionInLayout,
  V4_PRIMARY_PANE_ID,
  type PaneLayoutSnapshot,
} from "../src/v4/paneLayoutTree.js";
import {
  reconcileRetiredSessionInGroups,
} from "../src/v4/workbenchGroupStore.js";
import {
  sanitizePersistedPaneLayout,
} from "../src/v4/paneLayoutPersistence.js";
import { useZCodeSessionStore } from "../src/store/zcodeSessionStore.js";
import {
  planZaicodeClearAllSessions,
  runZaicodeClearAllSessions,
} from "../src/zaicode/zaicodeClearAllSessions.js";
import type { ZaicodeSessionBrief } from "../src/zaicode/zaicodeContinue.js";
import type { ConversationTransport, CommandEnvelope, CommandAck } from "@zcode/shared";

function createMockTransport(): ConversationTransport {
  return {
    subscribe: async ({ topic }) => ({ ack: { subscriptionId: `sub-${topic}`, openTiming: {} } } as any),
    activate: () => {},
    resync: async () => ({} as any),
    unsubscribe: async () => {},
    sendCommand: async (_envelope: CommandEnvelope): Promise<CommandAck> => ({
      commandId: "cmd-1",
      status: "accepted",
    }),
    onFrame: () => () => {},
  };
}

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

test("SRC-283 Regression H & I & T: SessionDataLayer.acquire rejects retired session with typed RetiredSessionError", () => {
  const layer = new SessionDataLayer({ transport: createMockTransport() });
  const retiredId = `sess_retire_${Date.now()}_1`;
  retireSessions([retiredId]);

  assert.equal(isSessionRetired(retiredId), true, "Session must be marked as retired");

  // Acquire must throw RetiredSessionError (H, I)
  let caughtError: unknown = null;
  try {
    layer.acquire(retiredId);
  } catch (err) {
    caughtError = err;
  }

  assert.ok(caughtError instanceof RetiredSessionError, "Should throw instance of RetiredSessionError");
  assert.equal(isRetiredSessionError(caughtError), true, "isRetiredSessionError must return true");
  assert.equal((caughtError as RetiredSessionError).sessionId, retiredId);
  assert.equal((caughtError as Error).name, "RetiredSessionError");

  // Non-retired session or generic error must NOT match
  const genericError = new Error("Generic network error");
  assert.equal(isRetiredSessionError(genericError), false, "Generic error must not match");

  // No resurrection (T): second acquire still fails identically
  assert.throws(
    () => layer.acquire(retiredId),
    (err: unknown) => isRetiredSessionError(err) && (err as RetiredSessionError).sessionId === retiredId,
    "No session resurrection: acquire repeatedly throws RetiredSessionError",
  );

  layer.dispose();
});

test("SRC-283 Regression E, F, G: Split pane references reconcile correctly when session is retired", () => {
  const retiredId = `sess_split_${Date.now()}_2`;

  // Layout with 2 panes holding the same session
  const layoutState: PaneLayoutSnapshot = {
    root: {
      type: "split",
      id: "split-root",
      direction: "row",
      ratio: 0.5,
      first: {
        type: "leaf",
        paneId: V4_PRIMARY_PANE_ID,
      },
      second: {
        type: "leaf",
        paneId: "pane-secondary-1",
      },
    },
    panes: {
      "pane-secondary-1": {
        sessionId: retiredId,
        workspaceScope: { workspacePath: "V:/code/proj" },
      },
    },
    focusedPaneId: "pane-secondary-1",
  };

  const reconciledLayout = reconcileRetiredSessionInLayout(layoutState, retiredId);
  assert.equal(reconciledLayout.panes["pane-secondary-1"], undefined, "Closed secondary pane must be removed from layout");
  assert.equal(reconciledLayout.root.type, "leaf", "Tree must collapse to single leaf after secondary closed");

  // WorkbenchGroupStore reconciliation
  const initialGroupSnapshot = {
    activeGroupId: "group-1",
    groups: {
      "group-1": {
        id: "group-1",
        primaryBinding: {
          sessionId: "sess_primary",
          workspaceScope: { workspacePath: "V:/code/proj" },
        },
        root: {
          type: "split" as const,
          id: "split-1",
          direction: "row" as const,
          ratio: 0.5,
          first: { type: "leaf" as const, paneId: V4_PRIMARY_PANE_ID },
          second: { type: "leaf" as const, paneId: "pane-secondary-1" },
        },
        panes: {
          "pane-secondary-1": {
            sessionId: retiredId,
            workspaceScope: { workspacePath: "V:/code/proj" },
          },
        },
        focusedPaneId: V4_PRIMARY_PANE_ID,
        updatedAt: Date.now(),
      },
    },
    sessionIndex: {
      "V:/code/proj::sess_primary": "group-1",
      [`V:/code/proj::${retiredId}`]: "group-1",
    },
  };

  const reconciledGroupSnapshot = reconcileRetiredSessionInGroups(initialGroupSnapshot, retiredId);
  assert.equal(
    reconciledGroupSnapshot.groups["group-1"]?.panes["pane-secondary-1"],
    undefined,
    "Retired session in secondary pane must be reconciled and removed",
  );

  const primaryRetiredGroupSnapshot = {
    activeGroupId: "group-2",
    groups: {
      "group-2": {
        id: "group-2",
        primaryBinding: {
          sessionId: retiredId,
          workspaceScope: { workspacePath: "V:/code/proj" },
        },
        root: { type: "leaf" as const, paneId: V4_PRIMARY_PANE_ID },
        panes: {},
        focusedPaneId: V4_PRIMARY_PANE_ID,
        updatedAt: Date.now(),
      },
    },
    sessionIndex: {
      [`V:/code/proj::${retiredId}`]: "group-2",
    },
  };
  const reconciledPrimaryGroup = reconcileRetiredSessionInGroups(primaryRetiredGroupSnapshot, retiredId);
  assert.equal(reconciledPrimaryGroup.groups["group-2"], undefined, "Group whose primary session retired must be deleted");
});

test("SRC-283 Regression J, K, L: Startup persistence reconciliation clears retired session without crash", () => {
  const retiredId = `sess_persisted_${Date.now()}_3`;
  retireSessions([retiredId]);

  const persistedLayout = {
    root: {
      type: "split" as const,
      id: "s1",
      direction: "row" as const,
      ratio: 0.5,
      first: { type: "leaf" as const, paneId: V4_PRIMARY_PANE_ID },
      second: { type: "leaf" as const, paneId: "pane-split-1" },
    },
    panes: {
      "pane-split-1": {
        workspaceScope: { workspacePath: "V:/code/proj" },
        sessionId: retiredId,
      },
    },
    focusedPaneId: V4_PRIMARY_PANE_ID,
  };

  const sanitized = sanitizePersistedPaneLayout(persistedLayout);
  assert.ok(sanitized, "Sanitized layout must exist");
  assert.equal(sanitized.panes["pane-split-1"]?.sessionId, null, "Retired session must be sanitized to null draft");
});

test("SRC-283 Regression M & N: Cross-window deletion notification reconciles active store", () => {
  const remoteRetiredId = `sess_remote_${Date.now()}_4`;
  let receivedRetirements: string[] = [];

  const unsubscribe = subscribeSessionRetirement((retiredIds) => {
    receivedRetirements.push(...retiredIds);
  });

  notifySessionRetirement([remoteRetiredId]);

  assert.ok(receivedRetirements.includes(remoteRetiredId), "Subscriber must receive cross-window retired session id");
  assert.equal(isSessionRetired(remoteRetiredId), true, "Cross-window retired session must be marked retired");

  unsubscribe();
});

test("SRC-283 Regression A, B, C, D: CLEAR IDLE cleans idle session and reconciles active store to clean draft", async () => {
  const idleSessionId = `sess_idle_${Date.now()}_5`;
  const workspacePath = "V:/code/proj";

  // Simulate active session in store
  useZCodeSessionStore.getState().setActiveTaskId(workspacePath, idleSessionId);
  assert.equal(
    useZCodeSessionStore.getState().getWorkspaceState(workspacePath).activeTaskId,
    idleSessionId,
  );

  const idleSession = makeBrief({
    sessionId: idleSessionId,
    projectKey: "proj-1",
    workspacePath,
    running: false,
    waiting: false,
  });

  const plan = planZaicodeClearAllSessions([idleSession], "IDLE_ONLY", { activeSessionId: idleSessionId });

  let deletedSessions: string[] = [];
  const runResult = await runZaicodeClearAllSessions({
    plan,
    policy: "IDLE_ONLY",
    taskService: {
      deleteTasks: async ({ taskIds }) => {
        deletedSessions.push(...taskIds);
        return { deletedTaskIds: taskIds, failedTaskIds: [] };
      },
      deleteTask: async () => {},
      deleteArchivedTasks: async () => {},
      listArchivedTasks: async () => [],
      cancelTaskCommand: async () => {},
      listTasks: async () => [],
    },
  });

  assert.equal(runResult.cleared, 1, "Idle session must be cleared");
  assert.ok(deletedSessions.includes(idleSessionId), "Session must be passed to deleteTasks");
  assert.equal(isSessionRetired(idleSessionId), true, "Session must be marked retired");

  // Verify store subscription reconciled activeTaskId to null
  const currentActive = useZCodeSessionStore.getState().getWorkspaceState(workspacePath).activeTaskId;
  assert.equal(currentActive, null, "Active selection must transition to clean draft state (null)");
});

test("SRC-283 Regression O & P: CLEAR IDLE preserves active running session", async () => {
  const activeSessionId = `sess_active_${Date.now()}_6`;
  const workspacePath = "V:/code/proj";

  const runningSession = makeBrief({
    sessionId: activeSessionId,
    projectKey: "proj-1",
    workspacePath,
    running: true, // ACTIVE WORK
  });

  const plan = planZaicodeClearAllSessions([runningSession], "IDLE_ONLY", { activeSessionId });

  let deleteCalled = false;
  const runResult = await runZaicodeClearAllSessions({
    plan,
    policy: "IDLE_ONLY",
    taskService: {
      deleteTasks: async () => {
        deleteCalled = true;
        return { deletedTaskIds: [], failedTaskIds: [] };
      },
      deleteTask: async () => {},
      deleteArchivedTasks: async () => {},
      listArchivedTasks: async () => [],
      cancelTaskCommand: async () => {},
      listTasks: async () => [],
    },
  });

  assert.equal(deleteCalled, false, "Active running session must NOT be passed to deleteTasks");
  assert.equal(runResult.cleared, 0, "No active session cleared");
  assert.equal(runResult.preservedActive, 1, "Active session preserved");
  assert.equal(isSessionRetired(activeSessionId), false, "Active session must NOT be retired");
});

test("SRC-283 Regression Q & R: Refused Host deletion preserves valid session selection", async () => {
  const failedSessionId = `sess_failed_${Date.now()}_7`;
  const workspacePath = "V:/code/proj";

  useZCodeSessionStore.getState().setActiveTaskId(workspacePath, failedSessionId);

  const idleSession = makeBrief({
    sessionId: failedSessionId,
    projectKey: "proj-1",
    workspacePath,
    running: false,
    waiting: false,
  });

  const plan = planZaicodeClearAllSessions([idleSession], "IDLE_ONLY", { activeSessionId: failedSessionId });

  const runResult = await runZaicodeClearAllSessions({
    plan,
    policy: "IDLE_ONLY",
    taskService: {
      deleteTasks: async () => ({
        deletedTaskIds: [],
        failedTaskIds: [failedSessionId], // Host refused deletion
      }),
      deleteTask: async () => {},
      deleteArchivedTasks: async () => {},
      listArchivedTasks: async () => [],
      cancelTaskCommand: async () => {},
      listTasks: async () => [],
    },
  });

  assert.equal(runResult.cleared, 0, "No session cleared on refusal");
  assert.ok(runResult.failedOrUnreachable.includes(failedSessionId));
  assert.equal(isSessionRetired(failedSessionId), false, "Failed session must NOT be marked retired");

  // Selection must remain intact
  const activeNow = useZCodeSessionStore.getState().getWorkspaceState(workspacePath).activeTaskId;
  assert.equal(activeNow, failedSessionId, "Selection must remain intact when Host refuses deletion");
});

test("SRC-283 Regression S & U: Repeated cleanup is idempotent and preserves unrelated sessions", () => {
  const targetId = `sess_idempotent_${Date.now()}_8`;
  const unrelatedId = `sess_unrelated_${Date.now()}_9`;

  // First retirement
  retireSessions([targetId]);
  assert.equal(isSessionRetired(targetId), true);
  assert.equal(isSessionRetired(unrelatedId), false);

  // Repeated retirement
  retireSessions([targetId]);
  assert.equal(isSessionRetired(targetId), true, "Repeated retirement is idempotent");
  assert.equal(isSessionRetired(unrelatedId), false, "Unrelated session remains untouched (U)");
});
