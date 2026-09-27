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
import { useZaicodeUiPrefs } from "./zaicodeUiPrefs.js";

/**
 * Background auto-retry (SRC-051): a turn that fails in a project nobody has
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
  },
): ZaicodeSessionBrief[] {
  return briefs.filter(
    (brief) =>
      brief.failed &&
      !brief.running &&
      !brief.waiting &&
      !options.isLocal(brief.sessionId) &&
      !options.isProjectDisabled(brief.projectKey) &&
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
    };

    const fire = (brief: ZaicodeSessionBrief) => {
      watches.delete(brief.sessionId);
      const prefs = useZaicodeUiPrefs.getState();
      if (!prefs.autoRetry) return;
      const current = useZaicodeSessionBriefs.getState().sessions.find((item) => item.sessionId === brief.sessionId);
      if (!current?.failed || current.running || current.waiting || isZaicodeAutoRetryLocal(current.sessionId)) return;
      if (inFlight.has(current.sessionId)) return;
      const project = useZaicodeHomeProjects.getState().rows[current.projectKey];
      if (project?.disabled || zaicodeAutoRetryAttempts(current.sessionId) >= prefs.autoRetryMaxAttempts) return;
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
        maxAttempts: prefs.autoRetryMaxAttempts,
      });
      const failedIds = new Set(failedNow.map((brief) => brief.sessionId));
      // Retired watches: the session recovered, vanished, or its pane took over.
      for (const sessionId of [...watches.keys()]) {
        if (!failedIds.has(sessionId) || !prefs.autoRetry) clearWatch(sessionId);
      }
      if (!prefs.autoRetry) return;
      const delay = Math.max(1, prefs.autoRetryIntervalSec) * 1000;
      for (const brief of failedNow) {
        if (watches.has(brief.sessionId) || inFlight.has(brief.sessionId)) continue;
        const timer = window.setTimeout(() => fire(brief), delay);
        watches.set(brief.sessionId, { timer });
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
