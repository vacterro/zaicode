import {
  createZaicodeAgentId,
  zaicodeAgentDefinitionSchema,
  type ZaicodeAgentCreateInput,
  type ZaicodeAgentDefinition,
  type ZaicodeAgentListResult,
  type ZaicodeAgentTemplate,
  type ZaicodeAgentUpdatePatch,
} from "@zcode/shared";
import {
  ZAICODE_BUILT_IN_AGENT_TEMPLATES,
  getZaicodeBuiltInAgentTemplate,
} from "./zaicodeTemplates.js";
import type { IZaicodeAgentService } from "./zaicodeAgents.js";
import type { ZaicodeAgentRepo } from "./zaicodeAgentRepo.js";

interface ZaicodeAgentServiceDeps {
  repo: ZaicodeAgentRepo;
  now?: () => number;
  onAgentsChanged?: () => void;
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** ZAICODE agent 定义服务：校验、稳定 id、模板实例化与持久化编排。 */
export class ZaicodeAgentService implements IZaicodeAgentService {
  constructor(private readonly deps: ZaicodeAgentServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private emitChanged(): void {
    try {
      this.deps.onAgentsChanged?.();
    } catch {
      // 广播钩子失败不影响写入结果。
    }
  }

  async list(): Promise<ZaicodeAgentListResult> {
    await this.deps.repo.ensureReady();
    return this.deps.repo.list();
  }

  async get(agentId: string): Promise<ZaicodeAgentDefinition | null> {
    await this.deps.repo.ensureReady();
    return this.deps.repo.get(agentId);
  }

  async create(input: ZaicodeAgentCreateInput): Promise<ZaicodeAgentDefinition> {
    await this.deps.repo.ensureReady();
    const now = this.now();
    const definition = zaicodeAgentDefinitionSchema.parse({
      id: createZaicodeAgentId(),
      name: input.name.trim(),
      role: input.role,
      instructions: input.instructions,
      enabled: input.enabled ?? true,
      modelSelection: input.modelSelection,
      providerRef: trimToUndefined(input.providerRef),
      modelRef: trimToUndefined(input.modelRef),
      reasoningEffort: trimToUndefined(input.reasoningEffort),
      toolPolicy: input.toolPolicy ?? {},
      backend: input.backend ?? "direct",
      templateId: trimToUndefined(input.templateId),
      createdAt: now,
      updatedAt: now,
    });
    await this.deps.repo.create(definition);
    this.emitChanged();
    return definition;
  }

  async update(
    agentId: string,
    patch: ZaicodeAgentUpdatePatch,
  ): Promise<ZaicodeAgentDefinition | null> {
    await this.deps.repo.ensureReady();
    const current = await this.deps.repo.get(agentId);
    if (!current) return null;
    const next = zaicodeAgentDefinitionSchema.parse({
      ...current,
      name: patch.name ?? current.name,
      role: patch.role ?? current.role,
      instructions: patch.instructions ?? current.instructions,
      enabled: patch.enabled ?? current.enabled,
      modelSelection:
        patch.modelSelection === null
          ? undefined
          : (patch.modelSelection ?? current.modelSelection),
      providerRef:
        patch.providerRef === null
          ? undefined
          : trimToUndefined(patch.providerRef ?? current.providerRef),
      modelRef:
        patch.modelRef === null ? undefined : trimToUndefined(patch.modelRef ?? current.modelRef),
      reasoningEffort:
        patch.reasoningEffort === null
          ? undefined
          : trimToUndefined(patch.reasoningEffort ?? current.reasoningEffort),
      toolPolicy: patch.toolPolicy ?? current.toolPolicy,
      backend: patch.backend === null ? "direct" : (patch.backend ?? current.backend),
      updatedAt: this.now(),
    });
    await this.deps.repo.update(next);
    this.emitChanged();
    return next;
  }

  async duplicate(agentId: string): Promise<ZaicodeAgentDefinition | null> {
    const current = await this.get(agentId);
    if (!current) return null;
    return this.create({
      name: `${current.name} (copy)`,
      role: current.role,
      instructions: current.instructions,
      enabled: current.enabled,
      modelSelection: current.modelSelection,
      providerRef: current.providerRef,
      modelRef: current.modelRef,
      reasoningEffort: current.reasoningEffort,
      toolPolicy: { ...current.toolPolicy },
      backend: current.backend,
      templateId: current.templateId,
    });
  }

  async remove(agentId: string): Promise<boolean> {
    await this.deps.repo.ensureReady();
    const removed = await this.deps.repo.remove(agentId);
    if (removed) this.emitChanged();
    return removed;
  }

  async listTemplates(): Promise<ZaicodeAgentTemplate[]> {
    return [...ZAICODE_BUILT_IN_AGENT_TEMPLATES];
  }

  async createFromTemplate(templateId: string, name?: string): Promise<ZaicodeAgentDefinition> {
    const template = getZaicodeBuiltInAgentTemplate(templateId);
    if (!template) throw new Error(`未知 ZAICODE agent 模板: ${templateId}`);
    return this.create({
      name: name?.trim() || template.name,
      role: template.role,
      instructions: template.instructions,
      toolPolicy: { ...template.toolPolicy },
      templateId: template.id,
    });
  }
}
