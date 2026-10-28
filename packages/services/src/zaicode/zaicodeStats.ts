import { ServiceChannels } from "@zcode/shared";
import type {
  ZaicodeHomeStats,
  ZaicodeHomeStatsRequest,
  ZaicodeStatsActivity,
  ZaicodeStatsWorkerSession,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * SAIHOME local statistics (T-56). Local only: nothing here is sent anywhere.
 * The service reads its sources (agent usage store, ZAICODE queue, recorded
 * worker sessions) into zaicode_stats_events and answers with sums in the
 * caller's time zone.
 */
export interface IZaicodeStatsService {
  /** Reads new events from the sources (throttled) and returns the home statistics. */
  getHomeStats(request: ZaicodeHomeStatsRequest): Promise<ZaicodeHomeStats>;
  /** Newest queue runs and worker sessions. */
  getRecentActivity(limit?: number): Promise<ZaicodeStatsActivity[]>;
  /** CLI worker sessions that ended (the renderer owns the worker terminals). */
  recordWorkerSessions(sessions: ZaicodeStatsWorkerSession[]): Promise<number>;
  /** Deletes the local history; sources are not read again before this moment. */
  clear(): Promise<{ clearedAt: number }>;
  /** Every stored event as JSON (the operator's own export). */
  exportEvents(): Promise<string>;
}

export const IZaicodeStatsService = createServiceDescriptor<IZaicodeStatsService>(ServiceChannels.ZaicodeStats);
