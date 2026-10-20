import assert from "node:assert/strict";
import test from "node:test";
import { IZaicodeAuditLoopService, IZaicodeAuditService, type ServiceCollection } from "@zcode/services";
import { createZaicodeAuditLoopAdmission } from "../src/host/zaicodeAuditLoopAdmission.js";
import type { ZaicodeTerminalOutcomeEvent } from "../src/host/zaicodeRunDispatch.js";

/**
 * T-289 (SRC-202): the host's half of "start only from an authoritative
 * execution completion event".
 *
 * The event under test is exactly what the runtime's own terminal callback
 * produces after `reportRunOutcome` succeeds. Nothing here reads chat text, a
 * timer or a model's claim, because nothing else can reach this function.
 */

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

interface AdmittedInput {
  workspaceKey: string;
  projectName: string;
  autoAudits: boolean;
  executor: { jobId: string };
}

function harness(options: { autoAudits?: boolean; admitFails?: { code: string; reason: string }; resumeThrows?: boolean } = {}) {
  const admitted: AdmittedInput[] = [];
  const advanced: string[] = [];
  const resumed: { workspaceKey: string; jobId: string; terminalDisposition: string }[] = [];
  const warnings: string[] = [];
  const loops = {
    admit: async (input: AdmittedInput) => {
      if (options.admitFails) return { ok: false as const, ...options.admitFails };
      admitted.push(input);
      return { ok: true as const, run: { loopId: "loop-1" } };
    },
    advance: async (loopId: string) => {
      advanced.push(loopId);
      return null;
    },
    resumeFromTerminalJob: async (input: { workspaceKey: string; jobId: string; terminalDisposition: string }) => {
      resumed.push(input);
      if (options.resumeThrows) throw new Error("resume failed");
      return null;
    },
  };
  const audits = { getState: async () => ({ autoAudits: options.autoAudits !== false }) };
  const services = {
    getOptional: (descriptor: { channelName: string }) => {
      if (descriptor.channelName === IZaicodeAuditLoopService.channelName) return loops;
      if (descriptor.channelName === IZaicodeAuditService.channelName) return audits;
      return null;
    },
  } as unknown as ServiceCollection;
  const admit = createZaicodeAuditLoopAdmission({
    resolveServices: () => services,
    logWarn: (message) => warnings.push(message),
  });
  return { admit, admitted, advanced, resumed, warnings };
}

function event(overrides: Partial<ZaicodeTerminalOutcomeEvent> = {}): ZaicodeTerminalOutcomeEvent {
  return {
    jobId: "job-1",
    workspaceKey: "ws-1",
    workspacePath: "C:/proj/zaicode",
    agentId: "agent-1",
    sessionId: "session-1",
    taskId: "job-1",
    outcome: "succeeded",
    title: "executor task",
    ...overrides,
  };
}

test("a completed executor job admits one run and advances it once", async () => {
  const h = harness();
  h.admit(event());
  await tick();
  assert.equal(h.admitted.length, 1);
  assert.equal(h.admitted[0]!.workspaceKey, "ws-1");
  assert.equal(h.admitted[0]!.projectName, "zaicode");
  assert.equal(h.admitted[0]!.executor.jobId, "job-1");
  assert.equal(h.admitted[0]!.autoAudits, true);
  assert.deepEqual(h.advanced, ["loop-1"]);
});

test("a failed or stopped job admits nothing", async () => {
  const h = harness();
  h.admit(event({ outcome: "failed" }));
  h.admit(event({ outcome: "stopped" }));
  await tick();
  assert.equal(h.admitted.length, 0);
  assert.deepEqual(h.advanced, []);
});

test("a review or fix the loop dispatched resumes the EXISTING run instead of admitting one", async () => {
  // The run is found by the DURABLE job id it recorded; this is what lets the
  // loop advance with no poller and no second loop.
  const h = harness();
  h.admit(event({ title: "AuditLoop loop-1 c0 review", jobId: "job-review" }));
  h.admit(event({ title: "AuditLoop loop-1 c0 fix", jobId: "job-fix" }));
  await tick();
  assert.equal(h.admitted.length, 0);
  assert.deepEqual(h.advanced, []);
  assert.deepEqual(
    h.resumed.map((entry) => entry.jobId),
    ["job-review", "job-fix"],
  );
  assert.equal(h.resumed[0]!.workspaceKey, "ws-1");
  assert.match(h.resumed[0]!.terminalDisposition, /job-review succeeded/);
  assert.deepEqual(h.warnings, []);
});

test("a failed review or fix job still resumes: that is how the run reaches its own terminal state", async () => {
  const h = harness();
  h.admit(event({ title: "AuditLoop loop-1 c0 fix", jobId: "job-fix", outcome: "failed" }));
  await tick();
  assert.equal(h.admitted.length, 0);
  assert.deepEqual(h.resumed.map((entry) => entry.jobId), ["job-fix"]);
  assert.match(h.resumed[0]!.terminalDisposition, /failed/);
});

test("an unknown or duplicate loop job finds no run and admits nothing", async () => {
  // The service matches by durable job id: a stale notification is a no-op.
  const h = harness();
  h.admit(event({ title: "AuditLoop loop-9 c3 review", jobId: "job-unknown" }));
  h.admit(event({ title: "AuditLoop loop-9 c3 review", jobId: "job-unknown" }));
  await tick();
  assert.equal(h.admitted.length, 0);
  assert.deepEqual(h.advanced, []);
  assert.deepEqual(h.warnings, []);
  assert.equal(h.resumed.length, 2);
});

test("a resume failure is reported, never silent", async () => {
  const h = harness({ resumeThrows: true });
  h.admit(event({ title: "AuditLoop loop-1 c0 review", jobId: "job-review" }));
  await tick();
  assert.equal(h.admitted.length, 0);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0]!, /audit loop/i);
});

test("the existing A3 automatic-audit switch is the permission the loop carries", async () => {
  const off = harness({ autoAudits: false });
  off.admit(event());
  await tick();
  assert.equal(off.admitted[0]!.autoAudits, false);

  const on = harness({ autoAudits: true });
  on.admit(event());
  await tick();
  assert.equal(on.admitted[0]!.autoAudits, true);
});

test("a refusal never advances, and an expected refusal is not an incident", async () => {
  const h = harness({ admitFails: { code: "CONFLICTING_LOOP", reason: "loop-0 is already running" } });
  h.admit(event());
  await tick();
  assert.deepEqual(h.advanced, []);
  assert.equal(h.warnings.length, 0);

  const noisy = harness({ admitFails: { code: "SOURCE_EVIDENCE_UNSTABLE", reason: "no stable identity" } });
  noisy.admit(event());
  await tick();
  assert.deepEqual(noisy.advanced, []);
  assert.equal(noisy.warnings.length, 1);
  assert.match(noisy.warnings[0]!, /SOURCE_EVIDENCE_UNSTABLE/);
});

test("a workspace without the loop service is silently skipped", async () => {
  const services = { getOptional: () => null } as unknown as ServiceCollection;
  const warnings: string[] = [];
  const admit = createZaicodeAuditLoopAdmission({
    resolveServices: () => services,
    logWarn: (message) => warnings.push(message),
  });
  admit(event());
  await tick();
  assert.equal(warnings.length, 0);
});
