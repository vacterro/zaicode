import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { ConversationV4Gateway } from "../src/zcode-protocol-v4/v4-gateway.js";
import { admitRecognizedContinueFromSendText } from "../src/zcode-protocol-v4/commands/continue-command.js";
import { parseSaipenContinueAnswer } from "../src/zcode-protocol-v4/commands/continue-owner.js";

const FIXTURE_PREFIX = "zaicode-t332-hook-";
const COMMAND_ID = "synthetic-t332-command";
const SESSION_ID = "synthetic-t332-session";

function fixture(options: { hookFailure?: boolean; modelFailure?: boolean; coreRefusal?: boolean; observerFailure?: boolean } = {}) {
  const project = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
  mkdirSync(join(project, ".saipen"));
  let complete!: () => void;
  let fail!: (error: Error) => void;
  const completion = new Promise<void>((resolveCompletion, rejectCompletion) => {
    complete = resolveCompletion;
    fail = rejectCompletion;
  });
  const effect = {
    dispatches: 0, routes: 0, cancelled: [] as string[], hooks: [] as string[],
    warnings: [] as { message: string; detail: any }[], errors: [] as string[],
  };
  const record: any = {
    workspace: { workspacePath: project }, persistence: "immediate",
    app: {
      sessionId: SESSION_ID, getMode: () => "build", readTarget: async () => null,
      runtime: { getPlanEnabled: () => false },
      sendInput: async () => {
        if (options.coreRefusal) return { kind: "rejected", reason: "controlled Core refusal" };
        effect.dispatches++;
        return { kind: "started_turn", completion };
      },
    },
  };
  const commandHost: any = {
    continueSaipenProject: async () => {
      effect.routes++;
      return parseSaipenContinueAnswer(JSON.stringify({ ok: true, action: "PHASE BUILD T-1", ticket: "T-1" }), 0);
    },
    ensureModelReady: async () => {
      if (options.modelFailure) throw new Error("controlled pre-admission model failure");
    },
    afterLegacyStateMutation: async (_record: unknown, reason: string) => {
      effect.hooks.push(reason);
      if (options.hookFailure && reason === "saipen_project_continue") {
        throw new Error("controlled post-admission hook failure");
      }
    },
    logger: {
      info: () => undefined,
      warn: (message: string, detail: any) => {
        effect.warnings.push({ message, detail });
        if (options.observerFailure) throw new Error("controlled diagnostic observer failure");
      },
    },
  };
  const gateway = new ConversationV4Gateway({
    sessionExists: () => true, emitWireFrame: () => undefined,
    admitCommandInput: async (envelope: any, admission: any) => ({
      sourceCommandId: envelope.commandId, queueItemId: admission.queueItemId, clientId: envelope.clientId,
      kind: "sendText", text: envelope.payload.text, attachments: [],
      delivery: { requested: "startNow", admitted: "startNow" }, order: { admissionSeq: admission.admissionSeq },
      admittedAt: admission.admittedAt,
      provenance: { sourceCommandId: envelope.commandId, origin: "real_user", source: "operator_ingress", humanAuthored: true },
    }),
    cancelCommandInput: async (_envelope: unknown, _queue: string, reason: string) => { effect.cancelled.push(reason); },
    executeCommand: async (envelope: any) =>
      admitRecognizedContinueFromSendText(commandHost, record, envelope, envelope.payload, "startNow"),
    onError: (scope: string, error: unknown) => { effect.errors.push(scope + ": " + String(error)); },
  } as any);
  const request = {
    commandId: COMMAND_ID, clientId: "synthetic-client", sessionId: SESSION_ID,
    type: "sendText", payload: { text: "cc" }, issuedAt: 1,
  };
  const dispose = () => {
    complete();
    assert.equal(dirname(resolve(project)), resolve(tmpdir()));
    assert.ok(basename(project).startsWith(FIXTURE_PREFIX));
    rmSync(project, { recursive: true, force: true });
  };
  return { gateway, request, effect, complete, fail, dispose };
}

test("T-332: post-start hook failure retains accepted admission and original cause", async () => {
  const f = fixture({ hookFailure: true });
  try {
    const ack = await f.gateway.handleCommand(f.request);
    assert.equal(f.effect.dispatches, 1);
    assert.equal(ack.status, "accepted");
    assert.equal(ack.result?.type, "inputAccepted");
    assert.deepEqual(f.effect.cancelled, []);
    assert.equal(f.effect.warnings.length, 1);
    assert.equal(f.effect.warnings[0]?.detail.error, "controlled post-admission hook failure");
    assert.equal(f.effect.warnings[0]?.detail.inputId, COMMAND_ID);
    assert.equal(f.effect.warnings[0]?.detail.sessionId, SESSION_ID);
  } finally { f.dispose(); }
});

test("T-332: same command-ID transport retry retains accepted result and dispatches once", async () => {
  const f = fixture({ hookFailure: true });
  try {
    const first = await f.gateway.handleCommand(f.request);
    const replay = await f.gateway.handleCommand(f.request);
    assert.equal(first.status, "accepted");
    assert.equal(replay.status, "duplicate");
    assert.deepEqual(replay.result, first.result);
    assert.equal(f.effect.dispatches, 1);
    assert.equal(f.effect.routes, 1);
    assert.deepEqual(f.effect.cancelled, []);
  } finally { f.dispose(); }
});

test("T-332: pre-admission model failure stays failed with zero dispatch", async () => {
  const f = fixture({ modelFailure: true });
  try {
    const ack = await f.gateway.handleCommand(f.request);
    assert.equal(ack.status, "failed");
    assert.equal(ack.message, "controlled pre-admission model failure");
    assert.equal(f.effect.dispatches, 0);
    assert.equal(f.effect.cancelled.length, 1);
  } finally { f.dispose(); }
});

test("T-332: Core refusal stays failed and never enters the post-start hook", async () => {
  const f = fixture({ coreRefusal: true });
  try {
    const ack = await f.gateway.handleCommand(f.request);
    assert.equal(ack.status, "failed");
    assert.match(ack.message ?? "", /controlled Core refusal/);
    assert.equal(f.effect.dispatches, 0);
    assert.deepEqual(f.effect.hooks, []);
    assert.equal(f.effect.cancelled.length, 1);
  } finally { f.dispose(); }
});

test("T-332: later execution failure remains separate from accepted command admission", async () => {
  const f = fixture();
  try {
    const ack = await f.gateway.handleCommand(f.request);
    assert.equal(ack.status, "accepted");
    f.fail(new Error("controlled later execution failure"));
    await setImmediate();
    assert.ok(f.effect.hooks.includes("prompt_failed"));
    assert.equal(f.effect.warnings[0]?.detail.error, "controlled later execution failure");
    const replay = await f.gateway.handleCommand(f.request);
    assert.equal(replay.status, "duplicate");
    assert.equal(f.effect.dispatches, 1);
    assert.deepEqual(f.effect.cancelled, []);
  } finally { f.dispose(); }
});

test("T-332: successful completion is reported through the existing completion owner", async () => {
  const f = fixture();
  try {
    const ack = await f.gateway.handleCommand(f.request);
    assert.equal(ack.status, "accepted");
    f.complete();
    await setImmediate();
    assert.deepEqual(f.effect.hooks, ["saipen_project_continue", "prompt_completed"]);
    assert.deepEqual(f.effect.warnings, []);
  } finally { f.dispose(); }
});

test("T-332: a failing diagnostic observer cannot undo an admitted command", async () => {
  const f = fixture({ hookFailure: true, observerFailure: true });
  try {
    const ack = await f.gateway.handleCommand(f.request);
    assert.equal(ack.status, "accepted");
    assert.equal(f.effect.dispatches, 1);
    assert.deepEqual(f.effect.cancelled, []);
    assert.equal(f.effect.warnings[0]?.detail.error, "controlled post-admission hook failure");
  } finally { f.dispose(); }
});

