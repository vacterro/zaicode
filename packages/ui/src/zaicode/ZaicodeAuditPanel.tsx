/* eslint-disable max-lines -- Audit centre: project picker, auditor, live campaigns, auto loop and history (SRC-060) */
import { useEffect, useMemo, useState } from "react";
import { ListChecks, Play, Plus, Zap } from "lucide-react";
import {
  ZAICODE_AUDIT_PROFILE,
  describeZaicodeAuditCampaign,
  formatZaicodeAuditElapsed,
  zaicodeAuditCampaignIsActive,
  zaicodeAuditProjectState,
  zaicodeAuditStage,
  zaicodeAuditTotalMs,
  type ZaicodeAuditProjectState,
} from "@zcode/shared";
import { Switch } from "@/components/ui/switch.js";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import type { ZaicodeServices, ZaicodeWorkspaceContext } from "./zaicodeServices.js";
import { useZaicodeAuditStore, type ZaicodeAuditProject } from "./zaicodeAuditStore.js";
import { readZaicodeKnownProjects } from "./zaicodeScheduler.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";
import { ZaicodeAuditCampaignCard } from "./ZaicodeAuditCampaignCard.js";

/**
 * ZAICODE Audits (T-66, SRC-049; reworked for SRC-060: "which projects, which
 * model, where it runs now, at what stage, for how long"). An audit is an A3
 * campaign: three waves by the Auditor agent, each an ordinary queue job,
 * each gated by its report's STATUS line (AUDAPACK's mechanism). This view
 * covers every project, not only the open one.
 */

const STATE_LABEL: Record<ZaicodeAuditProjectState, string> = {
  idle: "never audited",
  planned: "planned",
  running: "running",
  stopped: "stopped",
  done: "done",
};

const STATE_CLASS: Record<ZaicodeAuditProjectState, string> = {
  idle: "border-border text-foreground-subtlest",
  planned: "border-yellow-700/60 text-yellow-300",
  running: "border-blue-600/70 text-blue-300",
  stopped: "border-red-700/70 text-red-300",
  done: "border-green-700/70 text-green-300",
};

const HISTORY_LIMIT = 12;

export interface ZaicodeAuditPanelProps {
  services: ZaicodeServices;
  workspace: ZaicodeWorkspaceContext;
}

function nameOfPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function ZaicodeAuditPanel({ services, workspace }: ZaicodeAuditPanelProps) {
  const store = useZaicodeAuditStore();
  const audits = services.audits;
  const [now, setNow] = useState(() => Date.now());
  const [archiving, setArchiving] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set([workspace.workspacePath]));

  const projects: ZaicodeAuditProject[] = useMemo(() => {
    const known = readZaicodeKnownProjects().map((project) => ({
      workspaceKey: project.key,
      workspacePath: project.path,
      projectName: project.name || nameOfPath(project.path),
    }));
    if (!known.some((project) => project.workspacePath === workspace.workspacePath)) {
      known.unshift({
        workspaceKey: workspace.workspaceKey,
        workspacePath: workspace.workspacePath,
        projectName: nameOfPath(workspace.workspacePath),
      });
    }
    return known;
    // The known-project list is published by the sidebar; re-read on every store refresh.
  }, [store.campaigns, workspace.workspaceKey, workspace.workspacePath]);

  const running = store.campaigns.some((campaign) => campaign.status === "running");
  useEffect(() => {
    if (audits) void store.refresh(audits);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audits]);
  // A running wave ticks its clocks every second and re-reads its job every 5 s.
  useEffect(() => {
    if (!audits || !running) return;
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(() => void useZaicodeAuditStore.getState().refresh(audits), 5000);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(poll);
    };
  }, [audits, running]);

  if (!audits) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <p className="text-ui-xs text-foreground-muted">
          Audits need the local ZAICODE host (its queue runs the audit waves); this connection does not provide it.
        </p>
      </div>
    );
  }

  const chosen = projects.filter((project) => selected.has(project.workspacePath));
  const toggle = (path: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const startOn = (list: readonly ZaicodeAuditProject[], planOnly: boolean) => {
    if (list.length === 0) return;
    for (const project of list) {
      if (planOnly) void store.generate(audits, project);
      else void store.start(audits, project);
    }
    playZaicodeSound(planOnly ? "audit.plan" : "audit.start");
    const names = list.map((project) => project.projectName).join(", ");
    toast(
      planOnly
        ? `Planned an audit for ${names}. Nothing runs until you press Start on it.`
        : `Audit started for ${names}: wave 1 (Core correctness) is on the queue.`,
    );
  };

  const active = store.campaigns.filter(zaicodeAuditCampaignIsActive);
  const history = store.campaigns.filter((campaign) => !zaicodeAuditCampaignIsActive(campaign)).slice(0, HISTORY_LIMIT);
  const waves = ZAICODE_AUDIT_PROFILE.waves;
  const archivable = store.campaigns.filter((campaign) => campaign.status !== "running" && campaign.live?.status !== "running" && campaign.remediationStatus !== "running");
  const archiveIdle = async () => {
    if (!audits || archiving) return;
    setArchiving(true);
    try {
      for (const campaign of archivable) {
        await store.archive(audits, campaign.campaignId);
        if (useZaicodeAuditStore.getState().error) break;
      }
    } finally { setArchiving(false); }
  };

  return (
    <div className="flex h-full min-h-0 flex-col text-ui-xs" data-zaicode-audit-center data-zaicode-help="audit">
      <div className="flex shrink-0 flex-col gap-1 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <button type="button" className="shrink-0 border border-border px-1.5 text-foreground-subtle hover:bg-hover disabled:opacity-50" disabled={archiving || archivable.length === 0} title="Archive stopped, planned and finished audits. Running audits are kept; report files stay on disk." onClick={() => void archiveIdle()}>
            {archiving ? "Archiving…" : `Archive idle (${archivable.length})`}
          </button>
          <ListChecks className="size-4 text-foreground-subtle" />
          <span className="text-ui-sm font-medium text-foreground">Audits</span>
          <span className="text-foreground-subtle">
            An audit reads a project and writes down what is wrong, in {waves.length} waves:{" "}
            {waves.map((wave, index) => (
              <span key={wave.id}>
                {index > 0 ? " → " : ""}
                <strong className="font-medium text-foreground">{wave.ordinal} {wave.title}</strong>
              </span>
            ))}
            , then one list of next actions.
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 text-foreground-subtle" data-zaicode-auditor>
          <span>
            Auditor:{" "}
            {store.auditor ? (
              <>
                <strong className="font-medium text-foreground">{store.auditor.name}</strong>
                {" · "}
                <span className="font-mono">{store.auditor.model ?? "the default model"}</span>
              </>
            ) : (
              <span>none yet — the first audit creates one from the Auditor template</span>
            )}
          </span>
          <span className="text-foreground-subtlest">Change its model in Agents & tasks → the Auditor agent.</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="border-b border-border px-3 py-2" aria-label="Projects to audit">
          <div className="mb-1 flex items-center gap-2">
            <span className="font-medium text-foreground">1. Pick the projects</span>
            <button type="button" className="border border-border px-1 text-foreground-subtle hover:bg-hover" onClick={() => setSelected(new Set(projects.map((project) => project.workspacePath)))}>
              all
            </button>
            <button type="button" className="border border-border px-1 text-foreground-subtle hover:bg-hover" onClick={() => setSelected(new Set())}>
              none
            </button>
            <button type="button" className="border border-border px-1 text-foreground-subtle hover:bg-hover" onClick={() => setSelected(new Set([workspace.workspacePath]))}>
              only this one
            </button>
          </div>
          <div className="flex max-h-56 flex-col overflow-y-auto">
            {projects.map((project) => {
              const { state, campaign } = zaicodeAuditProjectState(store.campaigns, project.workspacePath);
              const total = campaign ? zaicodeAuditTotalMs(campaign, now) : null;
              return (
                <label key={project.workspacePath} className={cn("flex items-center gap-2 px-1 py-px hover:bg-hover", project.workspacePath === workspace.workspacePath && "bg-selected/50")}>
                  <input type="checkbox" checked={selected.has(project.workspacePath)} onChange={() => toggle(project.workspacePath)} />
                  <span className="min-w-0 flex-1 truncate text-foreground" title={project.workspacePath}>
                    {project.projectName}
                  </span>
                  {campaign && state !== "idle" ? (
                    <span className="truncate text-foreground-subtle">{zaicodeAuditStage(campaign).label}</span>
                  ) : null}
                  {total !== null ? <span className="font-mono tabular-nums text-foreground-subtlest">{formatZaicodeAuditElapsed(total)}</span> : null}
                  <span
                    className={cn("shrink-0 border px-1 text-[10px] uppercase", STATE_CLASS[state])}
                    title={campaign ? `${describeZaicodeAuditCampaign(campaign, now).stage} (${describeZaicodeAuditCampaign(campaign, now).where})` : "No audit yet"}
                  >
                    {STATE_LABEL[state]}
                  </span>
                </label>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">2.</span>
            <button
              type="button"
              disabled={chosen.length === 0}
              className="flex items-center gap-1 border border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected px-2 py-0.5 font-medium text-foreground hover:bg-hover disabled:opacity-40"
              data-zaicode-sound="audit.start"
              title="Plan and start an audit on every picked project now; each runs as queue jobs beside your other work"
              onClick={() => startOn(chosen, false)}
            >
              <Play className="size-3" />
              START audit on {chosen.length} project{chosen.length === 1 ? "" : "s"}
            </button>
            <button
              type="button"
              disabled={chosen.length === 0}
              className="flex items-center gap-1 border border-border px-2 py-0.5 text-foreground-subtle hover:bg-hover disabled:opacity-40"
              data-zaicode-sound="audit.plan"
              title="Only plan: the audits wait below until you press Start on them"
              onClick={() => startOn(chosen, true)}
            >
              <Plus className="size-3" />
              Plan only
            </button>
            <span className="text-foreground-subtlest">
              3. Watch it below: stage, time, where it runs and on which model.
            </span>
          </div>
        </section>

        <section aria-label="Audits in progress">
          <div className="px-3 pt-2 font-medium text-foreground">
            Now ({active.length === 0 ? "nothing running" : `${active.length} audit${active.length === 1 ? "" : "s"}`})
          </div>
          {active.length === 0 ? (
            <p className="px-3 pb-2 text-foreground-subtlest">Pick projects above and press START; each audit appears here with its waves and clocks.</p>
          ) : (
            active.map((campaign) => (
              <ZaicodeAuditCampaignCard
                key={campaign.campaignId}
                campaign={campaign}
                audits={audits}
                now={now}
                onWork={(campaignId) => void store.work(audits, campaignId)}
                onRetry={(campaignId) => void store.retry(audits, campaignId)}
                onFix={(campaignId) => void store.fixWithSaipen(audits, campaignId)}
                onCancel={(campaignId) => void store.cancel(audits, campaignId)}
                onArchive={(campaignId) => void store.archive(audits, campaignId)}
              />
            ))
          )}
        </section>

        <section className="border-t border-border px-3 py-2" aria-label="Automatic audits">
          <div className="flex flex-wrap items-center gap-2">
            <Zap className="size-3 text-foreground-subtle" />
            <span className="font-medium text-foreground">Automatic audits</span>
            <Switch checked={store.smartMode} onCheckedChange={(enabled) => void store.setSmartMode(audits, enabled)} />
            <label className="flex items-center gap-1 text-foreground-subtle">
              up to
              <select
                aria-label="Maximum automatic audits per project"
                className="h-5 border border-border bg-background px-1 text-foreground"
                value={store.maxCycles}
                onChange={(event) => void store.setMaxCycles(audits, Number(event.target.value))}
              >
                {Array.from({ length: 10 }, (_, index) => index + 1).map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
              per project
            </label>
          </div>
          <p className="mt-1 text-foreground-subtlest">
            On: when a project's SAIPEN board is empty and nothing runs there, it audits itself, then an
            implementer agent works through the findings, then it audits again — until an audit finds
            nothing or the limit is reached. Switched-off projects are never touched.
          </p>
        </section>

        {/*
          SRC-151:R008. Its own row, above the automatic-audits block and outside it,
          because it governs BOTH: an audit the operator started by hand and one
          smart mode started itself. Burying it under "automatic audits" is what
          made it unfindable in the first place.
        */}
        <section className="border-t border-border px-3 py-2" aria-label="Wave generation" data-zaicode-audit-waves>
          <div className="flex flex-wrap items-center gap-2">
            <ListChecks className="size-3 text-foreground-subtle" />
            <span className="font-medium text-foreground">Generate the next wave by itself</span>
            <Switch
              checked={store.autoWaves}
              aria-label="Generate the next A3 wave by itself"
              onCheckedChange={(enabled) => void store.setAutoWaves(audits, enabled)}
            />
            <span className="text-foreground-subtlest">{store.autoWaves ? "on" : "off — nothing starts itself"}</span>
          </div>
          <p className="mt-1 text-foreground-subtlest">
            {store.autoWaves
              ? "A validated wave starts the next one on its own, all the way to 3/3. This is the default and what every running audit is doing right now."
              : "Off means off for the automatic path too: Auto Continue never opens an audit on its own, not even the first wave. An audit you start by hand runs its first wave, then waits for Continue after each wave. Turn this back on and every waiting audit picks up where it stopped."}
          </p>
        </section>

        {history.length > 0 ? (
          <section className="border-t border-border" aria-label="Finished audits">
            <div className="px-3 pt-2 font-medium text-foreground">Finished</div>
            {history.map((campaign) => (
              <ZaicodeAuditCampaignCard
                key={campaign.campaignId}
                campaign={campaign}
                audits={audits}
                now={now}
                onWork={(campaignId) => void store.work(audits, campaignId)}
                onRetry={(campaignId) => void store.retry(audits, campaignId)}
                onFix={(campaignId) => void store.fixWithSaipen(audits, campaignId)}
                onCancel={(campaignId) => void store.cancel(audits, campaignId)}
                onArchive={(campaignId) => void store.archive(audits, campaignId)}
              />
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}
