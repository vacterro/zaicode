import assert from "node:assert/strict";
import { test } from "node:test";
import { NATIVE_HANDLERS } from "../src/zcode-protocol-v4/commands/handlers/index.js";
import { admitPrompt } from "../../core/src/runtime/methods/prompt-admission.js";

function subject({ busy = true, queue = 0, race = false } = {}) {
  const calls: string[] = [];
  const runtime: any = {
    activeTurn: undefined, foregroundPromotionLease: undefined, activeForegroundExecution: undefined,
    runtimeCommandDrainActive: false, runtimeCommandQueue: { hasPending: () => false },
    hasActiveOrQueuedTurnWork: () => busy,
    enqueueDeferredInput: async () => { calls.push("queued"); return { kind: "queued" }; },
  };
  const record: any = {
    workspace: { workspacePath: "V:/fixture" }, persistence: "immediate",
    app: {
      sessionId: "s", runtime, getMode: () => "build",
      sendInput: async (input: any, options: any) => admitPrompt.call(runtime, input.text, undefined, options),
      enqueueDeferredInput: async () => { calls.push("goal-queued"); return { kind: "queued" }; },
      steerTurn: async () => { calls.push("goal-queued"); return { kind: "queued" }; },
    },
  };
  const host: any = { getRecord: () => record, getQueueLength: () => queue, getInputRoutingMode: () => queue ? "choice" : busy ? "enqueue" : "startNow", ensureModelReady: async () => { if (race) busy = true; } };
  const envelope = (type: string, idleOnly = true): any => ({ commandId: "retry-s-failure1", clientId: "fixture", sessionId: "s", issuedAt: 1, type, payload: { text: "continue the task", idleOnly, modelSelection: { providerId: "fixture", modelId: "fixture" }, mode: "build", planEnabled: false, heldQueueDisposition: "keepQueueAndSend" } });
  return { calls, host, envelope };
}

test("SRC-185: automatic cc cannot enqueue while actual Core work is active", async () => {
  const s = subject();
  await assert.rejects(NATIVE_HANDLERS.sendText(s.host, s.envelope("sendText")), /idle|busy/i);
  assert.deepEqual(s.calls, []);
});

test("SRC-185: automatic goal continuation cannot enqueue behind current work", async () => {
  const s = subject();
  await assert.rejects(NATIVE_HANDLERS.sendGoalCommand(s.host, s.envelope("sendGoalCommand")), /idle|busy/i);
  assert.deepEqual(s.calls, []);
});

test("SRC-185: an existing held queue cannot acquire another automatic cc", async () => {
  const s = subject({ busy: true, queue: 3 });
  await assert.rejects(NATIVE_HANDLERS.sendText(s.host, s.envelope("sendText")), /idle|busy|queue/i);
  assert.deepEqual(s.calls, []);
});

test("SRC-185: Core requireIdle rejects a turn that starts during model readiness", async () => {
  const s = subject({ busy: false, race: true });
  await assert.rejects(NATIVE_HANDLERS.sendText(s.host, s.envelope("sendText")), /admission rejected/i);
  assert.deepEqual(s.calls, []);
});

test("SRC-185: ordinary operator Continue retains queue admission", async () => {
  const s = subject();
  const result = await NATIVE_HANDLERS.sendText(s.host, s.envelope("sendText", false));
  assert.equal(result?.type, "inputAccepted");
  assert.deepEqual(s.calls, ["queued"]);
});
