import { useEffect } from "react";
import { onTerminalOutput, terminalControl } from "@/terminal/terminalOutputTap.js";
import { addZaicodeAutostartJob, readZaicodeAutostartJobs, recordZaicodeScheduledWorkerCapacity, recordZaicodeScheduledWorkerLimit } from "./zaicodeAutostart.js";
import { refreshZaicodeEngineLimits } from "./zaicodeEngines.js";
import { notifyZaicode } from "./zaicodeNotifications.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";
import { readZaicodeWorkerPrefs } from "./zaicodeWorkerPrefs.js";
import {
  detectZaicodePromptReady,
  detectZaicodeTrustInput,
  detectZaicodeWorkerCapacity,
  detectZaicodeWorkerSignals,
  type ZaicodeWorkerCapacitySignal,
  type ZaicodeWorkerLimitSignal,
} from "./zaicodeWorkerSignals.js";
import { focusZaicodeWorker, readZaicodeWorkers, removeZaicodeWorker, zaicodeWorkerTitle, type ZaicodeWorker } from "./zaicodeWorkers.js";
import {
  useZaicodeRetryLedger,
  zaicodeAutoRetryAllowedFor,
  zaicodeRetryDelayMs,
  zaicodeRetryLimit,
} from "./zaicodeRetryPolicy.js";
import { useZaicodeUiPrefs } from "./zaicodeUiPrefs.js";
import { zaicodeScheduleStopAt } from "@zcode/shared";

export {
  detectZaicodePromptReady,
  detectZaicodeWorkerCapacity,
  detectZaicodeWorkerSignals,
  stripZaicodeAnsi,
  type ZaicodeWorkerCapacitySignal,
  type ZaicodeWorkerLimitSignal,
} from "./zaicodeWorkerSignals.js";

const TAIL_CHARS = 8000;
const SCAN_DELAY_MS = 400;
const TRUST_REPLY_MS = 600;
const LIMIT_REPEAT_MS = 30 * 60_000;
const CLOSE_DELAY_MS = 3000;

const setTimer = (fn: () => void, ms: number): number =>
  Number((typeof window !== "undefined" ? window : globalThis).setTimeout(fn, ms));
const clearTimer = (id: number | null): void => {
  if (id !== null) {
    (typeof window !== "undefined" ? window : globalThis).clearTimeout(id);
  }
};

interface WatchState {
  tail: string;
  generation: number;
  timer: number | null;
  trustTimer: number | null;
  limitAt: number;
  capacityTimer: number | null;
  capacityAttempts: number;
  lastCapacityLine: string | null;
}

const watch = new Map<string, WatchState>();
function workerById(id: string): ZaicodeWorker | undefined {
  return readZaicodeWorkers().workers.find((worker) => worker.id === id);
}

function answerTrust(worker: ZaicodeWorker, state: WatchState): void {
  if (state.trustTimer !== null || detectZaicodeTrustInput(state.tail) === null) return;
  const control = terminalControl(worker.id);
  if (!control) return;
  // 旧定时器不得向已替换/退出/转交的 PTY 输入；时间和答复次数不是授权。
  state.trustTimer = setTimer(() => {
    state.trustTimer = null;
    const current = workerById(worker.id);
    if (!current || current.kind !== "worker" || current.exitCode !== null || current.generation !== worker.generation || terminalControl(worker.id) !== control) return;
    const input = detectZaicodeTrustInput(state.tail);
    if (!input) return;
    state.tail = "";
    control.write(input);
    notifyZaicode("worker.exit", { header: "Workers", title: zaicodeWorkerTitle(current) + ": startup trust approved", body: current.projectPath, key: "worker-trust:" + worker.id });
  }, TRUST_REPLY_MS);
}

function resumeAfterReset(worker: ZaicodeWorker, signal: ZaicodeWorkerLimitSignal): void {
  if (!worker.accountId) return;
  addZaicodeAutostartJob({ name: "Resume " + worker.short + " after its limit", projectPath: worker.projectPath, engineId: worker.accountId, targetKind: "project", trigger: "reset", window: signal.window, prompt: worker.prompt ?? "cc", requireQuota: true, enabled: true });
}

function handleLimit(worker: ZaicodeWorker, state: WatchState, signal: ZaicodeWorkerLimitSignal): void {
  if (state.limitAt > 0 && Date.now() - state.limitAt < LIMIT_REPEAT_MS) return;
  state.limitAt = Date.now();
  state.tail = "";
  if (recordZaicodeScheduledWorkerLimit(worker, signal)) return;
  const action = readZaicodeWorkerPrefs().onLimit;
  if (worker.accountId) void refreshZaicodeEngineLimits(worker.accountId);
  playZaicodeSound("worker.fail");
  const when = signal.resetText ? " (back " + signal.resetText + ")" : "";
  const what = action === "close" ? "closed to free its place" : action === "closeAndResume" ? "closed; it starts again after the reset (SCHEDULER)" : "kept open; the CLI waits for the reset itself";
  notifyZaicode("worker.fail", { header: "Workers", title: zaicodeWorkerTitle(worker) + " hit its limit" + when, body: signal.line + "\n" + what + ". Workers settings → On a limit.", status: "Limit", key: "worker-limit:" + worker.id, actions: [{ label: "Show", run: () => focusZaicodeWorker(worker.id) }] });
  if (action === "keep") return;
  if (action === "closeAndResume") resumeAfterReset(worker, signal);
  setTimer(() => {
    const current = workerById(worker.id);
    if (current && current.exitCode === null && current.generation === worker.generation) removeZaicodeWorker(worker.id);
  }, CLOSE_DELAY_MS);
}

function handleCapacity(
  worker: ZaicodeWorker,
  state: WatchState,
  signal: ZaicodeWorkerCapacitySignal,
): void {
  watch.set(worker.id, state);
  if (state.capacityTimer !== null) return;
  if (useZaicodeRetryLedger.getState().halted) return;
  if (!zaicodeAutoRetryAllowedFor(worker.projectPath, undefined, true)) return;

  const prefs = useZaicodeUiPrefs.getState();
  const maxAttempts = zaicodeRetryLimit(prefs.autoRetryMaxAttempts);
  if (state.capacityAttempts >= maxAttempts) {
    notifyZaicode("worker.fail", {
      header: "Workers",
      title: `${zaicodeWorkerTitle(worker)}: capacity retry budget exhausted`,
      body: `Paused after ${state.capacityAttempts}/${maxAttempts} attempts.\n${signal.line}`,
      status: "Exhausted",
      key: "worker-capacity-exhausted:" + worker.id,
      actions: [{ label: "Show", run: () => focusZaicodeWorker(worker.id) }],
    });
    useZaicodeRetryLedger.getState().clear(worker.id);
    return;
  }

  const jobs = readZaicodeAutostartJobs();
  const job = jobs.find((candidate) =>
    candidate.continuationRuns.some(
      (run) => run.workerId === worker.id && run.generation === worker.generation,
    ),
  );
  if (job) {
    if (!job.enabled) return;
    if (job.stopAt) {
      const stopAt = zaicodeScheduleStopAt(job.stopAt, job.lastRunAt ?? Date.now());
      if (stopAt !== null && Date.now() >= stopAt) return;
    }
  }

  if (/WAIT_USER|RECONCILE_REAUTH_REQUIRED|REFUSE\s*\[/i.test(state.tail)) {
    return;
  }

  const delayMs = zaicodeRetryDelayMs(prefs.autoRetryIntervalSec);
  recordZaicodeScheduledWorkerCapacity(worker, signal, delayMs);

  state.capacityAttempts += 1;
  state.lastCapacityLine = signal.line;
  const attempt = state.capacityAttempts;
  const nextAt = Date.now() + delayMs;

  useZaicodeRetryLedger.getState().set({
    sessionId: worker.id,
    title: `${zaicodeWorkerTitle(worker)} (Codex capacity unavailable)`,
    nextAt,
    attempt,
    source: "worker",
    reason: "Codex capacity unavailable",
  });

  playZaicodeSound("worker.fail");
  notifyZaicode("worker.fail", {
    header: "Workers",
    title: `${zaicodeWorkerTitle(worker)}: Codex capacity unavailable`,
    body: `Retrying cc in ${Math.round(delayMs / 1000)}s · Attempt ${attempt}/${maxAttempts}\n${signal.line}`,
    status: "Capacity",
    key: "worker-capacity:" + worker.id,
    actions: [{ label: "Show", run: () => focusZaicodeWorker(worker.id) }],
  });

  state.capacityTimer = setTimer(() => {
    state.capacityTimer = null;
    const current = workerById(worker.id);
    if (
      !current ||
      current.kind !== "worker" ||
      current.exitCode !== null ||
      current.generation !== worker.generation ||
      current.accountId !== worker.accountId
    ) {
      useZaicodeRetryLedger.getState().clear(worker.id);
      return;
    }

    const control = terminalControl(worker.id);
    if (!control) {
      useZaicodeRetryLedger.getState().clear(worker.id);
      return;
    }

    if (useZaicodeRetryLedger.getState().halted) {
      useZaicodeRetryLedger.getState().clear(worker.id);
      return;
    }

    if (!zaicodeAutoRetryAllowedFor(current.projectPath, undefined, true)) {
      useZaicodeRetryLedger.getState().clear(worker.id);
      return;
    }

    const currentJobs = readZaicodeAutostartJobs();
    const currentJob = currentJobs.find((candidate) =>
      candidate.continuationRuns.some(
        (run) => run.workerId === current.id && run.generation === current.generation,
      ),
    );
    if (currentJob) {
      if (!currentJob.enabled) {
        useZaicodeRetryLedger.getState().clear(worker.id);
        return;
      }
      if (currentJob.stopAt) {
        const stopAt = zaicodeScheduleStopAt(currentJob.stopAt, currentJob.lastRunAt ?? Date.now());
        if (stopAt !== null && Date.now() >= stopAt) {
          useZaicodeRetryLedger.getState().clear(worker.id);
          return;
        }
      }
    }

    const currentState = watch.get(worker.id);
    if (!currentState) {
      useZaicodeRetryLedger.getState().clear(worker.id);
      return;
    }

    if (/WAIT_USER|RECONCILE_REAUTH_REQUIRED|REFUSE\s*\[/i.test(currentState.tail)) {
      useZaicodeRetryLedger.getState().clear(worker.id);
      return;
    }

    if (!detectZaicodePromptReady(currentState.tail)) {
      useZaicodeRetryLedger.getState().clear(worker.id);
      return;
    }

    currentState.tail = "";
    control.write("cc\r");
    useZaicodeRetryLedger.getState().clear(worker.id);
    notifyZaicode("worker.exit", {
      header: "Workers",
      title: `${zaicodeWorkerTitle(current)}: Retried cc on capacity recovery`,
      body: `Attempt ${attempt}/${maxAttempts} sent`,
      key: "worker-capacity-sent:" + worker.id,
    });
  }, delayMs);
}

function scan(id: string): void {
  const state = watch.get(id);
  const worker = workerById(id);
  if (!state || !worker) return;
  state.timer = null;
  if (worker.kind !== "worker" || worker.exitCode !== null || worker.generation !== state.generation) return;
  const signals = detectZaicodeWorkerSignals(state.tail, worker.vendor);
  if (signals.trust) answerTrust(worker, state);
  if (signals.limit) handleLimit(worker, state, signals.limit);
  if (signals.capacity) {
    handleCapacity(worker, state, signals.capacity);
  } else if (state.capacityAttempts > 0 && state.capacityTimer === null) {
    state.capacityAttempts = 0;
    state.lastCapacityLine = null;
    useZaicodeRetryLedger.getState().clear(worker.id);
  }
}

/** Actual terminal tap; tests exercise live ownership and delayed input. */
export function startZaicodeWorkerWatch(): () => void {
  const off = onTerminalOutput((key, data) => {
    const worker = workerById(key);
    if (!worker || worker.kind !== "worker" || worker.exitCode !== null) {
      const state = watch.get(key);
      if (state) {
        clearTimer(state.timer);
        clearTimer(state.trustTimer);
        clearTimer(state.capacityTimer);
        watch.delete(key);
        useZaicodeRetryLedger.getState().clear(key);
      }
      return;
    }
    let state = watch.get(key);
    if (state && state.generation !== worker.generation) {
      clearTimer(state.timer);
      clearTimer(state.trustTimer);
      clearTimer(state.capacityTimer);
      useZaicodeRetryLedger.getState().clear(key);
      state = undefined;
    }
    state ??= {
      tail: "",
      generation: worker.generation,
      timer: null,
      trustTimer: null,
      limitAt: 0,
      capacityTimer: null,
      capacityAttempts: 0,
      lastCapacityLine: null,
    };
    state.tail = (state.tail + data).slice(-TAIL_CHARS);
    watch.set(key, state);
    if (state.timer === null) state.timer = setTimer(() => scan(key), SCAN_DELAY_MS);
  });
  return () => {
    off();
    for (const [key, state] of watch.entries()) {
      clearTimer(state.timer);
      clearTimer(state.trustTimer);
      clearTimer(state.capacityTimer);
      useZaicodeRetryLedger.getState().clear(key);
    }
    watch.clear();
  };
}

export function clearZaicodeWorkerWatchForTest(): void {
  for (const [key, state] of watch.entries()) {
    clearTimer(state.timer);
    clearTimer(state.trustTimer);
    clearTimer(state.capacityTimer);
    useZaicodeRetryLedger.getState().clear(key);
  }
  watch.clear();
}

export function getZaicodeWorkerWatchStateForTest(id: string): {
  tail: string;
  generation: number;
  capacityAttempts: number;
  capacityTimer: number | null;
} | undefined {
  const s = watch.get(id);
  if (!s) return undefined;
  return {
    tail: s.tail,
    generation: s.generation,
    capacityAttempts: s.capacityAttempts,
    capacityTimer: s.capacityTimer,
  };
}

export const handleZaicodeWorkerCapacityForTest = handleCapacity;

export function useZaicodeWorkerWatch(): void {
  useEffect(startZaicodeWorkerWatch, []);
}
