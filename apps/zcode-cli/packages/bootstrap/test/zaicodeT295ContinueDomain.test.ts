import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitRecognizedContinue,
  isRecognizedContinueCommand,
  V4RecognizedContinueRejectedError,
} from "../src/zcode-protocol-v4/commands/continue-command.js";
import {
  hasSaipenProjectMemory,
  isSessionGoalContinuable,
  parseSaipenContinueAnswer,
  resolveContinueOwner,
  resolveSaipenHome,
  resolveSaipenLauncher,
  runSaipenContinueLauncher,
  SaipenContinueUnavailableError,
} from "../src/zcode-protocol-v4/commands/continue-owner.js";
import { CommandInbox } from "../src/zcode-protocol-v4/command-inbox.js";
import { inputIntentMetadataFromQueueItem } from "../src/zcode-protocol-v4/commands/input-intent.js";
import type { SaipenContinueAnswer } from "../src/zcode-protocol-v4/commands/continue-owner.js";

// T-295 (SRC-208): one recognized token, two owners.
//
// The operator's live failure was `guard.recognizedContinueGoalComplete` (and
// before that `...WithoutGoal`) for a bare `cc` in a project whose SAIPEN board
// was working: admission read the ZAICODE session goal and never asked the
// project. These cases pin the domain decision to observable effects -- who was
// called (the goal router or the SAIPEN boundary), how often, and what the
// operator is told -- so a re-entry that keeps reading only the local goal turns
// them red.

const OBJECTIVE = "ship the widget";

function tempProject(withSaipen: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "zaicode-t295-"));
  if (withSaipen) mkdirSync(join(root, ".saipen"), { recursive: true });
  return root;
}

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
    queueItemId: `queue_${sourceCommandId}`,
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

/**
 * The refusal the REAL launcher answers on a tripped safety valve (T-295 TASK 1:
 * exit 1, valid canonical JSON on stdout, empty stderr).
 */
const SAFETY_VALVE_REFUSAL = {
  ok: false,
  code: "RECONCILE_REAUTH_REQUIRED",
  message: "bounded run requires a fresh operator cc; WAIT: safety valve reached (0 waves / 20 tickets) -- run 'cc' to continue",
  next_action: "WAIT: safety valve reached (0 waves / 20 tickets) -- run 'cc' to continue",
  operator_action_due: true,
  safety_valve_tripped: true,
  remediation: "SAFETY_VALVE_TRIPPED",
};

function refusedAnswer(overrides: Partial<SaipenContinueAnswer>): SaipenContinueAnswer {
  return {
    ok: false,
    receipt: "refused",
    action: null,
    ticket: null,
    detail: "",
    code: null,
    remediation: null,
    nextAction: null,
    operatorActionDue: false,
    safetyValveTripped: false,
    canonicalNextCommand: null,
    exitStatus: 1,
    ...overrides,
  };
}

/** The launcher stub: records every consultation and returns one disposition. */
function launcherStub(disposition: "actionable" | "refused" | "unavailable"): {
  calls: number;
  port: () => Promise<SaipenContinueAnswer>;
} {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    port: async () => {
      state.calls += 1;
      if (disposition === "unavailable") {
        throw new SaipenContinueUnavailableError(
          "no SAIPEN launcher resolved: set SAIPEN_HOME or initialize .saipen/ with saipen_home",
          "SAIPEN_LAUNCHER_UNAVAILABLE",
        );
      }
      if (disposition === "refused") {
        return refusedAnswer({
          code: "OPERATOR_REQUIRED",
          remediation: "OPERATOR_DECISION",
          operatorActionDue: true,
          detail: "this ticket records a decision only the operator can take",
        });
      }
      return {
        ok: true,
        receipt: "accepted",
        action: "PHASE SCOUT T-307",
        ticket: "T-307",
        detail: "",
        code: null,
        remediation: null,
        nextAction: null,
        operatorActionDue: false,
        safetyValveTripped: false,
        canonicalNextCommand: null,
        exitStatus: 0,
      };
    },
  };
}

function subject(
  options: {
    workspacePath?: string;
    target?: any;
    busy?: boolean;
    /** undefined = the host exposes no SAIPEN boundary at all. */
    launcher?: { calls: number; port: () => Promise<SaipenContinueAnswer> } | null;
    sessionId?: string;
  } = {},
): any {
  const sessionId = options.sessionId ?? "s-1";
  const target =
    options.target === undefined ? goalOf("active", OBJECTIVE, sessionId) : options.target;
  const counters = { router: 0, modelReady: 0, launcher: 0, executions: 0 };
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
      continueActiveTarget: async () => {
        counters.router += 1;
        return null;
      },
      sendInput: async () => {
        counters.executions += 1;
        return { kind: "started_turn", completion: Promise.resolve() };
      },
    },
    workspace: { workspacePath: options.workspacePath ?? "V:/fixture" },
    persistence: "immediate",
    ...(options.busy ? { activeAbortController: new AbortController() } : {}),
  };
  const host: any = {
    ensureModelReady: async () => {
      counters.modelReady += 1;
    },
    afterLegacyStateMutation: async () => undefined,
  };
  if (options.launcher) {
    host.continueSaipenProject = async () => {
      counters.launcher += 1;
      return options.launcher!.port();
    };
  }
  return { counters, host, record };
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

// ── the decision function itself ────────────────────────────────────────────

test("T-295.0: the owner order is goal, then SAIPEN project, then none", () => {
  assert.equal(
    resolveContinueOwner({ sessionGoalContinuable: true, saipenProject: true }),
    "zaicode-goal",
  );
  assert.equal(
    resolveContinueOwner({ sessionGoalContinuable: true, saipenProject: false }),
    "zaicode-goal",
  );
  assert.equal(
    resolveContinueOwner({ sessionGoalContinuable: false, saipenProject: true }),
    "saipen-project",
  );
  assert.equal(
    resolveContinueOwner({ sessionGoalContinuable: false, saipenProject: false }),
    "none",
  );
  // Only an active goal can actually continue and own the command; paused yields to SAIPEN.
  assert.equal(isSessionGoalContinuable(goalOf("active")), true);
  assert.equal(isSessionGoalContinuable(goalOf("paused")), false);
  assert.equal(isSessionGoalContinuable(goalOf("complete")), false);
  assert.equal(isSessionGoalContinuable(goalOf("budget_limited")), false);
  assert.equal(isSessionGoalContinuable(null), false);
});

test("T-295.0: the launcher answer is read, never invented", () => {
  const accepted = parseSaipenContinueAnswer(
    '{"ok":true,"action":"PHASE SCOUT T-307","ticket":"T-307","load_path":"x"}',
    0,
  );
  assert.equal(accepted.ok, true);
  assert.equal(accepted.receipt, "accepted");
  assert.equal(accepted.action, "PHASE SCOUT T-307");
  assert.equal(accepted.ticket, "T-307");
  assert.equal(accepted.detail, "");
  assert.equal(accepted.exitStatus, 0);

  const refused = parseSaipenContinueAnswer(
    '{"ok":false,"code":"VALIDATION_FAILED","detail":"STATE.md is missing"}',
    1,
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.receipt, "refused");
  assert.equal(refused.action, null);
  assert.equal(refused.code, "VALIDATION_FAILED");
  assert.equal(refused.detail, "VALIDATION_FAILED — STATE.md is missing");
  assert.equal(refused.exitStatus, 1);
  // An ok answer with no action cannot authorize anything.
  assert.equal(parseSaipenContinueAnswer('{"ok":true}', 0).action, null);
  assert.throws(() => parseSaipenContinueAnswer("not json"), SaipenContinueUnavailableError);
});

// ── R: the T-295 incident, pinned to the receipt it actually produced ────────

test("T-295.R1: JSON success on exit 0 is accepted", () => {
  const answer = parseSaipenContinueAnswer(JSON.stringify(SAFETY_VALVE_REFUSAL).replace("false", "true").replace('"RECONCILE_REAUTH_REQUIRED"', '"VALVE_REAUTHORIZED"'), 0);
  assert.equal(answer.ok, true);
  assert.equal(answer.receipt, "accepted");
});

test("T-295.R2: a structured refusal on a NONZERO exit is a refusal, not an unavailable launcher", () => {
  // The measured incident: exit 1 with this exact body on stdout and empty stderr.
  const answer = parseSaipenContinueAnswer(JSON.stringify(SAFETY_VALVE_REFUSAL), 1);
  assert.equal(answer.ok, false);
  assert.equal(answer.receipt, "refused");
  assert.equal(answer.code, "RECONCILE_REAUTH_REQUIRED");
  assert.equal(answer.remediation, "SAFETY_VALVE_TRIPPED");
  assert.equal(answer.operatorActionDue, true);
  assert.equal(answer.safetyValveTripped, true);
  assert.equal(answer.exitStatus, 1);
  assert.match(answer.detail, /safety valve reached \(0 waves \/ 20 tickets\)/);
  assert.match(answer.nextAction ?? "", /run 'cc' to continue/);
});

test("T-295.R3: a structured refusal on exit 0 is exactly as authoritative", () => {
  const answer = parseSaipenContinueAnswer(
    JSON.stringify({ ...SAFETY_VALVE_REFUSAL, remediation: "OPERATOR_DECISION", safety_valve_tripped: false }),
    0,
  );
  assert.equal(answer.ok, false);
  assert.equal(answer.receipt, "refused");
  assert.equal(answer.remediation, "OPERATOR_DECISION");
  assert.equal(answer.safetyValveTripped, false);
});

test("T-295.R4: an ok:true receipt on a nonzero exit never authorizes anything", () => {
  const answer = parseSaipenContinueAnswer('{"ok":true,"action":"PHASE SCOUT T-307","ticket":"T-307"}', 9);
  assert.equal(answer.ok, false, "a failing process cannot have granted a continuation");
  assert.equal(answer.receipt, "refused");
  assert.equal(answer.action, null);
  assert.equal(answer.exitStatus, 9);
});

test("T-295.R5: arbitrary malformed output is never read as an authorization", () => {
  for (const junk of ["not json", "", "[]", '"just a string"', '{"hello":"world"}', '{"ok":"yes"}']) {
    assert.throws(
      () => parseSaipenContinueAnswer(junk, 1),
      SaipenContinueUnavailableError,
      JSON.stringify(junk),
    );
  }
});

// ── A/B/D: a complete or absent local goal no longer blocks the project ─────

test("T-295.A: a complete local goal does not refuse an actionable SAIPEN ticket", async () => {
  const project = tempProject(true);
  const launcher = launcherStub("actionable");
  const s = subject({ workspacePath: project, target: goalOf("complete"), launcher });
  await admitRecognizedContinue(s.host, s.record, { inputId: "cmd-op-1", intent: operatorIntent() });
  assert.equal(s.counters.launcher, 1);
  assert.equal(s.counters.router, 0);
  assert.equal(s.counters.modelReady, 1, "routed project work uses normal model admission");
  assert.equal(s.counters.executions, 1, "an actionable receipt starts execution");
  rmSync(project, { recursive: true, force: true });
});

test("T-295.B: an absent local goal does not refuse an actionable SAIPEN ticket", async () => {
  const project = tempProject(true);
  const launcher = launcherStub("actionable");
  const s = subject({ workspacePath: project, target: null, launcher });
  await admitRecognizedContinue(s.host, s.record, { inputId: "cmd-op-1", intent: operatorIntent() });
  assert.equal(s.counters.launcher, 1);
  assert.equal(s.counters.router, 0);
  rmSync(project, { recursive: true, force: true });
});

test("T-295.C: an active local goal in a non-SAIPEN project keeps the goal route", async () => {
  const s = subject({ workspacePath: "V:/fixture", launcher: launcherStub("actionable") });
  await admitRecognizedContinue(s.host, s.record, { inputId: "cmd-op-1", intent: operatorIntent() });
  assert.equal(s.counters.router, 1);
  assert.equal(s.counters.launcher, 0);
});

test("T-295.D: both domains available resolves to the session goal, deterministically", async () => {
  const project = tempProject(true);
  const launcher = launcherStub("actionable");
  const s = subject({ workspacePath: project, launcher });
  await admitRecognizedContinue(s.host, s.record, { inputId: "cmd-op-1", intent: operatorIntent() });
  assert.equal(s.counters.router, 1);
  assert.equal(s.counters.launcher, 0);
  rmSync(project, { recursive: true, force: true });
});

test("T-295: the project root, not the session id, decides the domain", () => {
  const project = tempProject(true);
  assert.equal(hasSaipenProjectMemory(project), true);
  assert.equal(hasSaipenProjectMemory("V:/fixture"), false);
  rmSync(project, { recursive: true, force: true });
});

// ── E/N: the launcher's own refusal is what the operator is told ────────────

test("T-295.E/N: a SAIPEN refusal is returned verbatim, not as a goal error", async () => {
  const project = tempProject(true);
  const launcher = launcherStub("refused");
  // Only an active goal owns the command; paused, complete, budget_limited, or none
  // leave the command to the project boundary.
  for (const status of ["paused", "complete", "budget_limited"]) {
    const s = subject({ workspacePath: project, target: goalOf(status), launcher });
    const error = await assertRejected(
      admitRecognizedContinue(s.host, s.record, { inputId: "cmd-op-1", intent: operatorIntent() }),
      "guard.recognizedContinueSaipenOperator",
    );
    assert.match(error.message, /OPERATOR_REQUIRED/);
    assert.equal(s.counters.router, 0);
  }
  // A project command is never described with the session goal's vocabulary.
  const absent = subject({ workspacePath: project, target: null, launcher });
  const error = await assertRejected(
    admitRecognizedContinue(absent.host, absent.record, {
      inputId: "cmd-op-1",
      intent: operatorIntent(),
    }),
    "guard.recognizedContinueSaipenOperator",
  );
  assert.doesNotMatch(error.message, /no goal to continue|goal is complete/i);
  assert.equal(absent.counters.launcher, 1);
  rmSync(project, { recursive: true, force: true });
});

// ── F/G: the trusted boundary is the carrier; .saipen alone grants nothing ──

test("T-295.F: a SAIPEN project without a trusted boundary is refused, not guessed", async () => {
  const project = tempProject(true);
  const s = subject({ workspacePath: project, target: null });
  const error = await assertRejected(
    admitRecognizedContinue(s.host, s.record, { inputId: "cmd-op-1", intent: operatorIntent() }),
    "guard.recognizedContinueNoOwner",
  );
  assert.match(error.message, /saipen continue/);
  assert.equal(s.counters.router, 0);
  assert.equal(s.counters.modelReady, 0);
  rmSync(project, { recursive: true, force: true });
});

test("T-295.G: a bare .saipen directory without an actionable ticket grants nothing", async () => {
  const project = tempProject(true);
  const launcher = launcherStub("refused");
  const s = subject({ workspacePath: project, target: null, launcher });
  await assertRejected(
    admitRecognizedContinue(s.host, s.record, { inputId: "cmd-op-1", intent: operatorIntent() }),
    "guard.recognizedContinueSaipenOperator",
  );
  assert.equal(s.counters.launcher, 1, "the directory only selected the question, it did not answer it");
  rmSync(project, { recursive: true, force: true });
});

// ── H: stale or forged carriers stay refused before any boundary is asked ───

test("T-295.H: a stale or foreign carrier never reaches the project boundary", async () => {
  const project = tempProject(true);
  const launcher = launcherStub("actionable");
  const forged: any = {
    ...carrierIntent("s-1"),
    provenance: {
      sourceCommandId: "cmd-auto-1",
      origin: "agent_runtime",
      source: "goal_autocontinuation",
      humanAuthored: true,
    },
  };
  for (const intent of [forged, carrierIntent("s-9", OBJECTIVE), undefined]) {
    const s = subject({ workspacePath: project, target: null, launcher });
    await assertRejected(
      admitRecognizedContinue(s.host, s.record, { inputId: "cmd-auto-1", intent }),
      "guard.recognizedContinueAuthorizationExpired",
    );
    assert.equal(s.counters.launcher, 0);
  }
  rmSync(project, { recursive: true, force: true });
});

test("T-295.L: an authorization minted for another project cannot switch domain", async () => {
  const project = tempProject(true);
  const launcher = launcherStub("actionable");
  const s = subject({ workspacePath: project, target: null, launcher });
  await assertRejected(
    admitRecognizedContinue(s.host, s.record, {
      inputId: "cmd-auto-1",
      intent: carrierIntent("s-B", OBJECTIVE, "other-project"),
    }),
    "guard.recognizedContinueAuthorizationExpired",
  );
  assert.equal(s.counters.launcher, 0);
  rmSync(project, { recursive: true, force: true });
});

test("T-295: an automatic continuation cannot acquire SAIPEN authority by itself", async () => {
  const project = tempProject(true);
  const launcher = launcherStub("actionable");
  // A carrier valid for THIS session, but the session goal is gone: the goal
  // domain's own verdict applies, and the project boundary is never asked.
  const s = subject({ workspacePath: project, target: goalOf("complete"), launcher });
  await assertRejected(
    admitRecognizedContinue(s.host, s.record, { inputId: "cmd-auto-1", intent: carrierIntent("s-1") }),
    "guard.recognizedContinueGoalComplete",
  );
  assert.equal(s.counters.launcher, 0);
  rmSync(project, { recursive: true, force: true });
});

// ── I/K: queue promotion and duplicate identity ─────────────────────────────

test("T-295.I: a promoted queued cc goes to the project boundary, once", async () => {
  const project = tempProject(true);
  const launcher = launcherStub("actionable");
  const intent = inputIntentMetadataFromQueueItem(
    {
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
        origin: "real_user",
        source: "operator_ingress",
        humanAuthored: true,
      },
    } as any,
    "cc",
  );
  assert.equal(intent.provenance?.source, "queue_promotion");
  const s = subject({ workspacePath: project, target: null, launcher });
  await admitRecognizedContinue(s.host, s.record, { inputId: "cmd-promo-1", intent });
  assert.equal(s.counters.launcher, 1);
  rmSync(project, { recursive: true, force: true });
});

test("T-295.K: duplicate command identity never consults the project boundary twice", async () => {
  const inbox = new CommandInbox({ getRevision: () => 1, getLogEpoch: () => "e" });
  const raw = {
    commandId: "cc-t295-dup-1",
    clientId: "c-1",
    sessionId: "s-1",
    type: "sendText",
    payload: { text: "cc" },
    issuedAt: 1,
  };
  let handled = 0;
  const first = await inbox.handle(raw);
  assert.equal(first.kind, "execute");
  if (first.kind === "execute") {
    handled += 1;
    first.settle({ status: "accepted" });
  }
  const second = await inbox.handle(raw);
  assert.equal(second.kind, "ack");
  if (second.kind === "ack") assert.equal(second.ack.status, "duplicate");
  assert.equal(handled, 1);
});

// ── J/M: preconditions are unchanged ───────────────────────────────────────

test("T-295.J: a busy session is still refused before any domain is chosen", async () => {
  const project = tempProject(true);
  const launcher = launcherStub("actionable");
  const s = subject({ workspacePath: project, target: null, busy: true, launcher });
  await assertRejected(
    admitRecognizedContinue(s.host, s.record, { inputId: "cmd-op-1", intent: operatorIntent() }),
    "guard.recognizedContinueSessionBusy",
  );
  assert.equal(s.counters.launcher, 0);
  rmSync(project, { recursive: true, force: true });
});

test("T-295.N1: an authoritative safety-valve refusal is reported as the valve, never as an unavailable launcher", async () => {
  const project = tempProject(true);
  const launcher: { calls: number; port: () => Promise<SaipenContinueAnswer> } = {
    calls: 0,
    port: async () => {
      launcher.calls += 1;
      return refusedAnswer({
        code: "RECONCILE_REAUTH_REQUIRED",
        remediation: "SAFETY_VALVE_TRIPPED",
        operatorActionDue: true,
        safetyValveTripped: true,
        exitStatus: 1,
        detail: "the SAIPEN safety valve is reached: WAIT: safety valve reached (0 waves / 20 tickets) -- run 'cc' to continue",
      });
    },
  };
  const s = subject({ workspacePath: project, target: null, launcher });
  const error = await assertRejected(
    admitRecognizedContinue(s.host, s.record, { inputId: "cmd-op-1", intent: operatorIntent(), operatorText: "cc" }),
    "guard.recognizedContinueSaipenValve",
  );
  assert.match(error.message, /safety valve/i);
  assert.doesNotMatch(error.message, /unavailable|could not be started|exited \d+/i);
  rmSync(project, { recursive: true, force: true });
});

// ── T-315: the refusal flavor travels as the guard code, not as prose ───────
// T-295 fixed the wrong-code half (authoritative refusal reported unavailable);
// the UI still re-derived the MEANING from the sentence. These pin the code as
// the discriminator: structured fields pick the code, and the sentence can be
// reworded without changing the diagnosis.

test("T-315.A: an operator-decision refusal carries the operator code, whatever the sentence says", async () => {
  const project = tempProject(true);
  const launcher: { calls: number; port: () => Promise<SaipenContinueAnswer> } = {
    calls: 0,
    port: async () => {
      launcher.calls += 1;
      return refusedAnswer({
        code: "OPERATOR_REQUIRED",
        remediation: "OPERATOR_DECISION",
        operatorActionDue: true,
        safetyValveTripped: false,
        exitStatus: 1,
        detail: "reworded sentence with no valve or operator keywords at all",
      });
    },
  };
  const s = subject({ workspacePath: project, target: null, launcher });
  const error = await assertRejected(
    admitRecognizedContinue(s.host, s.record, { inputId: "cmd-op-1", intent: operatorIntent(), operatorText: "cc" }),
    "guard.recognizedContinueSaipenOperator",
  );
  assert.match(error.message, /reworded sentence/);
  rmSync(project, { recursive: true, force: true });
});

test("T-315.B: a flag-only valve refusal carries the valve code (remediation unset)", async () => {
  const project = tempProject(true);
  const launcher: { calls: number; port: () => Promise<SaipenContinueAnswer> } = {
    calls: 0,
    port: async () => {
      launcher.calls += 1;
      return refusedAnswer({
        code: "RECONCILE_REAUTH_REQUIRED",
        operatorActionDue: false,
        safetyValveTripped: true,
        exitStatus: 1,
        detail: "terse refusal, keywords scrubbed",
      });
    },
  };
  const s = subject({ workspacePath: project, target: null, launcher });
  await assertRejected(
    admitRecognizedContinue(s.host, s.record, { inputId: "cmd-op-1", intent: operatorIntent(), operatorText: "cc" }),
    "guard.recognizedContinueSaipenValve",
  );
  rmSync(project, { recursive: true, force: true });
});

test("T-315.C: a plain refusal with no flags stays the generic code", async () => {
  const project = tempProject(true);
  const launcher: { calls: number; port: () => Promise<SaipenContinueAnswer> } = {
    calls: 0,
    port: async () => {
      launcher.calls += 1;
      return refusedAnswer({
        code: "INGRESS_TASK_CARRIER_INVALID",
        exitStatus: 1,
        detail: "the carrier did not match",
      });
    },
  };
  const s = subject({ workspacePath: project, target: null, launcher });
  await assertRejected(
    admitRecognizedContinue(s.host, s.record, { inputId: "cmd-op-1", intent: operatorIntent(), operatorText: "cc" }),
    "guard.recognizedContinueSaipenRefused",
  );
  rmSync(project, { recursive: true, force: true });
});

test("T-295.M: an unreachable launcher is an explicit diagnostic, not silent parity", async () => {
  const project = tempProject(true);
  const launcher = launcherStub("unavailable");
  const s = subject({ workspacePath: project, target: null, launcher });
  const error = await assertRejected(
    admitRecognizedContinue(s.host, s.record, { inputId: "cmd-op-1", intent: operatorIntent() }),
    "guard.recognizedContinueSaipenUnavailable",
  );
  assert.match(error.message, /SAIPEN_HOME/);
  assert.equal(s.counters.router, 0);
  rmSync(project, { recursive: true, force: true });
});

// ── O/P: recognition and the session-scoped domain are untouched ────────────

test("T-295.O: ordinary prose containing cc stays ordinary prose", () => {
  for (const prose of ["cc me the file", "/cc", "cc all", "acc", "see cc above", ""]) {
    assert.equal(isRecognizedContinueCommand(prose), false, JSON.stringify(prose));
  }
  assert.equal(isRecognizedContinueCommand("cc"), true);
  assert.equal(isRecognizedContinueCommand("cc", ["attachment"]), false);
});

test("T-295.P: a non-SAIPEN project keeps every T-284 session refusal", async () => {
  const absent = subject({ target: null });
  await assertRejected(
    admitRecognizedContinue(absent.host, absent.record, { inputId: "cmd-op-1", intent: operatorIntent() }),
    "guard.recognizedContinueWithoutGoal",
  );
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
  assert.equal(absent.counters.router, 0);
  assert.equal(done.counters.router, 0);
  assert.equal(spent.counters.router, 0);
});

test("T-295.P0: a paused ZAICODE goal cannot hijack a SAIPEN WAIT_USER reauthorization", async () => {
  const project = tempProject(true);
  const launcher = launcherStub("refused");
  const pausedTarget = goalOf("paused");
  const s = subject({ workspacePath: project, target: pausedTarget, launcher });

  // 1. Manual operator cc routes to the SAIPEN launcher, NOT the goal router
  const error = await assertRejected(
    admitRecognizedContinue(s.host, s.record, {
      inputId: "cmd-op-1",
      intent: operatorIntent(),
      operatorText: "cc",
    }),
    "guard.recognizedContinueSaipenOperator",
  );
  assert.equal(s.counters.launcher, 1, "manual cc was delivered to the SAIPEN launcher");
  assert.equal(s.counters.router, 0, "paused goal did not hijack execution to goal router");
  assert.equal(pausedTarget.status, "paused", "target remained paused, not silently unpaused");
  assert.match(error.message, /OPERATOR_REQUIRED/);

  // 2. An autonomous continuation on a paused goal in a SAIPEN project is refused without reaching SAIPEN
  const autoSubject = subject({ workspacePath: project, target: goalOf("paused"), launcher });
  await assertRejected(
    admitRecognizedContinue(autoSubject.host, autoSubject.record, {
      inputId: "cmd-auto-1",
      intent: carrierIntent("s-1"),
    }),
    "guard.recognizedContinueAuthorizationExpired",
  );
  assert.equal(autoSubject.counters.launcher, 0, "autonomous continuation never consulted SAIPEN boundary");
  assert.equal(autoSubject.counters.router, 0, "autonomous continuation never unpaused the goal");

  rmSync(project, { recursive: true, force: true });
});

test("T-295.P0: a paused goal in a non-SAIPEN project resumes on manual cc but refuses autonomous cc", async () => {
  // Manual operator cc in a non-SAIPEN project resumes the paused goal
  const pausedTarget = goalOf("paused");
  const manual = subject({ workspacePath: "V:/fixture", target: pausedTarget });
  await admitRecognizedContinue(manual.host, manual.record, {
    inputId: "cmd-op-1",
    intent: operatorIntent(),
  });
  assert.equal(manual.counters.router, 1, "manual cc resumed the paused non-SAIPEN goal");
  assert.equal(pausedTarget.status, "active", "goal was resumed to active");

  // Autonomous continuation cannot resume a paused goal
  const autoTarget = goalOf("paused");
  const auto = subject({ workspacePath: "V:/fixture", target: autoTarget });
  await assertRejected(
    admitRecognizedContinue(auto.host, auto.record, {
      inputId: "cmd-auto-1",
      intent: carrierIntent("s-1"),
    }),
    "guard.recognizedContinueAuthorizationExpired",
  );
  assert.equal(auto.counters.router, 0, "autonomous continuation cannot resume a paused goal");
  assert.equal(autoTarget.status, "paused", "goal stayed paused");
});

// ── the real boundary: resolution and the child environment ────────────────

test("T-295: SAIPEN_HOME comes from the environment, then from the project's STATE.md", () => {
  const project = tempProject(true);
  writeFileSync(join(project, ".saipen", "STATE.md"), 'phase: DONE\nsaipen_home: "V:/somewhere/saipen"\n');
  assert.equal(resolveSaipenHome(project, { SAIPEN_HOME: "V:/env/saipen" } as never), "V:/env/saipen");
  assert.equal(resolveSaipenHome(project, {} as never), "V:/somewhere/saipen");
  assert.equal(resolveSaipenLauncher("V:/definitely/not/here", "linux"), null);
  rmSync(project, { recursive: true, force: true });
});

test(
  "T-295: the launcher runs in the project root and inherits the session environment",
  { skip: process.platform !== "win32" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "zaicode-t295-launch-"));
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(join(home, "bin"), { recursive: true });
    mkdirSync(join(project, ".saipen"), { recursive: true });
    writeFileSync(
      join(project, ".saipen", "STATE.md"),
      `phase: DONE\nsaipen_home: "${home}"\n`,
    );
    const carrier = "a".repeat(64);
    // A launcher that answers like the real one and echoes the carrier it was
    // LAUNCHED with; nothing in the product may rewrite that variable.
    writeFileSync(
      join(home, "bin", "saipen.cmd"),
      '@echo off\r\necho {"ok":true,"action":"PHASE SCOUT T-307","ticket":"T-307","detail":"%SAIPEN_TASK_SHA256%"}\r\n',
    );
    const env = { ...process.env, SAIPEN_TASK_SHA256: carrier };
    delete (env as Record<string, string | undefined>).SAIPEN_HOME;
    const answer = await runSaipenContinueLauncher(project, { env });
    assert.equal(answer.ok, true);
    assert.equal(answer.action, "PHASE SCOUT T-307");
    assert.equal(answer.ticket, "T-307");
    assert.equal(answer.detail, carrier, "the launched carrier reached the launcher unchanged");
    rmSync(root, { recursive: true, force: true });
  },
);

// the real boundary, live: receipt classification and the operator carrier.
// The spawned child is a fixture, not the SAIPEN engine: these prove the
// process contract (exit status, canonical JSON on a nonzero exit, and what
// the child environment carries), never a fabricated verdict.

const FAKE_LAUNCHER_SOURCE = [
  'import { readFileSync } from "node:fs";',
  'const carrier = process.env.SAIPEN_TASK_FILE || "";',
  'const sha = process.env.SAIPEN_TASK_SHA256 || "";',
  'let fileText = "<unset>";',
  'if (carrier) {',
  '  try { fileText = readFileSync(carrier, "utf8"); } catch { fileText = "<unreadable>"; }',
  '}',
  'const echo = "REFUSALECHO path=" + carrier + " file=" + fileText + " sha=" + sha;',
  'if (process.env.T295_MODE === "crash") {',
  '  process.stderr.write("launcher exploded with exit 7");',
  '  process.exit(7);',
  '}',
  'process.stdout.write(JSON.stringify({',
  '  ok: false,',
  '  code: "RECONCILE_REAUTH_REQUIRED",',
  '  remediation: "SAFETY_VALVE_TRIPPED",',
  '  detail: "WAIT: safety valve reached (0 waves / 20 tickets) " + echo,',
  '  operator_action_due: true,',
  '  safety_valve_tripped: true,',
  '  next_action: "run cc",',
  '  canonical_next_command: "saipen continue --json",',
  '}));',
  'process.exit(1);',
].join(String.fromCharCode(10));

function fakeLauncherProject(): { root: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), "zaicode-t295-live-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, "bin"), { recursive: true });
  mkdirSync(join(project, ".saipen"), { recursive: true });
  writeFileSync(
    join(project, ".saipen", "STATE.md"),
    ['phase: DONE', 'saipen_home: "' + home + '"', ""].join(String.fromCharCode(10)),
  );
  const batch = [
    "@echo off",
    'node "%~dp0fake-launcher.mjs" %*',
    "",
  ].join(String.fromCharCode(13) + String.fromCharCode(10));
  writeFileSync(join(home, "bin", "saipen.cmd"), batch, "utf8");
  writeFileSync(join(home, "bin", "fake-launcher.mjs"), FAKE_LAUNCHER_SOURCE, "utf8");
  return { root, project };
}

/** Hermetic: no carrier and no host SAIPEN_HOME may leak into the child. */
function liveChildEnv(mode: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        key !== "SAIPEN_TASK_FILE" &&
        key !== "SAIPEN_TASK_SHA256" &&
        key !== "SAIPEN_HOME",
    ),
  ) as NodeJS.ProcessEnv;
  env.T295_MODE = mode;
  return env;
}

test(
  "T-295.L1: the live launcher's canonical refusal on exit 1 is its verdict, not a transport failure",
  { skip: process.platform !== "win32" },
  async () => {
    const { root, project } = fakeLauncherProject();
    const answer = await runSaipenContinueLauncher(project, { env: liveChildEnv("refuse") });
    assert.equal(answer.ok, false);
    assert.equal(answer.receipt, "refused");
    assert.equal(answer.exitStatus, 1);
    assert.equal(answer.code, "RECONCILE_REAUTH_REQUIRED");
    assert.equal(answer.remediation, "SAFETY_VALVE_TRIPPED");
    assert.equal(answer.safetyValveTripped, true);
    assert.equal(answer.operatorActionDue, true);
    assert.equal(answer.canonicalNextCommand, "saipen continue --json");
    assert.match(answer.detail, /safety valve/i);
    rmSync(root, { recursive: true, force: true });
  },
);

test(
  "T-295.L2: a nonzero exit with no canonical receipt is an unavailable launcher carrying the exit status",
  { skip: process.platform !== "win32" },
  async () => {
    const { root, project } = fakeLauncherProject();
    let caught;
    try {
      await runSaipenContinueLauncher(project, { env: liveChildEnv("crash") });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof SaipenContinueUnavailableError);
    assert.equal(caught.code, "SAIPEN_LAUNCHER_FAILED");
    assert.equal(caught.diagnostics?.exitStatus, 7);
    assert.match(caught.message, /exited 7/);
    assert.match(caught.message, /exploded/);
    rmSync(root, { recursive: true, force: true });
  },
);

test(
  "T-295.L3: a real operator submission is declared to the launcher as the exact operator carrier",
  { skip: process.platform !== "win32" },
  async () => {
    const { root, project } = fakeLauncherProject();
    const answer = await runSaipenContinueLauncher(project, {
      env: liveChildEnv("refuse"),
      operatorText: "cc",
    });
    assert.ok(answer.detail.includes("file=cc"), "the child read the carrier: " + answer.detail);
    const at = answer.detail.indexOf("path=");
    assert.ok(at >= 0, "the child saw a carrier path: " + answer.detail);
    const rest = answer.detail.slice(at + "path=".length);
    const carrierPath = rest.slice(0, rest.indexOf(" file="));
    assert.equal(readFileSync(carrierPath, "utf8"), "cc");
    rmSync(root, { recursive: true, force: true });
  },
);

test(
  "T-295.L4: a continuation with no operator submission declares no carrier at all",
  { skip: process.platform !== "win32" },
  async () => {
    const { root, project } = fakeLauncherProject();
    const answer = await runSaipenContinueLauncher(project, { env: liveChildEnv("refuse") });
    assert.ok(answer.detail.includes("file=<unset>"), answer.detail);
    assert.ok(answer.detail.includes("sha= "), "no digest was minted: " + answer.detail);
    rmSync(root, { recursive: true, force: true });
  },
);

test(
  "T-295.L5: a digest carrier the session was launched with is never overwritten by a file one",
  { skip: process.platform !== "win32" },
  async () => {
    const { root, project } = fakeLauncherProject();
    const carrier = "355b1bbfc96725cdce8f4a2708fda310a80e6d13315aec4e5eed2a75fe8032ce";
    const env = liveChildEnv("refuse");
    env.SAIPEN_TASK_SHA256 = carrier;
    const answer = await runSaipenContinueLauncher(project, { env, operatorText: "cc" });
    assert.ok(answer.detail.includes("sha=" + carrier), "the launched digest reached the child: " + answer.detail);
    assert.ok(answer.detail.includes("file=<unset>"), "the digest carrier is not replaced: " + answer.detail);
    rmSync(root, { recursive: true, force: true });
  },
);
