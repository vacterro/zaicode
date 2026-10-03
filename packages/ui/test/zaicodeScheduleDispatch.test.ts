import assert from "node:assert/strict";
import test from "node:test";
import { createZaicodeContinueHandle } from "../src/zaicode/zaicodeContinueHost.js";
import { V4_WIRE_PROTOCOL_VERSION, type CommandAck, type CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";

function fixture(status: CommandAck["status"] = "accepted") {
  const commands: CommandEnvelope[] = [];
  let gate = true;
  const handle = createZaicodeContinueHandle({
    workspacePath: "C:/fixture",
    taskService: { resumeTask: async () => undefined, createTask: async () => ({ taskId: "created-session" }) } as never,
    agentService: {
      helloConversationV4: async () => ({ kind: "hello", protocolVersion: V4_WIRE_PROTOCOL_VERSION, connectionId: "fixture", clientMode: "desktop-continuous", deliveryProfile: "continuous", serverTime: 1000, capabilities: { nativeDialogs: false, localTerminal: false, binaryFrames: false, compression: "none" }, auth: {} }),
      initializeConversationV4: async () => undefined,
      sendConversationCommandV4: async ({ envelope }: { envelope: CommandEnvelope }) => { commands.push(envelope); return { commandId: envelope.commandId, status, reasonCode: status === "noop" ? "guard.foregroundChanged" : undefined, revisionAtDecision: 1 }; },
    } as never,
  });
  return { handle, commands, gate: () => gate, cancel: () => { gate = false; } };
}

test("the real v4 dispatch carries the selected SAIFREN model and persisted command lease on replay", async () => {
  const f = fixture();
  const options = { modelSelection: { providerId: "route", modelId: "SAIFREN", options: { reasoningLevel: "high" } }, commandId: "persisted-lease", canDispatch: f.gate };
  await f.handle.start({ kind: "goal", objective: "cc all" }, { ...options, onCreated: (id) => assert.equal(id, "created-session") });
  await f.handle.send("created-session", { kind: "goal", objective: "cc all" }, options);
  assert.equal(f.commands.length, 2);
  for (const command of f.commands) {
    assert.equal(command.commandId, "persisted-lease");
    assert.equal(command.type, "sendGoalCommand");
    assert.deepEqual((command.payload as Record<string, unknown>).modelSelection, options.modelSelection);
    assert.equal((command.payload as Record<string, unknown>).mode, "yolo");
    assert.equal((command.payload as Record<string, unknown>).planEnabled, false);
  }
});

test("guarded stop preserves the execution id and refuses a host noop; unguarded idle stop stays compatible", async () => {
  const f = fixture("noop");
  await assert.rejects(f.handle.stop("owned", "execution-one"), /guard.foregroundChanged/);
  assert.deepEqual(f.commands[0]!.payload, { expectedForegroundExecutionId: "execution-one" });
  await f.handle.stop("already-idle");
});

test("cancellation during session creation blocks the first command at the real host boundary", async () => {
  const f = fixture();
  await assert.rejects(f.handle.start({ kind: "goal", objective: "cc all" }, { canDispatch: f.gate, onCreated: f.cancel }), /cancelled/);
  assert.equal(f.commands.length, 0);
});
