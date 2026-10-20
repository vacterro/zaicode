import { useEffect } from "react";
import { logger } from "../logger.js";
import { useZaicodeHomeProjects } from "./home/ZaicodeHomeFleet.js";
import { useZaicodeSessionBriefs, type ZaicodeSessionBrief } from "./zaicodeContinue.js";
import { zaicodeContinueHandleFor } from "./zaicodeContinueHost.js";
import {
  isZaicodeAutoRetryLocal,
  isZaicodeAutoRetryStoppedForSession,
} from "./zaicodeAutoRetry.js";
import {
  isZaicodeQuotaWall,
  useZaicodeRetryLedger,
  zaicodeRetryDelayMs,
  zaicodeRetryLimit,
  zaicodeEffectiveAutoRetryFor,
} from "./zaicodeRetryPolicy.js";
import { useZaicodeUiPrefs } from "./zaicodeUiPrefs.js";
import { useZaicodeLiveRuns } from "./zaicodeLiveRuns.js";
import {
  currentZaicodeRetrySafety,
  type ZaicodeQueueRetryEpisode,
} from "./zaicodeRetrySafety.js";
import {
  classifyQueuePause,
  recordZaicodeQueueResumeAttempt,
  zaicodeQueueResumeAttempts,
} from "./zaicodeQueueAutoResume.js";
import { isZaicodeCleanupInProgress, isSessionRetired } from "./zaicodeCleanupFence.js";

/**
 * T-361: Authoritative background queue recovery watch.
 *
 * Ensures automatic queue recovery continues even when the operator navigates away,
 * unmounts the session pane, collapses the sidebar, or runs multiple sessions concurrently.
 * When a session pane is mounted and active, isZaicodeAutoRetryLocal(sessionId) yields ownership
 * to the open pane; when unmounted or hidden, this background watch manages the recovery timer.
 */

const SWEEP_MS = 15_000;

interface QueueWatch {
  timer: number;
}

export interface BackgroundQueueRetryCandidate {
  sessionId: string;
  projectKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  queueHeadId: string;
  attempts: number;
  pauseReasonCode: string | null;
}

export function pickZaicodeBackgroundQueueRetrySessions(
  episodes: Record<string, ZaicodeQueueRetryEpisode>,
  briefs: readonly ZaicodeSessionBrief[],
  options: {
    isLocal: (sessionId: string) => boolean;
    isStopped: (sessionId: string) => boolean;
    isProjectDisabled: (projectKey: string) => boolean;
    maxAttempts: number;
    mayAutoSend: (projectKey: string, sessionId: string) => boolean;
    isQuotaWall: (sessionId: string) => boolean;
  },
): BackgroundQueueRetryCandidate[] {
  const briefsById = new Map(briefs.map((b) => [b.sessionId, b]));
  const candidates: BackgroundQueueRetryCandidate[] = [];

  for (const [sessionId, episode] of Object.entries(episodes)) {
    if (isSessionRetired(sessionId)) continue;
    if (options.isLocal(sessionId)) continue;
    if (options.isStopped(sessionId)) continue;
    if (options.isQuotaWall(sessionId)) continue;

    const brief = briefsById.get(sessionId);
    const projectKey = episode.projectKey ?? brief?.projectKey ?? "";
    const workspacePath = brief?.workspacePath ?? "";
    if (!projectKey || options.isProjectDisabled(projectKey)) continue;
    if (!options.mayAutoSend(projectKey, sessionId)) continue;

    const classification = classifyQueuePause({
      pauseReason: "error",
      pauseOrigin: "system",
      pauseReasonCode: episode.lastReasonCode,
    });
    if (classification !== "transient") continue;

    const attempts = episode.attempts ?? 0;
    if (attempts >= options.maxAttempts) continue;

    candidates.push({
      sessionId,
      projectKey,
      workspacePath,
      ...(episode.workspaceIdentity ? { workspaceIdentity: episode.workspaceIdentity } : {}),
      queueHeadId: episode.queueHeadId,
      attempts,
      pauseReasonCode: episode.lastReasonCode ?? null,
    });
  }

  return candidates;
}

export function useZaicodeQueueRetryWatch(): void {
  useEffect(() => {
    const watches = new Map<string, QueueWatch>();
    const inFlight = new Set<string>();

    const clearWatch = (sessionId: string) => {
      const watch = watches.get(sessionId);
      if (watch) {
        window.clearTimeout(watch.timer);
        watches.delete(sessionId);
      }
      useZaicodeRetryLedger.getState().clear(sessionId);
    };

    const fire = (candidate: BackgroundQueueRetryCandidate) => {
      watches.delete(candidate.sessionId);
      useZaicodeRetryLedger.getState().clear(candidate.sessionId);

      if (
        isZaicodeCleanupInProgress() ||
        isSessionRetired(candidate.sessionId) ||
        isZaicodeAutoRetryLocal(candidate.sessionId) ||
        isZaicodeAutoRetryStoppedForSession(candidate.sessionId) ||
        isZaicodeQuotaWall(candidate.sessionId) ||
        !zaicodeEffectiveAutoRetryFor(candidate.projectKey, candidate.sessionId).enabled
      ) {
        return;
      }

      const prefs = useZaicodeUiPrefs.getState();
      const currentAttempts = zaicodeQueueResumeAttempts(candidate.sessionId);
      if (currentAttempts >= zaicodeRetryLimit(prefs.autoRetryMaxAttempts)) return;

      const handle = zaicodeContinueHandleFor({
        key: candidate.projectKey,
        path: candidate.workspacePath,
        ...(candidate.workspaceIdentity ? { identity: candidate.workspaceIdentity } : {}),
      });
      if (!handle || !handle.resumeQueue) {
        logger.warn("[zaicode] background queue auto-resume: project handle not available", {
          sessionId: candidate.sessionId,
        });
        return;
      }

      inFlight.add(candidate.sessionId);
      const nextAttempts = recordZaicodeQueueResumeAttempt(candidate.sessionId, {
        projectKey: candidate.projectKey,
        workspaceIdentity: candidate.workspaceIdentity,
        queueHeadId: candidate.queueHeadId,
        attempts: currentAttempts + 1,
        pauseReasonCode: candidate.pauseReasonCode,
      });

      logger.info("[zaicode] background queue auto-resume dispatched", {
        sessionId: candidate.sessionId,
        queueHeadId: candidate.queueHeadId,
        attempt: nextAttempts,
      });

      void handle
        .resumeQueue(candidate.sessionId)
        .catch((error: unknown) => {
          logger.warn("[zaicode] background queue auto-resume failed to send", {
            sessionId: candidate.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          inFlight.delete(candidate.sessionId);
        });
    };

    const sweep = () => {
      if (isZaicodeCleanupInProgress()) return;
      const prefs = useZaicodeUiPrefs.getState();
      const briefs = useZaicodeSessionBriefs.getState().sessions;
      const safety = currentZaicodeRetrySafety();
      const episodes = safety.queueEpisodes ?? {};

      const candidates = pickZaicodeBackgroundQueueRetrySessions(episodes, briefs, {
        isLocal: isZaicodeAutoRetryLocal,
        isStopped: isZaicodeAutoRetryStoppedForSession,
        isProjectDisabled: (projectKey) => Boolean(useZaicodeHomeProjects.getState().rows[projectKey]?.disabled),
        maxAttempts: zaicodeRetryLimit(prefs.autoRetryMaxAttempts),
        mayAutoSend: (projectKey, sessionId) =>
          !useZaicodeLiveRuns.getState().runs[sessionId] &&
          zaicodeEffectiveAutoRetryFor(projectKey, sessionId).enabled,
        isQuotaWall: isZaicodeQuotaWall,
      });

      const candidateIds = new Set(candidates.map((c) => c.sessionId));
      for (const sessionId of [...watches.keys()]) {
        if (!candidateIds.has(sessionId)) clearWatch(sessionId);
      }

      for (const candidate of candidates) {
        if (watches.has(candidate.sessionId) || inFlight.has(candidate.sessionId)) continue;

        const delay = zaicodeRetryDelayMs(prefs.autoRetryIntervalSec);
        const timer = window.setTimeout(() => fire(candidate), delay);
        watches.set(candidate.sessionId, { timer });
        useZaicodeRetryLedger.getState().set({
          sessionId: candidate.sessionId,
          title: "queued message",
          nextAt: Date.now() + delay,
          attempt: candidate.attempts + 1,
          source: "background",
        });
      }
    };

    const unsubscribeBriefs = useZaicodeSessionBriefs.subscribe(sweep);
    const unsubscribePrefs = useZaicodeUiPrefs.subscribe(sweep);
    const unsubscribeLive = useZaicodeLiveRuns.subscribe(sweep);
    const unsubscribeHalt = useZaicodeRetryLedger.subscribe((state, previous) => {
      if (state.halted !== previous.halted) sweep();
    });
    const interval = window.setInterval(sweep, SWEEP_MS);
    sweep();

    return () => {
      unsubscribeBriefs();
      unsubscribePrefs();
      unsubscribeLive();
      unsubscribeHalt();
      window.clearInterval(interval);
      for (const sessionId of [...watches.keys()]) clearWatch(sessionId);
    };
  }, []);
}
