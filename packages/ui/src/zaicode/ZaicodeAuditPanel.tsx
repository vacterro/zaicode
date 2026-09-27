/* eslint-disable max-lines -- Audit panel: campaign queue + generate controls (T-66) */
import { useCallback, useEffect, useState } from "react";
import { ClipboardCopy, ListChecks, Plus, Play, X, Zap } from "lucide-react";
import {
  ZAICODE_AUDIT_PROFILE_A3,
  describeZaicodeAuditCampaign,
  formatZaicodeAuditElapsed,
  type ZaicodeAuditCampaign,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import type { ZaicodeServices, ZaicodeWorkspaceContext } from "./zaicodeServices.js";
import { useZaicodeAuditStore } from "./zaicodeAuditStore.js";

/**
 * ZAICODE A3 audit queue (T-66, SRC-049), AUDAPACK's own mechanism: campaigns
 * are generated ahead of time as `planned` and wait here editable and visible;
 * Work dispatches the next wave as a real queue job (parallel with any other
 * session's work); the wave's report file gates completion.
 */

const CAMPAIGN_STATUS_LABEL: Record<ZaicodeAuditCampaign["status"], string> = {
  planned: "planned",
  running: "running",
  complete: "complete",
  blocked: "blocked",
  cancelled: "cancelled",
};

const CAMPAIGN_STATUS_CLASS: Record<ZaicodeAuditCampaign["status"], string> = {
  planned: "bg-yellow-900/40 text-yellow-300 border-yellow-700/60",
  running: "bg-blue-900/40 text-blue-300 border-blue-700/60",
  complete: "bg-green-900/40 text-green-300 border-green-700/60",
  blocked: "bg-red-900/40 text-red-300 border-red-700/60",
  cancelled: "bg-zinc-800 text-zinc-500 border-zinc-700",
};

const WAVE_STATUS_CLASS: Record<string, string> = {
  pending: "text-foreground-muted",
  running: "text-blue-300",
  complete: "text-green-300",
  partial: "text-red-300",
  blocked: "text-red-400",
};

function StatusBadge({ status }: { status: ZaicodeAuditCampaign["status"] }) {
  return (
    <span
      className={cn(
        "border px-1 py-px text-[10px] uppercase tracking-wider font-mono",
        CAMPAIGN_STATUS_CLASS[status],
      )}
    >
      {CAMPAIGN_STATUS_LABEL[status]}
    </span>
  );
}

function CampaignCard({
  campaign,
  audits,
  onWork,
  onCancel,
}: {
  campaign: ZaicodeAuditCampaign;
  audits: NonNullable<ZaicodeServices["audits"]>;
  onWork: (campaignId: string) => void;
  onCancel: (campaignId: string) => void;
}) {
  const [report, setReport] = useState<string | null>(null);
  const readout = describeZaicodeAuditCampaign(campaign);
  const currentWave = campaign.waves[campaign.currentWaveIndex];
  const doneCount = campaign.waves.filter((wave) => wave.status === "complete").length;
  const isActive = campaign.status === "planned" || campaign.status === "running" || campaign.status === "blocked";
  const openReport = useCallback(async () => {
    if (report !== null || !currentWave?.reportFile) return;
    const markdown = await audits.readReport(campaign.campaignId, currentWave.waveId);
    setReport(markdown ?? "(no report yet)");
  }, [audits, campaign.campaignId, currentWave, report]);

  return (
    <div className="border-b border-border/50 last:border-0">
      <div className="flex items-center gap-2 bg-background-secondary/50 px-3 py-1">
        <StatusBadge status={campaign.status} />
        <span className="text-[10px] text-foreground-muted">
          {new Date(campaign.createdAt).toLocaleString()}
        </span>
        <span className="text-[10px] font-mono text-foreground-subtle">
          {doneCount}/{campaign.waves.length} waves
        </span>
        {/* SRC-060: the operator asked to know at a glance which project, which
            model, where it is, at what stage and for how long. All five come
            from one read model so they cannot disagree with each other. */}
        <span
          className="truncate text-[10px] text-foreground-subtle"
          title={`${readout.projectName} — ${readout.workspacePath}
stage: ${readout.stage}
model: ${readout.agentId ?? "not chosen yet"}
running for: ${formatZaicodeAuditElapsed(readout.elapsedMs)}`}
        >
          {readout.where} · {readout.stage} · {readout.agentId ?? "no model yet"} ·{" "}
          {formatZaicodeAuditElapsed(readout.elapsedMs)}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {currentWave?.reportFile && (
            <Button
              size="icon-xs"
              variant="ghost"
              title="Show the current wave's report"
              onClick={() => void openReport()}
            >
              <ClipboardCopy className="size-3" />
            </Button>
          )}
          {campaign.status === "planned" && (
            <Button
              size="icon-xs"
              variant="ghost"
              title="Work it: dispatch wave 1 onto the queue"
              onClick={() => onWork(campaign.campaignId)}
            >
              <Play className="size-3" />
            </Button>
          )}
          {isActive && (
            <Button
              size="icon-xs"
              variant="ghost"
              title="Cancel the campaign and its wave job"
              onClick={() => onCancel(campaign.campaignId)}
            >
              <X className="size-3" />
            </Button>
          )}
        </span>
      </div>
      <div className="px-3 py-1.5">
        {campaign.waves.map((state) => {
          const wave = ZAICODE_AUDIT_PROFILE_A3.waves.find((entry) => entry.id === state.waveId);
          return (
            <div key={state.waveId} className="flex items-center gap-2 py-px text-[11px]">
              <span className="font-mono text-foreground-muted">0{wave?.ordinal}</span>
              <span className="text-foreground-subtle">{wave?.title ?? state.waveId}</span>
              <span className={cn("ml-auto font-mono", WAVE_STATUS_CLASS[state.status] ?? "")}>
                {state.status}
              </span>
            </div>
          );
        })}
        {campaign.smartRunId && campaign.actionableFindings !== undefined && (
          <div className="mt-1 border-t border-border/40 pt-1 text-[11px] text-foreground-subtle">
            {campaign.actionableFindings === 0
              ? "No actionable findings · Auto stopped for this project"
              : campaign.actionableFindings === null
                ? "Final report incomplete or missing ACTIONABLE_FINDINGS count"
                : `${campaign.actionableFindings} actionable findings · implementation ${campaign.remediationStatus ?? (campaign.remediationJobId ? "unknown" : "pending")}`}
          </div>
        )}
        {report && (
          <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words border-t border-border/40 pt-1 font-mono text-[10px] text-foreground-subtle">
            {report}
          </pre>
        )}
      </div>
    </div>
  );
}

export interface ZaicodeAuditPanelProps {
  services: ZaicodeServices;
  workspace: ZaicodeWorkspaceContext;
}

export function ZaicodeAuditPanel({ services, workspace }: ZaicodeAuditPanelProps) {
  const store = useZaicodeAuditStore();
  const audits = services.audits;
  const campaigns = audits ? store.campaignsFor(workspace.workspacePath) : [];

  useEffect(() => {
    if (audits) void store.refresh(audits);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audits, workspace.workspacePath]);

  if (!audits) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <p className="text-ui-xs text-foreground-muted">
          A3 audits need a local host with the audit service; this connection does not provide it.
        </p>
      </div>
    );
  }

  const project = {
    workspaceKey: workspace.workspaceKey,
    workspacePath: workspace.workspacePath,
    projectName: workspace.workspacePath.split(/[\\/]/).pop() ?? workspace.workspacePath,
  };
  const generate = () => {
    void store.generate(audits, project);
    toast("A3 campaign generated: 3 waves planned in the review queue — nothing dispatched yet");
  };
  const startNow = () => {
    void store.start(audits, project);
    toast("A3 campaign started: wave 1 dispatched onto the queue");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-ui-xs font-medium text-foreground">Audits</span>
        <label
          className="flex items-center gap-1 text-[10px] text-foreground-muted"
          title="Smart mode: an empty SAIPEN board with nothing running audits itself"
        >
          <Zap className="size-3" />
          smart
          <Switch checked={store.smartMode} onCheckedChange={(enabled) => void store.setSmartMode(audits, enabled)} />
        </label>
        <label className="flex items-center gap-1 text-[10px] text-foreground-muted" title="Maximum automatic A3 campaigns per project in one Auto run">
          Max A3
          <select
            aria-label="Maximum automatic A3 campaigns"
            className="h-5 border border-border bg-background px-1 text-foreground"
            value={store.maxCycles}
            onChange={(event) => void store.setMaxCycles(audits, Number(event.target.value))}
          >
            {Array.from({ length: 10 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        </label>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="outline" title="Generate + work: a new A3 campaign, wave 1 dispatched now" onClick={startNow}>
            <ListChecks className="mr-1 size-3" />
            Audit now
          </Button>
          <Button
            size="sm"
            variant="outline"
            title="Generate an A3 campaign (3 waves) into the review queue; work it later"
            onClick={generate}
          >
            <Plus className="mr-1 size-3" />
            Generate A3
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {campaigns.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-ui-xs text-foreground-muted">No audit campaigns yet.</p>
            <p className="text-[11px] text-foreground-muted">
              Press <strong>Generate A3</strong> to plan a Core → Completeness → Performance
              campaign, or <strong>Audit now</strong> to start it immediately.
            </p>
          </div>
        ) : (
          campaigns.map((campaign) => (
            <CampaignCard
              key={campaign.campaignId}
              campaign={campaign}
              audits={audits}
              onWork={(campaignId) => void store.work(audits, campaignId)}
              onCancel={(campaignId) => void store.cancel(audits, campaignId)}
            />
          ))
        )}
      </div>
      <div className="shrink-0 border-t border-border/40 px-3 py-1">
        <p className="text-[10px] text-foreground-muted">
          Every wave is an ordinary queue job: one session audits while another finishes its work.
          A wave only counts when its report carries the STATUS line.
        </p>
      </div>
    </div>
  );
}
