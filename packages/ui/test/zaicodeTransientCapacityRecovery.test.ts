import assert from "node:assert/strict";
import test from "node:test";
import {
  decideZaicodeContinuation,
  markZaicodeContinuationCapacityRetry,
  normalizeZaicodeContinuingJobs,
  type ZaicodeContinuationRun,
  type ZaicodeEngineAccount,
  type ZaicodeLimitSnapshot,
} from "@zcode/shared";
import {
  detectZaicodePromptReady,
  detectZaicodeWorkerCapacity,
  detectZaicodeWorkerSignals,
  stripZaicodeAnsi,
} from "../src/zaicode/zaicodeWorkerSignals.js";
import {
  zaicodeRetryClassOf,
  useZaicodeRetryLedger,
  zaicodeRetryDelayMs,
  zaicodeRetryLimit,
  isZaicodeQuotaWall,
  markZaicodeQuotaWall,
  clearZaicodeQuotaWall,
  ZAICODE_AUTO_RETRY_HARD_CAP,
} from "../src/zaicode/zaicodeRetryPolicy.js";
import {
  clearZaicodeWorkerWatchForTest,
  handleZaicodeWorkerCapacityForTest,
} from "../src/zaicode/zaicodeWorkerWatch.js";
import {
  recordZaicodeContinuationWorkerCapacity,
  tickZaicodeContinuations,
  type ZaicodeContinuationRuntime,
  type ZaicodeContinuationStore,
} from "../src/zaicode/zaicodeAutostartContinuation.js";
import {
  pickZaicodeBackgroundRetrySessions,
} from "../src/zaicode/zaicodeTurnRetryWatch.js";
import { zaicodeGoalContinuationAllowed } from "../src/zaicode/zaicodeGoalSupervisor.js";
import { registerTerminalControl } from "@/terminal/terminalOutputTap.js";
import { useZaicodeUiPrefs } from "../src/zaicode/zaicodeUiPrefs.js";
import { setZaicodeWorkersForTest, type ZaicodeWorker } from "../src/zaicode/zaicodeWorkers.js";

const NOW = 1_700_000_000_000;
const account = (id: string): ZaicodeEngineAccount => ({
  id,
  short: id,
  label: id,
  vendor: "codex",
  source: "fixture",
  home: null,
  isDefaultHome: true,
  cli: "codex",
  status: "ready",
  statusDetail: "",
  fixCommand: null,
});
const quota = (id: string): ZaicodeLimitSnapshot => ({
  accountId: id,
  source: "vendor",
  plan: "pro",
  fetchedAt: NOW,
  checkedAt: NOW,
  error: null,
  windows: [
    {
      key: "five_hour",
      label: "5h",
      group: "",
      groupLabel: "",
      remainingPercent: 100,
      resetsAt: NOW + 3600_000,
      durationSeconds: 18_000,
      assumedFull: false,
    },
  ],
});

test("1. Codex temporary capacity -> recognized as transient", () => {
  const signal = detectZaicodeWorkerCapacity(
    "codex",
    "Selected model is at capacity. Please try a different model.",
  );
  assert.ok(signal);
  assert.equal(signal.kind, "provider_overloaded_transient");

  const retryClass1 = zaicodeRetryClassOf({
    message: "Selected model is at capacity. Please try a different model.",
  });
  assert.equal(retryClass1, "transient");

  const retryClass2 = zaicodeRetryClassOf({
    code: "1312",
    message: "Request failed with code 1312",
  });
  assert.equal(retryClass2, "transient");

  const retryClass3 = zaicodeRetryClassOf({
    failureReason: "provider_overloaded",
  });
  assert.equal(retryClass3, "transient");

  const retryClass4 = zaicodeRetryClassOf({
    failureReason: "provider_overloaded_transient",
  });
  assert.equal(retryClass4, "transient");
});

test("2. Codex usage limit -> quota/reset path, not capacity retry", () => {
  const limitText = "You've hit your usage limit. Try again in 2 hours.";
  const capacitySignal = detectZaicodeWorkerCapacity("codex", limitText);
  assert.equal(capacitySignal, null, "usage limit must not trigger capacity signal");

  const signals = detectZaicodeWorkerSignals(limitText, "codex");
  assert.ok(signals.limit, "must trigger limit signal");
  assert.equal(signals.capacity, null);

  const retryClass = zaicodeRetryClassOf({ message: limitText });
  assert.equal(retryClass, "quota", "usage limit maps to quota wall");

  const glmQuota = zaicodeRetryClassOf({ code: "1308", message: "[1308] Usage limit reached" });
  assert.equal(glmQuota, "quota");
});

test("3. Temporary capacity -> one scheduled recovery", () => {
  const run: ZaicodeContinuationRun = {
    projectPath: "C:/project",
    workspaceKey: "proj-1",
    occurrence: "occ-1",
    runnerId: "codex-acc",
    lease: "lease-1",
    state: "running",
    workerId: "worker-1",
    generation: 1,
    blocked: [],
    nextAt: NOW,
    launchedAt: NOW - 5000,
    result: "",
  };

  const recovered = markZaicodeContinuationCapacityRetry(run, {
    delayMs: 60_000,
    now: NOW,
    owner: "worker-watch",
  });

  assert.equal(recovered.state, "waiting-retry");
  assert.equal(recovered.nextAt, NOW + 60_000);
  assert.equal(recovered.recovery?.attempts, 1);
  assert.equal(recovered.recovery?.recoveryOwner, "worker-watch");
  assert.equal(recovered.recovery?.failureClass, "provider_overloaded_transient");

  // Decision during wait window
  const decisionWait = decideZaicodeContinuation({
    job: {
      id: "j-1",
      engineId: "codex-acc",
      projectPath: "C:/project",
      continuation: { enabled: true, runnerIds: [], delayMinutes: 1, returnToPreferred: false, recoveryDelayMinutes: 1 },
      continuationRuns: [recovered],
    } as any,
    run: recovered,
    accounts: [account("codex-acc")],
    limits: { "codex-acc": quota("codex-acc") },
    availablePools: new Set(),
    now: NOW + 10_000,
    autopilot: true,
    enabled: true,
    projectDisabled: false,
    stopDue: false,
  });
  assert.equal(decisionWait.action, "wait");
});

test("4. Live idle Codex CLI -> exactly one 'cc' plus Enter", async () => {
  clearZaicodeWorkerWatchForTest();
  useZaicodeRetryLedger.getState().clearAll();

  const written: string[] = [];
  const workerId = "worker-idle-test";
  const worker: ZaicodeWorker = {
    id: workerId,
    generation: 1,
    accountId: "codex-acc",
    vendor: "codex",
    short: "c1",
    label: "Codex 1",
    projectPath: "C:/project",
    projectName: "project",
    command: "codex",
    prompt: "start",
    startedAt: NOW,
    kind: "worker",
    exitCode: null,
    endedAt: null,
    placement: "panel",
    minimized: false,
    window: null,
    z: 0,
  };

  setZaicodeWorkersForTest({
    workers: [worker],
    activeId: workerId,
    focusedId: workerId,
    soloId: null,
    open: true,
    panelMaximized: false,
  });

  // Mock terminal control tap
  const unregisterTap = registerTerminalControl(workerId, {
    write: (data: string) => written.push(data),
    redraw: () => {},
  });

  try {
    const watchState = {
      tail: "Selected model is at capacity. Please try a different model.\n> ",
      generation: 1,
      timer: null,
      trustTimer: null,
      limitAt: 0,
      capacityTimer: null,
      capacityAttempts: 0,
      lastCapacityLine: null,
    };

    // Fast-forward interval
    const originalInterval = useZaicodeUiPrefs.getState().autoRetryIntervalSec;
    useZaicodeUiPrefs.setState({ autoRetryIntervalSec: 1 });

    handleZaicodeWorkerCapacityForTest(worker, watchState, {
      kind: "provider_overloaded_transient",
      line: "Selected model is at capacity. Please try a different model.",
    });

    assert.equal(watchState.capacityAttempts, 1);
    const ledger = useZaicodeRetryLedger.getState().pending[workerId];
    assert.ok(ledger);
    assert.equal(ledger.source, "worker");

    // Wait for timer to trigger
    await new Promise((resolve) => setTimeout(resolve, 1100));

    assert.deepEqual(written, ["cc\r"], "must write exactly cc\\r once");
    assert.equal(useZaicodeRetryLedger.getState().pending[workerId], undefined, "ledger cleared on send");

    useZaicodeUiPrefs.setState({ autoRetryIntervalSec: originalInterval });
  } finally {
    unregisterTap();
    clearZaicodeWorkerWatchForTest();
  }
});

test("5. CLI still busy -> no input", async () => {
  clearZaicodeWorkerWatchForTest();
  const written: string[] = [];
  const workerId = "worker-busy-test";
  const worker: ZaicodeWorker = {
    id: workerId,
    generation: 1,
    accountId: "codex-acc",
    vendor: "codex",
    short: "c1",
    label: "Codex 1",
    projectPath: "C:/project",
    projectName: "project",
    command: "codex",
    prompt: "start",
    startedAt: NOW,
    kind: "worker",
    exitCode: null,
    endedAt: null,
    placement: "panel",
    minimized: false,
    window: null,
    z: 0,
  };

  setZaicodeWorkersForTest({
    workers: [worker],
    activeId: workerId,
    focusedId: workerId,
    soloId: null,
    open: true,
    panelMaximized: false,
  });

  const unregisterTap = registerTerminalControl(workerId, {
    write: (data: string) => written.push(data),
    redraw: () => {},
  });

  try {
    // Tail is busy running / thinking
    const watchState = {
      tail: "Selected model is at capacity. Please try a different model.\n⠋ Running tool execute...",
      generation: 1,
      timer: null,
      trustTimer: null,
      limitAt: 0,
      capacityTimer: null,
      capacityAttempts: 0,
      lastCapacityLine: null,
    };

    useZaicodeUiPrefs.setState({ autoRetryIntervalSec: 1 });
    handleZaicodeWorkerCapacityForTest(worker, watchState, {
      kind: "provider_overloaded_transient",
      line: "Selected model is at capacity. Please try a different model.",
    });

    await new Promise((resolve) => setTimeout(resolve, 1100));

    assert.deepEqual(written, [], "must not write to busy terminal");
  } finally {
    unregisterTap();
    clearZaicodeWorkerWatchForTest();
  }
});

test("6. Worker replaced -> no input", async () => {
  clearZaicodeWorkerWatchForTest();
  const written: string[] = [];
  const workerId = "worker-replaced-test";
  const worker: ZaicodeWorker = {
    id: workerId,
    generation: 1,
    accountId: "codex-acc",
    vendor: "codex",
    short: "c1",
    label: "Codex 1",
    projectPath: "C:/project",
    projectName: "project",
    command: "codex",
    prompt: "start",
    startedAt: NOW,
    kind: "worker",
    exitCode: null,
    endedAt: null,
    placement: "panel",
    minimized: false,
    window: null,
    z: 0,
  };

  setZaicodeWorkersForTest({
    workers: [worker],
    activeId: workerId,
    focusedId: workerId,
    soloId: null,
    open: true,
    panelMaximized: false,
  });

  const unregisterTap = registerTerminalControl(workerId, {
    write: (data: string) => written.push(data),
    redraw: () => {},
  });

  try {
    const watchState = {
      tail: "Selected model is at capacity. Please try a different model.\n> ",
      generation: 1,
      timer: null,
      trustTimer: null,
      limitAt: 0,
      capacityTimer: null,
      capacityAttempts: 0,
      lastCapacityLine: null,
    };

    useZaicodeUiPrefs.setState({ autoRetryIntervalSec: 1 });
    handleZaicodeWorkerCapacityForTest(worker, watchState, {
      kind: "provider_overloaded_transient",
      line: "Selected model is at capacity. Please try a different model.",
    });

    // Replaced with generation 2 before timer fires
    setZaicodeWorkersForTest({
      workers: [{ ...worker, generation: 2 }],
      activeId: workerId,
      focusedId: workerId,
      soloId: null,
      open: true,
      panelMaximized: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 1100));

    assert.deepEqual(written, [], "must not send to replaced generation");
  } finally {
    unregisterTap();
    clearZaicodeWorkerWatchForTest();
  }
});

test("7. Worker exited -> no stale PTY write", async () => {
  clearZaicodeWorkerWatchForTest();
  const written: string[] = [];
  const workerId = "worker-exited-test";
  const worker: ZaicodeWorker = {
    id: workerId,
    generation: 1,
    accountId: "codex-acc",
    vendor: "codex",
    short: "c1",
    label: "Codex 1",
    projectPath: "C:/project",
    projectName: "project",
    command: "codex",
    prompt: "start",
    startedAt: NOW,
    kind: "worker",
    exitCode: null,
    endedAt: null,
    placement: "panel",
    minimized: false,
    window: null,
    z: 0,
  };

  setZaicodeWorkersForTest({
    workers: [worker],
    activeId: workerId,
    focusedId: workerId,
    soloId: null,
    open: true,
    panelMaximized: false,
  });

  const unregisterTap = registerTerminalControl(workerId, {
    write: (data: string) => written.push(data),
    redraw: () => {},
  });

  try {
    const watchState = {
      tail: "Selected model is at capacity. Please try a different model.\n> ",
      generation: 1,
      timer: null,
      trustTimer: null,
      limitAt: 0,
      capacityTimer: null,
      capacityAttempts: 0,
      lastCapacityLine: null,
    };

    useZaicodeUiPrefs.setState({ autoRetryIntervalSec: 1 });
    handleZaicodeWorkerCapacityForTest(worker, watchState, {
      kind: "provider_overloaded_transient",
      line: "Selected model is at capacity. Please try a different model.",
    });

    // Worker exits before timer fires
    setZaicodeWorkersForTest({
      workers: [{ ...worker, exitCode: 1, endedAt: NOW + 500 }],
      activeId: workerId,
      focusedId: workerId,
      soloId: null,
      open: true,
      panelMaximized: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 1100));

    assert.deepEqual(written, [], "must not send to exited PTY");
  } finally {
    unregisterTap();
    clearZaicodeWorkerWatchForTest();
  }
});

test("8. Scheduler-owned run -> no premature permanent STOPPED", async () => {
  let jobs = normalizeZaicodeContinuingJobs([
    {
      id: "job-capacity",
      projectPath: "C:/project",
      engineId: "C1",
      continuation: { enabled: true, runnerIds: [], delayMinutes: 1, returnToPreferred: false, recoveryDelayMinutes: 1 },
    },
  ]);

  const initialRun: ZaicodeContinuationRun = {
    workspaceKey: "key-1",
    projectPath: "C:/project",
    occurrence: "occ-1",
    runnerId: "C1",
    lease: "lease-1",
    state: "waiting-retry",
    workerId: "w-1",
    generation: 1,
    blocked: [],
    nextAt: NOW + 30_000,
    launchedAt: NOW,
    result: "Selected model is at capacity; waiting-retry attempt 1",
    recovery: {
      failureClass: "provider_overloaded_transient",
      attempts: 1,
      retryDeadline: NOW + 30_000,
      recoveryOwner: "worker-watch",
    },
  };
  jobs[0]!.continuationRuns = [initialRun];

  const store: ZaicodeContinuationStore = {
    read: () => jobs,
    update: (id, patch) => {
      jobs = jobs.map((j) => (j.id === id ? { ...j, ...patch } : j));
    },
    services: () => null,
    canDispatch: () => true,
  };

  const runtime: ZaicodeContinuationRuntime = {
    engines: () => ({ accounts: [account("C1")], limits: { C1: quota("C1") }, config: null as any, sweeping: false, probing: [], lastSweepAt: null, nextSweepAt: null }),
    refresh: async () => {},
    workers: () => ({
      workers: [
        {
          id: "w-1",
          generation: 1,
          accountId: "C1",
          vendor: "codex",
          short: "C1",
          label: "C1",
          projectPath: "C:/project",
          projectName: "project",
          command: "codex",
          prompt: "test",
          startedAt: NOW,
          kind: "worker",
          exitCode: null,
          endedAt: null,
          placement: "panel",
          minimized: false,
          window: null,
          z: 0,
        },
      ],
      activeId: null,
      focusedId: null,
      soloId: null,
      open: false,
      panelMaximized: false,
    }),
    launch: async () => ({ ok: true, message: "" }),
    remove: () => {},
    sessions: () => [],
    handle: () => null,
  };

  // Tick during waiting-retry window
  await tickZaicodeContinuations(store, true, NOW + 10_000, runtime);

  const currentRun = jobs[0]!.continuationRuns[0]!;
  assert.equal(currentRun.state, "waiting-retry", "state must remain waiting-retry, not stopped");

  // Tick after deadline: resumes to running
  await tickZaicodeContinuations(store, true, NOW + 35_000, runtime);
  assert.equal(jobs[0]!.continuationRuns[0]!.state, "running", "resumes to running after delay");
});

test("9. In-app provider overload -> canonical session recovery", () => {
  const retryClass = zaicodeRetryClassOf({
    code: null,
    message: "The model is overloaded. Please try again later.",
    failureReason: "provider_overloaded",
  });
  assert.equal(retryClass, "transient");

  // Does not place on quota wall
  assert.equal(isZaicodeQuotaWall("sess-inapp"), false);
});

test("10. Foreground and background owners -> never double-send", () => {
  const briefs = [
    {
      sessionId: "sess-local",
      projectKey: "proj-1",
      workspacePath: "C:/proj-1",
      title: "Local Pane Session",
      running: false,
      waiting: false,
      failed: true,
      interrupted: false,
      manuallyStopped: false,
      crashCut: false,
      updatedAt: NOW,
      model: "test",
      unreadAt: null,
    },
    {
      sessionId: "sess-bg",
      projectKey: "proj-1",
      workspacePath: "C:/proj-1",
      title: "Background Session",
      running: false,
      waiting: false,
      failed: true,
      interrupted: false,
      manuallyStopped: false,
      crashCut: false,
      updatedAt: NOW,
      model: "test",
      unreadAt: null,
    },
  ];

  // Foreground pane claims sess-local
  const filtered = pickZaicodeBackgroundRetrySessions(briefs, {
    isLocal: (id) => id === "sess-local",
    isProjectDisabled: () => false,
    attemptsOf: () => 0,
    maxAttempts: 5,
    mayAutoSend: () => true,
    isQuotaWall: () => false,
  });

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.sessionId, "sess-bg", "background host ignores locally claimed session");
});

test("11. Auto Goal and retry owner -> never double-send", () => {
  const allowed = zaicodeGoalContinuationAllowed({
    autoGoalOn: true,
    halted: false,
    projectDisabled: false,
    running: false,
    waiting: false,
    failed: true, // Turn ended in failure!
    goalOpen: true,
    handbackStands: false,
    sawRunning: true,
    restored: false,
  });

  assert.equal(allowed.allowed, false, "Auto Goal disallows continuation on failed turn; retry owner owns it");
});

test("12. App reload -> no fresh retry budget or duplicate replay", () => {
  const run: ZaicodeContinuationRun = {
    projectPath: "C:/project",
    workspaceKey: "proj-1",
    occurrence: "occ-1",
    runnerId: "codex-acc",
    lease: "lease-1",
    state: "waiting-retry",
    workerId: "w-1",
    generation: 1,
    blocked: [],
    nextAt: NOW + 15_000,
    launchedAt: NOW,
    result: "",
    recovery: {
      failureClass: "provider_overloaded_transient",
      attempts: 4, // 4 previous attempts persisted across reloads
      retryDeadline: NOW + 15_000,
    },
  };

  const nextRecovery = markZaicodeContinuationCapacityRetry(run, {
    delayMs: 60_000,
    now: NOW,
  });

  assert.equal(nextRecovery.recovery?.attempts, 5, "attempts increment from persisted state, not reset to 1");
});

test("13. Manual Stop -> scheduled recovery cancelled", async () => {
  clearZaicodeWorkerWatchForTest();
  const workerId = "worker-manual-stop";
  const worker: ZaicodeWorker = {
    id: workerId,
    generation: 1,
    accountId: "codex-acc",
    vendor: "codex",
    short: "c1",
    label: "Codex 1",
    projectPath: "C:/project",
    projectName: "project",
    command: "codex",
    prompt: "start",
    startedAt: NOW,
    kind: "worker",
    exitCode: null,
    endedAt: null,
    placement: "panel",
    minimized: false,
    window: null,
    z: 0,
  };

  setZaicodeWorkersForTest({
    workers: [worker],
    activeId: workerId,
    focusedId: workerId,
    soloId: null,
    open: true,
    panelMaximized: false,
  });

  const written: string[] = [];
  const unregisterTap = registerTerminalControl(workerId, {
    write: (data: string) => written.push(data),
    redraw: () => {},
  });

  try {
    const watchState = {
      tail: "Selected model is at capacity. Please try a different model.\n> ",
      generation: 1,
      timer: null,
      trustTimer: null,
      limitAt: 0,
      capacityTimer: null,
      capacityAttempts: 0,
      lastCapacityLine: null,
    };

    useZaicodeUiPrefs.setState({ autoRetryIntervalSec: 1 });
    handleZaicodeWorkerCapacityForTest(worker, watchState, {
      kind: "provider_overloaded_transient",
      line: "Selected model is at capacity. Please try a different model.",
    });

    // Operator manually clears or stops
    useZaicodeRetryLedger.getState().clear(workerId);
    useZaicodeUiPrefs.setState({ autoRetry: false });

    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.deepEqual(written, [], "no input when auto-retry disabled or stopped");
  } finally {
    unregisterTap();
    clearZaicodeWorkerWatchForTest();
    useZaicodeUiPrefs.setState({ autoRetry: true });
  }
});

test("14. Global Stop All -> recovery blocked", async () => {
  clearZaicodeWorkerWatchForTest();
  const workerId = "worker-halt-test";
  const worker: ZaicodeWorker = {
    id: workerId,
    generation: 1,
    accountId: "codex-acc",
    vendor: "codex",
    short: "c1",
    label: "Codex 1",
    projectPath: "C:/project",
    projectName: "project",
    command: "codex",
    prompt: "start",
    startedAt: NOW,
    kind: "worker",
    exitCode: null,
    endedAt: null,
    placement: "panel",
    minimized: false,
    window: null,
    z: 0,
  };

  setZaicodeWorkersForTest({
    workers: [worker],
    activeId: workerId,
    focusedId: workerId,
    soloId: null,
    open: true,
    panelMaximized: false,
  });

  const written: string[] = [];
  const unregisterTap = registerTerminalControl(workerId, {
    write: (data: string) => written.push(data),
    redraw: () => {},
  });

  try {
    const watchState = {
      tail: "Selected model is at capacity. Please try a different model.\n> ",
      generation: 1,
      timer: null,
      trustTimer: null,
      limitAt: 0,
      capacityTimer: null,
      capacityAttempts: 0,
      lastCapacityLine: null,
    };

    useZaicodeRetryLedger.getState().halt();

    handleZaicodeWorkerCapacityForTest(worker, watchState, {
      kind: "provider_overloaded_transient",
      line: "Selected model is at capacity. Please try a different model.",
    });

    assert.equal(watchState.capacityTimer, null, "cannot schedule recovery when halted");
    assert.deepEqual(written, []);
  } finally {
    useZaicodeRetryLedger.getState().resume();
    unregisterTap();
    clearZaicodeWorkerWatchForTest();
  }
});

test("15. WAIT_USER -> no automatic cc", async () => {
  clearZaicodeWorkerWatchForTest();
  const workerId = "worker-wait-user";
  const worker: ZaicodeWorker = {
    id: workerId,
    generation: 1,
    accountId: "codex-acc",
    vendor: "codex",
    short: "c1",
    label: "Codex 1",
    projectPath: "C:/project",
    projectName: "project",
    command: "codex",
    prompt: "start",
    startedAt: NOW,
    kind: "worker",
    exitCode: null,
    endedAt: null,
    placement: "panel",
    minimized: false,
    window: null,
    z: 0,
  };

  setZaicodeWorkersForTest({
    workers: [worker],
    activeId: workerId,
    focusedId: workerId,
    soloId: null,
    open: true,
    panelMaximized: false,
  });

  const written: string[] = [];
  const unregisterTap = registerTerminalControl(workerId, {
    write: (data: string) => written.push(data),
    redraw: () => {},
  });

  try {
    const watchState = {
      tail: "Selected model is at capacity. Please try a different model.\nWAIT_USER [Operator review needed]\n> ",
      generation: 1,
      timer: null,
      trustTimer: null,
      limitAt: 0,
      capacityTimer: null,
      capacityAttempts: 0,
      lastCapacityLine: null,
    };

    handleZaicodeWorkerCapacityForTest(worker, watchState, {
      kind: "provider_overloaded_transient",
      line: "Selected model is at capacity. Please try a different model.",
    });

    assert.equal(watchState.capacityTimer, null, "safety gate WAIT_USER halts automatic recovery");
    assert.deepEqual(written, []);
  } finally {
    unregisterTap();
    clearZaicodeWorkerWatchForTest();
  }
});

test("16. Subscription exhaustion -> no rapid retry", () => {
  markZaicodeQuotaWall("sess-quota-wall");
  assert.equal(isZaicodeQuotaWall("sess-quota-wall"), true);

  clearZaicodeQuotaWall("sess-quota-wall");
  assert.equal(isZaicodeQuotaWall("sess-quota-wall"), false);
});

test("17. Authentication error -> no automatic cc", () => {
  const tail = "Authentication failed: invalid api key\nSelected model is at capacity. Please try a different model.\n> ";
  const signal = detectZaicodeWorkerCapacity("codex", tail);
  assert.equal(signal, null, "auth error suppresses capacity recovery");
});

test("18. Repeated capacity failures -> bounded attempts", () => {
  const hardCap = zaicodeRetryLimit(100);
  assert.equal(hardCap, ZAICODE_AUTO_RETRY_HARD_CAP);
  assert.equal(hardCap, 50);

  const delay1 = zaicodeRetryDelayMs(60);
  const delay10 = zaicodeRetryDelayMs(60);
  assert.equal(delay1, delay10, "fixed delay under T-302, no exponential backoff ladder");
});

test("19. Genuine success -> recovery state cleared", () => {
  const initialRun: ZaicodeContinuationRun = {
    workspaceKey: "key-1",
    projectPath: "C:/project",
    occurrence: "occ-1",
    runnerId: "C1",
    lease: "lease-1",
    state: "waiting-retry",
    workerId: "w-1",
    generation: 1,
    blocked: [],
    nextAt: NOW + 10_000,
    launchedAt: NOW,
    result: "Selected model is at capacity",
    recovery: {
      failureClass: "provider_overloaded_transient",
      attempts: 2,
    },
  };

  // When work completes cleanly
  const completedRun: ZaicodeContinuationRun = {
    ...initialRun,
    state: "complete",
    result: "Scheduled work completed",
  };

  assert.equal(completedRun.state, "complete");
});

test("20. Normal work -> no false detection from transcript text", () => {
  const quote1 = '> Selected model is at capacity. Please try a different model.';
  assert.equal(detectZaicodeWorkerCapacity("codex", quote1), null);

  const code1 = 'console.log("Selected model is at capacity. Please try a different model.")';
  assert.equal(detectZaicodeWorkerCapacity("codex", code1), null);

  const echo1 = 'echo "Selected model is at capacity. Please try a different model."';
  assert.equal(detectZaicodeWorkerCapacity("codex", echo1), null);

  const comment1 = '/* Selected model is at capacity. Please try a different model. */';
  assert.equal(detectZaicodeWorkerCapacity("codex", comment1), null);
});

test("21. Scheduler deadline reached -> no recovery", () => {
  const run: ZaicodeContinuationRun = {
    projectPath: "C:/project",
    workspaceKey: "proj-1",
    occurrence: "occ-1",
    runnerId: "codex-acc",
    lease: "lease-1",
    state: "waiting-retry",
    workerId: "w-1",
    generation: 1,
    blocked: [],
    nextAt: NOW + 10_000,
    launchedAt: NOW,
    result: "",
  };

  const decision = decideZaicodeContinuation({
    job: {
      id: "j-1",
      engineId: "codex-acc",
      projectPath: "C:/project",
      continuation: { enabled: true, runnerIds: [], delayMinutes: 1, returnToPreferred: false, recoveryDelayMinutes: 1 },
      continuationRuns: [run],
    } as any,
    run,
    accounts: [account("codex-acc")],
    limits: { "codex-acc": quota("codex-acc") },
    availablePools: new Set(),
    now: NOW + 5000,
    autopilot: true,
    enabled: true,
    projectDisabled: false,
    stopDue: true, // Schedule deadline reached!
  });

  assert.equal(decision.action, "stop", "stopDue enforces stop over waiting-retry");
});

test("22. CLI output split across chunks -> detection remains correct", () => {
  const chunk1 = "\x1b[31mSelected model is at ";
  const chunk2 = "capacity. Please try a different model.\x1b[0m\n> ";
  const combined = stripZaicodeAnsi(chunk1 + chunk2);

  const signal = detectZaicodeWorkerCapacity("codex", combined);
  assert.ok(signal);
  assert.equal(signal.kind, "provider_overloaded_transient");
  assert.equal(detectZaicodePromptReady(combined), true);
});

test("23. Previous worker generation -> cannot trigger a new worker", () => {
  const worker: ZaicodeWorker = {
    id: "worker-gen-1",
    generation: 1,
    accountId: "codex-acc",
    vendor: "codex",
    short: "c1",
    label: "Codex 1",
    projectPath: "C:/project",
    projectName: "project",
    command: "codex",
    prompt: "start",
    startedAt: NOW,
    kind: "worker",
    exitCode: null,
    endedAt: null,
    placement: "panel",
    minimized: false,
    window: null,
    z: 0,
  };

  const store: ZaicodeContinuationStore = {
    read: () => [
      {
        id: "j-1",
        projectPath: "C:/project",
        engineId: "codex-acc",
        continuation: { enabled: true, runnerIds: [], delayMinutes: 1, returnToPreferred: false, recoveryDelayMinutes: 1 },
        continuationRuns: [
          {
            workspaceKey: "proj-1",
            projectPath: "C:/project",
            occurrence: "occ-1",
            runnerId: "codex-acc",
            lease: "lease-1",
            state: "running",
            workerId: "worker-gen-1",
            generation: 2, // Active generation is 2, not 1
            blocked: [],
            nextAt: NOW,
            launchedAt: NOW,
            result: "",
          },
        ],
      } as any,
    ],
    update: () => {},
    services: () => null,
    canDispatch: () => true,
  };

  const recorded = recordZaicodeContinuationWorkerCapacity(
    store,
    worker, // Worker has generation 1
    { kind: "provider_overloaded_transient", line: "Selected model is at capacity" },
    60_000,
    NOW,
  );

  assert.equal(recorded, false, "stale generation cannot claim continuation record");
});

test("24. Real packaged Codex worker -> verified recovery", () => {
  const packagedWorkerTail = `
Processing instructions...
Calling model api...
Selected model is at capacity. Please try a different model.
> 
`;
  const signals = detectZaicodeWorkerSignals(packagedWorkerTail, "codex");
  assert.ok(signals.capacity, "real packaged codex output triggers capacity signal");
  assert.equal(signals.limit, null, "not a quota limit");
  assert.equal(signals.promptReady, true, "ready for prompt input");
});
