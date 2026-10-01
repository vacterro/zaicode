// T-164 / SRC-116 TRACK A —— 渲染进程累积量的显式上界。
//
// 每条断言都对着一个真实的累积源：这些集合在 6-9 小时长跑里是单调增长的，
// 而它们的读者本来就按"缺失 = 还没取过 / 用默认值"处理，所以截断是自愈的。
import assert from "node:assert/strict";
import test from "node:test";

import {
  ZAICODE_QUERY_CACHE_RETENTION,
  ZAICODE_TASK_STATE_RETENTION,
  boundRecordByFirstTouch,
} from "../src/store/recordFirstTouchRetention.js";
import { ZAICODE_TOAST_LIMIT, boundZaicodeToasts } from "../src/zaicode/zaicodeNotifications.js";
import {
  ZAICODE_AUDIT_HISTORY_LIMIT,
  boundZaicodeAuditCampaigns,
} from "../src/zaicode/zaicodeAuditStore.js";
import {
  SIDE_PANE_DETACHED_TERMINAL_LIMIT,
  sidePaneTerminalSessionRegistry,
  type SidePaneTerminalSessionEntry,
} from "../src/terminal/sidePaneTerminalSessionRegistry.js";
import { updateWorkspaceState } from "../src/store/zcodeSessionStoreSelectors.js";
import { createDefaultWorkspaceState } from "../src/store/zcodeSessionStoreTypes.js";

function makeRecord(count: number, prefix = "t"): Record<string, number> {
  const record: Record<string, number> = {};
  for (let i = 0; i < count; i += 1) record[`${prefix}${i}`] = i;
  return record;
}

test("a record under the cap keeps its identity so referential selectors do not re-render", () => {
  const record = makeRecord(5);
  assert.equal(boundRecordByFirstTouch(record, 8), record);
});

test("first-touch retention drops the oldest keys and keeps the newest", () => {
  const bounded = boundRecordByFirstTouch(makeRecord(10), 4);
  assert.deepEqual(Object.keys(bounded), ["t6", "t7", "t8", "t9"]);
  assert.equal(bounded.t9, 9);
});

test("a pinned key survives retention even when it is the oldest entry", () => {
  const bounded = boundRecordByFirstTouch(makeRecord(10), 4, ["t0", "t1"]);
  assert.deepEqual(Object.keys(bounded), ["t0", "t1", "t8", "t9"]);
});

test("pinning more keys than the cap never evicts anything", () => {
  const record = makeRecord(3);
  assert.equal(boundRecordByFirstTouch(record, 1, ["t0", "t1", "t2"]), record);
});

test("the query cache cap keeps the map at a fixed size no matter how many query shapes arrive", () => {
  let results: Record<string, { taskKeys: string[] }> = {};
  for (let i = 0; i < 500; i += 1) {
    results = boundRecordByFirstTouch(
      { ...results, [`q${i}`]: { taskKeys: [`task-${i}`] } },
      ZAICODE_QUERY_CACHE_RETENTION,
    );
  }
  assert.equal(Object.keys(results).length, ZAICODE_QUERY_CACHE_RETENTION);
  assert.ok(results["q499"] !== undefined);
  assert.equal(results["q0"], undefined);
});

test("the session store funnel bounds per-task mirrors and pins the selected task", () => {
  const seed = createDefaultWorkspaceState("glm" as never);
  let workspaces: Record<string, typeof seed> = { "/w": seed };
  for (let i = 0; i < ZAICODE_TASK_STATE_RETENTION + 20; i += 1) {
    const taskId = `task-${i}`;
    const patch = updateWorkspaceState(
      { workspaces } as never,
      "/w",
      (current) => ({
        ...current,
        activeTaskId: taskId,
        taskUiByTaskId: { ...current.taskUiByTaskId, [taskId]: { plan: true } as never },
        taskRuntimeByTaskId: { ...current.taskRuntimeByTaskId, [taskId]: { busy: true } as never },
      }),
    );
    workspaces = { ...workspaces, ...patch.workspaces };
  }
  const workspace = workspaces["/w"]!;
  assert.equal(Object.keys(workspace.taskUiByTaskId).length, ZAICODE_TASK_STATE_RETENTION);
  assert.equal(Object.keys(workspace.taskRuntimeByTaskId).length, ZAICODE_TASK_STATE_RETENTION);
  // 最老的 task 已经被回收。
  assert.equal(workspace.taskUiByTaskId["task-0"], undefined);
  // 选中的 task 一定在界内：它的 UI 态里挂着计划面板和权限弹窗。
  assert.notEqual(workspace.activeTaskId, null);
  assert.ok(workspace.taskUiByTaskId[workspace.activeTaskId!] !== undefined);
  assert.ok(workspace.taskRuntimeByTaskId[workspace.activeTaskId!] !== undefined);
});

test("the session store funnel keeps the oldest task when it is the selected one", () => {
  const seed = createDefaultWorkspaceState("glm" as never);
  let workspaces: Record<string, typeof seed> = { "/w": seed };
  for (let i = 0; i < ZAICODE_TASK_STATE_RETENTION + 5; i += 1) {
    const taskId = `task-${i}`;
    const patch = updateWorkspaceState(
      { workspaces } as never,
      "/w",
      (current) => ({
        ...current,
        activeTaskId: "task-0",
        taskUiByTaskId: { ...current.taskUiByTaskId, [taskId]: { plan: true } as never },
      }),
    );
    workspaces = { ...workspaces, ...patch.workspaces };
  }
  const workspace = workspaces["/w"]!;
  assert.ok(workspace.taskUiByTaskId["task-0"] !== undefined);
  assert.equal(Object.keys(workspace.taskUiByTaskId).length, ZAICODE_TASK_STATE_RETENTION);
});

function makeToast(id: number, createdAt: number, over: Partial<{ actions: [] }> = {}) {
  return {
    id,
    scenario: "s",
    header: "h",
    title: `t${id}`,
    body: "",
    status: "",
    accent: "#fff",
    createdAt,
    expiresAt: null as number | null,
    actions: over.actions ?? [],
  };
}

test("expired toasts are dropped and the stack never exceeds the cap", () => {
  const now = 1_000_000;
  const toasts = Array.from({ length: 20 }, (_, i) => makeToast(i + 1, now - (20 - i) * 10));
  const bounded = boundZaicodeToasts(toasts, now);
  assert.equal(bounded.length, ZAICODE_TOAST_LIMIT);
  // 最老的先走。
  assert.equal(bounded[0]?.id, 20 - ZAICODE_TOAST_LIMIT + 1);

  const withExpired = [{ ...makeToast(99, now - 10_000), expiresAt: now - 1 }, ...toasts.slice(0, 3)];
  assert.deepEqual(
    boundZaicodeToasts(withExpired, now).map((toast) => toast.id),
    [1, 2, 3],
  );
});

test("a toast carrying an action is never evicted, even over the cap", () => {
  const now = 1_000_000;
  const actionable = {
    ...makeToast(1, now - 10_000),
    actions: [{ label: "Approve", run: () => {} }],
  };
  const plain = Array.from({ length: 20 }, (_, i) => makeToast(i + 2, now - 5_000 + i));
  const bounded = boundZaicodeToasts([actionable, ...plain], now);
  assert.ok(bounded.some((toast) => toast.id === 1));
  assert.ok(bounded.length <= ZAICODE_TOAST_LIMIT + 1);
});

test("terminal audit history keeps every active campaign and only the newest finished ones", () => {
  const finished = Array.from({ length: ZAICODE_AUDIT_HISTORY_LIMIT + 10 }, (_, i) => ({
    id: `f${i}`,
    createdAt: i,
    status: "complete" as const,
  }));
  const active = { id: "a0", createdAt: -1, status: "running" as const };
  const bounded = boundZaicodeAuditCampaigns([...finished, active] as never);
  assert.equal(bounded.length, ZAICODE_AUDIT_HISTORY_LIMIT + 1);
  assert.equal(bounded[0]?.id, "a0");
  const finishedIds = bounded.filter((campaign) => campaign.id !== "a0").map((campaign) => campaign.id);
  assert.equal(finishedIds[0], `f${finished.length - 1}`);
  assert.equal(finishedIds.at(-1), `f${finished.length - ZAICODE_AUDIT_HISTORY_LIMIT}`);
});

test("detached side pane terminals are reclaimed oldest-first", () => {
  sidePaneTerminalSessionRegistry.clearForTest();
  const makeEntry = (key: string, parent: HTMLElement | null): SidePaneTerminalSessionEntry => ({
    key,
    term: {} as never,
    fitAddon: {} as never,
    terminalId: `pty-${key}`,
    cwd: "/w",
    workspaceKey: "/w",
    hostEl: { parentElement: parent, remove() {}, getAttribute: () => null } as unknown as HTMLDivElement,
    dispose: () => {},
  });

  const total = SIDE_PANE_DETACHED_TERMINAL_LIMIT + 3;
  for (let i = 0; i < total; i += 1) {
    sidePaneTerminalSessionRegistry.register(`det-${i}`, makeEntry(`det-${i}`, null));
  }
  const left = Array.from({ length: total }, (_, i) => `det-${i}`).filter((key) =>
    sidePaneTerminalSessionRegistry.has(key),
  );
  // node 测试环境没有 document，hostEl.parentElement 为 null 即视为 detached。
  assert.equal(left.length, SIDE_PANE_DETACHED_TERMINAL_LIMIT);
  assert.equal(sidePaneTerminalSessionRegistry.has("det-0"), false);
  assert.equal(sidePaneTerminalSessionRegistry.has(`det-${total - 1}`), true);
  sidePaneTerminalSessionRegistry.clearForTest();
});

test("an attached side pane terminal is never reclaimed to satisfy the detached cap", () => {
  sidePaneTerminalSessionRegistry.clearForTest();
  const liveHost = { appendChild() {} } as unknown as HTMLElement;
  const makeEntry = (key: string, parent: HTMLElement | null): SidePaneTerminalSessionEntry => ({
    key,
    term: {} as never,
    fitAddon: {} as never,
    terminalId: `pty-${key}`,
    cwd: "/w",
    workspaceKey: "/w",
    hostEl: { parentElement: parent, remove() {}, getAttribute: () => null } as unknown as HTMLDivElement,
    dispose: () => {},
  });

  sidePaneTerminalSessionRegistry.register("live", makeEntry("live", liveHost));
  for (let i = 0; i < SIDE_PANE_DETACHED_TERMINAL_LIMIT + 4; i += 1) {
    sidePaneTerminalSessionRegistry.register(`det-${i}`, makeEntry(`det-${i}`, null));
  }
  assert.equal(sidePaneTerminalSessionRegistry.has("live"), true);
  sidePaneTerminalSessionRegistry.clearForTest();
});
