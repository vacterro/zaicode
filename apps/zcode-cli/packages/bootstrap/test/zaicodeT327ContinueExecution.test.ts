import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { admitRecognizedContinue, admitRecognizedContinueFromSendText } from "../src/zcode-protocol-v4/commands/continue-command.js";
import { parseSaipenContinueAnswer } from "../src/zcode-protocol-v4/commands/continue-owner.js";
import { inputIntentMetadataFromQueueItem } from "../src/zcode-protocol-v4/commands/input-intent.js";
import { CommandInbox } from "../src/zcode-protocol-v4/command-inbox.js";

function fixture(options: { refusal?: boolean; wait?: boolean; modelFailure?: boolean; admission?: "rejected" | "queued" } = {}) {
  const project = mkdtempSync(join(tmpdir(), "zaicode-t327-"));
  mkdirSync(join(project, ".saipen"));
  const calls: { text: string; options: any }[] = [];
  let routes = 0;
  const action = options.wait ? "WAIT: operator decision required" : "PHASE BUILD T-327";
  const answer = parseSaipenContinueAnswer(JSON.stringify({
    ok: !options.refusal, action, ticket: "T-327",
    load_path: join(project, "protocol", "phases", "build.md"),
    execution_instruction: "Read load_path and execute action in this turn.",
    ...(options.refusal ? { code: "OPERATOR_REQUIRED", detail: "operator decision required", operator_action_due: true } : {}),
  }), options.refusal ? 1 : 0);
  const record: any = {
    workspace: { workspacePath: project }, persistence: "immediate",
    app: {
      sessionId: "session-t327", getMode: () => "build", readTarget: async () => null,
      runtime: { getPlanEnabled: () => false },
      sendInput: async (input: { text: string }, opts: any) => {
        calls.push({ text: input.text, options: opts });
        return options.admission
          ? { kind: options.admission, reason: "synthetic concurrent admission" }
          : { kind: "started_turn", completion: Promise.resolve() };
      },
    },
  };
  const host: any = {
    continueSaipenProject: async (selected: any) => {
      assert.equal(selected, record, "routing stays bound to the selected session");
      routes += 1;
      return answer;
    },
    ensureModelReady: async () => { if (options.modelFailure) throw new Error("synthetic model unavailable"); },
    afterLegacyStateMutation: async () => undefined,
  };
  const intent: any = {
    kind: "sendText", text: "cc", requestedDelivery: "startNow",
    provenance: { origin: "real_user", source: "operator_submission", originalUserIntentId: "original-t327" },
  };
  return { project, calls, host, record, intent, action, routes: () => routes, dispose: () => rmSync(project, { recursive: true, force: true }) };
}

test("T-327: an accepted cc starts routed work in the same session with the original identity", async () => {
  const s = fixture();
  try {
    await admitRecognizedContinue(s.host, s.record, { inputId: "original-t327", intent: s.intent, operatorText: "cc" });
    assert.equal(s.routes(), 1);
    assert.equal(s.calls.length, 1, "a router receipt must actually reach Core execution admission");
    assert.ok(s.calls[0]!.text.includes(s.action), "the current canonical action reaches the executor");
    assert.ok(s.calls[0]!.text.includes(join(s.project, "protocol", "phases", "build.md")), "the returned load path is preserved");
    assert.notEqual(s.calls[0]!.text.trim(), "cc", "the executor never answers a bare token from memory");
    assert.equal(s.calls[0]!.options.inputId, "original-t327");
    assert.equal(s.calls[0]!.options.queryId, "original-t327");
    assert.equal(s.calls[0]!.options.intent, s.intent);
    assert.equal(s.calls[0]!.options.requireIdle, true, "Core owns the final race check");
  } finally { s.dispose(); }
});

test("T-327: sendText and Cyrillic cc acknowledge only after actual execution admission", async () => {
  for (const text of ["cc", "сс"]) {
    const s = fixture();
    try {
      const envelope: any = { commandId: "original-t327", clientId: "client", sessionId: s.record.app.sessionId, type: "sendText", payload: { text }, issuedAt: 1 };
      const result = await admitRecognizedContinueFromSendText(s.host, s.record, envelope, { text }, "startNow");
      assert.equal(result?.type, "inputAccepted");
      assert.equal(s.calls.length, 1);
      assert.equal(s.calls[0]!.options.intent.provenance.origin, "real_user");
      assert.equal(s.calls[0]!.options.intent.text, text);
    } finally { s.dispose(); }
  }
});

test("T-327: canonical refusal and WAIT never start a turn", async () => {
  for (const options of [{ refusal: true }, { wait: true }]) {
    const s = fixture(options);
    try {
      await assert.rejects(admitRecognizedContinue(s.host, s.record, { inputId: "original-t327", intent: s.intent, operatorText: "cc" }), /operator decision/);
      assert.equal(s.calls.length, 0);
    } finally { s.dispose(); }
  }
});

test("T-327: a model failure or Core refusal cannot become silent success", async () => {
  for (const options of [{ modelFailure: true }, { admission: "rejected" as const }, { admission: "queued" as const }]) {
    const s = fixture(options);
    try {
      await assert.rejects(admitRecognizedContinue(s.host, s.record, { inputId: "original-t327", intent: s.intent, operatorText: "cc" }));
    } finally { s.dispose(); }
  }
});

test("T-327: queued operator cc executes with its canonical provenance and source identity", async () => {
  const s = fixture();
  try {
    const intent = inputIntentMetadataFromQueueItem({
      sourceCommandId: "queued-original", queueItemId: "queue_queued-original", clientId: "client",
      kind: "sendText", text: "cc", attachments: [], delivery: { requested: "queue", admitted: "queue" },
      order: { admissionSeq: 7 }, admittedAt: 11,
      provenance: { sourceCommandId: "queued-original", origin: "real_user", source: "operator_ingress", humanAuthored: true },
    } as any, "cc");
    await admitRecognizedContinue(s.host, s.record, { inputId: "queued-original", intent, operatorText: "cc" });
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0]!.options.inputId, "queued-original");
    assert.equal(s.calls[0]!.options.intent.provenance.source, "queue_promotion");
    assert.equal(s.calls[0]!.options.intent.provenance.origin, "real_user");
  } finally { s.dispose(); }
});

test("T-327: a transport replay cannot route or execute the accepted cc twice", async () => {
  const s = fixture();
  try {
    const inbox = new CommandInbox({ getRevision: () => 1, getLogEpoch: () => "epoch" });
    const raw = { commandId: "original-t327", clientId: "client", sessionId: s.record.app.sessionId, type: "sendText", payload: { text: "cc" }, issuedAt: 1 };
    const first = await inbox.handle(raw);
    assert.equal(first.kind, "execute");
    if (first.kind === "execute") {
      await admitRecognizedContinue(s.host, s.record, { inputId: raw.commandId, intent: s.intent, operatorText: "cc" });
      first.settle({ status: "accepted" });
    }
    assert.equal((await inbox.handle(raw)).kind, "ack");
    assert.equal(s.routes(), 1);
    assert.equal(s.calls.length, 1);
  } finally { s.dispose(); }
});
