import { useEffect } from "react";
import { onTerminalOutput, terminalControl } from "@/terminal/terminalOutputTap.js";
import { addZaicodeAutostartJob, recordZaicodeScheduledWorkerLimit } from "./zaicodeAutostart.js";
import { refreshZaicodeEngineLimits } from "./zaicodeEngines.js";
import { notifyZaicode } from "./zaicodeNotifications.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";
import { readZaicodeWorkerPrefs } from "./zaicodeWorkerPrefs.js";
import { detectZaicodeTrustInput, detectZaicodeWorkerSignals, type ZaicodeWorkerLimitSignal } from "./zaicodeWorkerSignals.js";
import { focusZaicodeWorker, readZaicodeWorkers, removeZaicodeWorker, zaicodeWorkerTitle, type ZaicodeWorker } from "./zaicodeWorkers.js";

export { detectZaicodeWorkerSignals, stripZaicodeAnsi, type ZaicodeWorkerLimitSignal } from "./zaicodeWorkerSignals.js";

const TAIL_CHARS = 8000;
const SCAN_DELAY_MS = 400;
const TRUST_REPLY_MS = 600;
const LIMIT_REPEAT_MS = 30 * 60_000;
const CLOSE_DELAY_MS = 3000;

interface WatchState {
  tail: string;
  generation: number;
  timer: number | null;
  trustTimer: number | null;
  limitAt: number;
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
  state.trustTimer = window.setTimeout(() => {
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
  window.setTimeout(() => {
    const current = workerById(worker.id);
    if (current && current.exitCode === null && current.generation === worker.generation) removeZaicodeWorker(worker.id);
  }, CLOSE_DELAY_MS);
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
}

/** Actual terminal tap; tests exercise live ownership and delayed input. */
export function startZaicodeWorkerWatch(): () => void {
  const off = onTerminalOutput((key, data) => {
    const worker = workerById(key);
    if (!worker || worker.kind !== "worker" || worker.exitCode !== null) return;
    let state = watch.get(key);
    if (state && state.generation !== worker.generation) {
      if (state.timer !== null) window.clearTimeout(state.timer);
      if (state.trustTimer !== null) window.clearTimeout(state.trustTimer);
      state = undefined;
    }
    state ??= { tail: "", generation: worker.generation, timer: null, trustTimer: null, limitAt: 0 };
    state.tail = (state.tail + data).slice(-TAIL_CHARS);
    watch.set(key, state);
    if (state.timer === null) state.timer = window.setTimeout(() => scan(key), SCAN_DELAY_MS);
  });
  return () => {
    off();
    for (const state of watch.values()) {
      if (state.timer !== null) window.clearTimeout(state.timer);
      if (state.trustTimer !== null) window.clearTimeout(state.trustTimer);
    }
    watch.clear();
  };
}

export function useZaicodeWorkerWatch(): void {
  useEffect(startZaicodeWorkerWatch, []);
}
