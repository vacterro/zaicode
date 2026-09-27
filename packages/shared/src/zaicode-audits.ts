/**
 * ZAICODE A3 audit campaigns (T-66, SRC-049), after AUDAPACK's own mechanism:
 * a declarative wave profile ("A3" = AUDAPACK's quick3: three waves), one
 * agent turn per wave with a strict output contract, completion gated by the
 * report's STATUS line, a SHA-256 chain between waves, and a finalizer wave
 * that synthesizes the combined handoff. Pure logic only: the campaign store,
 * queue and UI live in services/desktop/ui and call into here.
 */

export interface ZaicodeAuditWave {
  id: string;
  ordinal: number;
  slug: string;
  title: string;
  /** Machine key the report's STATUS line must carry. */
  statusKey: string;
  /** What the wave looks at (AUDAPACK's prompt_focus). */
  promptFocus: string;
  outputContract: string;
  /** Marker the report must contain beyond the STATUS line. */
  doneMarker: string;
  finalizer: boolean;
}

export const ZAICODE_AUDIT_PROFILE_A3 = {
  id: "a3",
  label: "A3",
  description: "Three waves: core correctness, completeness, performance — then one combined handoff.",
  waves: [
    {
      id: "core",
      ordinal: 1,
      slug: "AUDIT_CORE",
      title: "Core correctness",
      statusKey: "AUDIT_CORE",
      promptFocus:
        "Core correctness. Read the project's own docs and code; find real defects: broken invariants, wrong edge cases, error paths that swallow failures, data-loss risks. Only findings you can point to with file:line. No style nits, no hypotheticals.",
      outputContract:
        "One markdown report: a table of findings (severity, file:line, what is wrong, why it matters, smallest safe fix), then 'Next actions' as an ordered list an agent can execute.",
      doneMarker: "AUDIT_CORE_DONE",
      finalizer: false,
    },
    {
      id: "second",
      ordinal: 2,
      slug: "AUDIT_SECOND_WAVE",
      title: "Completeness",
      statusKey: "AUDIT_SECOND",
      promptFocus:
        "Completeness against intent. Compare what the project's docs/requests promise with what the code does: missing pieces, half-wired features, dead paths, conditions nobody handles, TODOs that are really bugs. Build on the core wave's report; do not repeat its findings.",
      outputContract:
        "One markdown report: a gap table (promise, where it breaks, evidence, smallest safe fix), then 'Next actions' as an ordered list.",
      doneMarker: "AUDIT_SECOND_DONE",
      finalizer: false,
    },
    {
      id: "performance",
      ordinal: 3,
      slug: "AUDIT_PERFORMANCE",
      title: "Performance",
      statusKey: "AUDIT_PERFORMANCE",
      promptFocus:
        "Performance and leaks without losing behaviour: listeners/timers/pollers never cleaned up, stores that grow without bound, needless renders and process spawns, hot paths with avoidable work. Every finding needs a measurement or a concrete mechanism, not a feeling.",
      outputContract:
        "One markdown report: a findings table (mechanism, evidence, expected effect, smallest safe fix), then 'Next actions' as an ordered list. Finish by synthesizing the three waves into one prioritized handoff.",
      doneMarker: "AUDIT_PERFORMANCE_DONE",
      finalizer: true,
    },
  ] as readonly ZaicodeAuditWave[],
} as const;

export interface ZaicodeAuditCampaignWaveState {
  waveId: string;
  status: "pending" | "running" | "complete" | "partial" | "blocked";
  jobId: string | null;
  reportFile: string | null;
  resultSha256: string | null;
  completedAt: string | null;
  /** SRC-060: when this wave's job was put on the queue (absent on older campaigns). */
  startedAt?: string | null;
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
  schemaVersion: 1;
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
}

export function zaicodeAuditWaveOf(profile: typeof ZAICODE_AUDIT_PROFILE_A3, waveId: string): ZaicodeAuditWave | null {
  return profile.waves.find((wave) => wave.id === waveId) ?? null;
}

/** The wave a campaign works next, or null when every wave is complete. */
export function zaicodeAuditCurrentWave(campaign: ZaicodeAuditCampaign): ZaicodeAuditWave | null {
  const state = campaign.waves[campaign.currentWaveIndex];
  if (!state) return null;
  return zaicodeAuditWaveOf(ZAICODE_AUDIT_PROFILE_A3, state.waveId);
}

/**
 * AUDAPACK's wave prompt shape: shared protocol, the wave's focus, the output
 * contract, and the machine lines that gate completion. The agent writes the
 * report to `reportFile`; nothing else is accepted as progress.
 */
export function buildZaicodeAuditWavePrompt(input: {
  projectName: string;
  workspacePath: string;
  wave: ZaicodeAuditWave;
  reportFile: string;
  previousReport: string | null;
  previousReports?: string[];
}): string {
  return [
    `You are running AUDIT WAVE ${input.wave.ordinal}/3 (${input.wave.title}) of the A3 campaign for project ${input.projectName} at ${input.workspacePath}.`,
    "",
    `FOCUS: ${input.wave.promptFocus}`,
    "",
    `OUTPUT CONTRACT: ${input.wave.outputContract}`,
    "",
    "Write the report EXACTLY to this file (create it, markdown):",
    input.reportFile,
    "",
    ...(input.wave.finalizer
      ? ["Count distinct actionable findings across all three waves. Add one machine line before the two closing lines:", "ACTIONABLE_FINDINGS: <non-negative integer>", "Write 0 only when the combined handoff has no next actions.", ""]
      : []),
    "The report MUST end with these two machine lines (own line each, verbatim):",
    `STATUS: ${input.wave.statusKey}: COMPLETE`,
    input.wave.doneMarker,
    "",
    "Rules: read-only towards the code (change nothing); a wave with no findings still writes the report and both machine lines; never invent file:line; keep it dense.",
    (input.previousReports?.length ?? 0) > 0
      ? `\nRead every previous wave report before writing this one: ${input.previousReports!.join(", ")}. Build on them without repeating findings.`
      : input.previousReport
        ? `\nThe previous wave's report (${input.previousReport}) is your base: build on it, do not repeat it.`
        : "",
  ].join("\n");
}

export interface ZaicodeAuditWaveReportVerdict {
  complete: boolean;
  statusKey: string | null;
  reason: "ok" | "missing-status" | "wrong-status" | "missing-marker" | "empty";
}

/**
 * AUDAPACK's gate: the STATUS line names this wave's key and says COMPLETE,
 * and the wave's done marker is present. Anything else is a partial.
 */
export function parseZaicodeAuditWaveReport(
  text: string,
  wave: ZaicodeAuditWave,
): ZaicodeAuditWaveReportVerdict {
  if (!text.trim()) return { complete: false, statusKey: null, reason: "empty" };
  const status = /^STATUS:\s*([A-Z0-9_]+):\s*(COMPLETE|PARTIAL)\s*$/m.exec(text);
  if (!status) return { complete: false, statusKey: null, reason: "missing-status" };
  if (status[1] !== wave.statusKey) {
    return { complete: false, statusKey: status[1] ?? null, reason: "wrong-status" };
  }
  if (status[2] !== "COMPLETE") return { complete: false, statusKey: status[1] ?? null, reason: "missing-status" };
  if (!text.includes(wave.doneMarker)) {
    return { complete: false, statusKey: status[1] ?? null, reason: "missing-marker" };
  }
  return { complete: true, statusKey: status[1] ?? null, reason: "ok" };
}

/** A missing count cannot be treated as a clean audit by automatic mode. */
export function parseZaicodeAuditActionableFindings(text: string): number | null {
  const matches = [...text.matchAll(/^ACTIONABLE_FINDINGS:\s*(\d+)\s*$/gm)];
  if (matches.length !== 1) return null;
  const count = Number(matches[0]?.[1]);
  return Number.isSafeInteger(count) ? count : null;
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
