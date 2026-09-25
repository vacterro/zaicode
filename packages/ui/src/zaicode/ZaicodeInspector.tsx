import { resolveZaicodRoutePlan } from "@zcode/shared";
import type {
  ZaicodeAgentCreateInput,
  ZaicodeAgentDefinition,
  ZaicodeAgentTemplate,
  ZaicodeAgentUpdatePatch,
  ZaicodeJob,
} from "@zcode/shared";
import { Copy, Pencil, Play, RotateCcw, Trash2, Undo2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  jobStatusBadgeVariant,
  jobStatusLabelId,
  routePlanStatusMessageId,
} from "@/zaicode/zaicodeStatus.js";
import { formatPoolLabel } from "@/zaicode/zaicodeRoutingModel.js";
import { ZaicodeAgentEditor } from "@/zaicode/ZaicodeAgentEditor.js";
import { ZaicodeAgentSchedules } from "./ZaicodeSchedulerBits.js";

export interface ZaicodeInspectorProps {
  agent: ZaicodeAgentDefinition | null;
  job: ZaicodeJob | null;
  agents: readonly ZaicodeAgentDefinition[];
  jobs: readonly ZaicodeJob[];
  templates: readonly ZaicodeAgentTemplate[];
  editing: boolean;
  initialTemplateId?: string | null;
  busy?: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveNew: (input: ZaicodeAgentCreateInput) => void;
  onSavePatch: (patch: ZaicodeAgentUpdatePatch) => void;
  onDuplicate: (agentId: string) => void;
  onRemoveAgent: (agentId: string) => void;
  onDispatch: (jobId: string) => void;
  onCancelJob: (jobId: string) => void;
  onRetryJob: (jobId: string) => void;
  onResumeJob: (jobId: string) => void;
  /** 打开任务运行时的会话（切回聊天视图）。 */
  onOpenSession?: (sessionId: string) => void;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-ui-xs text-foreground-subtle">{label}</span>
      <span className="min-w-0 truncate text-ui-base text-foreground">{value}</span>
    </div>
  );
}

/** 池 = 配置的 provider/model 选择（例如 SAIRoute / SAIFREN）；没有选择时显示 —。 */
function agentPoolLabel(agent: ZaicodeAgentDefinition | undefined | null): string {
  const providerId = agent?.modelSelection?.providerId ?? agent?.providerRef;
  const modelId = agent?.modelSelection?.modelId ?? agent?.modelRef;
  if (!providerId || !modelId) return "—";
  return formatPoolLabel(providerId, modelId);
}

function formatTime(value: number | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/** Inspector：选中 agent 或任务的详情，不离开队列即可查看与操作。 */
export function ZaicodeInspector({
  agent,
  job,
  agents,
  jobs,
  templates,
  editing,
  initialTemplateId,
  busy = false,
  onStartEdit,
  onCancelEdit,
  onSaveNew,
  onSavePatch,
  onDuplicate,
  onRemoveAgent,
  onDispatch,
  onCancelJob,
  onRetryJob,
  onResumeJob,
  onOpenSession,
}: ZaicodeInspectorProps) {
  const { intl } = useZCodeIntl();
  const selectedAgent = agent;
  const selectedJob = job;
  const selectedJobAgent = selectedJob
    ? agents.find((candidate) => candidate.id === selectedJob.agentId)
    : undefined;
  const selectedAgentRoutePlan = selectedAgent
    ? resolveZaicodRoutePlan({
        agentId: selectedAgent.id,
        role: selectedAgent.role,
        backend: selectedAgent.backend,
        ...(selectedAgent.modelSelection
          ? { configuredSelection: selectedAgent.modelSelection }
          : {}),
        ...(selectedAgent.providerRef ? { providerRef: selectedAgent.providerRef } : {}),
        ...(selectedAgent.modelRef ? { modelRef: selectedAgent.modelRef } : {}),
      })
    : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center border-b border-border px-3">
        <span className="text-ui-xs font-medium uppercase tracking-wide text-foreground-subtle">
          {editing
            ? intl.formatMessage({ id: "zaicode.editor.title" })
            : intl.formatMessage({ id: "zaicode.inspector.title" })}
        </span>
      </div>
      {editing ? (
        <ZaicodeAgentEditor
          agent={selectedAgent}
          templates={templates}
          initialTemplateId={initialTemplateId}
          busy={busy}
          onSave={(payload) => {
            if (selectedAgent) onSavePatch(payload as ZaicodeAgentUpdatePatch);
            else onSaveNew(payload as ZaicodeAgentCreateInput);
          }}
          onCancel={onCancelEdit}
        />
      ) : selectedAgent ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-ui-lg text-foreground">
              {selectedAgent.name}
            </span>
            <Badge variant={selectedAgent.enabled ? "secondary" : "ghost"}>
              {intl.formatMessage({
                id: selectedAgent.enabled
                  ? "zaicode.agentStatus.idle"
                  : "zaicode.agentStatus.offline",
              })}
            </Badge>
          </div>
          <Field
            label={intl.formatMessage({ id: "zaicode.field.role" })}
            value={selectedAgent.role}
          />
          <div className="flex flex-col gap-0.5">
            <span className="text-ui-xs font-medium uppercase tracking-wide text-foreground-subtle">
              {intl.formatMessage({ id: "zaicode.inspector.configuredSection" })}
            </span>
          </div>
          <Field
            label={intl.formatMessage({ id: "zaicode.field.pool" })}
            value={agentPoolLabel(selectedAgent)}
          />
          {selectedAgentRoutePlan ? (
            <Field
              label={intl.formatMessage({ id: "zaicode.inspector.routeStatus" })}
              value={intl.formatMessage({ id: routePlanStatusMessageId(selectedAgentRoutePlan) })}
            />
          ) : null}

          <Field
            label={intl.formatMessage({ id: "zaicode.field.permissionMode" })}
            value={selectedAgent.toolPolicy.permissionMode ?? "default"}
          />
          <div className="flex flex-col gap-0.5">
            <span className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "zaicode.field.instructions" })}
            </span>
            <p className="text-ui-base whitespace-pre-wrap text-foreground">
              {selectedAgent.instructions}
            </p>
          </div>
          <Field
            label={intl.formatMessage({ id: "zaicode.inspector.queueDepth" })}
            value={String(
              jobs.filter(
                (candidate) =>
                  candidate.agentId === selectedAgent.id &&
                  candidate.status !== "completed" &&
                  candidate.status !== "failed" &&
                  candidate.status !== "cancelled",
              ).length,
            )}
          />
          <ZaicodeAgentSchedules agentId={selectedAgent.id} agentName={selectedAgent.name} />
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" disabled={busy} onClick={onStartEdit}>
              <Pencil className="size-3" />
              {intl.formatMessage({ id: "zaicode.action.edit" })}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              title="duplicate"
              disabled={busy}
              onClick={() => onDuplicate(selectedAgent.id)}
            >
              <Copy className="size-3" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              title="delete"
              disabled={busy}
              onClick={() => onRemoveAgent(selectedAgent.id)}
            >
              <Trash2 className="size-3" />
            </Button>
          </div>
        </div>
      ) : selectedJob ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
          <div className="flex items-center gap-2">
            <Badge variant={jobStatusBadgeVariant(selectedJob.status)}>
              {intl.formatMessage({ id: jobStatusLabelId(selectedJob.status) })}
            </Badge>
            <span className="min-w-0 truncate text-ui-base text-foreground">
              {selectedJob.title || selectedJob.id}
            </span>
          </div>
          <Field
            label={intl.formatMessage({ id: "zaicode.field.assignAgent" })}
            value={selectedJobAgent?.name ?? selectedJob.agentId}
          />
          <div className="flex flex-col gap-0.5">
            <span className="text-ui-xs font-medium uppercase tracking-wide text-foreground-subtle">
              {intl.formatMessage({ id: "zaicode.inspector.configuredSection" })}
            </span>
          </div>
          <Field
            label={intl.formatMessage({ id: "zaicode.field.pool" })}
            value={agentPoolLabel(selectedJobAgent)}
          />
          {selectedJob.error?.startsWith("route-unresolved:") ? (
            <Field
              label={intl.formatMessage({ id: "zaicode.inspector.routeStatus" })}
              value={intl.formatMessage({ id: "zaicode.route.unresolved" })}
            />
          ) : null}
          <div className="flex flex-col gap-0.5">
            <span className="text-ui-xs font-medium uppercase tracking-wide text-foreground-subtle">
              {intl.formatMessage({ id: "zaicode.inspector.resolvedSection" })}
            </span>
          </div>
          <Field
            label={intl.formatMessage({ id: "zaicode.inspector.started" })}
            value={formatTime(selectedJob.startedAt)}
          />
          <Field
            label={intl.formatMessage({ id: "zaicode.inspector.finished" })}
            value={formatTime(selectedJob.finishedAt)}
          />
          {selectedJob.sessionId && onOpenSession ? (
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              title={selectedJob.sessionId}
              onClick={() => onOpenSession(selectedJob.sessionId!)}
            >
              {intl.formatMessage({ id: "zaicode.inspector.openSession" })}
            </Button>
          ) : (
            <Field
              label={intl.formatMessage({ id: "zaicode.inspector.session" })}
              value={selectedJob.sessionId ?? "—"}
            />
          )}
          <Field
            label={intl.formatMessage({ id: "zaicode.inspector.resolvedSelection" })}
            value={
              selectedJob.actualModelSelection
                ? `${selectedJob.actualModelSelection.providerId}/${selectedJob.actualModelSelection.modelId}`
                : intl.formatMessage({ id: "zaicode.inspector.resolvedPending" })
            }
          />
          {selectedJob.retryOfJobId ? (
            <Field
              label={intl.formatMessage({ id: "zaicode.inspector.retryOf" })}
              value={selectedJob.retryOfJobId}
            />
          ) : null}
          {selectedJob.delegation ? (
            <Field
              label={intl.formatMessage({ id: "zaicode.inspector.delegation" })}
              value={selectedJob.delegation.targetAgentId}
            />
          ) : null}
          {selectedJob.error ? (
            <div className="flex flex-col gap-0.5">
              <span className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "zaicode.inspector.error" })}
              </span>
              <p className="text-ui-base whitespace-pre-wrap text-destructive">
                {selectedJob.error}
              </p>
            </div>
          ) : null}
          {selectedJob.resultSummary ? (
            <div className="flex flex-col gap-0.5">
              <span className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "zaicode.inspector.result" })}
              </span>
              <p className="text-ui-base whitespace-pre-wrap text-foreground">
                {selectedJob.resultSummary}
              </p>
            </div>
          ) : null}
          <div className="flex flex-col gap-0.5">
            <span className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "zaicode.field.instructions" })}
            </span>
            <p className="text-ui-base whitespace-pre-wrap text-foreground">
              {selectedJob.instructions}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || selectedJob.status === "running"}
              onClick={() => onDispatch(selectedJob.id)}
            >
              <Play className="size-3" />
              {intl.formatMessage({ id: "zaicode.action.dispatch" })}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => onCancelJob(selectedJob.id)}
            >
              <X className="size-3" />
              {intl.formatMessage({ id: "zaicode.action.cancelJob" })}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => onRetryJob(selectedJob.id)}
            >
              <RotateCcw className="size-3" />
              {intl.formatMessage({ id: "zaicode.action.retry" })}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || selectedJob.status !== "blocked"}
              onClick={() => onResumeJob(selectedJob.id)}
            >
              <Undo2 className="size-3" />
              {intl.formatMessage({ id: "zaicode.action.resume" })}
            </Button>
          </div>
          {jobs.filter((candidate) => candidate.parentJobId === selectedJob.id).length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "zaicode.inspector.children" })}
              </span>
              {jobs
                .filter((candidate) => candidate.parentJobId === selectedJob.id)
                .map((child) => (
                  <div
                    key={child.id}
                    className="flex items-center gap-2 rounded-lg border border-border px-2 py-1"
                  >
                    <Badge variant={jobStatusBadgeVariant(child.status)}>
                      {intl.formatMessage({ id: jobStatusLabelId(child.status) })}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-ui-xs text-foreground">
                      {child.title || child.id}
                    </span>
                  </div>
                ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="p-3 text-ui-xs text-foreground-subtlest">
          {intl.formatMessage({ id: "zaicode.inspector.empty" })}
        </p>
      )}
    </div>
  );
}
