import { useState } from "react";
import { ClipboardCopy, ExternalLink, FileText, Play, RotateCcw, Wrench, X } from "lucide-react";
import {
  formatZaicodeAuditElapsed,
  zaicodeAuditIdle,
  zaicodeAuditStage,
  zaicodeAuditSteps,
  zaicodeAuditTotalMs,
  type ZaicodeAuditCampaign,
  type ZaicodeAuditStepState,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { openZaicodeSession } from "./zaicodeSessionNav.js";
import type { ZaicodeServices } from "./zaicodeServices.js";

/**
 * One audit campaign, read out the way AUDAPACK's widget does it (SRC-060):
 * a step per wave with its state and time, the stage in words, the total
 * time, where the current wave runs (its session, openable), which model, and
 * an idle watchdog. Finished waves copy to the clipboard in one click.
 */

const STEP_CLASS: Record<ZaicodeAuditStepState, string> = {
  done: "border-green-700/70 bg-green-900/30 text-green-300",
  active: "border-blue-600/80 bg-blue-900/40 text-blue-200 animate-pulse",
  waiting: "border-border text-foreground-subtlest",
  planned: "border-yellow-700/60 bg-yellow-900/20 text-yellow-300/80",
  failed: "border-red-700/70 bg-red-900/30 text-red-300",
  cancelled: "border-zinc-700 text-zinc-500 line-through",
};

const STEP_MARK: Record<ZaicodeAuditStepState, string> = {
  done: "✓",
  active: "●",
  waiting: "○",
  planned: "○",
  failed: "✕",
  cancelled: "–",
};

const IDLE_CLASS = { ok: "text-green-300", quiet: "text-yellow-300", stalled: "text-red-300" } as const;

export function ZaicodeAuditCampaignCard({
  campaign,
  audits,
  now,
  onWork,
  onRetry,
  onFix,
  onCancel,
  onArchive,
}: {
  campaign: ZaicodeAuditCampaign;
  audits: NonNullable<ZaicodeServices["audits"]>;
  now: number;
  onWork: (campaignId: string) => void;
  onRetry: (campaignId: string) => void;
  onFix: (campaignId: string) => void;
  onCancel: (campaignId: string) => void;
  onArchive?: (campaignId: string) => void;
}) {
  const [report, setReport] = useState<string | null>(null);
  const steps = zaicodeAuditSteps(campaign, now);
  const stage = zaicodeAuditStage(campaign);
  const total = zaicodeAuditTotalMs(campaign, now);
  const idle = zaicodeAuditIdle(campaign, now);
  const live = campaign.live ?? null;
  const active = campaign.status === "planned" || campaign.status === "running" || campaign.status === "blocked";
  const currentWave = campaign.waves[campaign.currentWaveIndex];
  const stopped = campaign.status === "blocked";
  const complete = campaign.status === "complete" && campaign.combined !== null && campaign.combined !== undefined;

  const showCurrentReport = async () => {
    if (!currentWave?.reportFile) return;
    const markdown = await audits.readReport(campaign.campaignId, currentWave.waveId);
    setReport(markdown ?? "(no report yet: the wave is still writing it)");
  };
  const showCombined = async () => {
    if (!campaign.combined) return;
    const markdown = await audits.readCombined(campaign.campaignId);
    setReport(markdown ?? "(the combined file is recorded but is not on disk)");
  };
  const copyFinished = async () => {
    // Once it exists, the combined file IS the handoff -- copying the waves
    // back to back would drop the header, the digests and the chain.
    if (campaign.combined) {
      const combined = await audits.readCombined(campaign.campaignId);
      if (!combined) {
        toast("The combined file is recorded but is not on disk");
        return;
      }
      await navigator.clipboard.writeText(combined);
      toast(`Copied ${campaign.combined.file}`);
      return;
    }
    const parts: string[] = [];
    for (const wave of campaign.waves) {
      if (wave.status !== "complete") continue;
      const markdown = await audits.readReport(campaign.campaignId, wave.waveId);
      if (markdown) parts.push(markdown.trim());
    }
    if (parts.length === 0) {
      toast("No finished wave to copy yet");
      return;
    }
    await navigator.clipboard.writeText(parts.join("\n\n---\n\n"));
    toast(`Copied ${parts.length} finished wave report${parts.length === 1 ? "" : "s"}`);
  };

  return (
    <div className="flex flex-col gap-1.5 border-b border-border/50 px-3 py-2 last:border-0" data-zaicode-audit-campaign={campaign.status}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-medium text-foreground">{campaign.projectName}</span>
        <span className="text-foreground-subtle">{stage.label}</span>
        <span className="font-mono text-foreground-subtlest">{stage.done}/{stage.total}</span>
        {total !== null ? (
          <span className="font-mono tabular-nums text-foreground-subtle" title="Time since the first wave was put on the queue">
            ⏱ {formatZaicodeAuditElapsed(total)}
          </span>
        ) : null}
        {campaign.smartRunId ? (
          <span className="border border-border px-1 text-[10px] text-foreground-subtlest" title="Started by the automatic audit loop (Auto)">
            auto
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1">
          {campaign.status === "planned" ? (
            <button type="button" className="flex items-center gap-1 border border-border px-1.5 py-px hover:bg-hover" data-zaicode-sound="audit.start" onClick={() => onWork(campaign.campaignId)}>
              <Play className="size-3" /> Start
            </button>
          ) : null}
          {currentWave?.reportFile ? (
            <button type="button" className="flex items-center gap-1 border border-border px-1.5 py-px hover:bg-hover" title="Show the current wave's report" onClick={() => void showCurrentReport()}>
              <FileText className="size-3" /> Report
            </button>
          ) : null}
          {campaign.combined ? (
            <button
              type="button"
              className="flex items-center gap-1 border border-border px-1.5 py-px hover:bg-hover"
              title={`The combined handoff: ${campaign.combined.file} (sha256 ${campaign.combined.sha256})`}
              onClick={() => void showCombined()}
            >
              <FileText className="size-3" /> Handoff
            </button>
          ) : null}
          {stopped ? (
            <button
              type="button"
              className="flex items-center gap-1 border border-[var(--zaicode-highlight,var(--color-border-hover))] px-1.5 py-px hover:bg-hover"
              data-zaicode-sound="audit.start"
              title={`Run this same wave again (attempt ${(currentWave?.attempt ?? 0) + 1}). The wave index does not move.`}
              onClick={() => onRetry(campaign.campaignId)}
            >
              <RotateCcw className="size-3" /> Retry wave {(currentWave?.attempt ?? 0) + 1}
            </button>
          ) : null}
          {complete ? (
            <button
              type="button"
              className="flex items-center gap-1 border border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected px-1.5 py-px font-medium hover:bg-hover"
              data-zaicode-sound="audit.start"
              title="Start an implementation task that reads this exact combined artifact. The audit stays read-only."
              onClick={() => onFix(campaign.campaignId)}
            >
              <Wrench className="size-3" />
              {campaign.fixJobId ? "Fixing with SAIPEN…" : "Fix with SAIPEN"}
            </button>
          ) : null}
          {stage.done > 0 ? (
            <button type="button" className="flex items-center gap-1 border border-border px-1.5 py-px hover:bg-hover" title="Copy every finished wave's report to the clipboard" onClick={() => void copyFinished()}>
              <ClipboardCopy className="size-3" /> Copy {stage.done === stage.total ? "handoff" : "done waves"}
            </button>
          ) : null}
          {active ? (
            <button type="button" className="flex items-center gap-1 border border-border px-1.5 py-px text-foreground-subtle hover:bg-hover" data-zaicode-sound="audit.cancel" title="Cancel the audit and its wave job" onClick={() => onCancel(campaign.campaignId)}>
              <X className="size-3" /> Cancel
            </button>
          ) : null}
        </span>
            {onArchive && campaign.status !== "running" && live?.status !== "running" ? (
              <button type="button" className="border border-border px-1.5 py-px text-foreground-subtle hover:bg-hover" title="Archive this audit from the list; reports stay on disk" onClick={() => onArchive(campaign.campaignId)}>Archive</button>
            ) : null}
          </div>

      <ol className="flex flex-wrap items-stretch gap-1" aria-label="Audit waves">
        {steps.map((step, index) => (
          <li key={step.ordinal} className="flex items-center gap-1">
            {index > 0 ? <span className="text-foreground-subtlest">→</span> : null}
            <span className={cn("flex items-center gap-1 border px-1.5 py-px font-mono text-[11px]", STEP_CLASS[step.state])} title={`Wave ${step.ordinal}: ${step.title} — ${step.state}`}>
              <span>{STEP_MARK[step.state]}</span>
              <span>{step.ordinal} {step.title}</span>
              {step.elapsedMs !== null ? <span className="opacity-80">{formatZaicodeAuditElapsed(step.elapsedMs)}</span> : null}
            </span>
          </li>
        ))}
      </ol>

      {live || idle ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-foreground-subtle">
          {live?.sessionId ? (
            <button
              type="button"
              className="flex items-center gap-1 underline decoration-dotted hover:text-foreground"
              title="Open the session that runs this wave"
              onClick={() =>
                openZaicodeSession({
                  sessionId: live.sessionId!,
                  title: `A3 ${campaign.projectName}`,
                  workspacePath: campaign.workspacePath,
                })
              }
            >
              <ExternalLink className="size-3" /> Where: its session
            </button>
          ) : live ? (
            <span>Where: waiting in the queue ({live.status})</span>
          ) : null}
          {live?.agentName ? <span>Agent: {live.agentName}</span> : null}
          {live?.model ? <span>Model: {live.model}</span> : null}
          {live && live.attempt > 1 ? <span>Attempt {live.attempt}</span> : null}
          {idle ? (
            <span className={IDLE_CLASS[idle.level]} title="Time since the running wave last showed a sign of life">
              Last sign of life {formatZaicodeAuditElapsed(idle.idleMs)} ago
              {idle.level === "stalled" ? " — looks stuck: open the session or cancel" : idle.level === "quiet" ? " — quiet" : ""}
            </span>
          ) : null}
        </div>
      ) : null}

      {stopped ? (
        <p className="text-[11px] text-red-300">
          Stopped at wave {currentWave?.waveId}: {currentWave?.rejectReason ?? "the wave's job did not finish cleanly"}.
          Nothing was advanced — retry re-runs this same wave, or cancel.
        </p>
      ) : null}
      {campaign.combined ? (
        <p className="text-[11px] text-foreground-subtle">
          Handoff <span className="font-mono">{campaign.combined.file}</span> · sha256{" "}
          <span className="font-mono">{campaign.combined.sha256.slice(0, 12)}</span> ·{" "}
          {campaign.findings ?? 0} verified finding{(campaign.findings ?? 0) === 1 ? "" : "s"}
          {campaign.sourceDrift?.changed
            ? ` · source moved since the audit (${campaign.sourceDrift.audited} → ${campaign.sourceDrift.atFix})`
            : ""}
          {campaign.fixJobId ? ` · fix task ${campaign.remediationStatus ?? "queued"}` : ""}
        </p>
      ) : null}
      {campaign.smartRunId && !campaign.combined && campaign.findings !== undefined ? (
        <p className="text-[11px] text-foreground-subtle">
          {campaign.findings === 0
            ? "No actionable findings: Auto stops auditing this project."
            : `${campaign.findings} verified finding${campaign.findings === 1 ? "" : "s"} so far`}
        </p>
      ) : null}
      {report !== null ? (
        <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words border-t border-border/40 pt-1 font-mono text-[10px] text-foreground-subtle">
          {report}
        </pre>
      ) : null}
    </div>
  );
}
