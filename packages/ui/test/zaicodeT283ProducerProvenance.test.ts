import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  V4_WIRE_PROTOCOL_VERSION,
  type CommandAck,
  type CommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import { createZaicodeContinueHandle } from "../src/zaicode/zaicodeContinueHost.js";

// T-283 (SAIHANDOFF F-03): the Auto Goal owner dispatches its continuation
// through the SAME canonical send path a human uses, so the only thing that ever
// distinguished them was the `auto-goal:` command id -- and the receiving side
// recorded `semantics.origin: real_user` regardless. The producer must therefore
// DECLARE its origin on the unchanged envelope.

const raw = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => raw.get(key) ?? null,
  setItem: (key: string, value: string) => void raw.set(key, value),
  removeItem: (key: string) => void raw.delete(key),
};

const GOAL_INTENT_ID = "p-audit::s-audit::cc all";
const PRODUCER_ID = "zaicode-goal-continuation";

/** The exact declaration the Auto Goal owner builds. */
const DECLARED = {
  origin: "agent_runtime",
  source: "goal_autocontinuation",
  originalUserIntentId: GOAL_INTENT_ID,
  goalIntentId: GOAL_INTENT_ID,
  producerId: PRODUCER_ID,
} as const;

interface Sent {
  envelope: CommandEnvelope;
}

function fakeServices() {
  const sent: Sent[] = [];
  const agentService = {
    helloConversationV4: async () => ({
      kind: "hello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      connectionId: "conn-1",
      clientMode: "desktop-continuous",
      deliveryProfile: "continuous",
      serverTime: Date.now(),
      capabilities: {
        nativeDialogs: false,
        localTerminal: false,
        binaryFrames: false,
        compression: "none",
      },
      auth: {},
    }),
    initializeConversationV4: async () => undefined,
    sendConversationCommandV4: async (input: Sent) => {
      sent.push(input);
      return { status: "accepted", commandId: input.envelope.commandId } as unknown as CommandAck;
    },
  };
  const taskService = {
    resumeTask: async () => undefined,
    createTask: async () => ({ taskId: "s-audit" }),
    setTaskUnread: async () => undefined,
  };
  return { sent, agentService, taskService };
}

function handle(services: ReturnType<typeof fakeServices>) {
  return createZaicodeContinueHandle({
    workspacePath: "C:/ws",
    taskService: services.taskService as never,
    agentService: services.agentService as never,
  });
}

test("T-283: the automatic continuation declares agent_runtime on the unchanged sendText transport", async () => {
  const services = fakeServices();
  await handle(services).send(
    "s-audit",
    { kind: "text", text: "cc all" } as never,
    {
      idleOnly: true,
      commandId: `auto-goal:${GOAL_INTENT_ID}:4242`,
      inputProvenance: DECLARED,
    },
  );
  assert.equal(services.sent.length, 1);
  const envelope = services.sent[0]!.envelope;
  assert.equal(envelope.type, "sendText");
  assert.equal(envelope.commandId, `auto-goal:${GOAL_INTENT_ID}:4242`);
  const payload = envelope.payload as Record<string, unknown>;
  assert.equal(payload.text, "cc all");
  assert.deepEqual(payload.inputProvenance, DECLARED);
});

test("T-283: a goal continuation declares the same provenance on sendGoalCommand", async () => {
  const services = fakeServices();
  await handle(services).send(
    "s-audit",
    { kind: "goal", objective: "cc all" } as never,
    { idleOnly: true, inputProvenance: DECLARED },
  );
  assert.equal(services.sent.length, 1);
  const envelope = services.sent[0]!.envelope;
  assert.equal(envelope.type, "sendGoalCommand");
  assert.deepEqual((envelope.payload as Record<string, unknown>).inputProvenance, DECLARED);
});

test("T-283: an ordinary operator send declares nothing and stays the operator ingress", async () => {
  const services = fakeServices();
  await handle(services).send("s-audit", { kind: "text", text: "hello" } as never, {});
  const payload = services.sent[0]!.envelope.payload as Record<string, unknown>;
  assert.equal(payload.inputProvenance, undefined);
});

test("T-283 wiring: the Auto Goal owner declares its provenance on the real dispatch", () => {
  const owner = readFileSync(
    new URL("../src/zaicode/zaicodeGoalContinuation.ts", import.meta.url),
    "utf8",
  );
  assert.match(owner, /origin:\s*"agent_runtime"/);
  assert.match(owner, /source:\s*"goal_autocontinuation"/);
  assert.match(owner, /originalUserIntentId:\s*current\.intentId/);
  assert.match(owner, /goalIntentId:\s*current\.intentId/);
  assert.match(owner, /producerId:\s*AUTO_GOAL_CONTINUATION_PRODUCER_ID/);
  assert.match(
    owner,
    /AUTO_GOAL_CONTINUATION_PRODUCER_ID = "zaicode-goal-continuation"/,
    "the producer identity must stay stable for capture reconstruction",
  );
  // Declared on the SAME send that keeps the idempotent auto-goal command id.
  assert.match(owner, /commandId: `auto-goal:\$\{current\.intentId\}:\$\{brief\.updatedAt\}`/);
});

test("T-283 wiring: the continue handle forwards a declared provenance on BOTH input envelopes", () => {
  const host = readFileSync(
    new URL("../src/zaicode/zaicodeContinueHost.ts", import.meta.url),
    "utf8",
  );
  const forwards = host.match(/inputProvenance: options\.inputProvenance/g) ?? [];
  assert.equal(forwards.length, 2, "sendText and sendGoalCommand must both carry it");
  assert.match(
    readFileSync(new URL("../src/zaicode/zaicodeContinue.ts", import.meta.url), "utf8"),
    /inputProvenance\?: import\("@zcode\/shared\/zcode-protocol-v4"\)\.InputProvenanceClaim/,
  );
});
