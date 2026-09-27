import { create } from "zustand";
import type { IZaicodeAuditService } from "@zcode/services";
import type { ZaicodeAuditCampaign } from "@zcode/shared";
import { zaicodeAuditCampaignIsActive } from "@zcode/shared";
import { logger } from "@/logger.js";
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
  smartMode: boolean;
  maxCycles: number;
  runId: string | null;
  loading: boolean;
  error: string | null;
  refresh: (audits: IZaicodeAuditService) => Promise<void>;
  generate: (audits: IZaicodeAuditService, project: ZaicodeAuditProject) => Promise<void>;
  work: (audits: IZaicodeAuditService, campaignId: string) => Promise<void>;
  start: (audits: IZaicodeAuditService, project: ZaicodeAuditProject) => Promise<void>;
  cancel: (audits: IZaicodeAuditService, campaignId: string) => Promise<void>;
  setSmartMode: (audits: IZaicodeAuditService, enabled: boolean) => Promise<void>;
  setMaxCycles: (audits: IZaicodeAuditService, maxCycles: number) => Promise<void>;
  campaignsFor: (workspacePath: string) => ZaicodeAuditCampaign[];
  activeCountFor: (workspacePath: string) => number;
}

export interface ZaicodeAuditProgress {
  complete: number;
  total: number;
  campaigns: number;
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

  return {
    campaigns: [],
    smartMode: false,
    maxCycles: 10,
    runId: null,
    loading: false,
    error: null,

    refresh: async (audits) => {
      set({ loading: true });
      try {
        const state = await audits.getState();
        set({
          campaigns: state.campaigns,
          smartMode: state.smartMode,
          maxCycles: state.maxCycles,
          runId: state.runId,
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
    cancel: (audits, campaignId) => after(audits, () => audits.cancel(campaignId)),
    setSmartMode: (audits, enabled) => after(audits, () => audits.setSmartMode(enabled)),
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
