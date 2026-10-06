import { ServiceChannels } from "@zcode/shared";
import type { ZaicodeAuditCampaign, ZaicodeAuditorView, ZaicodeAuditsReport } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * ZAICODE A3 audit service (T-66, SRC-049). AUDAPACK's campaign machine on
 * ZAICODE's own durable queue: generate the three waves ahead of time into a
 * review queue, then work them when asked. Lives beside the job/agent/stats
 * services because a wave is an ordinary queue job and only the services layer
 * owns the queue.
 */
export interface IZaicodeAuditService {
  /**
   * Campaigns plus the smart-mode switch. Reconciles finished waves first.
   * SRC-060: each running campaign carries `live` (its wave's job: session,
   * start, last sign of life, model) and the auditor agent is named.
   */
  getState(): Promise<{
    campaigns: ZaicodeAuditCampaign[];
    smartMode: boolean;
    maxCycles: number;
    runId: string | null;
    /** SRC-151:R008: global "generate the next wave by itself" switch; true unless turned off. */
    autoWaves: boolean;
    auditor: ZaicodeAuditorView | null;
  }>;
  /** A project's newest campaign, or null. */
  getCampaign(campaignId: string): Promise<ZaicodeAuditCampaign | null>;
  /** Generate a campaign into the review queue as `planned`; nothing is dispatched. */
  generate(input: { workspaceKey: string; workspacePath: string; projectName: string }): Promise<ZaicodeAuditCampaign | null>;
  /** Start working a planned campaign (dispatch wave 1). */
  work(campaignId: string): Promise<ZaicodeAuditCampaign | null>;
  /** Generate and immediately work (explicit "audit now", `/a3`, and smart mode). */
  start(input: { workspaceKey: string; workspacePath: string; projectName: string }): Promise<ZaicodeAuditCampaign | null>;
  /**
   * Retry the wave a blocked campaign is stopped at. The wave index does not
   * move: the attempt number does.
   */
  retry(campaignId: string): Promise<ZaicodeAuditCampaign | null>;
  cancel(campaignId: string): Promise<ZaicodeAuditCampaign | null>;
  /** Archive a stopped/planned/finished audit; refuses while any associated job is running. Reports stay intact. */
  archive(campaignId: string): Promise<ZaicodeAuditCampaign | null>;
  /** One wave report's markdown, or null. */
  readReport(campaignId: string, waveId: string): Promise<string | null>;
  /** The synthesized `__00_AUDIT_ALL_3.md`, or null before it is durable. */
  readCombined(campaignId: string): Promise<string | null>;
  /**
   * "Fix with SAIPEN": one implementation job that consumes the exact combined
   * artifact by path and digest, records the source drift since the audit, and
   * leaves the read-only audit artifacts untouched. Refuses before 3/3.
   */
  fixWithSaipen(campaignId: string): Promise<ZaicodeAuditCampaign | null>;
  /** Smart mode: empty board + nothing running -> the project starts an A3 campaign itself. */
  setSmartMode(enabled: boolean): Promise<{ smartMode: boolean }>;
  /**
   * SRC-151:R008: the global wave switch. Off, a validated wave does not generate
   * the next one — the campaign parks in the review queue and only the
   * operator's Continue starts it. On again releases every held campaign.
   */
  setAutoWaves(enabled: boolean): Promise<{ autoWaves: boolean }>;
  /** Maximum number of automatic campaigns per project in one run (1..10). */
  setSmartMaxCycles(maxCycles: number): Promise<{ maxCycles: number }>;
  /** The projects smart mode may audit (pushed by the renderer, which owns the fleet). */
  publishProjects(projects: { workspaceKey: string; workspacePath: string; projectName: string; disabled?: boolean; runningSessions?: number; noWorkConfirmed?: boolean }[]): Promise<void>;
  /** Run every project's smart self-audit decision once (the caller owns the clock). */
  smartSweep(): Promise<ZaicodeAuditsReport>;
  dispose(): void;
}

export const IZaicodeAuditService = createServiceDescriptor<IZaicodeAuditService>(ServiceChannels.ZaicodeAudits);
