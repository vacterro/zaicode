import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { attachTaskListRowActivity } from "../src/v4/taskListRowActivity.js";
import { decideZaicodeProjectClick } from "../src/zaicode/zaicodeProjectClick.js";
import { zaicodeSessionIsEmptyChat } from "../src/zaicode/zaicodeSessionState.js";

// SRC-081: "if the chat is completely empty and the project has no real session, open the new task
// window instead of this one: the incompletes are confusing".

const source = (path: string) => readFileSync(join(import.meta.dirname, "../src", path), "utf8");

function task(patch: { phase?: "running" | "completedSuccess" | "error"; hasAssistantOutput?: boolean; goal?: "active" }) {
  const meta = { taskId: "m", title: "saipen continue", status: "completed", updatedAt: 1, ...(patch.goal ? { target: { status: patch.goal, objective: "x" } } : {}) } as unknown as ZCodeTaskMeta;
  return attachTaskListRowActivity(meta, {
    phase: patch.phase ?? "completedSuccess",
    lastActivityAt: 1,
    hasBackgroundWork: false,
    ...(patch.hasAssistantOutput === undefined ? {} : { hasAssistantOutput: patch.hasAssistantOutput }),
  });
}

test("a session that never said anything and stands idle is an empty chat", () => {
  assert.equal(zaicodeSessionIsEmptyChat(task({ hasAssistantOutput: false })), true);
  assert.equal(zaicodeSessionIsEmptyChat(task({ hasAssistantOutput: true })), false, "it has something to read");
  assert.equal(zaicodeSessionIsEmptyChat(task({})), false, "unknown is not empty");
  assert.equal(zaicodeSessionIsEmptyChat(task({ hasAssistantOutput: false, phase: "running" })), false, "running: not empty");
  assert.equal(zaicodeSessionIsEmptyChat(task({ hasAssistantOutput: false, phase: "error" })), false, "a failed turn has something to show");
  assert.equal(zaicodeSessionIsEmptyChat(task({ hasAssistantOutput: false, goal: "active" })), false, "an open goal is work");
});

test("the project click opens the new-task screen instead of an empty MAIN", () => {
  const base = { projectIsMain: true, mainId: "m", sessionIds: ["m", "x"], activeWorkspace: false, activeTaskId: null };
  assert.deepEqual(decideZaicodeProjectClick({ ...base, mainEmpty: true, readableSessionIds: [] }), { action: "draft" });
  assert.deepEqual(decideZaicodeProjectClick({ ...base, mainEmpty: false }), { action: "open", sessionId: "m" });
  assert.deepEqual(decideZaicodeProjectClick(base), { action: "open", sessionId: "m" }, "unchanged without the flag");
  // SRC-129: a label always navigates; empty MAIN cannot sneak into its fallback.
  assert.deepEqual(decideZaicodeProjectClick({ ...base, mainEmpty: true, activeWorkspace: true, activeTaskId: "m", readableSessionIds: [] }), { action: "draft" });
  assert.deepEqual(decideZaicodeProjectClick({ ...base, mainEmpty: true, readableSessionIds: ["x"] }), { action: "open", sessionId: "x" });
});

test("wiring: the summary reports an assistant preview, the row asks and replaces an empty MAIN", () => {
  assert.match(source("v4/mapSessionSummaryToTaskMeta.ts"), /hasAssistantOutput: Boolean\(summary\.lastAssistantPreview\?\.trim\(\)\)/);
  const row = source("WorkspaceSidebarItem.tsx");
  assert.match(row, /mainEmpty: Boolean\(zaicodeMainListed && zaicodeSessionIsEmptyChat\(zaicodeMainListed\)\)/);
  assert.match(row, /armZaicodeMain\(zaicodeMainKey\);\s*}\s*onStartDraftInWorkspace/, "the new session becomes the row");
});
