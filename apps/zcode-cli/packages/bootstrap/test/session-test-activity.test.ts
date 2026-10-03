import assert from "node:assert/strict";
import test from "node:test";
import { deriveSessionTestActivity, isTestExecutionCommand, type ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { SessionsIndexProjection } from "../src/zcode-protocol-v4/sessions-index-projection.js";

const snapshot = (): ConversationSnapshot => ({
  sessionId: "session-tests",
  meta: { title: "Tests", titleSource: "custom" },
  control: { phase: "running", sessionEnded: false, activeWorks: [{ kind: "primaryTurn", foregroundExecutionId: "execution-tests", startedAt: 100 }] },
  backgroundWorks: [], pendingInteractions: [], workflowRuns: [],
  rows: { window: [{ kind: "toolCall", rowId: 1, toolCallId: "tool-one", workId: "work-one", toolName: "Bash", status: "running", input: { command: "pnpm --filter @zcode/ui exec node --import tsx --test test/*.test.ts" } }] },
} as unknown as ConversationSnapshot);

test("real executed test commands are recognized without counting quoted prose or ordinary builds", () => {
  for (const command of ["pnpm test", "npm run test:unit", "uv run pytest tests", "python -m unittest", "cargo test", "pnpm --filter @zcode/ui exec node --import tsx --test test/*.test.ts", "cd app && pnpm test", "& 'C:/tools/pnpm.cmd' test"]) assert.equal(isTestExecutionCommand(command), true, command);
  for (const command of ["echo 'pnpm test'", "printf 'npm test; pytest'", "pnpm build", "pytest --help", "npm install vitest", "git diff -- test.ts"]) assert.equal(isTestExecutionCommand(command), false, command);
});

test("test activity comes from live tool rows, deduplicates background handoff and clears on exit", () => {
  const s = snapshot();
  assert.equal(deriveSessionTestActivity(s)?.count, 1);
  s.backgroundWorks = [{ kind: "bash", workId: "work-one", status: "running", command: "pnpm test" }] as ConversationSnapshot["backgroundWorks"];
  assert.equal(deriveSessionTestActivity(s)?.count, 1);
  s.control.sessionEnded = true;
  assert.deepEqual(deriveSessionTestActivity(s), { count: 1, commands: ["pnpm test"] });
  s.backgroundWorks[0]!.status = "completed";
  assert.equal(deriveSessionTestActivity(s), undefined, "stale foreground rows cannot animate an ended turn");
});

test("the real sessions-index projection emits test completion and foreground lease changes", () => {
  const s = snapshot();
  const extra = { workspaceId: "workspace", lastActivityAt: 100, createdAt: 1 };
  const index = new SessionsIndexProjection("workspace", "epoch");
  assert.equal(index.upsertFromConversation(s, extra).length, 1);
  const summary = index.getSnapshot().sessions[0]!;
  assert.equal(summary.foregroundExecutionId, "execution-tests");
  assert.equal(summary.testActivity?.count, 1);
  assert.equal(index.upsertFromConversation(s, extra).length, 0);
  s.control.sessionEnded = true;
  assert.equal(index.upsertFromConversation(s, extra).length, 1, "clearing tests is a real delta even when membership/title/clock stay identical");
  s.control.activeWorks[0]!.foregroundExecutionId = "next-execution";
  assert.equal(index.upsertFromConversation(s, extra).length, 1);
});
