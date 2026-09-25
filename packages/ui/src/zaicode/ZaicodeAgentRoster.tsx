import type { ZaicodeAgentDefinition, ZaicodeAgentDiagnostic, ZaicodeAgentTemplate, ZaicodeJob } from "@zcode/shared";
import { Copy, Plus, Trash2 } from "lucide-react";
import { ZaicodeIcon } from "./zaicodeIconSlots.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { agentDisplayStatusLabelId, deriveAgentDisplayStatus } from "@/zaicode/zaicodeStatus.js";

export interface ZaicodeAgentRosterProps {
  agents: readonly ZaicodeAgentDefinition[];
  templates: readonly ZaicodeAgentTemplate[];
  jobs: readonly ZaicodeJob[];
  diagnostics: readonly ZaicodeAgentDiagnostic[];
  selectedAgentId: string | null;
  busy?: boolean;
  onSelect: (agentId: string) => void;
  onCreate: () => void;
  onChooseTemplate: (templateId: string) => void;
  onDuplicate: (agentId: string) => void;
  onRemove: (agentId: string) => void;
  onToggleEnabled: (agent: ZaicodeAgentDefinition) => void;
}

function modelLabel(agent: ZaicodeAgentDefinition): string {
  const selection = agent.modelSelection;
  if (selection) return `${selection.providerId}/${selection.modelId}`;
  const reference = [agent.providerRef, agent.modelRef].filter(Boolean).join("/");
  return reference || "—";
}

/** Agent Roster：状态/模型/队列深度/最近活动一次可见，不需要打开对话框。 */
export function ZaicodeAgentRoster({
  agents,
  templates,
  jobs,
  diagnostics,
  selectedAgentId,
  busy = false,
  onSelect,
  onCreate,
  onChooseTemplate,
  onDuplicate,
  onRemove,
  onToggleEnabled,
}: ZaicodeAgentRosterProps) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <span
          className="text-ui-xs font-medium uppercase tracking-wide text-foreground-subtle"
          title={intl.formatMessage({ id: "zaicode.flow.agentsHelp" })}
        >
          {intl.formatMessage({ id: "zaicode.roster.title" })}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={busy}
          onClick={onCreate}
          title={intl.formatMessage({ id: "zaicode.editor.createTitle" })}
        >
          <Plus className="size-3" />
        </Button>
      </div>
      {diagnostics.length > 0 ? (
        <div className="border-b border-border px-3 py-2 text-ui-xs text-destructive">
          {intl.formatMessage({ id: "zaicode.roster.diagnostics" }, { count: diagnostics.length })}
        </div>
      ) : null}
      <div className="shrink-0 border-b border-border px-2 py-2">
        <div className="mb-1 flex items-center justify-between text-ui-xs text-foreground-subtle">
          <span>{intl.formatMessage({ id: "zaicode.roster.modes" })}</span>
          <span className="text-[10px] text-foreground-subtlest">Sub-agents</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {templates.map((template) => {
            const existing = agents.find(
              (agent) =>
                agent.templateId === template.id ||
                agent.name.toLowerCase() === template.name.toLowerCase() ||
                agent.role === template.role,
            );
            const isSelected = existing && selectedAgentId === existing.id;
            return (
              <Button
                key={template.id}
                size="xs"
                variant={isSelected ? "default" : existing ? "secondary" : "outline"}
                disabled={busy}
                title={
                  existing
                    ? `${template.name} (Active in roster: click to select)`
                    : `${template.name}: ${template.description}`
                }
                onClick={() => {
                  if (existing) {
                    onSelect(existing.id);
                  } else {
                    onChooseTemplate(template.id);
                  }
                }}
              >
                {existing ? template.name : `+ ${template.name}`}
              </Button>
            );
          })}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {agents.length === 0 ? (
          <div className="flex flex-col items-start gap-2 px-2 py-3 text-ui-xs text-foreground-subtle">
            <span>{intl.formatMessage({ id: "zaicode.roster.empty" })}</span>
            <Button size="sm" variant="outline" disabled={busy} onClick={onCreate}>
              <Plus className="size-3" />
              {intl.formatMessage({ id: "zaicode.action.createFirstAgent" })}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {agents.map((agent) => {
              const status = deriveAgentDisplayStatus(agent, jobs);
              const depth = jobs.filter(
                (job) =>
                  job.agentId === agent.id &&
                  job.status !== "completed" &&
                  job.status !== "failed" &&
                  job.status !== "cancelled",
              ).length;
              const selected = selectedAgentId === agent.id;
              return (
                <div
                  key={agent.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(agent.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") onSelect(agent.id);
                  }}
                  className={cn(
                    "group flex cursor-pointer flex-col gap-1 rounded-lg border border-transparent px-2 py-1.5 text-left hover:border-border hover:bg-surface-hover",
                    selected && "border-border bg-selected",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <ZaicodeIcon slot="roster.agent" className="size-3.5 text-foreground-subtle" />
                    <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">
                      {agent.name}
                    </span>
                    <span className="shrink-0 text-ui-xs text-foreground-subtle">
                      {intl.formatMessage({ id: agentDisplayStatusLabelId(status) })}
                    </span>
                  </div>
                  <div className="flex min-w-0 items-center gap-2 text-ui-xs text-foreground-subtlest">
                    <span className="truncate">{modelLabel(agent)}</span>
                    <span className="shrink-0">
                      {intl.formatMessage({ id: "zaicode.roster.queueDepth" }, { count: depth })}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleEnabled(agent);
                      }}
                    >
                      {agent.enabled
                        ? intl.formatMessage({ id: "zaicode.action.disable" })
                        : intl.formatMessage({ id: "zaicode.action.enable" })}
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      title={intl.formatMessage({ id: "zaicode.action.duplicate" })}
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        onDuplicate(agent.id);
                      }}
                    >
                      <Copy className="size-3" />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      title={intl.formatMessage({ id: "zaicode.action.remove" })}
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemove(agent.id);
                      }}
                    >
                      <Trash2 className="size-3" />
                    </Button>
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
