import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import { buildWorkspaceTaskListDisplayGroups } from "../src/hooks/workspaceTaskListDisplayGroups.js";
import { mapSessionSummaryToTaskMeta } from "../src/v4/mapSessionSummaryToTaskMeta.js";
import { getTaskListRowActivity } from "../src/v4/taskListRowActivity.js";

test("T-240: actual workspace group cache carries new runtime observations without a progress event", () => {
  const summary: SessionSummary = {
    sessionId: "quiet-worker",
    workspaceId: "C:/fixture",
    title: "Quiet worker",
    phase: "completedSuccess",
    sessionEnded: true,
    hasBackgroundWork: true,
    createdAt: 1,
    lastActivityAt: 1,
    executionLiveness: {
      ownerId: "runtime",
      observedAt: 1000,
      validUntil: 121000,
      released: false,
      foregroundExecutionId: "finishing-command",
      background: [{ workId: "worker", status: "running", confirmedAt: 1000 }],
      orphaned: false,
      unconfirmed: false,
    },
  };
  const initial = mapSessionSummaryToTaskMeta(summary, {
    workspacePath: "C:/fixture",
    livenessReceivedAt: 1000,
  });
  const params: Parameters<typeof buildWorkspaceTaskListDisplayGroups>[0] = {
    queryConfigs: [
      {
        scope: { workspacePath: "C:/fixture" },
        workspaceKey: "fixture",
        visibleLimit: 5,
        queryKey: "query",
      },
    ],
    resultsByQueryKey: { query: { taskKeys: ["key"], total: 1, unreadTaskKeys: [] } } as any,
    taskMetaByEntityKey: { key: initial },
    taskUnreadOverlayByEntityKey: {},
    optimisticTaskOverlayByWorkspaceKey: new Map(),
    previousGroupsByWorkspaceKey: new Map(),
    sortBy: "updated",
  };
  const before = buildWorkspaceTaskListDisplayGroups(params);
  assert.equal(
    getTaskListRowActivity(before.groups[0]!.items[0]!)?.executionLiveness?.foregroundExecutionId,
    "finishing-command",
  );
  const renewed = structuredClone(summary);
  renewed.executionLiveness!.observedAt = 31000;
  renewed.executionLiveness!.validUntil = 151000;
  renewed.executionLiveness!.background[0]!.confirmedAt = 31000;
  delete renewed.executionLiveness!.foregroundExecutionId;
  const next = mapSessionSummaryToTaskMeta(renewed, {
    workspacePath: "C:/fixture",
    livenessReceivedAt: 31000,
  });
  assert.equal(next.updatedAt, initial.updatedAt);
  const after = buildWorkspaceTaskListDisplayGroups({
    ...params,
    taskMetaByEntityKey: { key: next },
    previousGroupsByWorkspaceKey: before.cache,
  });
  const proof = getTaskListRowActivity(after.groups[0]!.items[0]!)?.executionLiveness;
  assert.equal(
    proof?.observedAt,
    31000,
    "heartbeat must survive the final real workspace group cache",
  );
  assert.equal(
    proof?.foregroundExecutionId,
    undefined,
    "finished foreground ownership must not be cached forever",
  );
  assert.notEqual(after.groups[0], before.groups[0]);
  const repeated = buildWorkspaceTaskListDisplayGroups({
    ...params,
    taskMetaByEntityKey: { key: next },
    previousGroupsByWorkspaceKey: after.cache,
  });
  assert.equal(
    repeated.groups[0],
    after.groups[0],
    "identical repeated observations still reuse the group",
  );
});
