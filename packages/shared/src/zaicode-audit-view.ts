import type { ModelSelection } from "./model-selection.js";
import {
  ZAICODE_AUDIT_PROFILE,
  zaicodeAuditCampaignIsActive,
  type ZaicodeAuditCampaign,
} from "./zaicode-audits.js";

/**
 * What the Audits view tells the operator about a campaign (SRC-060): "which
 * projects, which model, where it runs now, at what stage, for how long".
 * Pure, so the whole read-out is testable; AUDAPACK's widget is the model
 * (progress steps, stage labels with elapsed time, an idle watchdog).
 */

export type ZaicodeAuditStepState = "done" | "active" | "waiting" | "failed" | "planned" | "cancelled";

export interface ZaicodeAuditStep {
  ordinal: number;
  title: string;
  state: ZaicodeAuditStepState;
  /** How long this wave took (done) or has taken so far (active), ms; null = not started. */
  elapsedMs: number | null;
}

function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** One step per wave, in order, with its state and time. */
export function zaicodeAuditSteps(campaign: ZaicodeAuditCampaign, now: number): ZaicodeAuditStep[] {
  return campaign.waves.map((wave, index) => {
    const definition = ZAICODE_AUDIT_PROFILE.waves.find((entry) => entry.id === wave.waveId);
    const current = index === campaign.currentWaveIndex;
    let state: ZaicodeAuditStepState;
    if (wave.status === "complete") state = "done";
    else if (wave.status === "partial" || wave.status === "blocked") state = "failed";
    else if (campaign.status === "cancelled") state = "cancelled";
    else if (campaign.status === "planned") state = "planned";
    else if (current && campaign.status === "running") state = "active";
    else state = "waiting";
    const started = parseIso(wave.startedAt) ?? (current ? (campaign.live?.startedAt ?? null) : null);
    const finished = parseIso(wave.completedAt);
    const elapsedMs =
      started === null ? null : Math.max(0, (finished ?? (state === "active" ? now : started)) - started);
    return { ordinal: definition?.ordinal ?? index + 1, title: definition?.title ?? wave.waveId, state, elapsedMs };
  });
}

export interface ZaicodeAuditStage {
  /** "Wave 2 of 3 · Completeness", "Planned, not started", "Done: 3 of 3 waves". */
  label: string;
  done: number;
  total: number;
}

/** The current wave's job has not started yet (queued or ready in the ZAICODE queue). */
export function isZaicodeAuditJobWaiting(campaign: ZaicodeAuditCampaign): boolean {
  const status = campaign.live?.status;
  return status === "queued" || status === "ready";
}

export function zaicodeAuditStage(campaign: ZaicodeAuditCampaign): ZaicodeAuditStage {
  const total = campaign.waves.length;
  const done = campaign.waves.filter((wave) => wave.status === "complete").length;
  const current = ZAICODE_AUDIT_PROFILE.waves.find(
    (wave) => wave.id === campaign.waves[campaign.currentWaveIndex]?.waveId,
  );
  const wave = current ? `wave ${current.ordinal} of ${total} · ${current.title}` : `wave ${campaign.currentWaveIndex + 1}`;
  switch (campaign.status) {
    case "planned":
      return { label: "Planned, not started", done, total };
    case "running":
      // T-133: a wave whose job still waits in the queue is not running (on 30.09 two had waited three days: their
      // projects were switched off, and the Audits view said "Running").
      return { label: `${isZaicodeAuditJobWaiting(campaign) ? "Queued" : "Running"} ${wave}`, done, total };
    case "blocked":
      return { label: `Stopped at ${wave}`, done, total };
    case "cancelled":
      return { label: `Cancelled at ${wave}`, done, total };
    default:
      return { label: `Done: ${done} of ${total} waves`, done, total };
  }
}

/** Whole campaign time: first dispatch to the last finished wave (or now while it runs). */
export function zaicodeAuditTotalMs(campaign: ZaicodeAuditCampaign, now: number): number | null {
  const started =
    parseIso(campaign.startedAt) ??
    campaign.waves.map((wave) => parseIso(wave.startedAt)).find((value) => value !== null) ??
    campaign.live?.startedAt ??
    null;
  if (started === null) return null;
  if (campaign.status === "running") return Math.max(0, now - started);
  const ends = campaign.waves.map((wave) => parseIso(wave.completedAt)).filter((value): value is number => value !== null);
  const end = ends.length > 0 ? Math.max(...ends) : parseIso(campaign.updatedAt);
  return end === null ? null : Math.max(0, end - started);
}

export type ZaicodeAuditIdleLevel = "ok" | "quiet" | "stalled";

/** A running wave that has not shown a sign of life for this long reads "quiet" / "stalled". */
export const ZAICODE_AUDIT_QUIET_MS = 3 * 60_000;
export const ZAICODE_AUDIT_STALLED_MS = 10 * 60_000;

/**
 * AUDAPACK's idle watchdog, as a read-out: how long the running wave's job has
 * been silent. Null when nothing runs or there is no sign of life to go by.
 */
export function zaicodeAuditIdle(
  campaign: ZaicodeAuditCampaign,
  now: number,
): { idleMs: number; level: ZaicodeAuditIdleLevel } | null {
  const live = campaign.live;
  if (campaign.status !== "running" || !live || live.status !== "running") return null;
  const last = live.heartbeatAt ?? live.startedAt;
  if (last === null) return null;
  const idleMs = Math.max(0, now - last);
  return {
    idleMs,
    level: idleMs >= ZAICODE_AUDIT_STALLED_MS ? "stalled" : idleMs >= ZAICODE_AUDIT_QUIET_MS ? "quiet" : "ok",
  };
}

/** "provider / model · effort" for a model selection, or the bare reference. */
export function formatZaicodeModelLabel(
  selection: ModelSelection | null | undefined,
  fallback?: { modelRef?: string; providerRef?: string; reasoningEffort?: string } | null,
): string | null {
  if (selection) {
    const effort = selection.options?.reasoningLevel;
    return `${selection.providerId} / ${selection.modelId}${effort ? ` · ${effort}` : ""}`;
  }
  if (fallback?.modelRef) {
    const provider = fallback.providerRef ? `${fallback.providerRef} / ` : "";
    return `${provider}${fallback.modelRef}${fallback.reasoningEffort ? ` · ${fallback.reasoningEffort}` : ""}`;
  }
  return null;
}

export type ZaicodeAuditProjectState = "idle" | "planned" | "running" | "stopped" | "done";

/** One project's line in the Audits list: its newest campaign, read out. */
export function zaicodeAuditProjectState(
  campaigns: readonly ZaicodeAuditCampaign[],
  workspacePath: string,
): { state: ZaicodeAuditProjectState; campaign: ZaicodeAuditCampaign | null } {
  const mine = campaigns
    .filter((campaign) => campaign.workspacePath === workspacePath)
    .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
  const active = mine.find((campaign) => zaicodeAuditCampaignIsActive(campaign)) ?? null;
  const campaign = active ?? mine[0] ?? null;
  if (!campaign) return { state: "idle", campaign: null };
  if (campaign.status === "planned") return { state: "planned", campaign };
  if (campaign.status === "running") return { state: "running", campaign };
  if (campaign.status === "blocked") return { state: "stopped", campaign };
  if (campaign.status === "complete") return { state: "done", campaign };
  return { state: "idle", campaign };
}

