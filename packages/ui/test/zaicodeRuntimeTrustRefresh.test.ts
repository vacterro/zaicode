import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useTaskQueryCacheStore } from "../src/store/taskQueryCacheStore.js";
import {
  armTaskListMembershipRefreshHoldForE2E,
  fetchTaskListMembershipSets,
  membershipServiceIdOf,
  readWorkspaceTaskMembership,
  releaseTaskListMembershipRefreshHoldForE2E,
} from "../src/lib/taskListMembershipSets.js";
import { unionCommittedAndLiveSessionRows } from "../src/zaicode/zaicodeSidebarPrefs.js";
import { attachTaskListRowActivity } from "../src/v4/taskListRowActivity.js";
import { selectPendingWorkspaceTaskQueries } from "../src/hooks/workspaceTaskListRefreshSignatures.js";
import type { TaskListCacheDescriptor, TaskListMembershipSnapshot } from "../src/lib/taskQueryCache.js";

const a = { workspacePath: "V:/same", workspaceIdentity: "remote:a" };
const b = { workspacePath: "V:/same", workspaceIdentity: "remote:b" };
function endpoint(deleted: string[] = ["deleted"]) {
  return {
    listPinnedTaskIds: async () => [] as string[], listPinnedTasks: async () => [] as ZCodeTaskMeta[],
    listArchivedTasks: async () => [] as ZCodeTaskMeta[], listTasks: async () => [] as ZCodeTaskMeta[],
    listDeletedTaskIds: async () => deleted,
  };
}
function descriptor(key: string): TaskListCacheDescriptor {
  return { kind: "workspace", sortBy: "updated", search: "", expanded: false, visibleLimit: 1, workspaceKeys: [key] };
}
function snapshot(service: ReturnType<typeof endpoint>, deletedIds: string[], version = 1): TaskListMembershipSnapshot {
  return { version, serviceId: membershipServiceIdOf(service), deletedIds, archivedIds: [], pinnedIds: [] };
}
function commit(key: string, membership: TaskListMembershipSnapshot, expectedInvalidationVersion?: number, items: ZCodeTaskMeta[] = []) {
  useTaskQueryCacheStore.getState().setQueryResults([{
    queryKey: key, descriptor: descriptor(key), membership, expectedInvalidationVersion, items, total: items.length, hasMore: false,
  }]);
}
function read(key: string, service?: ReturnType<typeof endpoint>, version = 1) {
  return readWorkspaceTaskMembership({ resultsByQueryKey: useTaskQueryCacheStore.getState().resultsByQueryKey, workspaceKey: key, version, service });
}
function running(scope: typeof a, id = "deleted") {
  return attachTaskListRowActivity({ ...scope, taskId: id, title: id, status: "running", updatedAt: 2000 } as ZCodeTaskMeta,
    { phase: "running", lastActivityAt: 2000, hasBackgroundWork: true, sessionEnded: false });
}
afterEach(() => {
  releaseTaskListMembershipRefreshHoldForE2E();
  useTaskQueryCacheStore.getState().clearAll();
});

test("partial refresh: B-only commit retains A tombstone and separate remote identity", () => {
  const sa = endpoint(), sb = endpoint([]);
  commit(a.workspaceIdentity, snapshot(sa, ["deleted"]));
  commit(b.workspaceIdentity, snapshot(sb, []));
  useTaskQueryCacheStore.getState().markWorkspaceKeysStale([b.workspaceIdentity]);
  const pending = selectPendingWorkspaceTaskQueries([
    { workspaceKey: a.workspaceIdentity, queryKey: a.workspaceIdentity },
    { workspaceKey: b.workspaceIdentity, queryKey: b.workspaceIdentity },
  ], useTaskQueryCacheStore.getState().resultsByQueryKey, b.workspaceIdentity);
  assert.deepEqual(pending.map((entry) => entry.workspaceKey), [b.workspaceIdentity]);
  const beforeA = useTaskQueryCacheStore.getState().resultsByQueryKey[a.workspaceIdentity];
  commit(b.workspaceIdentity, snapshot(sb, []));
  assert.equal(useTaskQueryCacheStore.getState().resultsByQueryKey[a.workspaceIdentity], beforeA);
  assert.equal(read(a.workspaceIdentity, sa).ready, true);
  assert.deepEqual([...read(a.workspaceIdentity, sa).deletedIds], ["deleted"]);
  assert.equal(unionCommittedAndLiveSessionRows([], [running(a)], a.workspaceIdentity, 3000, true, read(a.workspaceIdentity, sa).excludedIds).length, 0);
  assert.equal(unionCommittedAndLiveSessionRows([], [running(b)], b.workspaceIdentity, 3000, true, read(b.workspaceIdentity, sb).excludedIds).length, 1);
});

test("failure/disconnect/reconnect: keep known exclusions while current automation authority is unavailable", async () => {
  const original = endpoint();
  commit(a.workspaceIdentity, snapshot(original, ["deleted"]));
  assert.equal(read(a.workspaceIdentity).ready, false);
  assert.ok(read(a.workspaceIdentity).deletedIds.has("deleted"));
  assert.equal(read(a.workspaceIdentity, original, 2).ready, false);
  const reconnected = endpoint();
  reconnected.listDeletedTaskIds = async () => { throw Error("remote RPC unavailable"); };
  await assert.rejects(fetchTaskListMembershipSets({ service: reconnected, scopes: [a] }));
  assert.equal(read(a.workspaceIdentity, reconnected).ready, false);
  assert.ok(read(a.workspaceIdentity, reconnected).deletedIds.has("deleted"));
  reconnected.listDeletedTaskIds = async () => ["deleted"];
  const recovered = await fetchTaskListMembershipSets({ service: reconnected, scopes: [a] });
  commit(a.workspaceIdentity, { ...recovered.membershipByWorkspaceKey.get(a.workspaceIdentity)!, version: 1, serviceId: membershipServiceIdOf(reconnected) });
  assert.equal(read(a.workspaceIdentity, reconnected).ready, true);
  assert.ok(read(a.workspaceIdentity, reconnected).deletedIds.has("deleted"));
});

test("out-of-order refresh: held old empty membership cannot overwrite a newer deletion", async () => {
  const service = endpoint([]);
  commit(a.workspaceIdentity, snapshot(service, []));
  armTaskListMembershipRefreshHoldForE2E();
  const oldRead = fetchTaskListMembershipSets({ service, scopes: [a] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  useTaskQueryCacheStore.getState().markWorkspaceKeysStale([a.workspaceIdentity]);
  service.listDeletedTaskIds = async () => ["deleted"];
  const newRead = fetchTaskListMembershipSets({ service, scopes: [a] });
  releaseTaskListMembershipRefreshHoldForE2E();
  const next = await newRead;
  commit(a.workspaceIdentity, { ...next.membershipByWorkspaceKey.get(a.workspaceIdentity)!, version: 2, serviceId: membershipServiceIdOf(service) }, 1);
  const old = await oldRead;
  commit(a.workspaceIdentity, { ...old.membershipByWorkspaceKey.get(a.workspaceIdentity)!, version: 1, serviceId: membershipServiceIdOf(service) }, 0);
  assert.equal(read(a.workspaceIdentity, service, 2).ready, true);
  assert.ok(read(a.workspaceIdentity, service, 2).deletedIds.has("deleted"));
});

test("project switch: a response for A cannot grant membership authority to B", () => {
  const service = endpoint();
  commit(a.workspaceIdentity, snapshot(service, ["deleted"]));
  assert.equal(read(b.workspaceIdentity, service).ready, false);
  assert.equal(read(b.workspaceIdentity, service).deletedIds.size, 0);
});

test("restart after deletion: no cached membership means no automatic work; persistent tombstone survives hydration", async () => {
  const persisted = endpoint();
  assert.equal(read(a.workspaceIdentity, persisted).ready, false);
  const membership = await fetchTaskListMembershipSets({ service: persisted, scopes: [a] });
  commit(a.workspaceIdentity, { ...membership.membershipByWorkspaceKey.get(a.workspaceIdentity)!, version: 1, serviceId: membershipServiceIdOf(persisted) });
  assert.ok(read(a.workspaceIdentity, persisted).deletedIds.has("deleted"));
  useTaskQueryCacheStore.getState().clearAll();
  persisted.listDeletedTaskIds = async () => { throw Error("restart RPC failed"); };
  await assert.rejects(fetchTaskListMembershipSets({ service: persisted, scopes: [a] }));
  assert.equal(read(a.workspaceIdentity, persisted).ready, false);
});

test("running projection: unloaded membership shows live running; known deleted ghosts disappear; archived and pinned true runs remain visible", () => {
  const live = running(a);
  assert.equal(unionCommittedAndLiveSessionRows([], [live], a.workspaceIdentity, 3000).length, 1);
  const service = endpoint();
  commit(a.workspaceIdentity, { ...snapshot(service, ["deleted"]), archivedIds: ["archived"], pinnedIds: ["pinned"] });
  const membership = read(a.workspaceIdentity, service);
  const all = [live, running(a, "archived"), running(a, "pinned")];
  assert.deepEqual(unionCommittedAndLiveSessionRows([], all, a.workspaceIdentity, 3000, false, membership.deletedIds).map((row) => row.taskId), ["archived", "pinned"]);
  assert.deepEqual(unionCommittedAndLiveSessionRows([], all, a.workspaceIdentity, 3000, true, membership.excludedIds), []);
});

test("authoritative deletion defeats optimistic fresh-row preservation in the existing cache", () => {
  const service = endpoint();
  const ghost = { ...running(a), updatedAt: Date.now() + 10000 };
  commit(a.workspaceIdentity, snapshot(service, []), undefined, [ghost]);
  commit(a.workspaceIdentity, snapshot(service, ["deleted"], 2));
  assert.deepEqual(useTaskQueryCacheStore.getState().resultsByQueryKey[a.workspaceIdentity]!.taskKeys, []);
});

test("successful empty membership grants automation and unchanged replay preserves result identity", () => {
  const service = endpoint([]);
  commit(a.workspaceIdentity, snapshot(service, []));
  const initial = useTaskQueryCacheStore.getState().resultsByQueryKey[a.workspaceIdentity];
  for (let replay = 0; replay < 20; replay++) commit(a.workspaceIdentity, snapshot(service, []));
  assert.equal(useTaskQueryCacheStore.getState().resultsByQueryKey[a.workspaceIdentity], initial);
  assert.equal(read(a.workspaceIdentity, service).ready, true);
});
