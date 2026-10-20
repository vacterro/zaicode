/* eslint-disable max-lines -- Quick3 Factory: Batch Audits, Parallel Agent Workers, and Production Orchestration UX */
import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  FileText,
  Layers,
  ListChecks,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Server,
  Square,
  Users,
  Zap,
} from "lucide-react";
import {
  ZAICODE_AUDIT_PROFILE,
  formatZaicodeAuditElapsed,
  zaicodeAuditCampaignIsActive,
  zaicodeAuditProjectState,
  zaicodeAuditStage,
  zaicodeAuditTotalMs,
  type ZaicodeAuditProjectState,
} from "@zcode/shared";
import { Switch } from "@/components/ui/switch.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import type { ZaicodeServices, ZaicodeWorkspaceContext } from "./zaicodeServices.js";
import { useZaicodeAuditStore, type ZaicodeAuditProject } from "./zaicodeAuditStore.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { readZaicodeKnownProjects } from "./zaicodeScheduler.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";
import { ZaicodeAutoSettingsPanel } from "./ZaicodeAutoSettings.js";
import { ZaicodeAuditCampaignCard } from "./ZaicodeAuditCampaignCard.js";
import { openZaicodeSession } from "./zaicodeSessionNav.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import {
  captureAllSessionDriftDetailed,
  exportDriftReviewPack,
} from "./zaicodeSessionDriftCapture.js";
import { validateDriftStorageRoot } from "./zaicodeDriftCaptureContract.js";
import { ZaicodeDriftSettings } from "./ZaicodeDriftSettings.js";
import { useDriftCaptureStore } from "./zaicodeDriftCaptureStore.js";
/**
 * Quick3 Production-Grade Orchestration UX.
 * 4 clear areas:
 * Area A: Batch Setup (Multi-project admission, profile, capacity, model policy, workload summary)
 * Area B: Live Production (Summary metrics, active worker instances, truthful status)
 * Area C: Project Pipeline (Multi-wave progress table, wave badges, worker attribution, actions)
 * Area D: Consolidated Results (Completed batches & campaigns, combined handoffs, fix with SAIPEN)
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

/** Evidence bytes the capture center knows about; the vault folder may hold more. */
function driftEvidenceBytes(): number {
  return Object.values(useDriftCaptureStore.getState().receipts).reduce(
    (sum, receipt) => sum + (receipt.fileSize ?? 0),
    0,
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function ZaicodeAuditPanel({ services, workspace }: ZaicodeAuditPanelProps) {
  const store = useZaicodeAuditStore();
  const audits = services.audits;
  const baseServices = useOptionalBaseWorkspaceServices();
  const platform = useOptionalPlatform();
  const [now, setNow] = useState(() => Date.now());
  const [archiving, setArchiving] = useState(false);
  const [startingBatch, setStartingBatch] = useState(false);
  const [capturingDrift, setCapturingDrift] = useState(false);
  const [exportingDrift, setExportingDrift] = useState(false);
  const [pendingBatchAction, setPendingBatchAction] = useState<string | null>(null);
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
  }, [workspace.workspaceKey, workspace.workspacePath]);

  const running = store.campaigns.some((campaign) => campaign.status === "running");

  useEffect(() => {
    if (audits) void store.refresh(audits, services.jobs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audits, services.jobs]);

  useEffect(() => {
    if (!audits) return;
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const handlePoll = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void useZaicodeAuditStore.getState().refresh(audits, services.jobs);
    };
    const poll = window.setInterval(handlePoll, running ? 3000 : 8000);
    const onVisibilityChange = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        void useZaicodeAuditStore.getState().refresh(audits, services.jobs);
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    return () => {
      window.clearInterval(clock);
      window.clearInterval(poll);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [audits, services.jobs, running]);

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

  const startBatch = async (planOnly: boolean) => {
    if (chosen.length === 0 || startingBatch) return;
    setStartingBatch(true);
    try {
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const result = await store.createBatch(audits, {
        requestId,
        projects: chosen,
        planOnly,
        workerCapacity: store.globalConcurrency,
        autoWaves: store.autoWaves,
      });
      playZaicodeSound(planOnly ? "audit.plan" : "audit.start");
      if (result) {
        toast(
          planOnly
            ? `Planned Quick3 batch for ${result.admittedCount} projects (${result.skippedCount} skipped, ${result.duplicateCount} duplicates).`
            : `Started Quick3 batch for ${result.admittedCount} projects with capacity ${store.globalConcurrency}.`,
        );
      }
    } finally {
      setStartingBatch(false);
    }
  };

  const changeCapacity = async (delta: number) => {
    const next = Math.max(1, Math.min(16, store.globalConcurrency + delta));
    await store.setGlobalConcurrency(services.jobs, next);
  };

  const handleBatchPause = async (batchId: string) => {
    if (pendingBatchAction) return;
    setPendingBatchAction(`${batchId}:pause`);
    try {
      const batch = await store.pauseBatch(audits, batchId);
      if (!batch) {
        toast(`Batch ${batchId} pause rejected.`);
        return;
      }
      if (batch.status === "paused") {
        const busy = store.activeWorkers.filter((w) => w.batchId === batchId).length;
        if (busy > 0) {
          toast(`Batch ${batchId} paused. ${busy} worker${busy > 1 ? "s" : ""} still finishing.`);
        } else {
          toast(`Batch ${batchId} paused.`);
        }
      } else {
        toast(`Batch ${batchId} pause requested (status: ${batch.status}).`);
      }
    } catch (err) {
      toast(`Failed to pause batch: ${String(err)}`);
    } finally {
      setPendingBatchAction(null);
    }
  };

  const handleBatchResume = async (batchId: string) => {
    if (pendingBatchAction) return;
    setPendingBatchAction(`${batchId}:resume`);
    try {
      const batch = await store.resumeBatch(audits, batchId);
      if (!batch) {
        toast(`Batch ${batchId} resume rejected.`);
        return;
      }
      if (batch.status === "running") {
        toast(`Batch ${batchId} resumed.`);
      } else {
        toast(`Batch ${batchId} resume requested (status: ${batch.status}).`);
      }
    } catch (err) {
      toast(`Failed to resume batch: ${String(err)}`);
    } finally {
      setPendingBatchAction(null);
    }
  };

  const handleBatchStop = async (batchId: string) => {
    if (pendingBatchAction) return;
    const confirmed = await useConfirmDialogStore.getState().requestConfirmation({
      title: `Stop and cancel batch ${batchId}?`,
      description: "Active workers will be halted.",
      confirmLabel: "Stop batch",
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    setPendingBatchAction(`${batchId}:stop`);
    try {
      const batch = await store.stopBatch(audits, batchId);
      if (!batch) {
        toast(`Batch ${batchId} stop rejected.`);
        return;
      }
      if (batch.status === "cancelled") {
        toast(`Batch ${batchId} stopped.`);
      } else if (batch.status === "stopping" || batch.status === "stop_requested") {
        const busy = store.activeWorkers.filter((w) => w.batchId === batchId).length;
        toast(`Stop requested for ${batchId}. Waiting for ${busy} worker${busy === 1 ? "" : "s"}.`);
      } else if (batch.status === "stop_partial") {
        const failedCount = batch.stopDetails?.failedCampaignIds.length ?? 1;
        toast(`Stop partial for ${batchId}. ${failedCount} worker${failedCount === 1 ? "" : "s"} could not terminate.`);
      } else if (batch.status === "stop_failed") {
        toast(`Stop failed for ${batchId}. Workers refused termination.`);
      } else {
        toast(`Batch ${batchId} stop requested (status: ${batch.status}).`);
      }
    } catch (err) {
      toast(`Failed to stop batch: ${String(err)}`);
    } finally {
      setPendingBatchAction(null);
    }
  };

  const handleBatchRetry = async (batchId: string) => {
    if (pendingBatchAction) return;
    setPendingBatchAction(`${batchId}:retry`);
    try {
      const batch = await store.retryBatch(audits, batchId, "blocked_only");
      if (!batch) {
        toast(`Batch ${batchId} retry rejected.`);
        return;
      }
      if (batch.status === "cancelled") {
        toast(`Retry rejected: batch ${batchId} is cancelled.`);
      } else {
        toast(`Retrying blocked work in batch ${batchId}.`);
      }
    } catch (err) {
      toast(`Failed to retry batch: ${String(err)}`);
    } finally {
      setPendingBatchAction(null);
    }
  };

  const active = store.campaigns.filter(zaicodeAuditCampaignIsActive);
  const history = store.campaigns
    .filter((campaign) => !zaicodeAuditCampaignIsActive(campaign))
    .slice(0, HISTORY_LIMIT);
  const archivable = store.campaigns.filter(
    (campaign) =>
      campaign.status !== "running" &&
      campaign.live?.status !== "running" &&
      campaign.remediationStatus !== "running",
  );

  const archiveIdle = async () => {
    if (archiving) return;
    setArchiving(true);
    try {
      for (const campaign of archivable) {
        await store.archive(audits, campaign.campaignId);
        if (useZaicodeAuditStore.getState().error) break;
      }
    } finally {
      setArchiving(false);
    }
  };

  const captureDrift = async () => {
    if (capturingDrift) return;
    const fileService = baseServices?.fileService;
    const sessionService = baseServices?.zcodeSessionService;
    if (!fileService || !sessionService) {
      toast("Host services unavailable", { variant: "warning" });
      return;
    }
    setCapturingDrift(true);
    try {
      const workspace = await fileService.ensureConversationWorkspace();
      const settings = useDriftCaptureStore.getState().settings;
      const validation = validateDriftStorageRoot(settings.storageRoot);
      if (!validation.ok) {
        toast(validation.reason ?? "Invalid storage directory", { variant: "warning" });
        return;
      }
      const vaultRoot = settings.storageRoot.trim() || `${workspace.path.replace(/[\\/]+$/, "")}/session-drift-vault`;
      const summary = await captureAllSessionDriftDetailed({
        fileService,
        sessionService,
        vaultRoot,
        concurrency: settings.concurrency,
        skipUnchanged: settings.skipUnchanged,
        forceRecapture: settings.forceRecapture,
        includeProtocolContext: settings.includeProtocolContext,
        includeHistorical: settings.includeHistorical,
        includeHelperSessions: settings.includeHelperSessions,
        includeDisabledProjects: settings.includeDisabledProjects,
        captureAttachmentsByReference: settings.captureAttachmentsByReference,
        app: { version: "0.0.3", commit: "", buildTime: "" },
      });
      const failedProjects = summary.discovery.failedProjects;
      const failedSessions = summary.failed ? `, ${summary.failed} session(s) failed` : "";
      const suffix = failedProjects ? `, ${failedProjects} project(s) failed` : "";
      const skippedProjects = summary.discovery.skippedProjects.length;
      const skippedSuffix = skippedProjects ? `, ${skippedProjects} project(s) skipped by policy` : "";
      toast(
        `${summary.status}: ${summary.committed}/${summary.total} sessions${failedSessions}${suffix}${skippedSuffix}`,
        { variant: summary.status === "COMPLETE" ? "info" : "warning" },
      );
      if (settings.notifyOnComplete) {
        platform?.showTaskNotification({
          taskId: `drift-capture-${summary.batchId}`,
          status: summary.status === "FAILED" ? "failed" : "completed",
          title: `Drift capture ${summary.status.toLowerCase()}`,
          body: `${summary.committed}/${summary.total} sessions captured${
            failedProjects ? `, ${failedProjects} project(s) failed` : ""
          }.`,
        });
      }
      const vaultBytes = driftEvidenceBytes();
      if (settings.maxStorageWarningBytes > 0 && vaultBytes > settings.maxStorageWarningBytes) {
        toast(
          `Drift evidence holds ${formatBytes(vaultBytes)}, above the ${formatBytes(settings.maxStorageWarningBytes)} warning threshold`,
          { variant: "warning" },
        );
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { variant: "warning" });
    } finally {
      setCapturingDrift(false);
    }
  };

  const exportDrift = async () => {
    if (exportingDrift) return;
    const fileService = baseServices?.fileService;
    if (!fileService) {
      toast("Host services unavailable", { variant: "warning" });
      return;
    }
    setExportingDrift(true);
    try {
      const workspace = await fileService.ensureConversationWorkspace();
      const settings = useDriftCaptureStore.getState().settings;
      const validation = validateDriftStorageRoot(settings.storageRoot);
      if (!validation.ok) {
        toast(validation.reason ?? "Invalid storage directory", { variant: "warning" });
        return;
      }
      const vaultRoot = settings.storageRoot.trim() || `${workspace.path.replace(/[\\/]+$/, "")}/session-drift-vault`;
      const pack = await exportDriftReviewPack({
        fileService,
        vaultRoot,
        format: settings.exportBundleFormat,
        splitPartBytes: settings.exportSplitPartBytes,
        exportBinaryAttachments: settings.exportBinaryAttachments,
      });
      toast(
        `Review pack: ${pack.exportDir} (${pack.sessions} verified, ${pack.problems} problem(s), ${pack.parts} part(s))`,
      );
      if (settings.notifyOnComplete) {
        platform?.showTaskNotification({
          taskId: `drift-export-${pack.exportDir}`,
          status: "completed",
          title: "Drift review pack exported",
          body: `${pack.sessions} verified session(s), ${pack.problems} problem(s).`,
        });
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { variant: "warning" });
    } finally {
      setExportingDrift(false);
    }
  };

  const totalProjects = projects.length;
  const busySlots = store.activeWorkers.length;
  const queuedCampaigns = store.campaigns.filter((c) => c.status === "planned").length;
  const runningCampaigns = store.campaigns.filter((c) => c.status === "running").length;
  const blockedCampaigns = store.campaigns.filter((c) => c.status === "blocked").length;
  const completedCampaigns = store.campaigns.filter((c) => c.status === "complete").length;

  return (
    <div
      className="flex h-full min-h-0 flex-col text-ui-xs"
      data-zaicode-audit-center
      data-zaicode-help="audit"
    >
      {/* Top Banner / Global Controls */}
      <div className="flex shrink-0 flex-col gap-1 border-b border-border bg-surface/50 px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ListChecks className="size-4 text-[var(--zaicode-highlight,#82aaff)]" />
            <span className="text-ui-sm font-semibold text-foreground">
              Quick3 Factory Orchestration
            </span>
            <span className="rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] uppercase text-foreground-subtle">
              {ZAICODE_AUDIT_PROFILE.label} v{ZAICODE_AUDIT_PROFILE.version}
            </span>
            {store.syncState === "STALE" ? (
              <span
                className="rounded border border-warning/60 bg-warning/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-warning"
                title="Preserving last trusted snapshot while Host reconnects"
              >
                STALE (RECONNECTING)
              </span>
            ) : store.syncState === "HOST_UNAVAILABLE" ? (
              <span
                className="rounded border border-error/60 bg-error/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-error"
                title={store.error ?? "Host unavailable"}
              >
                HOST UNAVAILABLE
              </span>
            ) : store.syncState === "PARTIAL" ? (
              <span
                className="rounded border border-warning/60 bg-warning/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-warning"
                title={store.error ?? "Partial sync"}
              >
                PARTIAL SYNC
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="shrink-0 border border-border bg-surface px-2 py-0.5 text-foreground-subtle hover:bg-hover disabled:opacity-50"
              disabled={archiving || archivable.length === 0}
              title="Archive stopped, planned and finished audits. Running audits are kept; report files stay on disk."
              onClick={() => void archiveIdle()}
            >
              {archiving ? "Archiving…" : `Archive idle (${archivable.length})`}
            </button>
            <button
              type="button"
              className="shrink-0 border border-border bg-surface px-2 py-0.5 text-foreground-subtle hover:bg-hover disabled:opacity-50"
              disabled={capturingDrift}
              title="Capture all known sessions' drift evidence into the persistent vault."
              onClick={() => void captureDrift()}
            >
              {capturingDrift ? "Capturing…" : "Capture all drift"}
            </button>
            <button
              type="button"
              className="shrink-0 border border-border bg-surface px-2 py-0.5 text-foreground-subtle hover:bg-hover disabled:opacity-50"
              disabled={exportingDrift}
              title="Export captured drift evidence as a review pack."
              onClick={() => void exportDrift()}
            >
              {exportingDrift ? "Exporting…" : "Export drift review pack"}
            </button>
          </div>
        </div>

        <ZaicodeDriftSettings
          defaultStorageRoot={`${workspace.workspacePath.replace(/[/]+$/, "")}/session-drift-vault`}
        />

        {store.error ? (
          <div
            role="alert"
            className="flex items-center gap-1.5 border border-error/50 bg-error/10 px-2 py-1 text-ui-xs text-error"
          >
            <span className="font-semibold">Sync notice:</span>
            <span>{store.error}</span>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-4 text-foreground-subtle" data-zaicode-auditor>
          <span>
            Auditor Template:{" "}
            {store.auditor ? (
              <>
                <strong className="font-medium text-foreground">{store.auditor.name}</strong>
                {" · "}
                <span className="font-mono">{store.auditor.model ?? "default model"}</span>
              </>
            ) : (
              <span>none yet — first audit seeds from the Auditor template</span>
            )}
          </span>
          <span className="text-foreground-subtlest">
            Sequential waves: 1 Core → 2 Second → 3 Performance.
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* ================= AREA A: BATCH SETUP ================= */}
        <section
          className="border-b border-border bg-background px-3 py-2.5"
          aria-label="Area A: Batch Setup"
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Layers className="size-3.5 text-foreground-subtle" />
              <span className="font-semibold uppercase tracking-wider text-foreground">
                Area A: Batch Setup
              </span>
            </div>
            <div className="flex items-center gap-1 text-[11px] text-foreground-subtle">
              <span>Selected:</span>
              <strong className="font-medium text-foreground">{chosen.length}</strong>
              <span>of {projects.length} projects</span>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {/* Project Picker Column */}
            <div className="flex flex-col rounded border border-border bg-surface/30 p-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="font-medium text-foreground">1. Select Target Projects</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="border border-border bg-surface px-1 text-[10px] hover:bg-hover"
                    onClick={() => setSelected(new Set(projects.map((p) => p.workspacePath)))}
                  >
                    all
                  </button>
                  <button
                    type="button"
                    className="border border-border bg-surface px-1 text-[10px] hover:bg-hover"
                    onClick={() => setSelected(new Set())}
                  >
                    none
                  </button>
                  <button
                    type="button"
                    className="border border-border bg-surface px-1 text-[10px] hover:bg-hover"
                    onClick={() => setSelected(new Set([workspace.workspacePath]))}
                  >
                    current
                  </button>
                </div>
              </div>

              <div className="flex max-h-48 flex-col overflow-y-auto divide-y divide-border/40">
                {projects.map((project) => {
                  const { state, campaign } = zaicodeAuditProjectState(
                    store.campaigns,
                    project.workspacePath,
                  );
                  const isCurrent = project.workspacePath === workspace.workspacePath;
                  return (
                    <label
                      key={project.workspacePath}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 px-1 py-1 hover:bg-hover/80",
                        isCurrent && "bg-selected/30",
                      )}
                    >
                      <Checkbox
                        checked={selected.has(project.workspacePath)}
                        onCheckedChange={() => toggle(project.workspacePath)}
                        aria-label={`Select ${project.projectName} for batch`}
                      />
                      <span
                        className="min-w-0 flex-1 truncate font-medium text-foreground"
                        title={project.workspacePath}
                      >
                        {project.projectName}
                      </span>
                      {campaign && state !== "idle" ? (
                        <span className="text-[10px] text-foreground-subtle">
                          {zaicodeAuditStage(campaign).label}
                        </span>
                      ) : null}
                      <span
                        className={cn(
                          "shrink-0 border px-1 text-[9px] uppercase",
                          STATE_CLASS[state],
                        )}
                      >
                        {STATE_LABEL[state]}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Capacity & Wave Policy Column */}
            <div className="flex flex-col justify-between rounded border border-border bg-surface/30 p-2">
              <div>
                <span className="font-medium text-foreground">2. Orchestration & Capacity</span>

                {/* Worker Capacity Stepper */}
                <div className="mt-2 flex items-center justify-between border-b border-border/50 pb-2">
                  <div>
                    <div className="flex items-center gap-1.5 font-medium text-foreground">
                      <Users className="size-3 text-foreground-subtle" />
                      <span>Global Worker Capacity:</span>
                      <span className="font-mono text-ui-sm text-[var(--zaicode-highlight,#82aaff)]">
                        {store.globalConcurrency}
                      </span>
                    </div>
                    <p className="text-[10px] text-foreground-subtlest">
                      Max parallel workers active across all projects (1..16).
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={store.globalConcurrency <= 1}
                      onClick={() => void changeCapacity(-1)}
                      className="size-5 border border-border bg-surface font-mono hover:bg-hover disabled:opacity-40"
                    >
                      -
                    </button>
                    <button
                      type="button"
                      disabled={store.globalConcurrency >= 16}
                      onClick={() => void changeCapacity(1)}
                      className="size-5 border border-border bg-surface font-mono hover:bg-hover disabled:opacity-40"
                    >
                      +
                    </button>
                  </div>
                </div>

                {/* Auto-waves switch */}
                <div className="mt-2 flex items-center justify-between border-b border-border/50 pb-2">
                  <div>
                    <span className="font-medium text-foreground">Sequential Wave Auto-Advance</span>
                    <p className="text-[10px] text-foreground-subtlest">
                      Automatically advance Wave 1 → 2 → 3 upon validated findings.
                    </p>
                  </div>
                  <Switch
                    checked={store.autoWaves}
                    aria-label="Sequential wave auto-advance"
                    onCheckedChange={(enabled) => void store.setAutoWaves(audits, enabled)}
                  />
                </div>

                {/* Expected Workload */}
                <div className="mt-2 rounded bg-surface/70 p-2 text-[11px] text-foreground-subtle">
                  <div className="flex items-center justify-between">
                    <span>Expected workload:</span>
                    <strong className="text-foreground">
                      {chosen.length} project{chosen.length === 1 ? "" : "s"} × 3 waves ={" "}
                      {chosen.length * 3} tasks
                    </strong>
                  </div>
                  <div className="mt-0.5 text-[10px] text-foreground-subtlest">
                    Parallelized across projects up to {store.globalConcurrency} workers. Waves inside each project run strictly sequentially.
                  </div>
                </div>
              </div>

              {/* Start & Plan Actions */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={chosen.length === 0 || startingBatch}
                  className="flex flex-1 items-center justify-center gap-1.5 border border-[var(--zaicode-highlight,#82aaff)] bg-selected px-3 py-1 font-semibold text-foreground hover:bg-hover disabled:opacity-40"
                  onClick={() => void startBatch(false)}
                >
                  <Play className="size-3.5 fill-current" />
                  <span>START Batch Audit ({chosen.length})</span>
                </button>
                <button
                  type="button"
                  disabled={chosen.length === 0 || startingBatch}
                  className="flex items-center gap-1 border border-border bg-surface px-2.5 py-1 text-foreground-subtle hover:bg-hover disabled:opacity-40"
                  onClick={() => void startBatch(true)}
                >
                  <Plus className="size-3" />
                  <span>Plan Only</span>
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* ================= AREA B: LIVE PRODUCTION ================= */}
        <section
          className="border-b border-border bg-surface/10 px-3 py-2.5"
          aria-label="Area B: Live Production"
        >
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Server className="size-3.5 text-foreground-subtle" />
              <span className="font-semibold uppercase tracking-wider text-foreground">
                Area B: Live Production & Worker Capacity
              </span>
            </div>
            <div className="flex items-center gap-1 text-[11px] text-foreground-subtle">
              <span>Capacity utilization:</span>
              <strong className="font-mono text-foreground">
                {Math.round((busySlots / Math.max(1, store.globalConcurrency)) * 100)}%
              </strong>
            </div>
          </div>

          {/* Metric Chips */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <div className="flex flex-col rounded border border-border bg-surface/40 p-2">
              <span className="text-[10px] uppercase text-foreground-subtle">Total Projects</span>
              <span className="font-mono text-ui-base font-semibold text-foreground">
                {totalProjects}
              </span>
            </div>
            <div className="flex flex-col rounded border border-border bg-surface/40 p-2">
              <span className="text-[10px] uppercase text-foreground-subtle">Worker Slots</span>
              <div className="flex items-baseline gap-1 font-mono text-ui-base font-semibold">
                <span className={busySlots > 0 ? "text-blue-400" : "text-foreground"}>
                  {busySlots}
                </span>
                <span className="text-ui-xs text-foreground-subtle">/ {store.globalConcurrency}</span>
              </div>
            </div>
            <div className="flex flex-col rounded border border-border bg-surface/40 p-2">
              <span className="text-[10px] uppercase text-foreground-subtle">Running Audits</span>
              <span className="font-mono text-ui-base font-semibold text-blue-400">
                {runningCampaigns}
              </span>
            </div>
            <div className="flex flex-col rounded border border-border bg-surface/40 p-2">
              <span className="text-[10px] uppercase text-foreground-subtle">Queued / Planned</span>
              <span className="font-mono text-ui-base font-semibold text-yellow-400">
                {queuedCampaigns}
              </span>
            </div>
            <div className="flex flex-col rounded border border-border bg-surface/40 p-2">
              <span className="text-[10px] uppercase text-foreground-subtle">Blocked / Need Action</span>
              <span className="font-mono text-ui-base font-semibold text-red-400">
                {blockedCampaigns}
              </span>
            </div>
            <div className="flex flex-col rounded border border-border bg-surface/40 p-2">
              <span className="text-[10px] uppercase text-foreground-subtle">Completed</span>
              <span className="font-mono text-ui-base font-semibold text-green-400">
                {completedCampaigns}
              </span>
            </div>
          </div>

          {/* Active Workers Detail List */}
          <div className="mt-2.5">
            <div className="mb-1 text-[11px] font-medium text-foreground-subtle">
              Active Agent Workers ({store.activeWorkers.length})
            </div>
            {store.activeWorkers.length === 0 ? (
              <div className="rounded border border-dashed border-border p-2 text-center text-foreground-subtlest">
                No active workers right now. Dispatch a batch above or let AUTO run.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {store.activeWorkers.map((worker) => (
                  <div
                    key={worker.workerId}
                    className="flex flex-col justify-between rounded border border-blue-600/50 bg-blue-950/20 p-2 text-[11px]"
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-foreground truncate" title={worker.projectName}>
                          {worker.projectName}
                        </span>
                        <span className="flex items-center gap-1 rounded bg-blue-900/60 px-1 text-[9px] uppercase font-mono text-blue-200">
                          <span className="size-1.5 rounded-full bg-blue-400 animate-pulse" />
                          Wave {worker.waveOrdinal}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-[10px] text-foreground-subtle">
                        <span>Wave ID:</span>
                        <span className="font-mono">{worker.waveId}</span>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-foreground-subtle">
                        <span>Model:</span>
                        <span className="font-mono truncate max-w-[120px]">{worker.model}</span>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between border-t border-border/40 pt-1 text-[10px] text-foreground-subtlest">
                      <span>Elapsed: {formatZaicodeAuditElapsed(Math.max(0, now - worker.startedAt))}</span>
                      <button
                        type="button"
                        onClick={() =>
                          void openZaicodeSession({
                            sessionId: worker.sessionId,
                            title: worker.projectName,
                          })
                        }
                        className="flex items-center gap-0.5 text-blue-400 hover:underline"
                        title="Open session terminal"
                      >
                        <span>session</span>
                        <ExternalLink className="size-2.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ================= BATCH MANAGEMENT & CONTROLS ================= */}
        <section
          className="border-b border-border bg-background px-3 py-2.5"
          aria-label="Batch Management & Controls"
          data-zaicode-batches
        >
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Layers className="size-3.5 text-foreground-subtle" />
              <span className="font-semibold uppercase tracking-wider text-foreground">
                Batch Lifecycle & Orchestration Controls
              </span>
              <span className="rounded border border-border bg-surface px-1.5 py-0.2 text-[10px] font-mono text-foreground-subtle">
                {store.batches.length} {store.batches.length === 1 ? "batch" : "batches"}
              </span>
            </div>
            <span className="text-[10px] text-foreground-subtlest">
              Authoritative pause, resume, stop, retry and report dispatch
            </span>
          </div>

          {store.batches.length === 0 ? (
            <div className="rounded border border-dashed border-border p-2.5 text-center text-foreground-subtlest">
              No audit batches created yet. Select projects above and launch a batch.
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {store.batches.map((batch) => {
                const batchCampaigns = batch.campaignIds
                  .map((id) => store.campaigns.find((c) => c.campaignId === id))
                  .filter(Boolean);
                const occupiedWorkers = store.activeWorkers.filter((w) =>
                  w.batchId === batch.batchId,
                ).length;

                const admittedCount = batch.stats?.admittedCount ?? batch.projects.filter((p) => p.status === "admitted").length;
                const queuedCount = batch.stats?.queuedCount ?? batchCampaigns.filter((c) => c?.status === "planned").length;
                const runningCount = batch.stats?.runningCount ?? batchCampaigns.filter((c) => c?.status === "running").length;
                const completedCount = batch.stats?.completedCount ?? batchCampaigns.filter((c) => c?.status === "complete").length;
                const blockedCount = batch.stats?.blockedCount ?? batchCampaigns.filter((c) => c?.status === "blocked").length;
                const rejectedCount = batch.stats?.rejectedCount ?? batch.projects.filter((p) => p.status === "rejected").length;

                const isPending = pendingBatchAction?.startsWith(`${batch.batchId}:`);
                const pendingOp = isPending ? pendingBatchAction?.split(":")[1] : null;

                const canPause =
                  !isPending && (batch.status === "running" || batch.status === "admitting");
                const canResume =
                  !isPending &&
                  (batch.status === "paused" ||
                    batch.status === "planned" ||
                    batch.status === "blocked");
                const canStop =
                  !isPending &&
                  batch.status !== "cancelled" &&
                  batch.status !== "complete" &&
                  batch.status !== "stopping" &&
                  batch.status !== "stop_requested";
                const canRetry =
                  !isPending &&
                  batch.status !== "cancelled" &&
                  batch.status !== "stopping" &&
                  batch.status !== "stop_requested" &&
                  (batch.status === "blocked" ||
                    batch.status === "partial" ||
                    batch.status === "stop_partial" ||
                    blockedCount > 0 ||
                    rejectedCount > 0);

                return (
                  <div
                    key={batch.batchId}
                    className="flex flex-col rounded border border-border bg-surface/30 p-2.5 text-[11px]"
                    data-zaicode-batch-card={batch.batchId}
                  >
                    {/* Header Row: ID, Revision, Time, Lifecycle Badge */}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-semibold text-foreground">
                          {batch.batchId}
                        </span>
                        <span className="text-[10px] text-foreground-subtle">
                          {new Date(batch.createdAt).toLocaleTimeString()}
                        </span>
                        {batch.lifecycleRevision ? (
                          <span className="rounded bg-surface px-1 text-[9px] font-mono text-foreground-subtle border border-border">
                            rev {batch.lifecycleRevision}
                          </span>
                        ) : null}
                      </div>

                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "rounded border px-1.5 py-0.5 text-[10px] font-mono uppercase font-medium",
                            batch.status === "running" && "border-blue-600 bg-blue-950/40 text-blue-300 animate-pulse",
                            batch.status === "admitting" && "border-blue-700 bg-blue-950/30 text-blue-300",
                            batch.status === "paused" && "border-yellow-700 bg-yellow-950/30 text-yellow-300",
                            batch.status === "planned" && "border-yellow-700/60 bg-yellow-950/20 text-yellow-300",
                            batch.status === "complete" && "border-green-700 bg-green-950/30 text-green-300",
                            batch.status === "partial" && "border-yellow-600 bg-yellow-950/30 text-yellow-300",
                            batch.status === "blocked" && "border-red-700 bg-red-950/30 text-red-300",
                            batch.status === "stopping" && "border-red-600 bg-red-950/40 text-red-300 animate-pulse",
                            batch.status === "stop_requested" && "border-red-600/60 bg-red-950/30 text-red-300",
                            batch.status === "stop_partial" && "border-orange-700 bg-orange-950/30 text-orange-300",
                            batch.status === "stop_failed" && "border-red-800 bg-red-950/50 text-red-400 font-bold",
                            batch.status === "cancelled" && "border-border text-foreground-subtle",
                          )}
                        >
                          {batch.status}
                        </span>
                      </div>
                    </div>

                    {/* Metadata & Metric Breakdown */}
                    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7 text-[10px]">
                      <div className="flex flex-col">
                        <span className="text-foreground-subtlest uppercase">Projects</span>
                        <span className="font-mono font-medium text-foreground">
                          {batch.projects.length}
                        </span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-foreground-subtlest uppercase">Admitted</span>
                        <span className="font-mono font-medium text-foreground">
                          {admittedCount}
                        </span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-foreground-subtlest uppercase">Workers</span>
                        <span className="font-mono font-medium text-blue-300">
                          {occupiedWorkers} / {batch.workerCapacity}
                        </span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-foreground-subtlest uppercase">Running / Queued</span>
                        <span className="font-mono font-medium text-foreground">
                          {runningCount} / {queuedCount}
                        </span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-foreground-subtlest uppercase">Completed</span>
                        <span className="font-mono font-medium text-green-400">
                          {completedCount}
                        </span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-foreground-subtlest uppercase">Blocked / Rejected</span>
                        <span
                          className={cn(
                            "font-mono font-medium",
                            blockedCount > 0 || rejectedCount > 0
                              ? "text-red-400 font-bold"
                              : "text-foreground-subtle",
                          )}
                        >
                          {blockedCount} / {rejectedCount}
                        </span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-foreground-subtlest uppercase">Model Policy</span>
                        <span className="truncate font-mono text-foreground" title={batch.modelPolicy?.defaultModel ?? "default"}>
                          {batch.modelPolicy?.defaultModel || "default"}
                        </span>
                      </div>
                    </div>

                    {/* Action Bar */}
                    <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          disabled={!canPause}
                          onClick={() => void handleBatchPause(batch.batchId)}
                          className="flex items-center gap-1 rounded border border-yellow-700/60 bg-yellow-950/20 px-2 py-0.5 text-[10px] text-yellow-300 hover:bg-yellow-900/30 disabled:opacity-40"
                          title="Stop new dispatch without interrupting currently running workers"
                        >
                          <Pause className="size-2.5" />
                          <span>{pendingOp === "pause" ? "Pausing…" : "PAUSE"}</span>
                        </button>

                        <button
                          type="button"
                          disabled={!canResume}
                          onClick={() => void handleBatchResume(batch.batchId)}
                          className="flex items-center gap-1 rounded border border-blue-600/60 bg-blue-950/20 px-2 py-0.5 text-[10px] text-blue-300 hover:bg-blue-900/30 disabled:opacity-40"
                          title="Resume eligible work under current state"
                        >
                          <Play className="size-2.5 fill-current" />
                          <span>{pendingOp === "resume" ? "Resuming…" : "RESUME"}</span>
                        </button>

                        <button
                          type="button"
                          disabled={!canStop}
                          onClick={() => void handleBatchStop(batch.batchId)}
                          className="flex items-center gap-1 rounded border border-red-700/60 bg-red-950/20 px-2 py-0.5 text-[10px] text-red-300 hover:bg-red-900/30 disabled:opacity-40"
                          title="Cancel batch with confirmed termination policy"
                        >
                          <Square className="size-2.5 fill-current" />
                          <span>{pendingOp === "stop" ? "Stopping…" : "STOP"}</span>
                        </button>

                        <button
                          type="button"
                          disabled={!canRetry}
                          onClick={() => void handleBatchRetry(batch.batchId)}
                          className="flex items-center gap-1 rounded border border-border bg-surface px-2 py-0.5 text-[10px] text-foreground-subtle hover:bg-hover disabled:opacity-40"
                          title="Target blocked work without restarting successful campaigns"
                        >
                          <RotateCcw className="size-2.5" />
                          <span>{pendingOp === "retry" ? "Retrying…" : "RETRY"}</span>
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          const el = document.querySelector('[aria-label*="Area D"]');
                          el?.scrollIntoView({ behavior: "smooth" });
                        }}
                        className="flex items-center gap-1 text-[10px] text-blue-400 hover:underline"
                        title="View completed reports in Area D"
                      >
                        <FileText className="size-2.5" />
                        <span>OPEN REPORTS</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ================= AREA C: PROJECT PIPELINE ================= */}
        <section className="px-3 py-2.5" aria-label="Area C: Project Pipeline">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <ListChecks className="size-3.5 text-foreground-subtle" />
              <span className="font-semibold uppercase tracking-wider text-foreground">
                Area C: Project Pipeline Table
              </span>
            </div>
            <span className="text-[10px] text-foreground-subtlest">
              Sequential waves per project: Core → Second → Performance
            </span>
          </div>

          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-left border-collapse text-[11px]">
              <thead>
                <tr className="border-b border-border bg-surface/70 text-foreground-subtle">
                  <th className="p-2 font-medium">Project</th>
                  <th className="p-2 font-medium">Wave 1: Core</th>
                  <th className="p-2 font-medium">Wave 2: Second</th>
                  <th className="p-2 font-medium">Wave 3: Perf</th>
                  <th className="p-2 font-medium">Worker / Model</th>
                  <th className="p-2 font-medium">Truthful Status</th>
                  <th className="p-2 font-medium">Elapsed</th>
                  <th className="p-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {projects.map((project) => {
                  const { state, campaign } = zaicodeAuditProjectState(
                    store.campaigns,
                    project.workspacePath,
                  );
                  const activeWorker = store.activeWorkers.find(
                    (w) => w.projectKey === project.workspaceKey,
                  );
                  const total = campaign ? zaicodeAuditTotalMs(campaign, now) : null;
                  const wave1 = campaign?.waves[0];
                  const wave2 = campaign?.waves[1];
                  const wave3 = campaign?.waves[2];

                  return (
                    <tr
                      key={project.workspacePath}
                      className={cn(
                        "hover:bg-hover/50 transition-colors",
                        project.workspacePath === workspace.workspacePath && "bg-selected/20",
                      )}
                    >
                      {/* Project info */}
                      <td className="p-2 min-w-[140px] max-w-[200px]">
                        <div className="font-medium text-foreground truncate" title={project.projectName}>
                          {project.projectName}
                        </div>
                        <div className="text-[10px] text-foreground-subtlest truncate" title={project.workspacePath}>
                          {project.workspacePath}
                        </div>
                      </td>

                      {/* Wave 1 */}
                      <td className="p-2">
                        {wave1 ? (() => {
                          const isCurrent = campaign?.currentWaveIndex === 0;
                          const isQueued = isCurrent && (campaign?.live?.status === "queued" || campaign?.live?.status === "ready");
                          const isRunning = wave1.status === "running" && !isQueued && (campaign?.live?.status === "running" || activeWorker !== undefined || !campaign?.live);
                          return (
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-mono",
                                wave1.status === "complete" && "border-green-700 bg-green-950/30 text-green-300",
                                isRunning && "border-blue-600 bg-blue-950/40 text-blue-300 animate-pulse",
                                isQueued && "border-yellow-600/70 bg-yellow-950/30 text-yellow-300",
                                wave1.status === "partial" && "border-yellow-700 bg-yellow-950/30 text-yellow-300",
                                wave1.status === "blocked" && "border-red-700 bg-red-950/30 text-red-300",
                                wave1.status === "pending" && "border-border text-foreground-subtle",
                              )}
                            >
                              <span>{isQueued ? "queued" : wave1.status}</span>
                              {wave1.findings !== undefined ? <span>({wave1.findings}f)</span> : null}
                            </span>
                          );
                        })() : (
                          <span className="text-foreground-subtlest">—</span>
                        )}
                      </td>

                      {/* Wave 2 */}
                      <td className="p-2">
                        {wave2 ? (() => {
                          const isCurrent = campaign?.currentWaveIndex === 1;
                          const isQueued = isCurrent && (campaign?.live?.status === "queued" || campaign?.live?.status === "ready");
                          const isRunning = wave2.status === "running" && !isQueued && (campaign?.live?.status === "running" || activeWorker !== undefined || !campaign?.live);
                          return (
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-mono",
                                wave2.status === "complete" && "border-green-700 bg-green-950/30 text-green-300",
                                isRunning && "border-blue-600 bg-blue-950/40 text-blue-300 animate-pulse",
                                isQueued && "border-yellow-600/70 bg-yellow-950/30 text-yellow-300",
                                wave2.status === "partial" && "border-yellow-700 bg-yellow-950/30 text-yellow-300",
                                wave2.status === "blocked" && "border-red-700 bg-red-950/30 text-red-300",
                                wave2.status === "pending" && "border-border text-foreground-subtle",
                              )}
                            >
                              <span>{isQueued ? "queued" : wave2.status}</span>
                              {wave2.findings !== undefined ? <span>({wave2.findings}f)</span> : null}
                            </span>
                          );
                        })() : (
                          <span className="text-foreground-subtlest">—</span>
                        )}
                      </td>

                      {/* Wave 3 */}
                      <td className="p-2">
                        {wave3 ? (() => {
                          const isCurrent = campaign?.currentWaveIndex === 2;
                          const isQueued = isCurrent && (campaign?.live?.status === "queued" || campaign?.live?.status === "ready");
                          const isRunning = wave3.status === "running" && !isQueued && (campaign?.live?.status === "running" || activeWorker !== undefined || !campaign?.live);
                          return (
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-mono",
                                wave3.status === "complete" && "border-green-700 bg-green-950/30 text-green-300",
                                isRunning && "border-blue-600 bg-blue-950/40 text-blue-300 animate-pulse",
                                isQueued && "border-yellow-600/70 bg-yellow-950/30 text-yellow-300",
                                wave3.status === "partial" && "border-yellow-700 bg-yellow-950/30 text-yellow-300",
                                wave3.status === "blocked" && "border-red-700 bg-red-950/30 text-red-300",
                                wave3.status === "pending" && "border-border text-foreground-subtle",
                              )}
                            >
                              <span>{isQueued ? "queued" : wave3.status}</span>
                              {wave3.findings !== undefined ? <span>({wave3.findings}f)</span> : null}
                            </span>
                          );
                        })() : (
                          <span className="text-foreground-subtlest">—</span>
                        )}
                      </td>

                      {/* Worker / Model */}
                      <td className="p-2">
                        {activeWorker ? (
                          <div className="flex flex-col">
                            <span className="font-mono text-blue-300 truncate max-w-[120px]">
                              {activeWorker.workerId}
                            </span>
                            <span className="text-[10px] text-foreground-subtler truncate max-w-[120px]">
                              {activeWorker.model}
                            </span>
                          </div>
                        ) : campaign?.live?.status === "queued" || campaign?.live?.status === "ready" ? (
                          <span className="text-yellow-300/80 font-mono text-[10px]">queued (slot waiting)</span>
                        ) : state === "planned" ? (
                          <span className="text-yellow-300/80 font-mono text-[10px]">waiting in queue</span>
                        ) : (
                          <span className="text-foreground-subtlest">—</span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="p-2">
                        {campaign?.status === "running" && (campaign?.live?.status === "queued" || campaign?.live?.status === "ready") ? (
                          <span className="inline-block rounded border border-yellow-600/70 bg-yellow-950/30 px-1.5 py-0.5 text-[10px] font-medium uppercase text-yellow-300">
                            Queued
                          </span>
                        ) : (
                          <span
                            className={cn(
                              "inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase",
                              STATE_CLASS[state],
                            )}
                          >
                            {STATE_LABEL[state]}
                          </span>
                        )}
                      </td>

                      {/* Elapsed */}
                      <td className="p-2 font-mono tabular-nums text-foreground-subtle">
                        {total !== null ? formatZaicodeAuditElapsed(total) : "—"}
                      </td>

                      {/* Actions */}
                      <td className="p-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {state === "idle" || state === "done" ? (
                            <button
                              type="button"
                              onClick={() => void store.start(audits, project)}
                              className="border border-border bg-surface px-1.5 py-0.5 text-foreground hover:bg-hover"
                              title="Start audit for this project"
                            >
                              Start
                            </button>
                          ) : null}
                          {state === "planned" && campaign ? (
                            <button
                              type="button"
                              onClick={() => void store.work(audits, campaign.campaignId)}
                              className="border border-border bg-surface px-1.5 py-0.5 text-foreground hover:bg-hover font-medium"
                              title="Work planned audit"
                            >
                              Dispatch
                            </button>
                          ) : null}
                          {state === "stopped" && campaign ? (
                            <button
                              type="button"
                              onClick={() => void store.retry(audits, campaign.campaignId)}
                              className="border border-yellow-700/60 bg-yellow-950/30 px-1.5 py-0.5 text-yellow-300 hover:bg-hover"
                              title="Retry blocked wave"
                            >
                              Retry
                            </button>
                          ) : null}
                          {state === "running" && campaign ? (
                            <button
                              type="button"
                              onClick={() => void store.cancel(audits, campaign.campaignId)}
                              className="border border-red-700/60 bg-red-950/30 px-1.5 py-0.5 text-red-300 hover:bg-hover"
                              title="Cancel campaign"
                            >
                              Cancel
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* ================= AREA D: CONSOLIDATED RESULTS ================= */}
        <section
          className="border-t border-border bg-surface/20 px-3 py-2.5"
          aria-label="Area D: Consolidated Results & Reports"
        >
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="size-3.5 text-foreground-subtle" />
              <span className="font-semibold uppercase tracking-wider text-foreground">
                Area D: Consolidated Results & Handoffs
              </span>
            </div>
            <span className="text-[10px] text-foreground-subtle">
              Finished campaigns & combined artifacts (`__00_AUDIT_ALL_3.md`)
            </span>
          </div>

          {/* Active Campaigns Cards (Detail inspection) */}
          {active.length > 0 ? (
            <div className="mb-4">
              <div className="mb-1 text-[11px] font-medium text-foreground">
                Active Campaigns Detail Cards ({active.length})
              </div>
              <div className="flex flex-col gap-2">
                {active.map((campaign) => (
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
              </div>
            </div>
          ) : null}

          {/* Finished Campaigns Cards */}
          {history.length > 0 ? (
            <div>
              <div className="mb-1 text-[11px] font-medium text-foreground">
                Completed & Stopped Campaigns History ({history.length})
              </div>
              <div className="flex flex-col gap-2">
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
              </div>
            </div>
          ) : active.length === 0 ? (
            <p className="p-3 text-center text-foreground-subtlest border border-dashed border-border rounded">
              No audit campaigns yet. Select projects above and launch a batch audit.
            </p>
          ) : null}

          {/* AUTO Settings Section */}
          <div className="mt-4 border-t border-border pt-3">
            <div className="flex items-center gap-1.5 font-medium text-foreground">
              <Zap className="size-3 text-foreground-subtle" />
              <span>Smart Self-Audit Automation (AUTO)</span>
            </div>
            <div className="mt-2">
              <ZaicodeAutoSettingsPanel
                audits={audits}
                workspaceKey={workspace.workspaceKey}
                projectName={nameOfPath(workspace.workspacePath)}
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
