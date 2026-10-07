import { useEffect } from "react";
import { create } from "zustand";
import type { IServiceAccessor } from "@zcode/services";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import type {
  ZaicodeHomeStats,
  ZaicodeHomeQueueOverview,
  ZaicodeStatsActivity,
} from "@zcode/shared";
import { useZaicodeWorkers } from "../zaicodeWorkers.js";
import { refreshZaicodeRouterHost } from "../zaicodeRouterSetup.js";
import { useZaicodeRouter } from "../zaicodeRouter.js";
import { readZaicodeHomePrefs } from "./zaicodeHomePrefs.js";
import { zaicodeStartOfToday } from "./zaicodeHomeModel.js";
import { ZaicodeWorkerStatsRecorder } from "./zaicodeWorkerStatsRecorder.js";
export { zaicodeWorkerSession } from "./zaicodeWorkerStatsRecorder.js";

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
  jobs: Feed<ZaicodeHomeQueueOverview | null>;
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
  // T-253 — 服务恢复时，已消失的 worker 不会再产生数组更新，必须从现有发布入口重试 pending。
  void flushWorkerStatistics();
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
    const workerFlush = flushWorkerStatistics();
    const prefs = readZaicodeHomePrefs();
    const statsService = accessor?.zaicodeStatsService;
    const jobService = accessor?.zaicodeJobService;
    const now = Date.now();
    const tasks: Promise<void>[] = [workerFlush];
    if (statsService) {
      tasks.push(
        workerFlush
          .then(() =>
            statsService.getHomeStats({
              timeZone: localTimeZone(),
              weekStartsOn: prefs.weekStartsOn,
              streakMeasure: prefs.streakMeasure,
              gridDays: prefs.gridDays,
            }),
          )
          .then((value) =>
            useZaicodeHomeFeed.setState({ stats: { value, readAt: Date.now(), error: null } }),
          )
          .catch((error: unknown) =>
            useZaicodeHomeFeed.setState((state) => ({
              stats: { ...state.stats, error: message(error) },
            })),
          ),
        workerFlush
          .then(() => statsService.getRecentActivity(12))
          .then((value) =>
            useZaicodeHomeFeed.setState({ activity: { value, readAt: Date.now(), error: null } }),
          )
          .catch((error: unknown) =>
            useZaicodeHomeFeed.setState((state) => ({
              activity: { ...state.activity, error: message(error) },
            })),
          ),
      );
    } else {
      useZaicodeHomeFeed.setState((state) => ({
        stats: { ...state.stats, error: "statistics need the local desktop host" },
      }));
    }
    if (jobService) {
      tasks.push(
        jobService
          .getHomeOverview(zaicodeStartOfToday(now))
          .then((result) =>
            useZaicodeHomeFeed.setState({
              jobs: { value: result, readAt: Date.now(), error: null },
            }),
          )
          .catch((error: unknown) =>
            useZaicodeHomeFeed.setState((state) => ({
              jobs: { ...state.jobs, error: message(error) },
            })),
          ),
      );
    }
    tasks.push(
      refreshZaicodeRouterHost()
        .then(() => undefined)
        .catch(() => undefined),
    );
    tasks.push(
      useZaicodeRouter
        .getState()
        .refresh()
        .catch(() => undefined),
    );
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
export function useZaicodeHomeFeedRefresh(dayStart: number): void {
  const baseServices = useOptionalBaseWorkspaceServices();
  useEffect(() => {
    if (baseServices) publishZaicodeHomeServices(baseServices);
  }, [baseServices]);
  useEffect(() => {
    if (baseServices) void refreshZaicodeHome();
    // T-254 — 午夜变化复用现有刷新；失败仍由原定时器重试，不能形成立即重试循环。
  }, [baseServices, dayStart]);
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

/**
 * Records every subscription worker session when it ends or is closed
 * (mount once, app-wide). The service ignores an id it already has, so a
 * reload that reports the same session again changes nothing.
 */
export function useZaicodeWorkerStatsRecorder(): void {
  const workers = useZaicodeWorkers().workers;
  const baseServices = useOptionalBaseWorkspaceServices();
  useEffect(() => {
    workerRecorder.observe(workers, Date.now());
    publishZaicodeHomeServices(baseServices);
  }, [workers, baseServices]);
}

const workerRecorder = new ZaicodeWorkerStatsRecorder();
let lastRecordingError: string | null = null;

async function flushWorkerStatistics(): Promise<void> {
  try {
    const service = accessor?.zaicodeStatsService;
    await workerRecorder.flush(
      service ? (sessions) => service.recordWorkerSessions(sessions) : undefined,
    );
    if (service) lastRecordingError = null;
  } catch (error) {
    const detail = message(error);
    if (detail !== lastRecordingError)
      logger.warn("ZAICODE worker statistics delivery pending:", detail);
    lastRecordingError = detail;
  }
}
