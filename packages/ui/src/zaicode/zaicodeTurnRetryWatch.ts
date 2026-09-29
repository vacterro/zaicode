import { useEffect } from "react";
import { toast } from "../components/ui/toast.js";
import { logger } from "../logger.js";
import { useZaicodeHomeProjects } from "./home/ZaicodeHomeFleet.js";
import {
  ZAICODE_CONTINUE_PLAIN_TEXT,
  ZAICODE_CONTINUE_SAIPEN_TEXT,
  describeZaicodeContinueCommand,
  useZaicodeSessionBriefs,
  type ZaicodeSessionBrief,
} from "./zaicodeContinue.js";
import { zaicodeContinueHandleFor } from "./zaicodeContinueHost.js";
import {
  bumpZaicodeAutoRetryAttempt,
  isZaicodeAutoRetryLocal,
  resetZaicodeAutoRetryAttempt,
  zaicodeAutoRetryAttempts,
} from "./zaicodeAutoRetry.js";
import {
  isZaicodeQuotaWall,
  useZaicodeRetryLedger,
  zaicodeAutoSendAllowed,
  zaicodeRetryDelayMs,
  zaicodeRetryLimit,
} from "./zaicodeRetryPolicy.js";
import { useZaicodeUiPrefs } from "./zaicodeUiPrefs.js";

/**
 * Background auto-retry (SRC-051; SRC-082 gave it a leash): it only works while the
 * sidebar's Auto is ON (or the session's own auto-continue is On), never on a session a
 * pane saw hit a quota wall, waits longer after every attempt, gives up after at most
 * ZAICODE_AUTO_RETRY_HARD_CAP attempts, and every scheduled knock is in the ledger the
 * sidebar shows, with one button that stops them all.
 *
 * Original (SRC-051): a turn that fails in a project nobody has
 * open retries on its own — the operator does not have to walk into the
 * project to arm the countdown. The open pane keeps its richer countdown
 * (useZaicodeAutoRetry, with "Retry now" / "Stop"); this host covers every
 * session the sidebar can see and is not the pane's job. Both share one
 * attempt budget per session, so they never double-fire, and both reset it
 * on the first clean finish.
 *
 * What it sends is the same "continue" decision the crash resume uses: the
 * session's unfinished goal again, else SAIPEN's `cc` (or "continue").
 */

/** A failed brief whose pane is closed stays put between brief pushes; sweep anyway. */
const SWEEP_MS = 15_000;

interface Watch {
  timer: number;
}

/** Pure: failed sessions the background host may pick up. */
export function pickZaicodeBackgroundRetrySessions(
  briefs: readonly ZaicodeSessionBrief[],
  options: {
    isLocal: (sessionId: string) => boolean;
    isProjectDisabled: (projectKey: string) => boolean;
    attemptsOf: (sessionId: string) => number;
    maxAttempts: number;
    /** The switches (sidebar Auto, the session's own mode, the retry switch) allow this session. */
    mayAutoSend?: (sessionId: string) => boolean;
    /** A pane saw this session hit a quota wall: asking again does not lift it. */
    isQuotaWall?: (sessionId: string) => boolean;
  },
): ZaicodeSessionBrief[] {
  return briefs.filter(
    (brief) =>
      brief.failed &&
      !brief.running &&
      !brief.waiting &&
      !options.isLocal(brief.sessionId) &&
      !options.isProjectDisabled(brief.projectKey) &&
      (options.mayAutoSend?.(brief.sessionId) ?? true) &&
      !(options.isQuotaWall?.(brief.sessionId) ?? false) &&
      options.attemptsOf(brief.sessionId) < options.maxAttempts,
  );
}

/** Mount once (ZaicodeAppRuntime), like the crash resume. */
export function useZaicodeTurnRetryWatch(): void {
  useEffect(() => {
    const watches = new Map<string, Watch>();
    const inFlight = new Set<string>();

    const clearWatch = (sessionId: string) => {
      const watch = watches.get(sessionId);
      if (watch) {
        window.clearTimeout(watch.timer);
        watches.delete(sessionId);
      }
      useZaicodeRetryLedger.getState().clear(sessionId);
    };

    const fire = (brief: ZaicodeSessionBrief) => {
      watches.delete(brief.sessionId);
      useZaicodeRetryLedger.getState().clear(brief.sessionId);
      const prefs = useZaicodeUiPrefs.getState();
      // The gate is asked again at the moment of sending, not only when the timer was set.
      if (!zaicodeAutoSendAllowed(brief.sessionId, prefs.autoRetry) || isZaicodeQuotaWall(brief.sessionId)) return;
      const current = useZaicodeSessionBriefs.getState().sessions.find((item) => item.sessionId === brief.sessionId);
      if (!current?.failed || current.running || current.waiting || isZaicodeAutoRetryLocal(current.sessionId)) return;
      if (inFlight.has(current.sessionId)) return;
      const project = useZaicodeHomeProjects.getState().rows[current.projectKey];
      if (project?.disabled || zaicodeAutoRetryAttempts(current.sessionId) >= zaicodeRetryLimit(prefs.autoRetryMaxAttempts)) return;
      const hasSaipen = project?.hasSaipen ?? false;
      const unfinishedGoal =
        current.goalObjective && (current.goalStatus === "active" || current.goalStatus === "paused");
      const command = unfinishedGoal && !hasSaipen
        ? { kind: "goal" as const, objective: current.goalObjective! }
        : {
            kind: "text" as const,
            text: hasSaipen ? ZAICODE_CONTINUE_SAIPEN_TEXT : ZAICODE_CONTINUE_PLAIN_TEXT,
          };
      const line = `${current.title} → ${describeZaicodeContinueCommand(command)}`;
      const handle = zaicodeContinueHandleFor({
        key: current.projectKey,
        path: current.workspacePath,
        ...(current.workspaceIdentity ? { identity: current.workspaceIdentity } : {}),
      });
      if (!handle) {
        logger.warn("[zaicode] background auto-retry: project not connected", { sessionId: current.sessionId });
        return;
      }
      bumpZaicodeAutoRetryAttempt(current.sessionId);
      const attempt = zaicodeAutoRetryAttempts(current.sessionId);
      inFlight.add(current.sessionId);
      logger.info("[zaicode] background auto-retry", { sessionId: current.sessionId, attempt });
      toast(`Auto-retry (attempt ${attempt}): ${line}`, { durationMs: 6000 });
      void handle
        .send(current.sessionId, command)
        .catch((error: unknown) => {
          logger.warn("[zaicode] background auto-retry failed to submit", {
            sessionId: current.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => inFlight.delete(current.sessionId));
    };

    const sweep = () => {
      const prefs = useZaicodeUiPrefs.getState();
      const briefs = useZaicodeSessionBriefs.getState().sessions;
      for (const brief of briefs) {
        if (!brief.failed && !brief.running && !brief.waiting && !brief.interrupted && !brief.crashCut) {
          resetZaicodeAutoRetryAttempt(brief.sessionId);
        }
      }
      const failedNow = pickZaicodeBackgroundRetrySessions(briefs, {
        isLocal: isZaicodeAutoRetryLocal,
        isProjectDisabled: (projectKey) => Boolean(useZaicodeHomeProjects.getState().rows[projectKey]?.disabled),
        attemptsOf: zaicodeAutoRetryAttempts,
        maxAttempts: zaicodeRetryLimit(prefs.autoRetryMaxAttempts),
        mayAutoSend: (sessionId) => zaicodeAutoSendAllowed(sessionId, prefs.autoRetry),
        isQuotaWall: isZaicodeQuotaWall,
      });
      const failedIds = new Set(failedNow.map((brief) => brief.sessionId));
      // Retired watches: the session recovered, vanished, or its pane took over.
      for (const sessionId of [...watches.keys()]) {
        if (!failedIds.has(sessionId)) clearWatch(sessionId);
      }
      for (const brief of failedNow) {
        if (watches.has(brief.sessionId) || inFlight.has(brief.sessionId)) continue;
        const attempts = zaicodeAutoRetryAttempts(brief.sessionId);
        const delay = zaicodeRetryDelayMs(prefs.autoRetryIntervalSec, attempts);
        const timer = window.setTimeout(() => fire(brief), delay);
        watches.set(brief.sessionId, { timer });
        useZaicodeRetryLedger.getState().set({
          sessionId: brief.sessionId,
          title: brief.title,
          nextAt: Date.now() + delay,
          attempt: attempts + 1,
          source: "background",
        });
      }
    };

    const unsubscribe = useZaicodeSessionBriefs.subscribe(sweep);
    const interval = window.setInterval(sweep, SWEEP_MS);
    sweep();
    return () => {
      unsubscribe();
      window.clearInterval(interval);
      for (const sessionId of [...watches.keys()]) clearWatch(sessionId);
    };
  }, []);
}
