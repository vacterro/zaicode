import { create } from "zustand";
import type { IZaicodeAuditService, IZaicodeJobService } from "@zcode/services";
import type {
  ZaicodeAuditBatch,
  ZaicodeAuditBatchAdmissionResult,
  ZaicodeAuditBatchModelPolicy,
  ZaicodeAuditCampaign,
  ZaicodeAuditWorker,
  ZaicodeAuditorView,
  ZaicodeAutoPolicy,
  ZaicodeAutoProjects,
} from "@zcode/shared";
import { ZAICODE_JOB_GLOBAL_CONCURRENCY_DEFAULT, zaicodeAuditCampaignIsActive } from "@zcode/shared";
import { logger } from "@/logger.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

/**
 * ZAICODE A3 audits, renderer side (T-66, SRC-049). The truth lives in the
 * durable queue behind IZaicodeAuditService; this store only mirrors it for the
 * panel and the workspace-bar badge, so a wave is a real queue job (AUDAPACK's
 * mechanism) and never a prompt pasted into chat.
 */

export interface ZaicodeAuditProject {
  workspaceKey: string;
  workspacePath: string;
  projectName: string;
}

export type ZaicodeAuditSyncState =
  | "LOADING"
  | "CURRENT"
  | "STALE"
  | "PARTIAL"
  | "HOST_UNAVAILABLE"
  | "RECONCILING";

interface ZaicodeAuditStoreState {
  campaigns: ZaicodeAuditCampaign[];
  batches: ZaicodeAuditBatch[];
  activeWorkers: ZaicodeAuditWorker[];
  globalConcurrency: number;
  /** SRC-060: the agent that runs audit waves (null until the first audit makes one). */
  auditor: ZaicodeAuditorView | null;
  smartMode: boolean;
  autoProjects: ZaicodeAutoProjects;
  policySaving: boolean;
  autoAudits: boolean;
  maxCycles: number;
  runId: string | null;
  /** SRC-151:R008: the global "generate the next wave by itself" switch. */
  autoWaves: boolean;
  loading: boolean;
  syncState: ZaicodeAuditSyncState;
  generation: number;
  error: string | null;
  refresh: (audits: IZaicodeAuditService, jobs?: IZaicodeJobService) => Promise<void>;
  createBatch: (
    audits: IZaicodeAuditService,
    input: {
      requestId?: string;
      projects: ZaicodeAuditProject[];
      planOnly?: boolean;
      autoWaves?: boolean;
      workerCapacity?: number;
      modelPolicy?: ZaicodeAuditBatchModelPolicy;
    },
  ) => Promise<ZaicodeAuditBatchAdmissionResult | null>;
  pauseBatch: (audits: IZaicodeAuditService, batchId: string) => Promise<ZaicodeAuditBatch | null>;
  resumeBatch: (audits: IZaicodeAuditService, batchId: string) => Promise<ZaicodeAuditBatch | null>;
  stopBatch: (audits: IZaicodeAuditService, batchId: string) => Promise<ZaicodeAuditBatch | null>;
  retryBatch: (
    audits: IZaicodeAuditService,
    batchId: string,
    mode?: "all_failed" | "blocked_only",
  ) => Promise<ZaicodeAuditBatch | null>;
  setGlobalConcurrency: (jobs: IZaicodeJobService, limit: number) => Promise<void>;
  generate: (audits: IZaicodeAuditService, project: ZaicodeAuditProject) => Promise<void>;
  work: (audits: IZaicodeAuditService, campaignId: string) => Promise<void>;
  start: (audits: IZaicodeAuditService, project: ZaicodeAuditProject) => Promise<void>;
  retry: (audits: IZaicodeAuditService, campaignId: string) => Promise<void>;
  cancel: (audits: IZaicodeAuditService, campaignId: string) => Promise<void>;
  archive: (audits: IZaicodeAuditService, campaignId: string) => Promise<void>;
  /** Hand the exact combined artifact to the next implementation task. */
  fixWithSaipen: (audits: IZaicodeAuditService, campaignId: string) => Promise<void>;
  setSmartMode: (audits: IZaicodeAuditService, enabled: boolean) => Promise<void>;
  setProjectAutoSettings: (audits: IZaicodeAuditService, workspaceKey: string, patch: Partial<ZaicodeAutoPolicy> | null) => Promise<void>;
  setAutoAudits: (audits: IZaicodeAuditService, enabled: boolean) => Promise<void>;
  /** SRC-151:R008: turn automatic wave generation on or off for every audit. */
  setAutoWaves: (audits: IZaicodeAuditService, enabled: boolean) => Promise<void>;
  setMaxCycles: (audits: IZaicodeAuditService, maxCycles: number) => Promise<void>;
  campaignsFor: (workspacePath: string) => ZaicodeAuditCampaign[];
  activeCountFor: (workspacePath: string) => number;
}

export interface ZaicodeAuditProgress {
  complete: number;
  total: number;
  campaigns: number;
}

/**
 * SRC-116 TRACK A: the mirror grew for the whole session -- every campaign the service ever
 * returned, each carrying its full wave list -- and every sidebar row rescanned the whole array
 * on every render. Over a 9-hour autonomous run that is thousands of retained objects and an
 * O(rows x campaigns x waves) render cost, which is what a frame-rate collapse looks like.
 *
 * Bounded here, not deleted: the durable queue behind IZaicodeAuditService still holds every
 * campaign. Active campaigns are never dropped -- a running wave must keep its badge.
 */
export const ZAICODE_AUDIT_HISTORY_LIMIT = 30;

export function boundZaicodeAuditCampaigns(
  campaigns: readonly ZaicodeAuditCampaign[],
  limit: number = ZAICODE_AUDIT_HISTORY_LIMIT,
): ZaicodeAuditCampaign[] {
  const active: ZaicodeAuditCampaign[] = [];
  const finished: ZaicodeAuditCampaign[] = [];
  for (const campaign of campaigns) {
    (zaicodeAuditCampaignIsActive(campaign) ? active : finished).push(campaign);
  }
  if (finished.length <= limit) return [...active, ...finished];
  finished.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return [...active, ...finished.slice(0, limit)];
}

/** Visible project-row progress for every non-terminal A3 campaign. */
export function zaicodeAuditProgressFor(
  campaigns: readonly ZaicodeAuditCampaign[],
  workspacePath: string,
): ZaicodeAuditProgress | null {
  const active = campaigns.filter(
    (campaign) =>
      campaign.workspacePath === workspacePath && zaicodeAuditCampaignIsActive(campaign),
  );
  if (active.length === 0) return null;
  return {
    complete: active.reduce(
      (count, campaign) =>
        count + campaign.waves.filter((wave) => wave.status === "complete").length,
      0,
    ),
    total: active.reduce((count, campaign) => count + campaign.waves.length, 0),
    campaigns: active.length,
  };
}

/**
 * SRC-060: what happened between two readings of the campaigns, as sound
 * cues: a wave finished, a campaign finished or stopped. The first reading
 * (no previous list) is silent.
 */
export function zaicodeAuditTransitions(
  previous: readonly ZaicodeAuditCampaign[] | null,
  next: readonly ZaicodeAuditCampaign[],
): ("audit.waveDone" | "audit.complete" | "audit.blocked")[] {
  if (!previous) return [];
  const before = new Map(previous.map((campaign) => [campaign.campaignId, campaign]));
  const cues = new Set<"audit.waveDone" | "audit.complete" | "audit.blocked">();
  for (const campaign of next) {
    const old = before.get(campaign.campaignId);
    if (!old) continue;
    if (campaign.status === "complete" && old.status !== "complete") cues.add("audit.complete");
    else if (campaign.status === "blocked" && old.status !== "blocked") cues.add("audit.blocked");
    else {
      const doneBefore = old.waves.filter((wave) => wave.status === "complete").length;
      const doneNow = campaign.waves.filter((wave) => wave.status === "complete").length;
      if (doneNow > doneBefore) cues.add("audit.waveDone");
    }
  }
  return [...cues];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useZaicodeAuditStore = create<ZaicodeAuditStoreState>((set, get) => {
  const after = async <T>(
    audits: IZaicodeAuditService,
    action: () => Promise<T>,
  ): Promise<T> => {
    try {
      const result = await action();
      await get().refresh(audits);
      return result;
    } catch (error) {
      logger.error("[zaicode-audits] action failed", { error: describeError(error) });
      set({ error: describeError(error) });
      throw error;
    }
  };

  let lastSeen: ZaicodeAuditCampaign[] | null = null;
  let currentGeneration = 0;
  let inFlightRefresh: Promise<void> | null = null;
  let lastTrustedSnapshot: {
    campaigns: ZaicodeAuditCampaign[];
    batches: ZaicodeAuditBatch[];
    activeWorkers: ZaicodeAuditWorker[];
    globalConcurrency: number;
    auditor: ZaicodeAuditorView | null;
    smartMode: boolean;
    autoProjects: ZaicodeAutoProjects;
    autoAudits: boolean;
    maxCycles: number;
    runId: string | null;
    autoWaves: boolean;
  } | null = null;

  const policyAfter = async <T>(audits: IZaicodeAuditService, action: () => Promise<T>): Promise<T | undefined> => {
    if (get().policySaving) return undefined;
    set({ policySaving: true });
    try { return await after(audits, action); } finally { set({ policySaving: false }); }
  };
  return {
    campaigns: [],
    batches: [],
    activeWorkers: [],
    globalConcurrency: ZAICODE_JOB_GLOBAL_CONCURRENCY_DEFAULT,
    auditor: null,
    smartMode: false,
    autoProjects: {},
    policySaving: false,
    autoAudits: true,
    maxCycles: 10,
    runId: null,
    autoWaves: true,
    loading: false,
    syncState: "LOADING",
    generation: 0,
    error: null,

    refresh: async (audits, jobs) => {
      if (inFlightRefresh) {
        return inFlightRefresh;
      }
      const thisGen = ++currentGeneration;
      const executeRefresh = async () => {
        set({ loading: true });
        try {
          const [stateRes, batchesRes, workersRes, jobsRes] = await Promise.allSettled([
            audits.getState(),
            audits.listBatches(),
            audits.getActiveWorkers(),
            jobs
              ? jobs.getGlobalConcurrency()
              : Promise.resolve(get().globalConcurrency),
          ]);

          if (thisGen < currentGeneration) {
            return;
          }

          if (stateRes.status === "rejected") {
            const err = describeError(stateRes.reason);
            logger.error("[zaicode-audits] host unavailable", { error: err });
            set({
              loading: false,
              syncState: lastTrustedSnapshot ? "STALE" : "HOST_UNAVAILABLE",
              error: `Host unavailable: ${err}`,
            });
            return;
          }

          const state = stateRes.value;
          const batchesFailed = batchesRes.status === "rejected";
          const workersFailed = workersRes.status === "rejected";

          if (batchesFailed || workersFailed) {
            const failedReason = batchesFailed
              ? (batchesRes as PromiseRejectedResult).reason
              : (workersRes as PromiseRejectedResult).reason;
            const err = describeError(failedReason);
            logger.warn("[zaicode-audits] partial refresh failure", { error: err });
            const batches = !batchesFailed
              ? batchesRes.value
              : (lastTrustedSnapshot?.batches ?? get().batches);
            const activeWorkers = !workersFailed
              ? workersRes.value
              : (lastTrustedSnapshot?.activeWorkers ?? get().activeWorkers);
            const globalConcurrency =
              jobsRes.status === "fulfilled" ? jobsRes.value : get().globalConcurrency;

            lastSeen = boundZaicodeAuditCampaigns(state.campaigns);
            set({
              campaigns: lastSeen,
              batches,
              activeWorkers,
              globalConcurrency,
              auditor: state.auditor ?? null,
              smartMode: state.smartMode,
              autoProjects: state.autoProjects ?? {},
              autoAudits: state.autoAudits !== false,
              maxCycles: state.maxCycles,
              runId: state.runId,
              autoWaves: state.autoWaves !== false,
              loading: false,
              syncState: "PARTIAL",
              error: `Partial update: ${err}`,
              generation: thisGen,
            });
            return;
          }

          for (const cue of zaicodeAuditTransitions(lastSeen, state.campaigns)) playZaicodeSound(cue);
          lastSeen = boundZaicodeAuditCampaigns(state.campaigns);
          const batches = batchesRes.value;
          const activeWorkers = workersRes.value;
          const globalConcurrency =
            jobsRes.status === "fulfilled" ? jobsRes.value : get().globalConcurrency;

          lastTrustedSnapshot = {
            campaigns: lastSeen,
            batches,
            activeWorkers,
            globalConcurrency,
            auditor: state.auditor ?? null,
            smartMode: state.smartMode,
            autoProjects: state.autoProjects ?? {},
            autoAudits: state.autoAudits !== false,
            maxCycles: state.maxCycles,
            runId: state.runId,
            autoWaves: state.autoWaves !== false,
          };

          set({
            ...lastTrustedSnapshot,
            loading: false,
            syncState: "CURRENT",
            error: null,
            generation: thisGen,
          });
        } catch (error) {
          const err = describeError(error);
          logger.error("[zaicode-audits] refresh failed", { error: err });
          set({
            loading: false,
            syncState: lastTrustedSnapshot ? "STALE" : "HOST_UNAVAILABLE",
            error: err,
          });
        }
      };

      inFlightRefresh = executeRefresh().finally(() => {
        inFlightRefresh = null;
      });
      return inFlightRefresh;
    },

    createBatch: async (audits, input) => {
      try {
        const result = await audits.createBatch(input);
        await get().refresh(audits);
        return result;
      } catch (error) {
        logger.error("[zaicode-audits] createBatch failed", { error: describeError(error) });
        set({ error: describeError(error) });
        return null;
      }
    },
    pauseBatch: (audits, batchId) => after(audits, () => audits.pauseBatch(batchId)),
    resumeBatch: (audits, batchId) => after(audits, () => audits.resumeBatch(batchId)),
    stopBatch: (audits, batchId) => after(audits, () => audits.stopBatch(batchId)),
    retryBatch: (audits, batchId, mode) => after(audits, () => audits.retryBatch(batchId, mode)),
    setGlobalConcurrency: async (jobs, limit) => {
      try {
        const clamped = await jobs.setGlobalConcurrency(limit);
        set({ globalConcurrency: clamped });
      } catch (error) {
        logger.error("[zaicode-audits] setGlobalConcurrency failed", { error: describeError(error) });
        set({ error: describeError(error) });
      }
    },

    generate: async (audits, project) => { await after(audits, () => audits.generate(project)); },
    work: async (audits, campaignId) => { await after(audits, () => audits.work(campaignId)); },
    start: async (audits, project) => { await after(audits, () => audits.start(project)); },
    retry: async (audits, campaignId) => { await after(audits, () => audits.retry(campaignId)); },
    cancel: async (audits, campaignId) => { await after(audits, () => audits.cancel(campaignId)); },
    archive: async (audits, campaignId) => { await after(audits, () => audits.archive(campaignId)); },
    fixWithSaipen: async (audits, campaignId) => { await after(audits, () => audits.fixWithSaipen(campaignId)); },
    setSmartMode: async (audits, enabled) => { await policyAfter(audits, () => audits.setSmartMode(enabled)); },
    setProjectAutoSettings: async (audits, key, patch) => { await policyAfter(audits, () => audits.setProjectAutoSettings(key, patch)); },
    setAutoAudits: async (audits, enabled) => { await policyAfter(audits, () => audits.setAutoAudits(enabled)); },
    setAutoWaves: async (audits, enabled) => { await after(audits, () => audits.setAutoWaves(enabled)); },
    setMaxCycles: async (audits, maxCycles) => { await policyAfter(audits, () => audits.setSmartMaxCycles(maxCycles)); },

    campaignsFor: (workspacePath) =>
      get()
        .campaigns.filter((campaign) => campaign.workspacePath === workspacePath)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),

    activeCountFor: (workspacePath) =>
      get().campaigns.filter(
        (campaign) =>
          campaign.workspacePath === workspacePath && zaicodeAuditCampaignIsActive(campaign),
      ).length,
  };
});

// 内存诊断计数器 (T-67): the campaign mirror's size rides the 60s memory sample.
uiMemoryDiagnosticsRegistry.register("zaicodeAudits", () => {
  const state = useZaicodeAuditStore.getState();
  return {
    campaigns: state.campaigns.length,
    activeCampaigns: state.campaigns.filter(zaicodeAuditCampaignIsActive).length,
  };
});
