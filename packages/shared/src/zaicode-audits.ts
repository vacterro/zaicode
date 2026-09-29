/**
 * ZAICODE A3 audit campaigns (T-66, SRC-049; Quick3 contract as of Wave 5).
 * A campaign is AUDAPACK's three-wave machine on ZAICODE's own durable queue:
 * a declarative wave profile, one agent turn per wave with a read-only role
 * contract, completion gated by the report's own terminal line and done marker,
 * a SHA-256 chain between waves, and a combined handoff synthesized only after
 * all three artifacts are durable. Pure logic only: the campaign store, queue
 * and UI live in services/desktop/ui and call into here.
 */

import { ZAICODE_AUDIT_QUICK3_PROFILE, zaicodeAuditQuick3Wave } from "./zaicode-audit-quick3.js";

/**
 * The one profile a campaign is bound to. The legacy hand-written A3 profile is
 * gone: it is what produced an audit that read like an implementation plan,
 * because its output contract ASKED for one ("then 'Next actions' as an
 * ordered list"). Quick3's contract asks for verified findings with evidence
 * and states that a plan does not count, and the report gate enforces it.
 */
export const ZAICODE_AUDIT_PROFILE = ZAICODE_AUDIT_QUICK3_PROFILE;

export interface ZaicodeAuditCampaignWaveState {
  waveId: string;
  status: "pending" | "running" | "complete" | "partial" | "blocked";
  jobId: string | null;
  reportFile: string | null;
  resultSha256: string | null;
  completedAt: string | null;
  /** SRC-060: when this wave's job was put on the queue (absent on older campaigns). */
  startedAt?: string | null;
  /**
   * The agent this wave ran on, recorded when the wave is enqueued. SRC-060
   * asked "which model is chosen"; the job knows its agent but the campaign
   * never wrote it down, so the panel could only name the project. Optional so
   * campaigns written by an older build still load.
   */
  agentId?: string | null;
  /**
   * Quick3: which dispatch this is, starting at 1. A retry REPLACES the attempt
   * at the same wave index -- it never moves the index -- so the operator can
   * see that wave 2 was tried twice while wave 3 has still not started.
   */
  attempt?: number;
  /** Stable per (run, wave); this is what makes a retry the same dispatch. */
  idempotencyKey?: string;
  /** Verified findings this wave's report carried, as the gate counted them. */
  findings?: number;
  /** Why the gate refused the last report, in its own words. */
  rejectReason?: string | null;
}

/**
 * SRC-060: where a campaign's current wave runs right now, read from its queue
 * job by getState. Never persisted: it is a view of the queue, not campaign truth.
 */
export interface ZaicodeAuditLiveJob {
  jobId: string;
  status: string;
  /** The agent session doing the wave, once dispatch attached one. */
  sessionId: string | null;
  /** Epoch ms. */
  startedAt: number | null;
  /** Last sign of life from the running job (epoch ms). */
  heartbeatAt: number | null;
  attempt: number;
  agentName: string | null;
  /** The model actually used, else the one the agent is configured with. */
  model: string | null;
}

/** SRC-060: the agent that runs audit waves, as the Audits view names it. */
export interface ZaicodeAuditorView {
  agentId: string;
  name: string;
  model: string | null;
}

export interface ZaicodeAuditCampaign {
  /**
   * 2 = the Quick3 campaign (Wave 5). 1 = the legacy A3 record, which still
   * loads so an old campaign's history stays readable; the service reads it,
   * never writes it.
   */
  schemaVersion: 1 | 2;
  campaignId: string;
  profileId: string;
  /** Identifies an automatic audit run; manual campaigns have no run id. */
  smartRunId?: string;
  projectName: string;
  workspaceKey: string;
  workspacePath: string;
  /**
   * AUDAPACK's generate-first / work-later split, not "sent straight to chat":
   * `planned` = generated and sitting in the review queue, no job dispatched;
   * `running` = a wave is being worked; then `complete` / `blocked` /
   * `cancelled`. `work()` is the only transition out of `planned`.
   */
  status: "planned" | "running" | "complete" | "blocked" | "cancelled";
  createdAt: string;
  updatedAt: string;
  currentWaveIndex: number;
  waves: ZaicodeAuditCampaignWaveState[];
  finalHandoffFile: string | null;
  /** Finalizer's explicit count; null means its handoff was not machine readable. */
  actionableFindings?: number | null;
  /** Automatic implementation job for this handoff, if findings exist. */
  remediationJobId?: string | null;
  /** SRC-060: first wave dispatch (absent on older campaigns and on planned ones). */
  startedAt?: string | null;
  /** SRC-060: the current wave's queue job, filled by getState; never persisted. */
  live?: ZaicodeAuditLiveJob | null;
  /** Current queue status, filled by getState and never used as persisted truth. */
  remediationStatus?: "draft" | "queued" | "ready" | "running" | "waiting" | "blocked" | "completed" | "failed" | "cancelled" | null;

  // ---- Wave 5 (Quick3). Absent on a legacy v1 campaign. ----

  /**
   * The run identity, frozen at the campaign's start. Every artifact carries it
   * and the gate checks it, so yesterday's reports cannot satisfy today's run.
   */
  runId?: string;
  /** The profile contract this campaign is judged against, not the one on disk now. */
  profileVersion?: string;
  /** A stamp of that contract, so a mid-campaign edit cannot excuse a bad report. */
  manifestHash?: string;
  /**
   * What was audited, frozen at start: git HEAD plus a digest of the dirty
   * state, or `no-git:<path>` when the project is not a repository. A later
   * Fix job records the drift between this and its own HEAD.
   */
  sourceIdentity?: string;
  /** The model that actually runs the audit waves, as `provider / model`. */
  modelIdentity?: string | null;
  /**
   * The synthesized handoff. It exists ONLY after all three wave artifacts are
   * durable and hash-verified, which is why a campaign is `complete` only when
   * this is written -- three saved waves without it is `saving`, never `ready`.
   */
  combined?: {
    file: string;
    kind: string;
    sha256: string;
    synthesizedAt: string;
  } | null;
  /** Verified findings across the whole campaign, summed from the gate. */
  findings?: number;
  /** The implementation job created by "Fix with SAIPEN", by identity. */
  fixJobId?: string | null;
  /** How far the source moved between the audited snapshot and the fix. */
  sourceDrift?: { audited: string; atFix: string; changed: boolean; recordedAt: string } | null;
}

/**
 * SRC-060: "какие проекты, какая модель выбрана, где щас идёт аудит, на какой
 * стадии, сколько идёт процесс" -- one read model so the panel, the sidebar and
 * anything else answer from the same place instead of each re-deriving it.
 *
 * Pure: no clock and no IO beyond the arguments, so it is directly testable.
 */
export interface ZaicodeAuditReadout {
  projectName: string;
  workspacePath: string;
  /** The wave being worked right now, as "2/3 Performance and leaks". */
  where: string;
  /** The plain-language stage, which is not the same thing as the status enum. */
  stage: string;
  /** Agent the current wave runs on, or null for a campaign not yet enqueued. */
  agentId: string | null;
  doneWaves: number;
  totalWaves: number;
  /** Milliseconds since the campaign was generated. */
  elapsedMs: number;
  /** True while a wave is queued, running or waiting. */
  active: boolean;
}

const ZAICODE_AUDIT_STAGE_WORDS: Record<ZaicodeAuditCampaign["status"], string> = {
  planned: "waiting in the queue until you start it",
  running: "running now",
  complete: "finished",
  blocked: "stopped on something it could not finish",
  cancelled: "cancelled",
};

export function describeZaicodeAuditCampaign(
  campaign: ZaicodeAuditCampaign,
  now: number = Date.now(),
): ZaicodeAuditReadout {
  const current = campaign.waves[campaign.currentWaveIndex] ?? null;
  const wave = current ? zaicodeAuditQuick3Wave(current.waveId) : null;
  const doneWaves = campaign.waves.filter((entry) => entry.status === "complete").length;
  const where =
    wave && current
      ? `${wave.ordinal}/${ZAICODE_AUDIT_PROFILE.waves.length} ${wave.title}`
      : "no wave left";
  const stage =
    campaign.status === "running" && current?.status === "partial"
      ? `${ZAICODE_AUDIT_STAGE_WORDS[campaign.status]} — this wave came back partial`
      : ZAICODE_AUDIT_STAGE_WORDS[campaign.status] ?? campaign.status;
  return {
    projectName: campaign.projectName,
    workspacePath: campaign.workspacePath,
    where,
    stage,
    agentId: current?.agentId ?? null,
    doneWaves,
    totalWaves: campaign.waves.length,
    elapsedMs: Math.max(0, now - Date.parse(campaign.createdAt)),
    active: campaign.status === "running",
  };
}

/** Compact "3m 12s" / "2h 04m" for a duration, the way a person reads it. */
export function formatZaicodeAuditElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}h ${pad(minutes)}m` : minutes > 0 ? `${minutes}m ${pad(seconds)}s` : `${seconds}s`;
}

/** The wave a campaign works next, or null when every wave is complete. */
export function zaicodeAuditCurrentWave(campaign: ZaicodeAuditCampaign) {
  const state = campaign.waves[campaign.currentWaveIndex];
  if (!state) return null;
  return zaicodeAuditQuick3Wave(state.waveId);
}

/**
 * Smart mode (SRC-049): when a project's board is empty and nothing is
 * running, the project improves itself - generate the next A3 campaign, then
 * work it. Pure decision: the caller owns the timers and the write.
 */
export function shouldStartZaicodeAuditCampaign(input: {
  smartMode: boolean;
  hasSaipenBoard: boolean;
  openBoardTickets: number;
  runningSessions: number;
  activeCampaign: ZaicodeAuditCampaign | null;
}): boolean {
  if (!input.smartMode) return false;
  if (!input.hasSaipenBoard) return false;
  if (input.openBoardTickets > 0) return false;
  if (input.runningSessions > 0) return false;
  if (input.activeCampaign && input.activeCampaign.status !== "complete" && input.activeCampaign.status !== "cancelled") {
    return false;
  }
  return true;
}

/** Outcome of one smart-mode sweep (the service's answer to the caller's clock tick). */
export interface ZaicodeAuditsReport {
  /** Projects whose empty board started a campaign this sweep. */
  started: string[];
}

/** Terminal campaigns no longer occupy a project's audit seat. */
export function zaicodeAuditCampaignIsActive(campaign: ZaicodeAuditCampaign): boolean {
  return campaign.status !== "complete" && campaign.status !== "cancelled";
}

/** Open DOING/TODO tickets in a project's BOARD.md (`- [ ]` / `- [/]` T-### lines). */
export function countZaicodeOpenBoardTickets(boardMarkdown: string): number {
  let open = 0;
  for (const line of boardMarkdown.split(/\r?\n/)) {
    if (/^- \[[ /]\] T-\d+/.test(line.trim())) open += 1;
  }
  return open;
}
