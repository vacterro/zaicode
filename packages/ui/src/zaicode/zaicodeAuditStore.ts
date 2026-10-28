import { create } from "zustand";
import type { IZaicodeAuditService } from "@zcode/services";
import type { ZaicodeAuditCampaign, ZaicodeAuditorView } from "@zcode/shared";
import { zaicodeAuditCampaignIsActive } from "@zcode/shared";
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

interface ZaicodeAuditStoreState {
  campaigns: ZaicodeAuditCampaign[];
  /** SRC-060: the agent that runs audit waves (null until the first audit makes one). */
  auditor: ZaicodeAuditorView | null;
  smartMode: boolean;
  maxCycles: number;
  runId: string | null;
  /** SRC-151:R008: the global "generate the next wave by itself" switch. */
  autoWaves: boolean;
  loading: boolean;
  error: string | null;
  refresh: (audits: IZaicodeAuditService) => Promise<void>;
  generate: (audits: IZaicodeAuditService, project: ZaicodeAuditProject) => Promise<void>;
  work: (audits: IZaicodeAuditService, campaignId: string) => Promise<void>;
  start: (audits: IZaicodeAuditService, project: ZaicodeAuditProject) => Promise<void>;
  retry: (audits: IZaicodeAuditService, campaignId: string) => Promise<void>;
  cancel: (audits: IZaicodeAuditService, campaignId: string) => Promise<void>;
  archive: (audits: IZaicodeAuditService, campaignId: string) => Promise<void>;
  /** Hand the exact combined artifact to the next implementation task. */
  fixWithSaipen: (audits: IZaicodeAuditService, campaignId: string) => Promise<void>;
  setSmartMode: (audits: IZaicodeAuditService, enabled: boolean) => Promise<void>;
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
  const after = async (
    audits: IZaicodeAuditService,
    action: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      await action();
      await get().refresh(audits);
    } catch (error) {
      logger.error("[zaicode-audits] action failed", { error: describeError(error) });
      set({ error: describeError(error) });
    }
  };

  let lastSeen: ZaicodeAuditCampaign[] | null = null;
  return {
    campaigns: [],
    auditor: null,
    smartMode: false,
    maxCycles: 10,
    runId: null,
    autoWaves: true,
    loading: false,
    error: null,

    refresh: async (audits) => {
      set({ loading: true });
      try {
        const state = await audits.getState();
        for (const cue of zaicodeAuditTransitions(lastSeen, state.campaigns)) playZaicodeSound(cue);
        // SRC-116: the sound-cue memory kept the whole untrimmed list, so it leaked exactly like
        // the mirror it compared against. It holds the same bounded slice now.
        lastSeen = boundZaicodeAuditCampaigns(state.campaigns);
        set({
          campaigns: lastSeen,
          auditor: state.auditor ?? null,
          smartMode: state.smartMode,
          maxCycles: state.maxCycles,
          runId: state.runId,
          autoWaves: state.autoWaves !== false,
          loading: false,
          error: null,
        });
      } catch (error) {
        logger.error("[zaicode-audits] refresh failed", { error: describeError(error) });
        set({ loading: false, error: describeError(error) });
      }
    },

    generate: (audits, project) => after(audits, () => audits.generate(project)),
    work: (audits, campaignId) => after(audits, () => audits.work(campaignId)),
    start: (audits, project) => after(audits, () => audits.start(project)),
    retry: (audits, campaignId) => after(audits, () => audits.retry(campaignId)),
    cancel: (audits, campaignId) => after(audits, () => audits.cancel(campaignId)),
    archive: (audits, campaignId) => after(audits, () => audits.archive(campaignId)),
    fixWithSaipen: (audits, campaignId) => after(audits, () => audits.fixWithSaipen(campaignId)),
    setSmartMode: (audits, enabled) => after(audits, () => audits.setSmartMode(enabled)),
    setAutoWaves: (audits, enabled) => after(audits, () => audits.setAutoWaves(enabled)),
    setMaxCycles: (audits, maxCycles) => after(audits, () => audits.setSmartMaxCycles(maxCycles)),

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
