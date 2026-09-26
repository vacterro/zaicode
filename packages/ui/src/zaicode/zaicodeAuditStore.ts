import { create } from "zustand";
import type { IZaicodeAuditService } from "@zcode/services";
import type { ZaicodeAuditCampaign } from "@zcode/shared";
import { zaicodeAuditCampaignIsActive } from "@zcode/shared";
import { logger } from "@/logger.js";

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
  loading: boolean;
  error: string | null;
  refresh: (audits: IZaicodeAuditService) => Promise<void>;
  generate: (audits: IZaicodeAuditService, project: ZaicodeAuditProject) => Promise<void>;
  work: (audits: IZaicodeAuditService, campaignId: string) => Promise<void>;
  start: (audits: IZaicodeAuditService, project: ZaicodeAuditProject) => Promise<void>;
  cancel: (audits: IZaicodeAuditService, campaignId: string) => Promise<void>;
  setSmartMode: (audits: IZaicodeAuditService, enabled: boolean) => Promise<void>;
  campaignsFor: (workspacePath: string) => ZaicodeAuditCampaign[];
  activeCountFor: (workspacePath: string) => number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useZaicodeAuditStore = create<ZaicodeAuditStoreState>((set, get) => {
  const after = async (audits: IZaicodeAuditService, action: () => Promise<unknown>): Promise<void> => {
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
    loading: false,
    error: null,

    refresh: async (audits) => {
      set({ loading: true });
      try {
        const state = await audits.getState();
        set({ campaigns: state.campaigns, smartMode: state.smartMode, loading: false, error: null });
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

    campaignsFor: (workspacePath) =>
      get()
        .campaigns.filter((campaign) => campaign.workspacePath === workspacePath)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),

    activeCountFor: (workspacePath) =>
      get().campaigns.filter(
        (campaign) => campaign.workspacePath === workspacePath && zaicodeAuditCampaignIsActive(campaign),
      ).length,
  };
});
