import { useState } from "react";
import type { ZaicodeAgentDefinition, ZaicodeJob, ZaicodeJobDiagnostic } from "@zcode/shared";
import { zaicodeJobTaskText } from "@zcode/shared";
import { ChevronDown, ChevronUp, Play, RotateCcw, Square, Trash2, Undo2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  isJobActive,
  jobPrimaryAction,
  jobStatusBadgeVariant,
  jobStatusGroup,
  jobStatusHelpId,
  jobStatusLabelId,
  sortJobsForDisplay,
  type ZaicodeJobGroup,
  type ZaicodeJobPrimaryAction,
} from "@/zaicode/zaicodeStatus.js";
import { ZaicodeQueueTodometer } from "@/v4/ZaicodeTodoGauge.js";

type QueueFilter = "all" | ZaicodeJobGroup;
const FILTERS: readonly QueueFilter[] = ["all", "active", "attention", "done"];

export interface ZaicodeQueuePanelProps {
  jobs: readonly ZaicodeJob[];
  diagnostics: readonly ZaicodeJobDiagnostic[];
  agents: readonly ZaicodeAgentDefinition[];
  selectedJobId: string | null;
  autoRun: boolean;
  busy?: boolean;
  workspacePath?: string;
  onSelectJob: (jobId: string) => void;
  onCreateAgent: () => void;
  onCreateJob: (input: {
    agentId: string;
    title: string;
    instructions: string;
    priority: number;
    delegation?: { targetAgentId: string; instructions: string };
  }) => void;
  onDispatch: (jobId: string) => void;
  onCancel: (jobId: string) => void;
  onRetry: (jobId: string) => void;
  onResume: (jobId: string) => void;
  onRemove: (jobId: string) => void;
  onMove: (jobId: string, direction: "up" | "down") => void;
}

function formatTime(value: number | undefined): string {
  return value ? new Date(value).toLocaleTimeString() : "—";
}

const PRIMARY_ICON: Record<Exclude<ZaicodeJobPrimaryAction, null>, typeof Play> = {
  run: Play,
  stop: Square,
  retry: RotateCcw,
  resume: Undo2,
};

/**
 * 任务队列：「要做什么」。每行只有一个与状态匹配的主操作（运行/停止/重试/恢复），
 * 排序与删除在悬停时出现；筛选收敛为 全部/进行中/需要处理/已结束 四组。
 */
export function ZaicodeQueuePanel({
  jobs,
  diagnostics,
  agents,
  selectedJobId,
  autoRun,
  busy = false,
  onSelectJob,
  onCreateAgent,
  onCreateJob,
  onDispatch,
  onCancel,
  onRetry,
  onResume,
  onRemove,
  onMove,
  workspacePath,
}: ZaicodeQueuePanelProps) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [showCreate, setShowCreate] = useState(false);
  const [agentId, setAgentId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [priority, setPriority] = useState(0);
  const [delegateAgentId, setDelegateAgentId] = useState<string>("");

  const enabledAgents = agents.filter((agent) => agent.enabled);
  const selectedAgent =
    enabledAgents.find((agent) => agent.id === agentId) ?? enabledAgents[0] ?? null;
  const counts: Record<QueueFilter, number> = {
    all: jobs.length,
    active: 0,
    attention: 0,
    done: 0,
  };
  for (const job of jobs) counts[jobStatusGroup(job.status)] += 1;
  const visibleJobs = sortJobsForDisplay(
    jobs.filter((job) => filter === "all" || jobStatusGroup(job.status) === filter),
  );

  const runPrimary = (job: ZaicodeJob, action: ZaicodeJobPrimaryAction) => {
    if (action === "run") onDispatch(job.id);
    else if (action === "stop") onCancel(job.id);
    else if (action === "retry") onRetry(job.id);
    else if (action === "resume") onResume(job.id);
  };

  const submit = () => {
    if (!selectedAgent) return;
    // SRC-038 hit and go: an empty "what to do" runs /goal cc all.
    const task = zaicodeJobTaskText(instructions);
    onCreateJob({
      agentId: selectedAgent.id,
      title: title.trim() || task.split("\n")[0]!.slice(0, 80),
      instructions: task,
      priority,
      ...(selectedAgent.role === "coordinator" && delegateAgentId
        ? { delegation: { targetAgentId: delegateAgentId, instructions: instructions.trim() } }
        : {}),
    });
    setTitle("");
    setInstructions("");
    setDelegateAgentId("");
    setPriority(0);
    setShowCreate(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-ui-xs font-medium uppercase tracking-wide text-foreground-subtle">
          {t("zaicode.queue.title")}
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {FILTERS.map((value) => (
            <Button
              key={value}
              size="xs"
              variant={filter === value ? "secondary" : "ghost"}
              title={t(`zaicode.queue.filterHelp.${value}`)}
              onClick={() => setFilter(value)}
            >
              {t(`zaicode.queue.filter.${value}`)}
              <span className="tabular-nums text-foreground-subtle">{counts[value]}</span>
            </Button>
          ))}
        </div>
        <Button
          size="sm"
          variant={showCreate ? "secondary" : "outline"}
          disabled={enabledAgents.length === 0}
          title={enabledAgents.length === 0 ? t("zaicode.queue.needAgent") : undefined}
          onClick={() => setShowCreate((value) => !value)}
        >
          {t("zaicode.action.newTask")}
        </Button>
      </div>

      <ZaicodeQueueTodometer
        jobs={jobs}
        selectedJobId={selectedJobId}
        workspacePath={workspacePath}
      />

      {showCreate && selectedAgent ? (
        <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface px-3 py-3">
          <Textarea
            autoFocus
            value={instructions}
            rows={4}
            placeholder={t("zaicode.queue.instructionsPlaceholder")}
            onChange={(event) => setInstructions(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.ctrlKey || event.metaKey)
              ) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-ui-xs text-foreground-subtle">
              {t("zaicode.field.assignAgent")}
            </span>
            {enabledAgents.map((agent) => (
              <Button
                key={agent.id}
                size="xs"
                variant={selectedAgent.id === agent.id ? "secondary" : "ghost"}
                onClick={() => {
                  setAgentId(agent.id);
                  setDelegateAgentId("");
                }}
              >
                {agent.name}
              </Button>
            ))}
          </div>
          {selectedAgent.role === "coordinator" && enabledAgents.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1">
              <span
                className="text-ui-xs text-foreground-subtle"
                title={t("zaicode.queue.delegateHelp")}
              >
                {t("zaicode.field.delegateTo")}
              </span>
              {enabledAgents
                .filter((agent) => agent.id !== selectedAgent.id)
                .map((agent) => (
                  <Button
                    key={agent.id}
                    size="xs"
                    variant={delegateAgentId === agent.id ? "secondary" : "ghost"}
                    onClick={() => setDelegateAgentId(delegateAgentId === agent.id ? "" : agent.id)}
                  >
                    {agent.name}
                  </Button>
                ))}
            </div>
          ) : null}
          <details className="text-ui-xs text-foreground-subtle">
            <summary className="cursor-pointer select-none">{t("zaicode.queue.more")}</summary>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Input
                className="min-w-40 flex-1"
                value={title}
                placeholder={t("zaicode.queue.titlePlaceholder")}
                onChange={(event) => setTitle(event.target.value)}
              />
              <label className="flex items-center gap-2" title={t("zaicode.queue.priorityHelp")}>
                {t("zaicode.field.priority")}
                <Input
                  className="w-16"
                  type="number"
                  value={String(priority)}
                  onChange={(event) => setPriority(Number.parseInt(event.target.value, 10) || 0)}
                />
              </label>
            </div>
          </details>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-ui-xs text-foreground-subtle">
              {t(autoRun ? "zaicode.queue.willAutoStart" : "zaicode.queue.willWait")}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setShowCreate(false)}>
              {t("zaicode.action.cancel")}
            </Button>
            <Button size="sm" disabled={busy} onClick={submit}>
              {t("zaicode.action.addTask")}
            </Button>
          </div>
        </div>
      ) : null}

      {diagnostics.length > 0 ? (
        <div className="shrink-0 border-b border-border px-3 py-2 text-ui-xs text-destructive">
          {t("zaicode.queue.diagnostics", { count: diagnostics.length })}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {enabledAgents.length === 0 && jobs.length === 0 ? (
          <div className="flex flex-col items-start gap-2 px-2 py-4 text-ui-sm text-foreground-subtle">
            <span>{t("zaicode.queue.emptyNoAgents")}</span>
            <Button size="sm" variant="outline" onClick={onCreateAgent}>
              {t("zaicode.action.createFirstAgent")}
            </Button>
          </div>
        ) : visibleJobs.length === 0 ? (
          <div className="flex flex-col items-start gap-2 px-2 py-4 text-ui-sm text-foreground-subtle">
            <span>
              {t(filter === "all" ? "zaicode.queue.emptyAll" : "zaicode.queue.emptyFiltered")}
            </span>
            {filter === "all" && !showCreate ? (
              <Button size="sm" variant="outline" onClick={() => setShowCreate(true)}>
                {t("zaicode.action.newTask")}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {visibleJobs.map((job) => {
              const agent = agents.find((candidate) => candidate.id === job.agentId);
              const selected = selectedJobId === job.id;
              const active = isJobActive(job.status);
              const primary = jobPrimaryAction(job.status);
              const PrimaryIcon = primary ? PRIMARY_ICON[primary] : null;
              return (
                <div
                  key={job.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectJob(job.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") onSelectJob(job.id);
                  }}
                  className={cn(
                    "group flex cursor-pointer items-center gap-2 border border-transparent px-2 py-1.5 hover:border-border hover:bg-surface-hover",
                    selected && "border-border bg-selected",
                  )}
                >
                  <Badge
                    variant={jobStatusBadgeVariant(job.status)}
                    className="shrink-0"
                    title={t(jobStatusHelpId(job.status))}
                  >
                    {t(jobStatusLabelId(job.status))}
                  </Badge>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-ui-base text-foreground">
                      {job.title || job.instructions.split("\n")[0] || job.id}
                    </span>
                    <span className="truncate text-ui-xs text-foreground-subtlest">
                      {agent?.name ?? job.agentId} · {formatTime(job.startedAt ?? job.createdAt)}
                      {job.attempt > 1
                        ? ` · ${t("zaicode.queue.attempt", { count: job.attempt })}`
                        : ""}
                      {job.error ? <span className="text-destructive"> · {job.error}</span> : null}
                    </span>
                  </div>
                  <div
                    className="flex shrink-0 items-center gap-0.5"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div
                      className={cn(
                        "flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                        selected && "opacity-100",
                      )}
                    >
                      {active ? (
                        <>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            title={t("zaicode.action.moveUp")}
                            disabled={busy}
                            onClick={() => onMove(job.id, "up")}
                          >
                            <ChevronUp className="size-3" />
                          </Button>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            title={t("zaicode.action.moveDown")}
                            disabled={busy}
                            onClick={() => onMove(job.id, "down")}
                          >
                            <ChevronDown className="size-3" />
                          </Button>
                          {primary !== "stop" ? (
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              title={t("zaicode.action.cancelJob")}
                              disabled={busy}
                              onClick={() => onCancel(job.id)}
                            >
                              <X className="size-3" />
                            </Button>
                          ) : null}
                        </>
                      ) : (
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          title={t("zaicode.action.remove")}
                          disabled={busy}
                          onClick={() => onRemove(job.id)}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      )}
                    </div>
                    {primary && PrimaryIcon ? (
                      <Button
                        size="xs"
                        variant={primary === "run" ? "secondary" : "ghost"}
                        disabled={busy}
                        title={t(`zaicode.primaryHelp.${primary}`)}
                        onClick={() => runPrimary(job, primary)}
                      >
                        <PrimaryIcon className="size-3" />
                        {t(`zaicode.primary.${primary}`)}
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
