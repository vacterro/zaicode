import { create } from "zustand";
import { useZaicodeAuditStore } from "./zaicodeAuditStore.js";
import { zaicodeAutoContinueModeFor, type ZaicodeAutoContinueMode } from "./zaicodeAutoContinue.js";
import { ZAICODE_AUTO_RETRY_DEFAULT_ATTEMPTS, ZAICODE_AUTO_RETRY_HARD_CAP } from "./zaicodeUiPrefs.js";

export { ZAICODE_AUTO_RETRY_DEFAULT_ATTEMPTS, ZAICODE_AUTO_RETRY_HARD_CAP };

/**
 * SRC-082: "it knocks on an empty door with no limits, nowhere to turn it off or
 * watch it, even with auto continue off. That is a hole."
 *
 * One policy for every automatic send that answers a failure (the open chat's
 * countdown, the background retry host, the crash resume). It answers four
 * questions the three of them used to answer differently or not at all:
 *
 *   MAY it send?     the session's own switch, the sidebar Auto master and the
 *                    feature's own switch (zaicodeMayAutoSend);
 *   SHOULD it?       a quota / usage-limit error is a wall, not a hiccup: it
 *                    waits for the reset instead of being asked again every
 *                    minute (zaicodeRetryClassOf, the quota memory);
 *   HOW OFTEN?       backoff, never a flat interval (zaicodeRetryDelayMs);
 *   HOW MANY?        a hard cap no setting can raise (ZAICODE_AUTO_RETRY_HARD_CAP);
 *   AND WHO SEES IT? every scheduled retry is in the ledger the sidebar shows,
 *                    with one button that stops them all.
 */

/** Backoff never waits longer than this between two attempts. */
const BACKOFF_CEILING_SEC = 1800;
/** A quota wall is remembered this long; after it, one probe may go out. */
const QUOTA_MEMORY_MS = 30 * 60 * 1000;

export function zaicodeRetryLimit(preferred: number): number {
  return Math.max(1, Math.min(ZAICODE_AUTO_RETRY_HARD_CAP, Math.round(preferred)));
}

/** interval, 2x, 4x, 8x ... capped: attempt 0 waits the interval itself. */
export function zaicodeRetryDelayMs(intervalSec: number, attemptsDone: number): number {
  const factor = 2 ** Math.min(Math.max(0, attemptsDone), 6);
  return Math.min(BACKOFF_CEILING_SEC, Math.max(1, intervalSec) * factor) * 1000;
}

export type ZaicodeRetryClass = "transient" | "quota";

/** GLM business codes 1308-1321: quota, plan and account boundaries. */
const QUOTA_CODE = /^13(?:0[89]|1[0-9]|2[01])$/;
const QUOTA_MESSAGE = /usage limit|limit reached|quota|insufficient (?:balance|credit)|out of credit|额度|用量/i;

export function zaicodeRetryClassOf(error: { code?: string | null; message?: string | null }): ZaicodeRetryClass {
  const code = (error.code ?? "").trim();
  const message = error.message ?? "";
  if (QUOTA_CODE.test(code) || /QUOTA|USAGE_LIMIT/i.test(code)) return "quota";
  // "[1308][Usage limit reached ..." arrives with a wrapper code and the business code in the text.
  if (/\[13(?:0[89]|1[0-9]|2[01])\]/.test(message)) return "quota";
  return QUOTA_MESSAGE.test(message) ? "quota" : "transient";
}

/**
 * The per-session switch, the sidebar Auto master and the feature's own switch.
 * An explicit per-session Off always wins; an explicit On lets the session
 * continue itself (the rule zaicodeAutoContinueAllowed always had); otherwise
 * it needs the master AND the feature.
 */
export function zaicodeMayAutoSend(input: {
  mode: ZaicodeAutoContinueMode | undefined;
  masterOn: boolean;
  featureOn: boolean;
}): boolean {
  if (input.mode === "off") return false;
  if (input.mode === "on") return true;
  return input.masterOn && input.featureOn;
}

/** The sidebar's Auto ON/OFF, read outside React. Unknown yet (not loaded) reads as OFF: safe. */
export function zaicodeMasterAutoOn(): boolean {
  return useZaicodeAuditStore.getState().smartMode === true;
}

/** The whole gate for one session, outside React. */
export function zaicodeAutoSendAllowed(sessionId: string, featureOn: boolean): boolean {
  if (useZaicodeRetryLedger.getState().halted) return false;
  return zaicodeMayAutoSend({ mode: zaicodeAutoContinueModeFor(sessionId), masterOn: zaicodeMasterAutoOn(), featureOn });
}

// ---------------------------------------------------------------- quota memory

const quotaWalls = new Map<string, number>();

/** A pane saw a quota error on this session: nobody retries it blindly for a while. */
export function markZaicodeQuotaWall(sessionId: string, now = Date.now()): void {
  quotaWalls.set(sessionId, now);
  for (const [id, at] of quotaWalls) {
    if (quotaWalls.size <= 200) break;
    if (now - at > QUOTA_MEMORY_MS) quotaWalls.delete(id);
  }
}

export function isZaicodeQuotaWall(sessionId: string, now = Date.now()): boolean {
  const at = quotaWalls.get(sessionId);
  if (at === undefined) return false;
  if (now - at > QUOTA_MEMORY_MS) {
    quotaWalls.delete(sessionId);
    return false;
  }
  return true;
}

export function clearZaicodeQuotaWall(sessionId: string): void {
  quotaWalls.delete(sessionId);
}

// ---------------------------------------------------------------- the ledger

export interface ZaicodePendingRetry {
  sessionId: string;
  title: string;
  /** Epoch ms of the next automatic attempt. */
  nextAt: number;
  /** The attempt that will go out (1-based). */
  attempt: number;
  source: "chat" | "background" | "crash";
}

interface ZaicodeRetryLedgerState {
  pending: Record<string, ZaicodePendingRetry>;
  /** The operator pressed the sidebar's stop-all: no automatic send goes out, per-session On included. */
  halted: boolean;
  set: (entry: ZaicodePendingRetry) => void;
  clear: (sessionId: string) => void;
  clearAll: () => void;
  halt: () => void;
  resume: () => void;
}

/** Everything scheduled to knock by itself, so the sidebar can show it and stop it. */
export const useZaicodeRetryLedger = create<ZaicodeRetryLedgerState>((set, get) => ({
  pending: {},
  halted: false,
  halt: () => set({ pending: {}, halted: true }),
  resume: () => set({ halted: false }),
  set: (entry) => {
    const current = get().pending[entry.sessionId];
    if (current && current.nextAt === entry.nextAt && current.attempt === entry.attempt && current.source === entry.source) return;
    set({ pending: { ...get().pending, [entry.sessionId]: entry } });
  },
  clear: (sessionId) => {
    if (!(sessionId in get().pending)) return;
    const pending = { ...get().pending };
    delete pending[sessionId];
    set({ pending });
  },
  clearAll: () => {
    if (Object.keys(get().pending).length > 0) set({ pending: {} });
  },
}));
