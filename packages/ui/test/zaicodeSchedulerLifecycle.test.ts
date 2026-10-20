import assert from "node:assert/strict";
import test from "node:test";
import {
  createZaicodeAutostartJob,
  evaluateZaicodeAutostartJob,
  normalizeZaicodeAutostartJobs,
  normalizeZaicodeContinuingJobs,
  decideZaicodeContinuation,
  markZaicodeContinuationLimit,
  type ZaicodeContinuationRun,
  type ZaicodeEngineAccount,
  type ZaicodeLimitSnapshot,
} from "@zcode/shared";

const now = 20_000_000;
const account = (id: string, vendor: "codex" | "claude" = "codex"): ZaicodeEngineAccount => ({
  id,
  short: id,
  label: `${id} (${vendor})`,
  vendor,
  source: "fixture",
  home: null,
  isDefaultHome: true,
  cli: vendor,
  status: "ready",
  statusDetail: "",
  fixCommand: null,
});

const quota = (
  id: string,
  percent = 100,
  fetchedAt = now,
  resetsAt = now + 3600_000,
): ZaicodeLimitSnapshot => ({
  accountId: id,
  source: "vendor",
  plan: "fixture",
  fetchedAt,
  checkedAt: fetchedAt,
  error: null,
  windows: [
    {
      key: "five_hour",
      label: "5h",
      group: "",
      groupLabel: "",
      remainingPercent: percent,
      resetsAt,
      durationSeconds: 18_000,
      assumedFull: false,
    },
  ],
});

test("1. Initial-start timing: wait until explicitly configured start time", () => {
  const initialAt = now + 120_000;
  const job = createZaicodeAutostartJob({
    id: "job-1",
    projectPath: "C:/fixture",
    engineId: "acc-A",
    trigger: "everyReset",
    initialAt,
    firedEvents: [],
  });

  // Before initialAt: must return waiting-time
  const before = evaluateZaicodeAutostartJob(job, quota("acc-A"), initialAt - 1000);
  assert.equal(before.state, "waiting-time");
  assert.equal(before.dueAt, initialAt);
  assert.equal(before.eventId, `initial:${initialAt}`);
  assert.match(before.reason, /initial start time/);

  // At or after initialAt: must be due
  const atStart = evaluateZaicodeAutostartJob(job, quota("acc-A"), initialAt);
  assert.equal(atStart.state, "due");
  assert.equal(atStart.dueAt, initialAt);
  assert.equal(atStart.eventId, `initial:${initialAt}`);

  // If initial run has quota gate and watched engine is blocked: waits for quota
  const blockedQuota = quota("acc-A", 0);
  const waitingQuota = evaluateZaicodeAutostartJob(job, blockedQuota, initialAt);
  assert.equal(waitingQuota.state, "waiting-quota");

  // Once fired: initial event never fires again
  const postFired = {
    ...job,
    firedEvents: [`initial:${initialAt}`],
    lastRunAt: initialAt,
  };
  const afterRun = evaluateZaicodeAutostartJob(postFired, quota("acc-A"), initialAt + 1000);
  assert.equal(afterRun.state, "waiting-reset");
});

test("2. Ordered fallback chain: launch A if quota permits; on exhaustion continue on B", () => {
  const baseJob = normalizeZaicodeContinuingJobs([
    {
      id: "continuation-job",
      engineId: "acc-A",
      projectPath: "C:/fixture",
      continuation: {
        enabled: true,
        runnerIds: ["acc-B"],
        delayMinutes: 2,
        returnToPreferred: true,
        recoveryDelayMinutes: 1,
      },
    },
  ])[0]!;

  const baseRun: ZaicodeContinuationRun = {
    projectPath: "C:/fixture",
    workspaceKey: "ws-key",
    occurrence: "initial:20000000",
    runnerId: "acc-A",
    primaryRunnerId: "acc-A",
    lease: "lease-1",
    state: "running",
    workerId: "worker-1",
    generation: 1,
    blocked: [],
    nextAt: now,
    launchedAt: now - 5000,
    result: "",
  };

  const inputState = () => ({
    job: baseJob,
    run: { ...baseRun },
    accounts: [account("acc-A"), account("acc-B")],
    limits: { "acc-A": quota("acc-A"), "acc-B": quota("acc-B") },
    availablePools: new Set<string>(),
    now,
    autopilot: true,
    enabled: true,
    projectDisabled: false,
    stopDue: false,
  });

  const i = inputState();
  // While running on A with quota: owned runner is working
  assert.deepEqual(decideZaicodeContinuation(i), { action: "none", reason: "Owned runner is working" });

  // 3. Proven A quota exhaustion: mark limit for A
  const limitTime = now + 10_000;
  i.run = markZaicodeContinuationLimit(
    i.run,
    { window: "five_hour", resetText: "in 4h" },
    limitTime,
    2,
    { primaryRunnerId: "acc-A", fallbackRunnerIds: ["acc-B"] },
  );
  assert.equal(i.run.state, "waiting");
  assert.equal(i.run.blocked.length, 1);
  assert.equal(i.run.blocked[0]?.runnerId, "acc-A");

  // During handoff delay (2 min): wait
  i.now = limitTime + 30_000;
  assert.equal(decideZaicodeContinuation(i).action, "wait");

  // After handoff delay: switch to fallback runner B
  i.now = limitTime + 120_000;
  const decision = decideZaicodeContinuation(i);
  assert.deepEqual(decision, { action: "switch", runnerId: "acc-B" });
});

test("3. Dual exhaustion: on proven B quota exhaustion enter WAIT_PRIMARY_RESET", () => {
  const baseJob = normalizeZaicodeContinuingJobs([
    {
      id: "continuation-job",
      engineId: "acc-A",
      projectPath: "C:/fixture",
      continuation: {
        enabled: true,
        runnerIds: ["acc-B"],
        delayMinutes: 2,
        returnToPreferred: true,
        recoveryDelayMinutes: 1,
      },
    },
  ])[0]!;

  const runOnB: ZaicodeContinuationRun = {
    projectPath: "C:/fixture",
    workspaceKey: "ws-key",
    occurrence: "initial:20000000",
    runnerId: "acc-B",
    primaryRunnerId: "acc-A",
    lease: "lease-1",
    state: "running",
    workerId: "worker-2",
    generation: 2,
    blocked: [{ runnerId: "acc-A", observedAt: now - 60_000, window: "five_hour", resetText: "in 3h" }],
    nextAt: now,
    launchedAt: now - 30_000,
    result: "Continuing on acc-B",
  };

  const i = {
    job: baseJob,
    run: runOnB,
    accounts: [account("acc-A"), account("acc-B")],
    limits: { "acc-A": quota("acc-A", 0, now - 60_000), "acc-B": quota("acc-B", 100) },
    availablePools: new Set<string>(),
    now,
    autopilot: true,
    enabled: true,
    projectDisabled: false,
    stopDue: false,
  };

  // While running on B: preferred A is not available, work continues on B
  assert.deepEqual(decideZaicodeContinuation(i), { action: "none", reason: "Preferred subscription is not freshly available" });

  // 4. Proven B quota exhaustion:
  const bExhaustionTime = now + 15_000;
  i.run = markZaicodeContinuationLimit(
    i.run,
    { window: "five_hour", resetText: "in 5h" },
    bExhaustionTime,
    2,
    { primaryRunnerId: "acc-A", fallbackRunnerIds: ["acc-B"] },
  );

  // Both A and B are now blocked: MUST enter waiting-primary-reset with result WAIT_PRIMARY_RESET
  assert.equal(i.run.state, "waiting-primary-reset");
  assert.equal(i.run.result, "WAIT_PRIMARY_RESET");
  assert.equal(i.run.blocked.length, 2);

  i.now = bExhaustionTime + 130_000;
  // With both exhausted and no fresh quota: decides wait-primary-reset
  const dualExhaustionDecision = decideZaicodeContinuation(i);
  assert.deepEqual(dualExhaustionDecision, { action: "wait-primary-reset", reason: "WAIT_PRIMARY_RESET" });

  // 5. Return to A only when fresh vendor quota read proves availability:
  // A clock tick alone without fresh fetch cannot unblock
  i.now += 3600_000;
  assert.deepEqual(decideZaicodeContinuation(i), { action: "wait-primary-reset", reason: "WAIT_PRIMARY_RESET" });

  // Fresh vendor quota read arrives for primary A
  i.limits["acc-A"] = quota("acc-A", 100, i.now);
  const recoveryDecision = decideZaicodeContinuation(i);
  assert.deepEqual(recoveryDecision, { action: "switch", runnerId: "acc-A" });
});

test("4. Reset overlap and duplicate prevention across Every Reset recurrence", () => {
  const initialAt = now;
  const job = createZaicodeAutostartJob({
    id: "every-reset-job",
    projectPath: "C:/fixture",
    engineId: "acc-A",
    trigger: "everyReset",
    initialAt,
    firedEvents: [`initial:${initialAt}`],
    lastRunAt: initialAt,
    window: "five_hour",
  });

  // Stale or equal reset that occurred before or at initialAt: ignored
  const staleResetSnapshot = quota("acc-A", 100, now, initialAt - 1000);
  const evalStale = evaluateZaicodeAutostartJob(job, staleResetSnapshot, now + 1000);
  assert.equal(evalStale.state, "waiting-reset");
  assert.equal(evalStale.dueAt, null);

  // Future reset strictly after initialAt: evaluates to waiting-reset before dueAt, due at dueAt
  const futureResetAt = now + 18_000_000;
  const freshResetSnapshot = quota("acc-A", 0, now, futureResetAt);
  const beforeDue = evaluateZaicodeAutostartJob(job, freshResetSnapshot, futureResetAt - 10_000);
  assert.equal(beforeDue.state, "waiting-reset");
  assert.equal(beforeDue.dueAt, futureResetAt + 60_000); // safetyDelaySeconds: 60

  // At due moment: window refilled -> due
  const dueMoment = futureResetAt + 60_000;
  const atDue = evaluateZaicodeAutostartJob(job, freshResetSnapshot, dueMoment);
  assert.equal(atDue.state, "due");
  assert.equal(atDue.eventId, `reset:acc-A:five_hour:${futureResetAt}`);

  // Once fired: eventId in firedEvents prevents duplicate execution
  const recurringFired = {
    ...job,
    firedEvents: [...job.firedEvents, atDue.eventId],
    lastRunAt: dueMoment,
  };
  const afterRecurring = evaluateZaicodeAutostartJob(recurringFired, freshResetSnapshot, dueMoment + 5000);
  assert.equal(afterRecurring.state, "waiting-reset");
  assert.equal(afterRecurring.dueAt, null);
  assert.match(afterRecurring.reason, /next refill/);
});

test("5. Never restart completed work or replay in-flight requests", () => {
  const job = normalizeZaicodeContinuingJobs([
    {
      id: "terminal-job",
      engineId: "acc-A",
      projectPath: "C:/fixture",
      continuation: { enabled: true, runnerIds: ["acc-B"], delayMinutes: 1, returnToPreferred: true },
    },
  ])[0]!;

  const completedRun: ZaicodeContinuationRun = {
    projectPath: "C:/fixture",
    workspaceKey: "ws-key",
    occurrence: "initial:20000000",
    runnerId: "acc-A",
    lease: "lease-done",
    state: "complete",
    result: "Scheduled work completed",
    nextAt: now,
    launchedAt: now - 10_000,
  };

  const decisionCompleted = decideZaicodeContinuation({
    job,
    run: completedRun,
    accounts: [account("acc-A")],
    limits: { "acc-A": quota("acc-A") },
    availablePools: new Set(),
    now,
    autopilot: true,
    enabled: true,
    projectDisabled: false,
    stopDue: false,
  });
  assert.deepEqual(decisionCompleted, { action: "none", reason: "Run is terminal" });

  const stoppedRun: ZaicodeContinuationRun = {
    ...completedRun,
    state: "stopped",
    result: "Schedule stop time reached",
  };
  const decisionStopped = decideZaicodeContinuation({
    job,
    run: stoppedRun,
    accounts: [account("acc-A")],
    limits: { "acc-A": quota("acc-A") },
    availablePools: new Set(),
    now,
    autopilot: true,
    enabled: true,
    projectDisabled: false,
    stopDue: false,
  });
  assert.deepEqual(decisionStopped, { action: "none", reason: "Run is terminal" });
});

test("6. App restart persistence and backward compatibility", () => {
  const original = createZaicodeAutostartJob({
    id: "persist-job",
    projectPath: "C:/project",
    engineId: "acc-A",
    trigger: "everyReset",
    initialAt: 12345678,
  });

  // Roundtrip through normalization
  const normalized = normalizeZaicodeAutostartJobs(JSON.parse(JSON.stringify([original])));
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.id, "persist-job");
  assert.equal(normalized[0]?.initialAt, 12345678);

  // Backward compatibility: job without initialAt normalizes to null
  const legacy = {
    id: "legacy-job",
    projectPath: "C:/project",
    engineId: "acc-A",
    trigger: "everyReset",
  };
  const normalizedLegacy = normalizeZaicodeAutostartJobs([legacy]);
  assert.equal(normalizedLegacy[0]?.initialAt, null);

  // Continuation run with waiting-primary-reset survives roundtrip
  const continuingJob = normalizeZaicodeContinuingJobs([
    {
      ...original,
      continuation: { enabled: true, runnerIds: ["acc-B"], delayMinutes: 1, returnToPreferred: true },
      continuationRuns: [
        {
          projectPath: "C:/project",
          workspaceKey: "ws-key",
          occurrence: "initial:12345678",
          runnerId: "acc-B",
          primaryRunnerId: "acc-A",
          lease: "durable-lease",
          state: "waiting-primary-reset",
          result: "WAIT_PRIMARY_RESET",
          nextAt: now,
          launchedAt: now,
          blocked: [{ runnerId: "acc-A", observedAt: now - 1000, window: "5h", resetText: null }],
        },
      ],
    },
  ]);
  assert.equal(continuingJob[0]?.continuationRuns[0]?.state, "waiting-primary-reset");
  assert.equal(continuingJob[0]?.continuationRuns[0]?.result, "WAIT_PRIMARY_RESET");
  assert.equal(continuingJob[0]?.continuationRuns[0]?.primaryRunnerId, "acc-A");
});

test("7. Pause and stop rules remain effective", () => {
  const job = normalizeZaicodeContinuingJobs([
    {
      id: "job-pause",
      engineId: "acc-A",
      projectPath: "C:/fixture",
      continuation: { enabled: true, runnerIds: ["acc-B"], delayMinutes: 1, returnToPreferred: true },
    },
  ])[0]!;

  const pendingRun: ZaicodeContinuationRun = {
    projectPath: "C:/fixture",
    workspaceKey: "ws-key",
    occurrence: "occ-1",
    runnerId: "acc-A",
    primaryRunnerId: "acc-A",
    lease: "lease-p",
    state: "pending",
    nextAt: now,
    launchedAt: now,
    blocked: [],
    result: "",
  };

  const baseInput = {
    job,
    run: pendingRun,
    accounts: [account("acc-A")],
    limits: { "acc-A": quota("acc-A") },
    availablePools: new Set<string>(),
    now,
    autopilot: true,
    enabled: true,
    projectDisabled: false,
    stopDue: false,
  };

  // Autopilot false -> wait
  assert.equal(decideZaicodeContinuation({ ...baseInput, autopilot: false }).action, "wait");

  // Job disabled -> wait
  assert.equal(decideZaicodeContinuation({ ...baseInput, enabled: false }).action, "wait");

  // Project disabled -> wait
  assert.equal(decideZaicodeContinuation({ ...baseInput, projectDisabled: true }).action, "wait");

  // Stop due -> stop
  assert.equal(decideZaicodeContinuation({ ...baseInput, stopDue: true }).action, "stop");
});
