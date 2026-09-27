import type { ZaicodeBoardCounts, ZaicodeProjectRuntimeVerdict } from "@zcode/shared";

/**
 * The special DONE mark of a project row (SRC-062): "a separate DONE
 * indicator when a project is fully done by SAIPEN and has a clean board,
 * with an offer to run an A3 audit wave then -- smart, no frills".
 *
 * Fully done = SAIPEN's own verdict is DONE (T-41 read model), nothing is
 * parked for a human and the board has no open or blocked ticket. A DONE with
 * parked or blocked tickets is not "clean": the row keeps its ordinary state
 * strip for it.
 *
 * The A3 offer is honest about what an audit adds: it is made only when no
 * A3 campaign is planned or running for the project and the project changed
 * (a SAIPEN checkpoint) after its last finished audit -- auditing the same
 * state twice finds nothing new.
 */

export interface ZaicodeDoneCampaignFacts {
  status: "planned" | "running" | "complete" | "blocked" | "cancelled";
  /** ISO time of the campaign's last change. */
  updatedAt: string;
}

export interface ZaicodeProjectDoneMark {
  /** Offer a new A3 audit wave. */
  offerA3: boolean;
  /** Epoch ms of the last finished audit, or null when there never was one. */
  lastAuditAt: number | null;
  title: string;
}

export function zaicodeProjectDoneMark(input: {
  verdict: Pick<ZaicodeProjectRuntimeVerdict, "state"> | null;
  board: ZaicodeBoardCounts | null;
  parked: number;
  campaigns: readonly ZaicodeDoneCampaignFacts[];
  /** Epoch ms of the project's last SAIPEN checkpoint (STATE `updated`), 0 when unknown. */
  stateUpdatedAt: number;
}): ZaicodeProjectDoneMark | null {
  if (input.verdict?.state !== "done") return null;
  if (input.parked > 0) return null;
  if (input.board && input.board.doing + input.board.todo + input.board.blocked > 0) return null;
  const auditing = input.campaigns.some((campaign) => campaign.status === "planned" || campaign.status === "running");
  let lastAuditAt: number | null = null;
  for (const campaign of input.campaigns) {
    if (campaign.status !== "complete") continue;
    const at = Date.parse(campaign.updatedAt);
    if (Number.isFinite(at) && (lastAuditAt === null || at > lastAuditAt)) lastAuditAt = at;
  }
  const changedSinceAudit = lastAuditAt === null || input.stateUpdatedAt > lastAuditAt;
  const offerA3 = !auditing && changedSinceAudit;
  const done = input.board ? `${input.board.done} ticket(s) closed, none open, none blocked or parked` : "every ticket closed";
  const title = auditing
    ? `SAIPEN: done and clean (${done}). An A3 audit is already planned or running.`
    : offerA3
      ? `SAIPEN: done and clean (${done}). Click to plan an A3 audit wave: three independent auditors look for what was missed${lastAuditAt ? " since the last audit" : ""}.`
      : `SAIPEN: done and clean (${done}). Audited after the last change; nothing new to audit.`;
  return { offerA3, lastAuditAt, title };
}
