import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  fetchTaskListMembershipSets,
  fetchTaskListMembershipSetsForEndpointsCached,
  armTaskListMembershipRefreshHoldForE2E,
  releaseTaskListMembershipRefreshHoldForE2E,
} from "../src/lib/taskListMembershipSets.js";
import { unionCommittedAndLiveSessionRows } from "../src/zaicode/zaicodeSidebarPrefs.js";
import { attachTaskListRowActivity } from "../src/v4/taskListRowActivity.js";
import { zaicodeSessionBriefOf } from "../src/zaicode/zaicodeContinue.js";
import { pickZaicodeBackgroundRetrySessions } from "../src/zaicode/zaicodeTurnRetryWatch.js";
import { planZaicodeCrashResume } from "../src/zaicode/zaicodeCrashResume.js";
import type { ZCodeTaskMeta } from "@zcode/shared";

const scope = { workspacePath: "V:/runtime-trust/a", workspaceIdentity: "remote:a" };
const rows = ["deleted", "active-outside-page"].map((taskId) =>
  attachTaskListRowActivity({
    ...scope, taskId, title: taskId, updatedAt: 2000, status: "error",
    target: { status: "active", objective: "fixture" },
  } as ZCodeTaskMeta, {
    phase: "error", lastActivityAt: 2000, hasBackgroundWork: false, sessionEnded: true,
  }),
);
function service() {
  return {
    listPinnedTaskIds: async () => [] as string[],
    listPinnedTasks: async () => [] as ZCodeTaskMeta[],
    listArchivedTasks: async () => [] as ZCodeTaskMeta[],
    listTasks: async () => [rows[1]!],
    listDeletedTaskIds: async () => ["deleted"],
  };
}
afterEach(() => releaseTaskListMembershipRefreshHoldForE2E());

test("negative membership: a rejected tombstone RPC is not an authoritative empty result", async () => {
  const endpoint = service();
  endpoint.listDeletedTaskIds = async () => { throw Error("membership disconnected"); };
  await assert.rejects(fetchTaskListMembershipSets({ service: endpoint, scopes: [scope] }), /读取不完整|membership/i);
});

test("negative membership: missing tombstone capability is unavailable", async () => {
  const { listDeletedTaskIds: _omitted, ...endpoint } = service();
  await assert.rejects(fetchTaskListMembershipSets({ service: endpoint, scopes: [scope] }));
});

test("negative membership: a successful empty RPC permits genuine pagination omissions", async () => {
  const endpoint = service();
  endpoint.listDeletedTaskIds = async () => [];
  const membership = await fetchTaskListMembershipSets({ service: endpoint, scopes: [scope] });
  assert.equal(membership.deletedIds.size, 0);
  const active = unionCommittedAndLiveSessionRows([], [rows[1]!], scope.workspaceIdentity, 3000, true, membership.deletedIds);
  assert.equal(active.length, 1);
});

test("negative membership: failure is evicted from the shared promise cache; recovery and replay exclude deleted work", async () => {
  const endpoint = service();
  let reads = 0;
  endpoint.listDeletedTaskIds = async () => {
    if (++reads === 1) throw Error("first tombstone read failed");
    return ["deleted"];
  };
  const request = { cacheKey: "runtime-trust-recovery", endpoints: [{ service: endpoint, scopes: [scope] }] };
  await assert.rejects(fetchTaskListMembershipSetsForEndpointsCached(request));
  const membership = await fetchTaskListMembershipSetsForEndpointsCached(request);
  for (let replay = 0; replay < 5; replay++) {
    const cached = await fetchTaskListMembershipSetsForEndpointsCached(request);
    assert.equal(cached, membership);
    const joined = unionCommittedAndLiveSessionRows([], rows, scope.workspaceIdentity, 3000, true, cached.deletedIds);
    const briefs = joined.map((row) => zaicodeSessionBriefOf(row, scope.workspaceIdentity, scope));
    const retries = pickZaicodeBackgroundRetrySessions(briefs, {
      isLocal: () => false, isProjectDisabled: () => false, attemptsOf: () => 0, maxAttempts: 3, isQuotaWall: () => false,
    });
    assert.deepEqual(retries.map((brief) => brief.sessionId), ["active-outside-page"]);
    assert.ok(!planZaicodeCrashResume(briefs, () => ({ hasSaipen: true, disabled: false }), 3000, 24)
      .some((step) => step.sessionId === "deleted"));
  }
  assert.equal(reads, 2, "replay shares the authenticated snapshot rather than dispatching deleted work");
});

test("negative membership: failed archived membership rejects the entire join", async () => {
  const endpoint = service();
  endpoint.listArchivedTasks = async () => { throw Error("archive read failed"); };
  await assert.rejects(fetchTaskListMembershipSets({ service: endpoint, scopes: [scope] }));
});

test("negative membership: a known tombstone also excludes a stale committed row without a live frame", () => {
  assert.deepEqual(unionCommittedAndLiveSessionRows([rows[0]!], [], scope.workspaceIdentity, 3000, true, new Set(["deleted"])), []);
});

test("negative membership: refresh hold retains a successfully read snapshot until release", async () => {
  armTaskListMembershipRefreshHoldForE2E();
  let settled = false;
  const reading = fetchTaskListMembershipSets({ service: service(), scopes: [scope] }).then((result) => {
    settled = true;
    return result;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseTaskListMembershipRefreshHoldForE2E();
  assert.deepEqual([...(await reading).deletedIds], ["deleted"]);
});
