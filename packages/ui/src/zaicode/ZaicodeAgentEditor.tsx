import { useEffect, useState } from "react";
import { resolveZaicodRoutePlan } from "@zcode/shared";
import type {
  ZaicodeAgentCreateInput,
  ZaicodeAgentDefinition,
  ZaicodeAgentRole,
  ZaicodeAgentTemplate,
  ZaicodeAgentUpdatePatch,
  ZaicodeRouteBackend,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { Textarea } from "@/components/ui/textarea.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildZaicodeAgentEditorRoutingFields } from "./zaicodeAgentEditorPolicy.js";
import { routePlanStatusMessageId } from "./zaicodeStatus.js";
import { backendForPool, findLegacyPoolOption, formatPoolLabel } from "./zaicodeRoutingModel.js";
import { ZaicodePoolPicker, useZaicodePoolGroups } from "./ZaicodePoolPicker.js";
import { readZaicodeDefaultModel } from "./zaicodeDefaultModel.js";

const ROLES: ZaicodeAgentRole[] = ["coordinator", "implementer", "auditor", "researcher", "custom"];

export interface ZaicodeAgentEditorProps {
  agent: ZaicodeAgentDefinition | null;
  initialTemplateId?: string | null;
  templates: readonly ZaicodeAgentTemplate[];
  busy?: boolean;
  onSave: (payload: ZaicodeAgentCreateInput | ZaicodeAgentUpdatePatch) => void;
  onCancel: () => void;
}

/** agent 创建/编辑表单：角色与权限档位用分段按钮，避免不必要的下拉配置。 */
export function ZaicodeAgentEditor({
  agent,
  initialTemplateId,
  templates,
  busy = false,
  onSave,
  onCancel,
}: ZaicodeAgentEditorProps) {
  const { intl } = useZCodeIntl();
  const [name, setName] = useState("");
  const [role, setRole] = useState<ZaicodeAgentRole>("custom");
  const [instructions, setInstructions] = useState("");
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [reasoningLevel, setReasoningLevel] = useState("");
  const [permissionPlan, setPermissionPlan] = useState(false);
  const [backend, setBackend] = useState<ZaicodeRouteBackend>("direct");
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    setName(agent?.name ?? "");
    setRole(agent?.role ?? "custom");
    setInstructions(agent?.instructions ?? "");
    // SRC-038: a new agent starts on the default model for new tasks (usually SAIFREN), ready to run.
    const fresh = agent ? null : readZaicodeDefaultModel();
    setProviderId(agent?.modelSelection?.providerId ?? agent?.providerRef ?? fresh?.providerId ?? "");
    setModelId(agent?.modelSelection?.modelId ?? agent?.modelRef ?? fresh?.modelId ?? "");
    setReasoningLevel(
      agent?.modelSelection?.options?.reasoningLevel ?? agent?.reasoningEffort ?? "",
    );
    setPermissionPlan(agent?.toolPolicy.permissionMode === "plan");
    setBackend(agent?.backend ?? "direct");
    setEnabled(agent?.enabled ?? true);
  }, [agent]);

  // Pool = provider/model selection (e.g. SAIRoute / SAIFREN). Legacy agents that
  // only stored backend "saifren" get the matching pool preselected once.
  const { groups: poolGroups, loading: poolsLoading } = useZaicodePoolGroups();
  const selectedPool = poolGroups.flatMap((group) => group.options).find(
    (option) => option.providerId === providerId && option.modelId === modelId,
  );
  const reasoningLevels = selectedPool?.reasoningLevels ?? [];
  const reasoningValid = !modelId || (reasoningLevels.length > 0 && reasoningLevels.includes(reasoningLevel));
  useEffect(() => {
    if (agent || !initialTemplateId) return;
    const template = templates.find((item) => item.id === initialTemplateId);
    if (!template) return;
    setName(template.name);
    setRole(template.role);
    setInstructions(template.instructions);
    setPermissionPlan(template.toolPolicy.permissionMode === "plan");
  }, [agent, initialTemplateId, templates]);
  useEffect(() => {
    // 同一次提交里上一个 effect 的 setState 尚未生效，所以直接看 agent 本身的引用字段。
    if (!agent || agent.modelSelection || agent.providerRef || agent.modelRef) return;
    if (providerId || modelId) return;
    const legacy = findLegacyPoolOption(agent.backend, poolGroups);
    if (!legacy) return;
    setProviderId(legacy.providerId);
    setModelId(legacy.modelId);
    setBackend(backendForPool(legacy.providerId, legacy.providerLabel));
    setReasoningLevel(legacy.reasoningLevels.at(-1) ?? "");
    // 只在池列表或编辑对象变化时尝试一次迁移预选。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, poolGroups]);
  const modelSelection =
    providerId.trim() && modelId.trim()
      ? {
          providerId: providerId.trim(),
          modelId: modelId.trim(),
          ...(reasoningLevel.trim() ? { options: { reasoningLevel: reasoningLevel.trim() } } : {}),
        }
      : undefined;

  const routePlan = resolveZaicodRoutePlan({
    agentId: agent?.id ?? "draft-agent",
    role,
    backend,
    ...(modelSelection ? { configuredSelection: modelSelection } : {}),
    ...(providerId.trim() ? { providerRef: providerId.trim() } : {}),
    ...(modelId.trim() ? { modelRef: modelId.trim() } : {}),
  });
  const routeStatusMessageId = routePlanStatusMessageId(routePlan);

  const canSave = name.trim().length > 0 && reasoningValid && !busy;

  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div className="text-ui-base font-medium text-foreground">
        {agent
          ? intl.formatMessage({ id: "zaicode.editor.editTitle" })
          : intl.formatMessage({ id: "zaicode.editor.createTitle" })}
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "zaicode.field.name" })}
        </span>
        <Input value={name} onChange={(event) => setName(event.target.value)} />
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "zaicode.field.role" })}
        </span>
        <div className="flex flex-wrap gap-1">
          {ROLES.map((candidate) => (
            <Button
              key={candidate}
              type="button"
              size="sm"
              variant={role === candidate ? "secondary" : "ghost"}
              className={cn("rounded-md", role === candidate && "bg-selected text-foreground")}
              onClick={() => setRole(candidate)}
            >
              {intl.formatMessage({ id: `zaicode.role.${candidate}` })}
            </Button>
          ))}
        </div>
      </div>

      {agent ? null : (
        <div className="flex flex-col gap-1">
          <span className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "zaicode.field.template" })}
          </span>
          <div className="flex flex-wrap gap-1">
            {templates.map((template) => (
              <Button
                key={template.id}
                type="button"
                size="sm"
                variant="ghost"
                className="rounded-md"
                onClick={() => {
                  setName(template.name);
                  setRole(template.role);
                  setInstructions(template.instructions);
                  setPermissionPlan(template.toolPolicy.permissionMode === "plan");
                }}
              >
                {template.name}
              </Button>
            ))}
          </div>
          <p className="text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "zaicode.field.templateHint" })}
          </p>
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "zaicode.field.instructions" })}
        </span>
        <Textarea
          value={instructions}
          rows={8}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "zaicode.field.pool" })}
          {providerId && modelId ? ` — ${formatPoolLabel(providerId, modelId)}` : ""}
        </span>
        <ZaicodePoolPicker
          groups={poolGroups}
          loading={poolsLoading}
          providerId={providerId}
          modelId={modelId}
          onChange={(selection) => {
            setProviderId(selection.providerId);
            setModelId(selection.modelId);
            setReasoningLevel(selection.reasoningLevels.at(-1) ?? "");
            setBackend(backendForPool(selection.providerId, selection.providerLabel));
          }}
        />
        <p className="text-ui-xs text-foreground-subtlest">
          {intl.formatMessage({ id: "zaicode.field.poolHint" })}
        </p>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "zaicode.field.reasoning" })}
        </span>
        {reasoningLevels.length > 0 ? (
          <select
            className="h-8 w-full border border-border bg-background px-2 text-ui-sm text-foreground"
            value={reasoningValid ? reasoningLevel : ""}
            onChange={(event) => setReasoningLevel(event.target.value)}
          >
            {!reasoningValid ? <option value="">Choose a supported level</option> : null}
            {reasoningLevels.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        ) : (
          <Input value={reasoningLevel} onChange={(event) => setReasoningLevel(event.target.value)} />
        )}
      </label>

      <p className="text-ui-xs text-foreground-subtlest">
        {intl.formatMessage({ id: routeStatusMessageId })}
      </p>
      <label className="flex items-center justify-between gap-2">
        <span className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "zaicode.field.planOnly" })}
        </span>
        <Switch checked={permissionPlan} onCheckedChange={setPermissionPlan} />
      </label>

      {agent ? (
        <label className="flex items-center justify-between gap-2">
          <span className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "zaicode.field.enabled" })}
          </span>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </label>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="lg"
          disabled={!canSave}
          onClick={() => {
            if (!canSave) return;
            const base = {
              name: name.trim(),
              role,
              instructions,
              ...(modelSelection ? { modelSelection } : {}),
              ...(!modelSelection && providerId.trim() ? { providerRef: providerId.trim() } : {}),
              ...(!modelSelection && modelId.trim() ? { modelRef: modelId.trim() } : {}),
              ...(!modelSelection && reasoningLevel.trim()
                ? { reasoningEffort: reasoningLevel.trim() }
                : {}),
              ...buildZaicodeAgentEditorRoutingFields(backend, agent?.toolPolicy, permissionPlan),
            };
            if (agent) {
              onSave({
                ...base,
                enabled,
                ...(modelSelection ? {} : { modelSelection: null }),
                ...(providerId.trim() ? {} : { providerRef: null }),
                ...(modelId.trim() ? {} : { modelRef: null }),
                ...(reasoningLevel.trim() ? {} : { reasoningEffort: null }),
              } satisfies ZaicodeAgentUpdatePatch);
            } else {
              onSave({ ...base, enabled: true } satisfies ZaicodeAgentCreateInput);
            }
          }}
        >
          {intl.formatMessage({ id: "zaicode.action.save" })}
        </Button>
        <Button type="button" size="lg" variant="ghost" onClick={onCancel}>
          {intl.formatMessage({ id: "zaicode.action.cancel" })}
        </Button>
      </div>
    </div>
  );
}
