import { create } from "zustand";
import { useZaicodeAuditStore } from "./zaicodeAuditStore.js";
import { zaicodeAutoContinueModeFor, type ZaicodeAutoContinueMode } from "./zaicodeAutoContinue.js";
import { ZAICODE_AUTO_RETRY_DEFAULT_ATTEMPTS, ZAICODE_AUTO_RETRY_HARD_CAP, zaicodeAutoRetryEnabled, useZaicodeUiPrefs, type ZaicodeUiPrefs } from "./zaicodeUiPrefs.js";
import { currentZaicodeRetrySafety, writeZaicodeRetrySafety } from "./zaicodeRetrySafety.js";

export { ZAICODE_AUTO_RETRY_DEFAULT_ATTEMPTS, ZAICODE_AUTO_RETRY_HARD_CAP };

/**
 * SRC-082: "it knocks on an empty door with no limits, nowhere to turn it off or
 * watch it, even with auto continue off. That is a hole."
 *
 * One policy for every automatic send that answers a failure (the open chat's
 * countdown, the background retry host, the queue auto-resume, the crash resume). It
 * answers four questions the three of them used to answer differently or not at all:
 *
 *   MAY it send?     the one effective retry projection (zaicodeEffectiveAutoRetry:
 *                    the project/session/global retry preference, the sidebar Auto
 *                    master, the session's own mode and the stop-all ledger);
 *   SHOULD it?       a quota / usage-limit error is a wall, not a hiccup: it
 *                    waits for the reset instead of being asked again every
 *                    minute (zaicodeRetryClassOf, the quota memory);
 *   HOW OFTEN?       backoff, never a flat interval (zaicodeRetryDelayMs);
 *   HOW MANY?        a hard cap no setting can raise (ZAICODE_AUTO_RETRY_HARD_CAP);
 *   AND WHO SEES IT? every scheduled retry is in the ledger the sidebar shows,
 *                    with one button that stops them all.
 *
 * There is exactly one answer to "may it send", and it is the conservative one: an
 * operator's explicit OFF (project, session or the stop-all button) wins over any
 * session that says On. The old second gate (zaicodeMayAutoSend / zaicodeAutoSendAllowed)
 * answered the same question differently and was deleted with the queue and crash-resume
 * owners that still asked it -- two authorities answering one question was the defect.
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

/** The sidebar's Auto ON/OFF, read outside React. Unknown yet (not loaded) reads as OFF: safe. */
export function zaicodeMasterAutoOn(): boolean {
  return useZaicodeAuditStore.getState().smartMode === true;
}

/**
 * The canonical gate for one autonomous sender outside React: the effective retry
 * projection claim for this session ANDed with the feature's own switch (e.g.
 * `resumeAfterCrash` for the crash resume, the caller's `enabled` for the queue).
 * Every autonomous-send owner asks this, so what the Auto Retry surface says and what
 * actually goes out cannot disagree.
 */
export function zaicodeAutoRetryAllowedFor(
  projectKey: string,
  sessionId: string | null | undefined,
  featureOn: boolean,
): boolean {
  if (!featureOn) return false;
  return zaicodeEffectiveAutoRetryFor(projectKey, sessionId).enabled;
}

/** Single effective projection for every retry owner and representation. */
export type ZaicodeAutoRetryPrefs = Pick<ZaicodeUiPrefs, "autoRetry" | "autoRetryScope" | "autoRetryProjects"> &
  Partial<Pick<ZaicodeUiPrefs, "autoRetrySessions">>;

/** Which gate holds the effective answer OFF; null while it is ON. */
export type ZaicodeAutoRetryBlock = "halted" | "session-off" | "preference-off" | "master-off";

export function zaicodeEffectiveAutoRetry(prefs: ZaicodeAutoRetryPrefs, projectKey: string, sessionId: string | null | undefined, gate: { masterOn: boolean; sessionMode?: ZaicodeAutoContinueMode; halted: boolean }) {
  const preference = zaicodeAutoRetryEnabled(prefs, projectKey, sessionId);
  const source: "session" | "project" | "global" = sessionId && prefs.autoRetrySessions?.[sessionId] !== undefined ? "session" : prefs.autoRetryProjects[projectKey] !== undefined ? "project" : "global";
  // SRC-162: an explicit project or session retry ON is the operator's own answer for this place,
  // exactly like a session set to auto-continue On, so it does not wait for the sidebar Auto
  // master. Only the inherited global default follows the master. Before this, a click on the
  // composer button while Auto was OFF flipped a preference the master then hid, so the button
  // read "off" whatever the operator did.
  const explicitOn = source !== "global";
  const block: ZaicodeAutoRetryBlock | null = gate.halted
    ? "halted"
    : gate.sessionMode === "off"
      ? "session-off"
      : !preference
        ? "preference-off"
        : !gate.masterOn && gate.sessionMode !== "on" && !explicitOn
          ? "master-off"
          : null;
  // Every reason names the surface that owns it (SRC-161:REQ-002).
  const reason = block === "halted" ? "All retries stopped" : block === "session-off" ? "Session auto-continue is off" : block === "preference-off" ? `${source} retry preference is off` : block === "master-off" ? "Sidebar Auto is off" : null;
  return { enabled: block === null, preference, source, reason, block, halted: gate.halted, sessionOff: gate.sessionMode === "off" };
}

/**
 * What one click on the composer's Auto retry button does (SRC-162: "auto retry works badly and
 * unpredictably"). The click always flips the EFFECTIVE answer, so the button's look changes on
 * every click:
 * - ON -> OFF writes OFF into the scope that owns the answer;
 * - OFF -> ON lifts whatever holds it off: the stop-all, a session auto-continue Off, and writes an
 *   explicit ON (a project override when the answer was only inherited, so the sidebar Auto master
 *   no longer hides it).
 */
export function zaicodeAutoRetryToggle(
  prefs: ZaicodeAutoRetryPrefs,
  projectKey: string,
  sessionId: string | null | undefined,
  effective: Pick<ReturnType<typeof zaicodeEffectiveAutoRetry>, "enabled" | "source" | "halted" | "sessionOff">,
): { patch: Partial<ZaicodeUiPrefs>; resumeHalt: boolean; clearSessionOff: boolean; next: boolean } {
  if (effective.enabled) {
    return { patch: zaicodeScopedRetryPatch(prefs, projectKey, sessionId, effective.source, false), resumeHalt: false, clearSessionOff: false, next: false };
  }
  const scope = effective.source === "global" ? "project" : effective.source;
  return {
    patch: zaicodeScopedRetryPatch(prefs, projectKey, sessionId, scope, true),
    resumeHalt: effective.halted,
    clearSessionOff: effective.sessionOff && Boolean(sessionId),
    next: true,
  };
}

function zaicodeScopedRetryPatch(
  prefs: ZaicodeAutoRetryPrefs,
  projectKey: string,
  sessionId: string | null | undefined,
  scope: "session" | "project" | "global",
  value: boolean,
): Partial<ZaicodeUiPrefs> {
  if (scope === "session" && sessionId) return { autoRetrySessions: { ...prefs.autoRetrySessions, [sessionId]: value } };
  if (scope === "project" || scope === "session") return { autoRetryProjects: { ...prefs.autoRetryProjects, [projectKey]: value } };
  return { autoRetry: value };
}

export function zaicodeEffectiveAutoRetryFor(projectKey: string, sessionId?: string | null): ReturnType<typeof zaicodeEffectiveAutoRetry> {
  return zaicodeEffectiveAutoRetry(useZaicodeUiPrefs.getState(), projectKey, sessionId, { masterOn: zaicodeMasterAutoOn(), sessionMode: sessionId ? zaicodeAutoContinueModeFor(sessionId) : undefined, halted: useZaicodeRetryLedger.getState().halted });
}

// ---------------------------------------------------------------- quota memory

// Hydrated from the durable safety record: a reload must not ask an account the operator just
// watched hit its limit (SRC-161:W2-002). Stale entries fall out on first read.
const quotaWalls = new Map<string, number>(
  Object.entries(currentZaicodeRetrySafety().quotaWalls).filter(([, at]) => Date.now() - at <= QUOTA_MEMORY_MS),
);

/** A pane saw a quota error on this session: nobody retries it blindly for a while. */
export function markZaicodeQuotaWall(sessionId: string, now = Date.now()): void {
  quotaWalls.set(sessionId, now);
  writeZaicodeRetrySafety({ quotaWalls: Object.fromEntries(quotaWalls) });
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
  if (!quotaWalls.delete(sessionId)) return;
  writeZaicodeRetrySafety({ quotaWalls: Object.fromEntries(quotaWalls) });
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
  // The stop-all is the operator's own instruction; a renderer reload does not undo it. The
  // ledger chip shows it with one click to allow again, so it is never a silent dead end.
  halted: currentZaicodeRetrySafety().halted,
  halt: () => {
    writeZaicodeRetrySafety({ halted: true });
    set({ pending: {}, halted: true });
  },
  resume: () => {
    writeZaicodeRetrySafety({ halted: false });
    set({ halted: false });
  },
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
