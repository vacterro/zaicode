import { useEffect } from "react";
import { create } from "zustand";
import type { IServiceAccessor } from "@zcode/services";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { ZaicodeHomeStats, ZaicodeJob, ZaicodeStatsActivity, ZaicodeStatsWorkerSession } from "@zcode/shared";
import { useZaicodeWorkers, type ZaicodeWorker } from "../zaicodeWorkers.js";
import { refreshZaicodeRouterHost } from "../zaicodeRouterSetup.js";
import { useZaicodeRouter } from "../zaicodeRouter.js";
import { readZaicodeHomePrefs } from "./zaicodeHomePrefs.js";

/**
 * SAIHOME's one feed (T-56). Every widget reads this store; only this module
 * asks the services, once per refresh for all widgets together, and only
 * while SAIHOME is on screen and the window is visible. The engines,
 * workers, sessions and SAIPEN pollers already push their own state.
 */

type Feed<T> = { value: T; readAt: number | null; error: string | null };

interface ZaicodeHomeFeedState {
  stats: Feed<ZaicodeHomeStats | null>;
  activity: Feed<ZaicodeStatsActivity[]>;
  /** Every workspace's queue rows (the queue service owns them). */
  jobs: Feed<ZaicodeJob[] | null>;
  refreshing: boolean;
  lastRefreshAt: number | null;
}

const empty = <T>(value: T): Feed<T> => ({ value, readAt: null, error: null });

export const useZaicodeHomeFeed = create<ZaicodeHomeFeedState>(() => ({
  stats: empty(null),
  activity: empty([]),
  jobs: empty(null),
  refreshing: false,
  lastRefreshAt: null,
}));

let accessor: IServiceAccessor | null = null;

/** The base (local) services; SAIHOME statistics never go to a remote host. */
export function publishZaicodeHomeServices(next: IServiceAccessor | null): void {
  accessor = next;
}

/** The same base (local host) services, for work that must not depend on a mounted sidebar row. */
export function readZaicodeLocalServices(): IServiceAccessor | null {
  return accessor;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

let inflight: Promise<void> | null = null;

/** Refreshes every SAIHOME source once (concurrent callers share the pass). */
export function refreshZaicodeHome(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    useZaicodeHomeFeed.setState({ refreshing: true });
    const prefs = readZaicodeHomePrefs();
    const statsService = accessor?.zaicodeStatsService;
    const jobService = accessor?.zaicodeJobService;
    const now = Date.now();
    const tasks: Promise<void>[] = [];
    if (statsService) {
      tasks.push(
        statsService
          .getHomeStats({ timeZone: localTimeZone(), weekStartsOn: prefs.weekStartsOn, streakMeasure: prefs.streakMeasure, gridDays: prefs.gridDays })
          .then((value) => useZaicodeHomeFeed.setState({ stats: { value, readAt: Date.now(), error: null } }))
          .catch((error: unknown) =>
            useZaicodeHomeFeed.setState((state) => ({ stats: { ...state.stats, error: message(error) } })),
          ),
        statsService
          .getRecentActivity(12)
          .then((value) => useZaicodeHomeFeed.setState({ activity: { value, readAt: Date.now(), error: null } }))
          .catch((error: unknown) =>
            useZaicodeHomeFeed.setState((state) => ({ activity: { ...state.activity, error: message(error) } })),
          ),
      );
    } else {
      useZaicodeHomeFeed.setState((state) => ({ stats: { ...state.stats, error: "statistics need the local desktop host" } }));
    }
    if (jobService) {
      tasks.push(
        jobService
          .list({})
          .then((result) => useZaicodeHomeFeed.setState({ jobs: { value: result.jobs, readAt: Date.now(), error: null } }))
          .catch((error: unknown) =>
            useZaicodeHomeFeed.setState((state) => ({ jobs: { ...state.jobs, error: message(error) } })),
          ),
      );
    }
    tasks.push(refreshZaicodeRouterHost().then(() => undefined).catch(() => undefined));
    tasks.push(useZaicodeRouter.getState().refresh().catch(() => undefined));
    await Promise.all(tasks);
    useZaicodeHomeFeed.setState({ refreshing: false, lastRefreshAt: now });
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Keeps the feed fresh while SAIHOME is mounted; pauses while the window is
 * hidden. The page brings its own base services: SAIHOME is the first view
 * after a start, so it must not wait for another component to publish them.
 */
export function useZaicodeHomeFeedRefresh(): void {
  const baseServices = useOptionalBaseWorkspaceServices();
  useEffect(() => {
    if (baseServices) publishZaicodeHomeServices(baseServices);
  }, [baseServices]);
  useEffect(() => {
    if (baseServices) void refreshZaicodeHome();
  }, [baseServices]);
  useEffect(() => {
    let timer: number | null = null;
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (document.visibilityState === "visible") void refreshZaicodeHome();
        schedule();
      }, readZaicodeHomePrefs().refreshSeconds * 1000);
    };
    schedule();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshZaicodeHome();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}

/** A worker's finished session, or null while it runs / when it is not a subscription worker. */
export function zaicodeWorkerSession(worker: ZaicodeWorker, endedAt: number | null): ZaicodeStatsWorkerSession | null {
  if (worker.kind !== "worker") return null;
  const end = worker.endedAt ?? endedAt;
  if (end === null) return null;
  return {
    id: worker.id,
    startedAt: worker.startedAt,
    endedAt: end,
    project: worker.projectPath,
    engine: worker.short,
    exitCode: worker.exitCode,
  };
}

/**
 * Records every subscription worker session when it ends or is closed
 * (mount once, app-wide). The service ignores an id it already has, so a
 * reload that reports the same session again changes nothing.
 */
export function useZaicodeWorkerStatsRecorder(): void {
  const workers = useZaicodeWorkers().workers;
  useEffect(() => {
    const seen = recorderMemory;
    const now = Date.now();
    const finished: ZaicodeStatsWorkerSession[] = [];
    const present = new Set<string>();
    for (const worker of workers) {
      present.add(worker.id);
      seen.running.set(worker.id, worker);
      if (worker.exitCode !== null && !seen.recorded.has(worker.id)) {
        const session = zaicodeWorkerSession(worker, now);
        if (session) finished.push(session);
        seen.recorded.add(worker.id);
      }
    }
    // Closed while still running: the session ends now ("stopped").
    for (const [id, worker] of seen.running) {
      if (present.has(id)) continue;
      seen.running.delete(id);
      if (seen.recorded.has(id)) continue;
      seen.recorded.add(id);
      const session = zaicodeWorkerSession(worker, now);
      if (session) finished.push(session);
    }
    const service = accessor?.zaicodeStatsService;
    if (finished.length > 0 && service) void service.recordWorkerSessions(finished).catch(() => undefined);
  }, [workers]);
}

const recorderMemory = { running: new Map<string, ZaicodeWorker>(), recorded: new Set<string>() };
