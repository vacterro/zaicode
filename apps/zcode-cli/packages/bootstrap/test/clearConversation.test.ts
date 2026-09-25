import assert from "node:assert/strict";
import test from "node:test";
import { RewindStrategy } from "@zcode/contracts";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";

/**
 * ZAICODE CLEAR (v4 clearConversation) against a fake host: the order of
 * effects is the contract (stop -> goal -> queue -> branch cut -> broadcast).
 */
function fakeSession(options: { running?: boolean; goal?: boolean; queued?: number; rewind?: "cut" | "empty" | "unavailable" }) {
  const calls: string[] = [];
  let foreground: string | undefined = options.running ? "exec-1" : undefined;
  let goal = options.goal ? { status: "active" as const } : null;
  const record = {
    activeAbortController: undefined as AbortController | undefined,
    traceContext: { traceId: "t", spanId: "s" },
    app: {
      sessionId: "s1",
      readTarget: async () => goal,
      updateTargetStatus: async (status: "paused") => {
        calls.push(`goal:${status}`);
        goal = goal ? { ...goal, status: status as never } : null;
        return goal;
      },
      clearTarget: async () => {
        calls.push("goal:clear");
        const had = goal !== null;
        goal = null;
        return had;
      },
      clearQueueItems: async () => {
        calls.push("queue:clear");
        return options.queued ?? 0;
      },
      runtime: {
        stopActiveForegroundExecution: () => {
          if (!foreground) return { kind: "idle" };
          calls.push("stop");
          foreground = undefined;
          return { kind: "stopped" };
        },
        getActiveForegroundExecutionId: () => foreground,
        rewindConversationToStart: async () => {
          calls.push("rewind");
          if (options.rewind === "empty") return null;
          return { strategy: options.rewind === "unavailable" ? "unavailable" : RewindStrategy.ActiveChain };
        },
      },
    },
  };
  const host = {
    getRecord: (id: string) => (id === "s1" ? record : undefined),
    afterLegacyStateMutation: async (_record: unknown, reason: string) => {
      calls.push(`broadcast:${reason}`);
    },
    logger: { info: () => undefined, warn: () => undefined },
  };
  const envelope = {
    commandId: "c1",
    clientId: "ui",
    sessionId: "s1",
    type: "clearConversation" as const,
    payload: {},
    issuedAt: 0,
  };
  const executor = new V4CommandExecutor(host as never);
  return { calls, run: () => executor.execute(envelope as never) };
}

test("CLEAR on a running goal session: stop, pause, drop goal and queue, cut, broadcast", async () => {
  const { calls, run } = fakeSession({ running: true, goal: true, queued: 2 });
  const result = await run();
  assert.equal(result, undefined);
  assert.deepEqual(calls, [
    "stop",
    "goal:paused",
    "broadcast:clear_conversation_goal_paused",
    "goal:clear",
    "queue:clear",
    "rewind",
    "broadcast:session_rewound",
  ]);
});

test("CLEAR on an idle, already empty session is a quiet noop", async () => {
  const { calls, run } = fakeSession({ rewind: "empty" });
  await run();
  assert.deepEqual(calls, ["goal:clear", "queue:clear", "rewind"]);
});

test("CLEAR fails loudly when the branch cut is unavailable", async () => {
  const { run } = fakeSession({ rewind: "unavailable" });
  await assert.rejects(run(), /conversation clear unavailable/);
});

test("clearConversation is a native v4 command and is refused in selection side chats", async () => {
  const executor = new V4CommandExecutor({ getRecord: () => ({ taskType: "selection_side_chat" }) } as never);
  assert.equal(executor.supports("clearConversation"), true);
  await assert.rejects(
    executor.execute({ commandId: "c", clientId: "u", sessionId: "s", type: "clearConversation", payload: {}, issuedAt: 0 } as never),
    /selection_side_chat/,
  );
});
