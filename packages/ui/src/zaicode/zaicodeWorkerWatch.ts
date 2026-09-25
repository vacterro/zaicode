import { useEffect } from "react";
import { onTerminalOutput, terminalControl } from "@/terminal/terminalOutputTap.js";
import { addZaicodeAutostartJob } from "./zaicodeAutostart.js";
import { refreshZaicodeEngineLimits } from "./zaicodeEngines.js";
import { notifyZaicode } from "./zaicodeNotifications.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";
import { readZaicodeWorkerPrefs } from "./zaicodeWorkerPrefs.js";
import { focusZaicodeWorker, readZaicodeWorkers, removeZaicodeWorker, zaicodeWorkerTitle, type ZaicodeWorker } from "./zaicodeWorkers.js";

/**
 * Watches what worker CLIs print (SRC-046):
 * - "Trust this folder?" -- the first-run question of Claude Code / Codex in a
 *   new folder. A scheduled worker used to sit on it for 8 hours; it is
 *   answered with Enter (the "yes" choice) when "auto-trust" is on.
 * - "You've hit your session limit" (and the other vendors' words for it) --
 *   the operator is told, the engine's limits are read again, and by the
 *   Workers setting the worker stays, closes, or closes and is started again
 *   after the window's reset (a one-shot SCHEDULER entry).
 */

const TAIL_CHARS = 4000;
const SCAN_CHARS = 1600;
const SCAN_DELAY_MS = 400;
/** The trust question only comes at a CLI's start. */
const TRUST_WINDOW_MS = 15 * 60_000;
const TRUST_MAX_ANSWERS = 2;
const LIMIT_REPEAT_MS = 30 * 60_000;
const CLOSE_DELAY_MS = 3000;

// eslint-disable-next-line no-control-regex -- terminal escape sequences are exactly what is stripped
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;

const TRUST =
  /do you trust the (?:files|contents) (?:in|of) this (?:folder|directory)|is this a project you created or one you trust|yes,? i trust this folder|trust this folder\?|yes,? allow codex to work in this folder/i;

const LIMIT =
  /(?:you['’]ve |you have )?hit your (?:session|usage|weekly|daily|5-hour|five-hour|monthly)?\s*limit|usage limit reached|(?:5-hour|weekly|session) limit reached|you['’]ve reached your [^\n]{0,30}limit|quota exceeded|resource_exhausted|exhausted your (?:capacity|quota)/i;

const RESET = /(?:resets?|reset at|try again in)\s+([^\n·∙|]{1,48})/i;

export interface ZaicodeWorkerLimitSignal {
  /** Which window to wait for when the worker is started again. */
  window: "five_hour" | "weekly";
  /** The vendor's own words for when it comes back ("7:40pm (Europe/Tallinn)"). */
  resetText: string | null;
  line: string;
}

// eslint-disable-next-line no-control-regex -- cursor-forward is how TUIs draw spaces
const CURSOR_FORWARD = /\u001b\[\d*C/g;

/** Terminal bytes to plain lines: cursor-forward becomes a space, a bare CR ends a line. */
export function stripZaicodeAnsi(text: string): string {
  return text.replace(CURSOR_FORWARD, " ").replace(ANSI, "").replace(/\r\n?/g, "\n");
}

/**
 * A CLI prints its own status at the start of a line (after box drawing,
 * bullets or a menu number); an agent or a pasted prompt that merely talks
 * about limits writes it inside prose. Only the first kind counts.
 */
function findAtLineStart(pattern: RegExp, text: string): RegExpExecArray | null {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (let match = global.exec(text); match; match = global.exec(text)) {
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    if (!/[A-Za-zЀ-ӿ]/.test(text.slice(lineStart, match.index))) return match;
  }
  return null;
}

/** Pure: what the tail of a worker's output asks for. */
export function detectZaicodeWorkerSignals(tail: string): { trust: boolean; limit: ZaicodeWorkerLimitSignal | null } {
  const text = tail.slice(-SCAN_CHARS);
  const trust = findAtLineStart(TRUST, text) !== null;
  const match = findAtLineStart(LIMIT, text);
  if (!match) return { trust, limit: null };
  const lineStart = text.lastIndexOf("\n", match.index) + 1;
  const lineEnd = text.indexOf("\n", match.index);
  const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim();
  const reset = RESET.exec(text.slice(match.index));
  return {
    trust,
    limit: {
      window: /weekly|week/i.test(line) ? "weekly" : "five_hour",
      resetText: reset?.[1]?.trim() ?? null,
      line,
    },
  };
}

interface WatchState {
  tail: string;
  timer: number | null;
  trustAnswers: number;
  limitAt: number;
}

const watch = new Map<string, WatchState>();

function workerById(id: string): ZaicodeWorker | undefined {
  return readZaicodeWorkers().workers.find((worker) => worker.id === id);
}

function answerTrust(worker: ZaicodeWorker, state: WatchState): void {
  if (!readZaicodeWorkerPrefs().autoTrust) return;
  if (state.trustAnswers >= TRUST_MAX_ANSWERS || Date.now() - worker.startedAt > TRUST_WINDOW_MS) return;
  const control = terminalControl(worker.id);
  if (!control) return;
  state.trustAnswers += 1;
  state.tail = "";
  window.setTimeout(() => control.write("\r"), 600);
  notifyZaicode("worker.exit", {
    header: "Workers",
    title: `${zaicodeWorkerTitle(worker)}: “Trust this folder?” answered yes`,
    body: `${worker.projectPath}\nWorkers settings -> auto-trust switches this off.`,
    key: `worker-trust:${worker.id}`,
  });
}

function resumeAfterReset(worker: ZaicodeWorker, signal: ZaicodeWorkerLimitSignal): void {
  if (!worker.accountId) return;
  addZaicodeAutostartJob({
    name: `Resume ${worker.short} after its limit`,
    projectPath: worker.projectPath,
    engineId: worker.accountId,
    targetKind: "project",
    trigger: "reset",
    window: signal.window,
    prompt: worker.prompt ?? "cc",
    requireQuota: true,
    enabled: true,
  });
}

function handleLimit(worker: ZaicodeWorker, state: WatchState, signal: ZaicodeWorkerLimitSignal): void {
  if (Date.now() - state.limitAt < LIMIT_REPEAT_MS) return;
  state.limitAt = Date.now();
  const action = readZaicodeWorkerPrefs().onLimit;
  if (worker.accountId) void refreshZaicodeEngineLimits(worker.accountId);
  playZaicodeSound("worker.fail");
  const when = signal.resetText ? ` (back ${signal.resetText})` : "";
  const what =
    action === "close"
      ? "closed to free its place"
      : action === "closeAndResume"
        ? "closed; it starts again after the reset (SCHEDULER)"
        : "kept open; the CLI waits for the reset itself";
  notifyZaicode("worker.fail", {
    header: "Workers",
    title: `${zaicodeWorkerTitle(worker)} hit its limit${when}`,
    body: `${signal.line}\n${what}. Workers settings -> “On a limit” decides this.`,
    status: "Limit",
    key: `worker-limit:${worker.id}`,
    actions: [{ label: "Show", run: () => focusZaicodeWorker(worker.id) }],
  });
  if (action === "keep") return;
  if (action === "closeAndResume") resumeAfterReset(worker, signal);
  window.setTimeout(() => {
    const current = workerById(worker.id);
    if (current && current.exitCode === null) removeZaicodeWorker(worker.id);
  }, CLOSE_DELAY_MS);
}

function scan(id: string): void {
  const state = watch.get(id);
  const worker = workerById(id);
  if (!state || !worker) {
    watch.delete(id);
    return;
  }
  state.timer = null;
  if (worker.kind !== "worker" || worker.exitCode !== null) return;
  const signals = detectZaicodeWorkerSignals(state.tail);
  if (signals.trust) answerTrust(worker, state);
  if (signals.limit) handleLimit(worker, state, signals.limit);
}

/** Mount once (ZaicodeAppRuntime). */
export function useZaicodeWorkerWatch(): void {
  useEffect(
    () =>
      onTerminalOutput((key, data) => {
        if (!key.startsWith("zaicode-worker:")) return;
        const state = watch.get(key) ?? { tail: "", timer: null, trustAnswers: 0, limitAt: 0 };
        state.tail = (state.tail + stripZaicodeAnsi(data)).slice(-TAIL_CHARS);
        watch.set(key, state);
        if (state.timer === null) state.timer = window.setTimeout(() => scan(key), SCAN_DELAY_MS);
      }),
    [],
  );
}
