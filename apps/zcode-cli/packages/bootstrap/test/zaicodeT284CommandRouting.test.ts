import assert from "node:assert/strict";
import { test } from "node:test";
import {
  admitRecognizedContinue,
  isRecognizedContinueCommand,
  V4RecognizedContinueRejectedError,
} from "../src/zcode-protocol-v4/commands/continue-command.js";
import { CommandInbox } from "../src/zcode-protocol-v4/command-inbox.js";
import {
  inputIntentMetadata,
  inputIntentMetadataFromQueueItem,
} from "../src/zcode-protocol-v4/commands/input-intent.js";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import { NATIVE_HANDLERS } from "../src/zcode-protocol-v4/commands/handlers/index.js";
import { parseGoalObjectiveFromCommandText } from "../src/zcode-protocol-v4/commands/goal-command-text.js";
import {
  inputProvenanceRowOrigin,
  inputProvenanceSemanticsOrigin,
} from "@zcode/shared/zcode-protocol-v4";
import {
  goalCompletionDispositionOf,
  isGoalCompletionBlockedDisposition,
  isGoalCompletionComplete,
} from "../../contracts/src/tools/goal-completion-disposition.js";

// T-284 (SAIHANDOFF F-04): fourteen admitted `cc` inputs were answered by the
// model from remembered blocker text with no router invocation. An admitted
// recognized command either executes its mechanical route or is refused with
// an explicit authoritative receipt -- never a model turn on the text.
//
// These cases drive the REAL admission (`admitRecognizedContinue`), the REAL
// recognizer, the REAL inbox and the REAL intent constructors, so a bypass in
// the production path turns them red.

const OBJECTIVE = "ship the widget";

function goalOf(status: string, objective = OBJECTIVE, sessionId = "s-1"): any {
  return {
    sessionID: sessionId,
    targetID: "t-1",
    objective,
    summaryTitle: null,
    status,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    time: { created: 1, updated: 1 },
  };
}

function operatorIntent(sourceCommandId = "cmd-op-1"): any {
  return {
    sourceCommandId,
    queueItemId: "queue_cmd-op-1",
    clientId: "c-1",
    kind: "sendText",
    text: "cc",
    admissionSeq: 1,
    admittedAt: 1,
    requestedDelivery: "startNow",
    admittedDelivery: "startNow",
    provenance: {
      sourceCommandId,
      origin: "real_user",
      source: "operator_ingress",
      humanAuthored: true,
    },
  };
}

function carrierIntent(sessionId: string, objective = OBJECTIVE, project = "p"): any {
  const carrier = `${project}::${sessionId}::${objective}`;
  return {
    sourceCommandId: "cmd-auto-1",
    queueItemId: "queue_cmd-auto-1",
    clientId: "c-1",
    kind: "sendText",
    text: "cc",
    admissionSeq: 2,
    admittedAt: 2,
    requestedDelivery: "startNow",
    admittedDelivery: "startNow",
    provenance: {
      sourceCommandId: "cmd-auto-1",
      origin: "agent_runtime",
      source: "goal_autocontinuation",
      humanAuthored: false,
      originalUserIntentId: carrier,
      goalIntentId: carrier,
      producerId: "zaicode-goal-continuation",
    },
  };
}

function subject(options: {
  sessionId?: string;
  target?: any;
  routerMissing?: boolean;
  busy?: boolean;
} = {}): any {
  const sessionId = options.sessionId ?? "s-1";
  const target = options.target === undefined ? goalOf("active", OBJECTIVE, sessionId) : options.target;
  const counters = { router: 0, modelReady: 0, mutation: 0 };
  let lastOpts: any = null;
  const record: any = {
    app: {
      sessionId,
      getMode: () => "build",
      runtime: { getPlanEnabled: () => false },
      readTarget: async () => target,
      updateTargetStatus: async (status: string) => {
        target.status = status;
        return target;
      },
    },
    workspace: { workspacePath: "V:/fixture" },
    persistence: "immediate",
    ...(options.busy ? { activeAbortController: new AbortController() } : {}),
  };
  if (!options.routerMissing) {
    record.app.continueActiveTarget = async (opts: any) => {
      counters.router += 1;
      lastOpts = opts;
      return null;
    };
  }
  const host: any = {
    ensureModelReady: async () => {
      counters.modelReady += 1;
    },
    afterLegacyStateMutation: async () => {
      counters.mutation += 1;
    },
  };
  return { counters, host, record, get lastOpts(): any { return lastOpts; } };
}

async function waitForRouter(counters: { router: number }): Promise<void> {
  for (let i = 0; i < 200 && counters.router === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function assertRejected(
  promise: Promise<unknown>,
  reasonCode: string,
): Promise<V4RecognizedContinueRejectedError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof V4RecognizedContinueRejectedError, `expected refusal, got ${String(error)}`);
  assert.equal(error.reasonCode, reasonCode);
  return error;
}

test("T-284.1: a recognized authorized command invokes the router exactly once", async () => {
  const s = subject();
  await admitRecognizedContinue(s.host, s.record, { inputId: "cmd-op-1", intent: operatorIntent() });
  await waitForRouter(s.counters);
  assert.equal(s.counters.router, 1);
  assert.equal(s.counters.modelReady, 1);
  assert.equal(s.lastOpts.inputId, "cmd-op-1");
});

test("T-284.2: a rejected command never reaches the model", async () => {
  const s = subject({ target: null });
  await assertRejected(
    admitRecognizedContinue(s.host, s.record, { inputId: "cmd-op-1", intent: operatorIntent() }),
    "guard.recognizedContinueWithoutGoal",
  );
  assert.equal(s.counters.router, 0);
  assert.equal(s.counters.modelReady, 0);
});

test("T-284.3: ordinary prose containing cc stays ordinary prose", () => {
  for (const prose of ["cc me the file", "/cc", "cc all", "acc", "cc!", "see cc above", ""]) {
    assert.equal(isRecognizedContinueCommand(prose), false, JSON.stringify(prose));
  }
  assert.equal(isRecognizedContinueCommand("cc"), true);
  assert.equal(isRecognizedContinueCommand("  CC  "), true);
  assert.equal(isRecognizedContinueCommand("cc", ["attachment"]), false);
});

test("T-284.4: an automatic continuation cannot reauthorize itself", async () => {
  const bare: any = {
    ...carrierIntent("s-1"),
    provenance: { sourceCommandId: "cmd-auto-1", origin: "agent_runtime", source: "goal_autocontinuation", humanAuthored: false },
  };
  const unknown: any = {
    ...carrierIntent("s-1"),
    provenance: { sourceCommandId: "cmd-auto-1", origin: "unknown", source: "unknown", humanAuthored: false },
  };
  for (const intent of [bare, unknown, undefined]) {
    const s = subject();
    await assertRejected(
      admitRecognizedContinue(s.host, s.record, { inputId: "cmd-auto-1", intent }),
      "guard.recognizedContinueAuthorizationExpired",
    );
    assert.equal(s.counters.router, 0);
    assert.equal(s.counters.modelReady, 0);
  }
});

test("T-284.5: duplicate command IDs do not duplicate side effects", async () => {
  const inbox = new CommandInbox({ getRevision: () => 1, getLogEpoch: () => "e" });
  const raw = {
    commandId: "cc-dup-1",
    clientId: "c-1",
    sessionId: "s-1",
    type: "sendText",
    payload: { text: "cc" },
    issuedAt: 1,
  };
  let executes = 0;
  const first = await inbox.handle(raw);
  assert.equal(first.kind, "execute");
  if (first.kind === "execute") {
    executes += 1;
    first.settle({ status: "accepted" });
  }
  const second = await inbox.handle(raw);
  assert.equal(second.kind, "ack");
  assert.equal(executes, 1);
  if (second.kind === "ack") assert.equal(second.ack.status, "duplicate");
});

test("T-284.6: queue promotion preserves command identity", () => {
  const item: any = {
    sourceCommandId: "cmd-orig-1",
    queueItemId: "queue_cmd-orig-1",
    clientId: "c-1",
    kind: "sendText",
    text: "cc",
    attachments: [],
    delivery: { requested: "queue", admitted: "queue" },
    order: { admissionSeq: 7 },
    admittedAt: 11,
    provenance: {
      sourceCommandId: "cmd-orig-1",
      origin: "agent_runtime",
      source: "goal_autocontinuation",
      humanAuthored: false,
      originalUserIntentId: "p::s-1::ship the widget",
    },
  };
  const intent = inputIntentMetadataFromQueueItem(item, "cc");
  assert.equal(intent.sourceCommandId, "cmd-orig-1");
  assert.equal(intent.queueItemId, "queue_cmd-orig-1");
  assert.equal(intent.provenance?.source, "queue_promotion");
  assert.equal(intent.provenance?.origin, "agent_runtime");
  assert.equal(intent.provenance?.originalUserIntentId, "p::s-1::ship the widget");
});

test("T-284.7: a lost acknowledgement does not replay completed work", async () => {
  const inbox = new CommandInbox({ getRevision: () => 1, getLogEpoch: () => "e" });
  const raw = {
    commandId: "cc-lost-ack-1",
    clientId: "c-1",
    sessionId: "s-1",
    type: "sendText",
    payload: { text: "cc" },
    issuedAt: 1,
  };
  let executes = 0;
  const first = await inbox.handle(raw);
  if (first.kind === "execute") {
    executes += 1;
    first.settle({ status: "accepted" });
  }
  const queried = await inbox.query([{ sessionId: "s-1", commandId: "cc-lost-ack-1" }]);
  assert.notEqual(queried[0]?.result, "unknown");
  const replay = await inbox.handle(raw);
  assert.equal(replay.kind, "ack");
  assert.equal(executes, 1);
});

test("T-284.8: a missing router returns an explicit failure", async () => {
  const s = subject({ routerMissing: true });
  await assertRejected(
    admitRecognizedContinue(s.host, s.record, { inputId: "cmd-op-1", intent: operatorIntent() }),
    "guard.recognizedContinueRouterUnavailable",
  );
  assert.equal(s.counters.router, 0);
});

test("T-284.9: a stale authorization is rejected", async () => {
  const s = subject({ target: goalOf("active", "new objective", "s-1") });
  await assertRejected(
    admitRecognizedContinue(s.host, s.record, { inputId: "cmd-auto-1", intent: carrierIntent("s-1", OBJECTIVE) }),
    "guard.recognizedContinueAuthorizationExpired",
  );
  assert.equal(s.counters.router, 0);
  assert.equal(s.counters.modelReady, 0);
});

test("T-284.10: a valid operator command uses the correct host context", async () => {
  const a = subject({ sessionId: "s-A", target: goalOf("active", OBJECTIVE, "s-A") });
  const b = subject({ sessionId: "s-B", target: goalOf("active", OBJECTIVE, "s-B") });
  await admitRecognizedContinue(a.host, a.record, { inputId: "cmd-A", intent: operatorIntent("cmd-A") });
  await waitForRouter(a.counters);
  assert.equal(a.counters.router, 1);
  assert.equal(a.lastOpts.inputId, "cmd-A");
  assert.equal(b.counters.router, 0);
});

test("T-284.11: different projects cannot reuse one another's authorization", async () => {
  const s = subject({ sessionId: "s-A", target: goalOf("active", OBJECTIVE, "s-A") });
  await assertRejected(
    admitRecognizedContinue(s.host, s.record, { inputId: "cmd-auto-1", intent: carrierIntent("s-B", OBJECTIVE, "other-project") }),
    "guard.recognizedContinueAuthorizationExpired",
  );
  assert.equal(s.counters.router, 0);
});

test("T-284.12: transcript hydration preserves command provenance", () => {
  const envelope: any = { commandId: "human-cmd-1", clientId: "c-1", sessionId: "s-1", type: "sendText", payload: {}, issuedAt: 1 };
  const human = inputIntentMetadata(envelope, { text: "cc", requestedDelivery: "startNow" });
  assert.equal(inputProvenanceSemanticsOrigin(human.provenance), "real_user");
  assert.equal(inputProvenanceRowOrigin(human.provenance), "realUser");
  const autoEnvelope: any = { commandId: "auto-goal:p::s-1::ship the widget:9", clientId: "c-1", sessionId: "s-1", type: "sendText", payload: {}, issuedAt: 1 };
  const auto = inputIntentMetadata(autoEnvelope, {
    text: "cc",
    requestedDelivery: "startNow",
    inputProvenance: {
      origin: "agent_runtime",
      source: "goal_autocontinuation",
      originalUserIntentId: "p::s-1::ship the widget",
      goalIntentId: "p::s-1::ship the widget",
      producerId: "zaicode-goal-continuation",
    },
  });
  assert.equal(inputProvenanceSemanticsOrigin(auto.provenance), "agent_runtime");
  assert.equal(inputProvenanceRowOrigin(auto.provenance), "goalContinuation");
});

test("T-284.13: existing native goal commands retain their behavior", () => {
  assert.equal(parseGoalObjectiveFromCommandText("/goal ship the widget"), "ship the widget");
  assert.equal(parseGoalObjectiveFromCommandText("  /GoAl replace old  "), "old");
  const executor = new V4CommandExecutor({} as any);
  assert.equal(executor.supports("sendGoalCommand"), true);
  assert.equal(executor.supports("sendText"), true);
});

test("T-284.14: blocked-goal and continuation protections remain intact", async () => {
  assert.equal(isGoalCompletionComplete({ passed: true, disposition: "complete" }), true);
  assert.equal(isGoalCompletionComplete({ passed: true, disposition: "blocked_human" }), false);
  assert.equal(goalCompletionDispositionOf({ passed: false, nextAction: "ask the operator" }), "continue");
  assert.equal(isGoalCompletionBlockedDisposition("blocked_human"), true);
  const done = subject({ target: goalOf("complete") });
  await assertRejected(
    admitRecognizedContinue(done.host, done.record, { inputId: "cmd-op-1", intent: operatorIntent() }),
    "guard.recognizedContinueGoalComplete",
  );
  const spent = subject({ target: goalOf("budget_limited") });
  await assertRejected(
    admitRecognizedContinue(spent.host, spent.record, { inputId: "cmd-op-1", intent: operatorIntent() }),
    "guard.recognizedContinueBudgetExhausted",
  );
  assert.equal(done.counters.router, 0);
  assert.equal(spent.counters.router, 0);
});

test("T-284.15: sendText admits a bare cc through the router, never the model", async () => {
  const counts = { router: 0, model: 0, modelReady: 0 };
  const target = goalOf("active", OBJECTIVE, "s-1");
  const record: any = {
    app: {
      sessionId: "s-1",
      getMode: () => "build",
      getModel: () => "fixture:model",
      runtime: {
        getPlanEnabled: () => false,
        getSessionModelSelection: () => ({ providerId: "p", modelId: "m" }),
      },
      readTarget: async () => target,
      updateTargetStatus: async (status: string) => {
        target.status = status;
        return target;
      },
      continueActiveTarget: async () => {
        counts.router += 1;
        return null;
      },
      sendInput: async () => {
        counts.model += 1;
        return { kind: "queued" };
      },
    },
    workspace: { workspacePath: "V:/fixture" },
    persistence: "immediate",
  };
  const host: any = {
    getRecord: (id: string) => (id === "s-1" ? record : undefined),
    getInputRoutingMode: () => "startNow",
    ensureModelReady: async () => {
      counts.modelReady += 1;
    },
    afterLegacyStateMutation: async () => undefined,
  };
  const envelope: any = {
    commandId: "cmd-cc-1",
    clientId: "c-1",
    sessionId: "s-1",
    type: "sendText",
    payload: { text: "cc" },
    issuedAt: 1,
  };
  const result = await (NATIVE_HANDLERS as any).sendText(host, envelope);
  await waitForRouter(counts);
  assert.equal(result?.type, "inputAccepted");
  assert.equal(counts.router, 1);
  assert.equal(counts.model, 0);
});
