import { useZaicodeRouterSetup } from "./zaicodeRouterSetup.js";
import { isZaicodeQuotaWall, useZaicodeRetryLedger } from "./zaicodeRetryPolicy.js";

/**
 * Fresh REQ-005 (SRC-153 R005): one truthful connection/recovery projection.
 *
 * When a session loses its API connection and ZAICODE attempts recovery, the UI
 * must not keep showing the ordinary "Working" state. This module is the single
 * projector every working surface (composer mini, sidebar row, worker/session
 * indicators) reads: same inputs, same answer, no second timer and no second
 * state machine. Inputs are the existing authoritative states only:
 * - the router supervisor the main process reports (route/status/failure/attempts),
 * - the retry ledger (a scheduled automatic attempt exists),
 * - the quota-wall memory (the error is a wall, not a hiccup),
 * - the session running flag and the global retry halt.
 *
 * Restart reconciliation falls out of the inputs: the ledger is memory-only, so
 * a fresh boot has no pending retry and no quota wall; the supervisor is
 * re-polled by the existing 15s router poll. Until the poll reports recovery,
 * a running session reads as working (never a false offline); once it reports
 * recovering/fallback, every surface flips together.
 */

export type ZaicodePresenceKind =
  | "working"
  | "reconnecting"
  | "fallback-active"
  | "waiting-retry"
  | "waiting-quota"
  | "offline"
  | "idle";

export interface ZaicodePresenceInput {
  /** The session (or project aggregate) claims to be doing work. */
  running: boolean;
  /** Router supervisor route, when the main process has reported one. */
  supervisorRoute?: "preferred" | "fallback" | null;
  /** Router supervisor status. */
  supervisorStatus?: string | null;
  /** Router supervisor failure class (e.g. "connection-failure"). */
  supervisorFailure?: string | null;
  /** Bounded recovery attempt counter for "attempt N/10" detail. */
  supervisorAttempts?: number | null;
  /** A retry is scheduled for this session in the retry ledger. */
  pendingRetry?: boolean;
  /** The last error was a quota wall: only the reset lifts it. */
  quotaWall?: boolean;
  /** The operator stopped all automatic retries. */
  halted?: boolean;
}

export interface ZaicodePresence {
  kind: ZaicodePresenceKind;
  /** Compact surface text. null means the surface keeps its ordinary rendering. */
  label: string | null;
  /** Longer tooltip/detail text, null when there is nothing to add. */
  detail: string | null;
}

const RECOVERY_ATTEMPT_CAP = 10;

export function projectZaicodeConnectionState(input: ZaicodePresenceInput): ZaicodePresence {
  if (!input.running) return { kind: "idle", label: null, detail: null };
  // A quota wall is known, not guessed: waiting differs from retrying.
  if (input.quotaWall) {
    return {
      kind: "waiting-quota",
      label: "Waiting for reset",
      detail: "The route is quota-exhausted; retrying cannot lift it, only the vendor reset can.",
    };
  }
  // Internal fallback carries the work: never claim the preferred route is live.
  if (input.supervisorRoute === "fallback" && input.supervisorStatus === "fallback-active") {
    return {
      kind: "fallback-active",
      label: "Fallback active",
      detail: "Preferred router unavailable · internal fallback carries the work.",
    };
  }
  // Bounded router recovery in flight: the first connection failure reads as
  // Reconnecting, with the attempt counter while the supervisor reports it.
  if (
    input.supervisorStatus === "recovering" ||
    (input.supervisorFailure === "connection-failure" && input.supervisorRoute === "preferred")
  ) {
    const attempts = Math.max(0, input.supervisorAttempts ?? 1);
    return {
      kind: "reconnecting",
      label: `Reconnecting · attempt ${Math.min(attempts, RECOVERY_ATTEMPT_CAP)}/${RECOVERY_ATTEMPT_CAP}`,
      detail: "API connection lost; ZAICODE is attempting recovery instead of doing work.",
    };
  }
  // Both routes down: interrupted, never working.
  if (
    input.supervisorStatus === "unavailable" ||
    input.supervisorStatus === "preferred-unavailable" ||
    (input.supervisorFailure !== null &&
      input.supervisorFailure !== undefined &&
      input.supervisorRoute === "fallback" &&
      input.supervisorStatus !== "fallback-active")
  ) {
    return {
      kind: "offline",
      label: "Interrupted",
      detail: "Recovery and fallback both failed; no work is going out.",
    };
  }
  // A scheduled automatic attempt exists: healthy work has not resumed yet.
  if (input.pendingRetry) {
    return {
      kind: "waiting-retry",
      label: "Waiting for retry",
      detail: "The next automatic attempt is scheduled; work resumes when it goes out.",
    };
  }
  if (input.halted) {
    return {
      kind: "offline",
      label: "Retries stopped",
      detail: "Automatic retries were stopped; nothing will go out by itself.",
    };
  }
  return { kind: "working", label: null, detail: null };
}

/** True when the surface must not render the ordinary "Working" state. */
export function zaicodePresenceOverridesWorking(presence: ZaicodePresence): boolean {
  return presence.kind !== "working" && presence.kind !== "idle";
}

/** Snapshot the router supervisor fields the projector reads. */
export function readSupervisorPresenceInput(host: {
  supervisor?: {
    status: string;
    route: "preferred" | "fallback";
    failure: string | null;
    attempts: number;
  } | null;
} | null): Pick<
  ZaicodePresenceInput,
  "supervisorRoute" | "supervisorStatus" | "supervisorFailure" | "supervisorAttempts"
> {
  return {
    supervisorRoute: host?.supervisor?.route ?? null,
    supervisorStatus: host?.supervisor?.status ?? null,
    supervisorFailure: host?.supervisor?.failure ?? null,
    supervisorAttempts: host?.supervisor?.attempts ?? null,
  };
}

/**
 * One session's presence from the live stores. The composer calls this with
 * its own session id; the sidebar calls it per row through the project
 * aggregate below. Same projector, same stores, every surface.
 */
export function useZaicodePresenceSession(
  sessionId: string | null | undefined,
  running: boolean,
): ZaicodePresence {
  const host = useZaicodeRouterSetup((state) => state.host);
  const pendingRetry = useZaicodeRetryLedger((state) =>
    sessionId ? state.pending[sessionId] !== undefined : false,
  );
  const halted = useZaicodeRetryLedger((state) => state.halted);
  const quotaWall = sessionId ? isZaicodeQuotaWall(sessionId) : false;
  return projectZaicodeConnectionState({
    running,
    ...readSupervisorPresenceInput(host),
    pendingRetry,
    quotaWall,
    halted,
  });
}

/**
 * Project-row presence. Router-level truth (reconnecting / fallback / offline)
 * is global, so the row observes it with the row's own running flag; per-session
 * waiting detail (retry scheduled, quota wall) lives where the session is
 * visible -- the composer mini and the retry ledger chip -- instead of being
 * smeared across an aggregate count. The halted flag is global and applies.
 */
export function useZaicodePresenceProject(running: boolean): ZaicodePresence {
  const host = useZaicodeRouterSetup((state) => state.host);
  const halted = useZaicodeRetryLedger((state) => state.halted);
  return projectZaicodeConnectionState({
    running,
    ...readSupervisorPresenceInput(host),
    pendingRetry: false,
    quotaWall: false,
    halted,
  });
}
