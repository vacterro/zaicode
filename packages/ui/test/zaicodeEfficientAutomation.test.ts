import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { ConversationRow, SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import { decideZaicodeProjectClick } from "../src/zaicode/zaicodeProjectClick.js";
import { attachTaskListRowActivity, isTaskListRowActive } from "../src/v4/taskListRowActivity.js";
import { mapSessionSummaryToTaskMeta } from "../src/v4/mapSessionSummaryToTaskMeta.js";
import { zaicodeSessionWorking } from "../src/zaicode/zaicodeStall.js";
import { buildConversationTurnRenderUnits } from "../src/v4/conversationTurnRenderUnits.js";
import { ZAICODE_HIGHLIGHT_TARGETS } from "../src/zaicode/zaicodeHighlights.js";

Object.defineProperty(globalThis, "__ZAICODE_PRODUCT_MODE__", { value: true, configurable: true });
const task = { taskId: "a", title: "a", workspacePath: "C:/fixture", updatedAt: 10 } as ZCodeTaskMeta;

test("project label repeatedly opens its conversation; folder mode also opens MAIN", () => {
  for (const projectIsMain of [true, false]) {
    assert.deepEqual(decideZaicodeProjectClick({ projectIsMain, mainId: "a", sessionIds: ["a", "b"], activeWorkspace: true, activeTaskId: "a" }), { action: "open", sessionId: "a" });
  }
});

test("project without MAIN opens the last meaningful session; empty project starts a draft", () => {
  assert.deepEqual(decideZaicodeProjectClick({ projectIsMain: false, mainId: null, sessionIds: ["b", "a"], activeWorkspace: false, activeTaskId: null }), { action: "open", sessionId: "b" });
  assert.deepEqual(decideZaicodeProjectClick({ projectIsMain: false, mainId: null, sessionIds: [], activeWorkspace: true, activeTaskId: null }), { action: "draft" });
});

test("MAIN navigation survives an open helper and never reopens an explicitly empty MAIN", () => {
  const base = { projectIsMain: true, mainId: "a", sessionIds: ["a", "b"], activeWorkspace: true, activeTaskId: "b" };
  assert.deepEqual(decideZaicodeProjectClick(base), { action: "open", sessionId: "a" });
  assert.deepEqual(decideZaicodeProjectClick({ ...base, mainEmpty: true, activeTaskId: "a", readableSessionIds: ["b"] }), { action: "open", sessionId: "b" });
  assert.deepEqual(decideZaicodeProjectClick({ ...base, mainEmpty: true, activeTaskId: "a", readableSessionIds: [] }), { action: "draft" });
});

test("an ended foreground cannot spin from a stale running phase; background stays live", () => {
  const row = attachTaskListRowActivity(task, { phase: "running", sessionEnded: true, lastActivityAt: 10, hasBackgroundWork: false } as Parameters<typeof attachTaskListRowActivity>[1]);
  assert.equal(isTaskListRowActive(row), false);
  assert.equal(isTaskListRowActive(attachTaskListRowActivity(task, { phase: "completedSuccess", sessionEnded: true, lastActivityAt: 10, hasBackgroundWork: true } as Parameters<typeof attachTaskListRowActivity>[1])), true);
});

test("quiet live background tests are working after five hours", () => {
  assert.equal(zaicodeSessionWorking(attachTaskListRowActivity(task, { phase: "completedSuccess", hasBackgroundWork: true, lastActivityAt: 10 }), 5 * 60 * 60 * 1000), true);
});

test("the actual index mapping carries test activity and turn completion", () => {
  const summary = { sessionId: "a", workspaceId: "w", title: "a", titleSource: "custom", phase: "running", sessionEnded: false, hasBackgroundWork: false, lastActivityAt: 10, createdAt: 1, testActivity: { count: 1, commands: ["pnpm test"] } } as SessionSummary;
  const row = mapSessionSummaryToTaskMeta(summary, { workspacePath: "C:/fixture" });
  assert.deepEqual((row.__zcodeSessionActivity as unknown as Record<string, unknown>).testActivity, { count: 1, commands: ["pnpm test"] });
});

test("tests have independently configurable project and session motion targets", () => {
  const ids: string[] = ZAICODE_HIGHLIGHT_TARGETS.map((target) => target.id);
  assert.ok(ids.includes("projectTests"));
  assert.ok(ids.includes("sessionTests"));
});

test("repeated goal-incomplete notices leave no empty turns; failure and completion remain", () => {
  const marker = (outcome: string, rowId: number) => ({ kind: "timelineMarker", rowId, turnId: `t${rowId}`, lane: "turnTailBoundary", marker: { type: "goalVerify", outcome, iteration: rowId } }) as ConversationRow;
  const rows = [marker("notSatisfied", 1), marker("notSatisfied", 2), marker("failed", 3), marker("pass", 4)];
  const units = buildConversationTurnRenderUnits(rows);
  assert.deepEqual(units.flatMap((unit) => unit.renderRows).map((row) => row.rowId), [3, 4]);
  assert.equal(rows.length, 4);
});
