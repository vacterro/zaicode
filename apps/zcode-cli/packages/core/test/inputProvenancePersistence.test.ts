import assert from "node:assert/strict";
import { test } from "node:test";
import type { TurnInputIntentMetadata } from "@zcode/contracts";
import { conversationInputIntentSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  persistMessage,
  persistPart,
  persistUserPrompt,
} from "../src/runtime/methods/message-persistence.js";

// T-283 (SAIHANDOFF F-03): `persistUserPrompt` hardcoded
// `semantics.origin: real_user` / `kind: user_prompt` and an `anchor.origin` of
// `realUser`, so a host-generated continuation was persisted as a fresh human
// decision. These cases drive the REAL persistence owner and assert the
// classification it now derives from the admitted intent's provenance.

interface SavedMessage {
  role?: string;
  semantics?: {
    origin?: string;
    kind?: string;
    source?: string;
    uiVisibility?: string;
    providerVisibility?: string;
    transcriptVisibility?: string;
  };
  anchor?: { origin?: string; sourceCommandId?: string; turnId?: string };
  metadata?: Record<string, unknown>;
}

interface Harness {
  saved: SavedMessage[];
  parts: number;
  runtime: Record<string, unknown>;
}

function harness(): Harness {
  const saved: SavedMessage[] = [];
  const state = { parts: 0 };
  const runtime = {
    latestConversationMessageId: undefined as unknown,
    sessionId: "sess_t283",
    sessionStore: {
      saveMessage: async (message: SavedMessage) => {
        saved.push(message);
      },
      savePart: async () => {
        state.parts += 1;
      },
    },
    config: { agentName: "zcode-agent" },
    workingDirectory: "C:/ws",
    workspaceRoot: "C:/ws",
    getTools: () => [],
    getSessionModelSelection: () => undefined,
    persistMessage,
    persistPart,
  };
  return {
    saved,
    get parts() {
      return state.parts;
    },
    runtime,
  } as Harness;
}

const TRACE = {
  traceId: "trace_t283",
  sessionId: "sess_t283",
  queryId: "query_t283",
  turnId: "turn_t283",
} as never;

const GOAL_INTENT_ID = "p-audit::s-audit::cc all";

function intentWith(provenance: TurnInputIntentMetadata["provenance"]): TurnInputIntentMetadata {
  return {
    sourceCommandId: "cmd_t283",
    queueItemId: "queue_t283",
    clientId: "client-1",
    kind: "sendText",
    text: "cc all",
    admissionSeq: 1,
    admittedAt: 1,
    requestedDelivery: "startNow",
    admittedDelivery: "startNow",
    ...(provenance ? { provenance } : {}),
  } as TurnInputIntentMetadata;
}

async function persist(options: { intent?: TurnInputIntentMetadata | undefined }): Promise<SavedMessage> {
  const box = harness();
  await persistUserPrompt.call(
    box.runtime as never,
    "msg_t283" as never,
    "cc all",
    undefined,
    TRACE,
    options.intent ? { intent: options.intent } : {},
  );
  assert.equal(box.saved.length, 1, "exactly one user message is persisted");
  assert.equal(box.parts, 1, "the text part is persisted with it");
  return box.saved[0]!;
}

test("T-283: an automatic continuation is persisted as agent_runtime, not a human prompt", async () => {
  const message = await persist({
    intent: intentWith({
      sourceCommandId: "cmd_t283",
      origin: "agent_runtime",
      source: "goal_autocontinuation",
      humanAuthored: false,
      originalUserIntentId: GOAL_INTENT_ID,
      goalIntentId: GOAL_INTENT_ID,
      producerId: "zaicode-goal-continuation",
    }),
  });

  // The transport stays a model-compatible user message...
  assert.equal(message.role, "user");
  assert.equal(message.semantics?.kind, "user_prompt");
  assert.equal(message.semantics?.uiVisibility, "visible");
  assert.equal(message.semantics?.providerVisibility, "visible");
  assert.equal(message.semantics?.transcriptVisibility, "visible");
  // ...but the authorization classification is no longer `real_user`.
  assert.equal(message.semantics?.origin, "agent_runtime");
  assert.equal(message.semantics?.source, "goal_autocontinuation");
  // Display follows the goal-continuation treatment rather than a human bubble.
  assert.equal(message.anchor?.origin, "goalContinuation");

  const provenance = (message.metadata?.inputProvenance ?? {}) as Record<string, unknown>;
  assert.equal(provenance.origin, "agent_runtime");
  assert.equal(provenance.humanAuthored, false);
  assert.equal(provenance.originalUserIntentId, GOAL_INTENT_ID);
});

test("T-283: a genuine operator submission keeps human origin and the real-user row", async () => {
  const message = await persist({
    intent: intentWith({
      sourceCommandId: "cmd_t283",
      origin: "real_user",
      source: "operator_ingress",
      humanAuthored: true,
      originalUserIntentId: "cmd_t283",
    }),
  });
  assert.equal(message.semantics?.origin, "real_user");
  assert.equal(message.semantics?.source, "operator_ingress");
  assert.equal(message.anchor?.origin, "realUser");
  assert.equal((message.metadata?.inputProvenance as Record<string, unknown>).humanAuthored, true);
});

test("T-283: an unclassifiable provenance never silently becomes human authority", async () => {
  const message = await persist({
    intent: intentWith({
      sourceCommandId: "cmd_t283",
      origin: "unknown",
      source: "unknown",
      humanAuthored: false,
    }),
  });
  assert.equal(message.semantics?.origin, "system");
  assert.notEqual(message.semantics?.origin, "real_user");
  assert.equal((message.metadata?.inputProvenance as Record<string, unknown>).humanAuthored, false);
});

test("T-283: a legacy caller without provenance keeps the historical behaviour", async () => {
  const message = await persist({ intent: intentWith(undefined) });
  assert.equal(message.semantics?.origin, "real_user");
  assert.equal(message.anchor?.origin, "realUser");
  assert.equal(message.metadata?.inputProvenance, undefined);

  const bare = await persist({});
  assert.equal(bare.semantics?.origin, "real_user");
  assert.equal(bare.anchor?.origin, "realUser");
});

test("T-283: the persisted intent survives the strict hydration schema", async () => {
  const message = await persist({
    intent: intentWith({
      sourceCommandId: "cmd_t283",
      origin: "agent_runtime",
      source: "goal_autocontinuation",
      humanAuthored: false,
      originalUserIntentId: GOAL_INTENT_ID,
      goalIntentId: GOAL_INTENT_ID,
      producerId: "zaicode-goal-continuation",
    }),
  });

  // `conversationInputIntentSchema` is `.strict()`: an unmodelled provenance key
  // would make the whole intent unreadable on restore and lose the row's origin.
  const parsed = conversationInputIntentSchema.safeParse(message.metadata?.conversationInputIntent);
  assert.equal(parsed.success, true, "the persisted intent must hydrate");
  if (!parsed.success) return;
  assert.equal(parsed.data.provenance?.origin, "agent_runtime");
  assert.equal(parsed.data.provenance?.source, "goal_autocontinuation");
  assert.equal(parsed.data.provenance?.humanAuthored, false);
  assert.equal(parsed.data.provenance?.originalUserIntentId, GOAL_INTENT_ID);

  // The same fact also rides the raw metadata seed the fallback reader uses.
  const seed = message.metadata?.inputIntent as { provenance?: { origin?: string } } | undefined;
  assert.equal(seed?.provenance?.origin, "agent_runtime");
});
