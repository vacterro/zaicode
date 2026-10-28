import { zaicodeAuditCampaignIsActive, type ZaicodeAuditCampaign } from "@zcode/shared";

/**
 * What `/a3` should do, as a pure decision (Wave 5).
 *
 * The composer's app-command channel runs this and never sends a message, so
 * the only way a duplicate campaign can happen is if the start is issued twice
 * or against a project that already has one. Both are decided here, with no
 * React and no IO, so the rule is testable on its own.
 */

export interface ZaicodeA3Target {
  workspaceKey: string;
  workspacePath: string;
  projectName: string;
}

export type ZaicodeA3Decision =
  /** Start a fresh campaign for this project. */
  | { kind: "start" }
  /** One is already live for this project: open it, do not start another. */
  | { kind: "open-existing"; campaignId: string; currentWave: number; status: string }
  | { kind: "unavailable"; reason: string };

/**
 * `planned`, `running` and `blocked` all still hold the project's audit seat: a
 * stopped campaign is waiting for a decision (retry or cancel), not free.
 */
export function planZaicodeA3(
  campaigns: readonly ZaicodeAuditCampaign[],
  target: ZaicodeA3Target,
  hasService: boolean,
): ZaicodeA3Decision {
  if (!hasService) {
    return { kind: "unavailable", reason: "the local ZAICODE host is not connected" };
  }
  const existing = campaigns.find(
    (campaign) =>
      campaign.workspacePath === target.workspacePath && zaicodeAuditCampaignIsActive(campaign),
  );
  if (existing) {
    return {
      kind: "open-existing",
      campaignId: existing.campaignId,
      currentWave: existing.currentWaveIndex + 1,
      status: existing.status,
    };
  }
  return { kind: "start" };
}

export function zaicodeA3ProjectName(target: ZaicodeA3Target): string {
  return target.projectName || (target.workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? target.workspacePath);
}

/**
 * The exactly-once latch. A double Enter, or a click plus Enter, issues two
 * calls before the first has finished; the second must be refused rather than
 * creating a second campaign. Refusal is per-instance, so the test can drive
 * one without touching the module the app uses.
 */
export function createZaicodeA3Starter() {
  let starting = false;
  return {
    inFlight: () => starting,
    /**
     * Run `start` at most once at a time. Returns false when one is already
     * running, which the caller reports rather than retrying.
     */
    async once<T>(start: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
      if (starting) return { ran: false };
      starting = true;
      try {
        return { ran: true, value: await start() };
      } finally {
        starting = false;
      }
    },
  };
}
