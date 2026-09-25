import { useEffect, useMemo, useState } from "react";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import { resolveWorkspaceKey } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { resolveZaicodeServices } from "@/zaicode/zaicodeServices.js";
import { useZaicodeStore } from "@/zaicode/zaicodeStore.js";
import { countRunningJobs, isJobActive } from "@/zaicode/zaicodeStatus.js";
import { ZaicodeAgentRoster } from "@/zaicode/ZaicodeAgentRoster.js";
import { ZaicodeInspector } from "@/zaicode/ZaicodeInspector.js";
import { ZaicodeQueuePanel } from "@/zaicode/ZaicodeQueuePanel.js";
import { ZaicodeWorkingMeter } from "@/zaicode/ZaicodeWorkingMeter.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ZaicodeIcon } from "@/zaicode/zaicodeIconSlots.js";
import { ZaicodeIconEditor } from "@/zaicode/ZaicodeIconEditor.js";
import { ZaicodeTeamPresetsStrip } from "@/zaicode/ZaicodeTeamPresets.js";
import { ZaicodeTour } from "@/zaicode/ZaicodeTour.js";
import { ZAICODE_WAITING_STATUSES, ZaicodeFlowBar, ZaicodeHelpStrip } from "@/zaicode/ZaicodeWorkspaceStrips.js";
import { Play, Users, X } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { ZaicodeSchedulerPanel } from "@/zaicode/ZaicodeSchedulerPanel.js";
import { useZaicodeWorkspaceTab } from "@/zaicode/zaicodeScheduler.js";
import { ZaicodeHitAndGoButton, ZaicodeWorkspaceTabs } from "@/zaicode/ZaicodeWorkspaceBar.js";

const HELP_STORAGE_KEY = "zaicode-help-hidden";
/** 队列事实由 host 持有；有活跃任务时轮询，让运行状态无需手动刷新。 */
const ACTIVE_POLL_MS = 3000;

function readHelpHidden(): boolean {
  try {
    return readZaicodeSetting(HELP_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export interface ZaicodeWorkspaceProps {
  workspacePath: string;
  workspaceIdentity?: string;
  onOpenSession?: (sessionId: string) => void;
}

/** ZAICODE 主工作区：Agent Roster | Work Queue + Active Work | Inspector。 */
export function ZaicodeWorkspace({
  workspacePath,
  workspaceIdentity,
  onOpenSession,
}: ZaicodeWorkspaceProps) {
  const { intl } = useZCodeIntl();
  const accessor = useBaseWorkspaceServices();
  const services = useMemo(() => resolveZaicodeServices(accessor), [accessor]);
  const [editing, setEditing] = useState(false);
  const [initialTemplateId, setInitialTemplateId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [iconsOpen, setIconsOpen] = useState(false);
  const [helpHidden, setHelpHidden] = useState(readHelpHidden);
  const [presetsOpen, setPresetsOpen] = useState<boolean | null>(null);
  const [tourOpen, setTourOpen] = useState(false);
  const toggleHelp = (hidden: boolean) => {
    setHelpHidden(hidden);
    try {
      localStorage.setItem(HELP_STORAGE_KEY, hidden ? "1" : "0");
    } catch {
      // 偏好只影响提示条显示，存储不可用时保持本次会话状态即可。
    }
  };

  const workspace = useMemo(
    () => ({
      workspaceKey: resolveWorkspaceKey({ workspacePath, workspaceIdentity }),
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    }),
    [workspacePath, workspaceIdentity],
  );

  const store = useZaicodeStore();
  const tab = useZaicodeWorkspaceTab((state) => state.tab);

  useEffect(() => {
    if (!services) return;
    void store.refresh(services, workspace);
    // refresh 只在服务/工作区变化时重载；store 方法是稳定引用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, workspace]);

  const hasActiveJobs = store.jobs.some((job) => isJobActive(job.status));
  useEffect(() => {
    if (!services || !hasActiveJobs) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void store.refresh(services, workspace);
    }, ACTIVE_POLL_MS);
    return () => window.clearInterval(timer);
    // store 方法是稳定引用；只在服务/工作区/是否有活跃任务变化时重建轮询。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, workspace, hasActiveJobs]);

  if (!services) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "zaicode.unavailable" })}
        </p>
      </div>
    );
  }

  const ctx = services;
  const selectedAgent = store.agents.find((agent) => agent.id === store.selectedAgentId) ?? null;
  const selectedJob = store.jobs.find((job) => job.id === store.selectedJobId) ?? null;
  const running = countRunningJobs(store.jobs);
  const waitingCount = store.jobs.filter((job) => ZAICODE_WAITING_STATUSES.has(job.status)).length;
  // Teams show by themselves while there is no agent yet; after that only on request.
  const showPresets = presetsOpen ?? (!store.loading && store.agents.length === 0);

  const withBusy = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  // SRC-038: in a narrow window the inspector opens over the queue instead of off-screen.
  const inspectorWanted = editing || iconsOpen || Boolean(selectedAgent) || Boolean(selectedJob);
  const closeInspector = () => {
    setEditing(false);
    setIconsOpen(false);
    store.selectAgent(null);
    store.selectJob(null);
  };

  return (
    <div className="@container/zws flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "zaicode.title" })}
          </span>
          <ZaicodeWorkspaceTabs />
          <span className="hidden min-w-0 truncate text-ui-xs text-foreground-subtle @min-[1100px]/zws:inline">
            {intl.formatMessage({ id: "zaicode.subtitle" })}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ZaicodeHitAndGoButton services={ctx} workspace={workspace} disabled={busy} />
          <ZaicodeWorkingMeter jobs={store.jobs} />
          <Button
            size="sm"
            variant={store.autoRun ? "secondary" : "outline"}
            aria-pressed={store.autoRun}
            disabled={busy}
            title={intl.formatMessage({ id: "zaicode.autopilot.help" })}
            onClick={() => withBusy(() => store.setAutoRun(ctx, workspace, !store.autoRun))}
          >
            {intl.formatMessage({
              id: store.autoRun ? "zaicode.autopilot.on" : "zaicode.autopilot.off",
            })}
          </Button>
          {!store.autoRun && waitingCount > 0 ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              title={intl.formatMessage({ id: "zaicode.action.dispatchQueue.help" })}
              onClick={() => withBusy(() => store.pumpQueue(ctx, workspace))}
            >
              <ZaicodeIcon slot="workspace.dispatch" className="size-3" />
              {intl.formatMessage({ id: "zaicode.action.startWaiting" }, { count: waitingCount })}
            </Button>
          ) : null}
          <span
            className="ml-1 flex items-center text-ui-xs text-foreground-subtle"
            title={intl.formatMessage({ id: "zaicode.queue.concurrencyHelp" })}
          >
            {intl.formatMessage(
              { id: "zaicode.queue.concurrency" },
              { running, limit: store.maxConcurrency },
            )}
            <Button
              size="icon-xs"
              variant="ghost"
              title={intl.formatMessage({ id: "zaicode.action.concurrencyDown" })}
              disabled={busy || store.maxConcurrency <= 1}
              onClick={() =>
                withBusy(() => store.setMaxConcurrency(ctx, workspace, store.maxConcurrency - 1))
              }
            >
              -
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              title={intl.formatMessage({ id: "zaicode.action.concurrencyUp" })}
              disabled={busy}
              onClick={() =>
                withBusy(() => store.setMaxConcurrency(ctx, workspace, store.maxConcurrency + 1))
              }
            >
              +
            </Button>
          </span>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={showPresets}
            title="Ready-made teams of agents"
            onClick={() => setPresetsOpen(!showPresets)}
          >
            <Users className="size-3" />
            Teams
          </Button>
          <Button size="sm" variant="ghost" title="Guided tour of the screen" onClick={() => setTourOpen(true)}>
            <Play className="size-3" />
            Tour
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={!helpHidden}
            data-zaicode-tour="help"
            onClick={() => toggleHelp(!helpHidden)}
          >
            {intl.formatMessage({ id: "zaicode.help.toggle" })}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-pressed={iconsOpen}
            title={intl.formatMessage({ id: "zaicode.icons.title" })}
            onClick={() => setIconsOpen((value) => !value)}
          >
            <ZaicodeIcon slot="roster.agent" className="size-3" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title={intl.formatMessage({ id: "zaicode.action.refresh" })}
            disabled={busy}
            onClick={() => withBusy(() => store.refresh(ctx, workspace))}
          >
            <ZaicodeIcon slot="workspace.refresh" className="size-3" />
          </Button>
        </div>
      </header>
      <ZaicodeFlowBar agents={store.agents} jobs={store.jobs} autoRun={store.autoRun} />
      {helpHidden ? null : <ZaicodeHelpStrip onHide={() => toggleHelp(true)} onTour={() => setTourOpen(true)} />}
      {showPresets ? (
        <ZaicodeTeamPresetsStrip
          agents={store.agents}
          templates={store.templates}
          busy={busy}
          onClose={() => setPresetsOpen(false)}
          onCreate={(inputs) =>
            withBusy(async () => {
              for (const input of inputs) await store.createAgent(ctx, workspace, input);
            })
          }
        />
      ) : null}
      {tourOpen ? <ZaicodeTour onClose={() => setTourOpen(false)} /> : null}
      {store.error ? (
        <div className="shrink-0 border-b border-border px-3 py-1.5 text-ui-xs text-destructive">
          {store.error}
        </div>
      ) : null}
      {tab === "scheduler" ? (
        <ZaicodeSchedulerPanel agents={store.agents} />
      ) : (
      <div className="relative flex min-h-0 flex-1">
        <aside className="flex w-56 min-h-0 shrink-0 flex-col border-r border-border @min-[1100px]/zws:w-64" data-zaicode-tour="agents">
          <ZaicodeAgentRoster
            agents={store.agents}
            templates={store.templates}
            jobs={store.jobs}
            diagnostics={store.agentDiagnostics}
            selectedAgentId={store.selectedAgentId}
            busy={busy}
            onSelect={store.selectAgent}
            onCreate={() => {
              store.selectAgent(null);
              setInitialTemplateId(null);
              setEditing(true);
            }}
            onChooseTemplate={(templateId) => {
              store.selectAgent(null);
              setInitialTemplateId(templateId);
              setEditing(true);
            }}
            onDuplicate={(agentId) => withBusy(() => store.duplicateAgent(ctx, workspace, agentId))}
            onRemove={(agentId) => withBusy(() => store.removeAgent(ctx, workspace, agentId))}
            onToggleEnabled={(agent) =>
              withBusy(() =>
                store.updateAgent(ctx, workspace, agent.id, { enabled: !agent.enabled }),
              )
            }
          />
        </aside>
        <main className="flex min-w-0 min-h-0 flex-1 flex-col" data-zaicode-tour="queue">
          <ZaicodeQueuePanel
            jobs={store.jobs}
            diagnostics={store.jobDiagnostics}
            agents={store.agents}
            selectedJobId={store.selectedJobId}
            autoRun={store.autoRun}
            busy={busy}
            workspacePath={workspace.workspacePath}
            onSelectJob={store.selectJob}
            onCreateAgent={() => {
              store.selectAgent(null);
              setInitialTemplateId(null);
              setEditing(true);
            }}
            onCreateJob={(input) => withBusy(() => store.createJob(ctx, workspace, input))}
            onDispatch={(jobId) => withBusy(() => store.dispatchJob(ctx, workspace, jobId))}
            onCancel={(jobId) => withBusy(() => store.cancelJob(ctx, workspace, jobId))}
            onRetry={(jobId) => withBusy(() => store.retryJob(ctx, workspace, jobId))}
            onResume={(jobId) => withBusy(() => store.resumeJob(ctx, workspace, jobId))}
            onRemove={(jobId) => withBusy(() => store.removeJob(ctx, workspace, jobId))}
            onMove={(jobId, direction) =>
              withBusy(() => store.reorderJob(ctx, workspace, jobId, direction))
            }
          />
        </main>
        <aside
          className={cn(
            "min-h-0 w-80 max-w-full shrink-0 flex-col border-l border-border bg-background",
            // Wide: always beside the queue. Narrow: over the queue, only while there is something to show.
            "@min-[1100px]/zws:static @min-[1100px]/zws:flex",
            inspectorWanted ? "absolute inset-y-0 right-0 z-20 flex shadow-lg" : "hidden",
          )}
          data-zaicode-tour="inspector"
          data-zaicode-inspector-overlay={inspectorWanted ? "open" : undefined}
        >
          {inspectorWanted ? (
            <button
              type="button"
              className="absolute right-1 top-1 z-10 flex size-6 items-center justify-center text-foreground-subtle hover:bg-hover hover:text-foreground @min-[1100px]/zws:hidden"
              title="Close"
              onClick={closeInspector}
            >
              <X className="size-3.5" />
            </button>
          ) : null}
          {iconsOpen ? (
            <ZaicodeIconEditor onClose={() => setIconsOpen(false)} />
          ) : (
            <ZaicodeInspector
              agent={selectedAgent}
              job={selectedJob}
              agents={store.agents}
              jobs={store.jobs}
              templates={store.templates}
              editing={editing}
              initialTemplateId={initialTemplateId}
              busy={busy}
              onStartEdit={() => setEditing(true)}
              onCancelEdit={() => setEditing(false)}
              onSaveNew={(input) =>
                withBusy(async () => {
                  await store.createAgent(ctx, workspace, input);
                  setEditing(false);
                })
              }
              onSavePatch={(patch) => {
                if (!selectedAgent) return;
                void withBusy(async () => {
                  await store.updateAgent(ctx, workspace, selectedAgent.id, patch);
                  setEditing(false);
                });
              }}
              onDuplicate={(agentId) =>
                withBusy(() => store.duplicateAgent(ctx, workspace, agentId))
              }
              onRemoveAgent={(agentId) =>
                withBusy(() => store.removeAgent(ctx, workspace, agentId))
              }
              onDispatch={(jobId) => withBusy(() => store.dispatchJob(ctx, workspace, jobId))}
              onCancelJob={(jobId) => withBusy(() => store.cancelJob(ctx, workspace, jobId))}
              onRetryJob={(jobId) => withBusy(() => store.retryJob(ctx, workspace, jobId))}
              onResumeJob={(jobId) => withBusy(() => store.resumeJob(ctx, workspace, jobId))}
              {...(onOpenSession ? { onOpenSession } : {})}
            />
          )}
        </aside>
      </div>
      )}
    </div>
  );
}
