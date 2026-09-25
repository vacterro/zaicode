/**
 * ZAICODE 任务执行器（host 域）。
 *
 * 把队列任务转为真实的上游运行时执行，路径与 automation / off-peak 派发一致：
 * IZCodeTaskService.createTask -> sendPrompt -> onDynamicTaskTerminalOutcome 终态回写。
 * ZAICODE 只保存 sessionId 引用与执行结果，不复制会话状态机；
 * 编排委托（Coordinator -> worker）由队列服务在终态回写时按 delegation 字段入队子任务。
 */
import {
  IModelSelectionService,
  IZCodeTaskService,
  IZaicodeJobService,
  type ServiceCollection,
  type ZaicodeJobExecutionHandle,
  type ZaicodeJobExecutor,
} from "@zcode/services";
import {
  describeZaicodRouteFailure,
  isZaicodeRawCommand,
  pickZaicodeFallbackPool,
  resolveZaicodRoutePlan,
  zaicodeChildInstructions,
  zaicodeDelegationInstructions,
  zaicodeJobTaskText,
} from "@zcode/shared";
import type { ZaicodeDelegationSpool } from "./zaicodeDelegationSpool.js";

interface ZaicodeRunDispatchDeps {
  /** 与 automation 相同的目标解析：远端 workspace 走远端 host，本地走 activeServices。 */
  resolveServices: (request: {
    workspacePath: string;
    workspaceIdentity?: string;
  }) => ServiceCollection;
  logWarn: (message: string, error?: unknown) => void;
  /** Runtime delegation channel (T-10); absent = no agent-initiated delegation. */
  delegationSpool?: ZaicodeDelegationSpool;
}

/** 任务正文 = agent 指令 + 分隔线 + 任务标题与指令；不在队列层改写 agent 人格。 */
export function buildZaicodeJobPrompt(input: {
  jobId: string;
  jobTitle: string;
  jobInstructions: string;
  agentInstructions: string;
  /** Delegation or helper paragraph (T-10), appended after the task. */
  delegationSection?: string;
}): string {
  // SRC-038 hit and go: an empty task runs `/goal cc all`; a slash command or a bare SAIPEN
  // shortcut goes alone and first -- behind a persona paragraph it would be plain prose, and
  // the SAIPEN operator template would file it as a new ticket.
  const task = zaicodeJobTaskText(input.jobInstructions);
  if (isZaicodeRawCommand(task)) return task;
  const sections = [input.agentInstructions.trim()];
  sections.push("---");
  sections.push(`ZAICODE task ${input.jobId}: ${input.jobTitle}`.trim());
  sections.push(task);
  if (input.delegationSection) sections.push(input.delegationSection.trim());
  return sections.filter((section) => section.length > 0).join("\n\n");
}

type ZaicodeModelSelection = NonNullable<ReturnType<typeof resolveZaicodRoutePlan>["resolvedSelection"]>;

/**
 * An agent may carry a reasoning level from another model (e.g. "high" saved
 * while a SAIOPP pool was picked); a pool like SAIFREN then refuses the whole
 * run with `Reasoning effort "high" is not supported`. Clamp it to a level the
 * target model actually offers ("medium" when available, else its first one).
 */
export function clampZaicodeReasoningLevel(
  selection: ZaicodeModelSelection,
  supportedLevels: readonly string[] | undefined,
): ZaicodeModelSelection {
  const requested = selection.options?.reasoningLevel;
  if (!requested || !supportedLevels || supportedLevels.length === 0) return selection;
  if (supportedLevels.includes(requested)) return selection;
  const fallback = supportedLevels.includes("medium") ? "medium" : supportedLevels[0]!;
  return { ...selection, options: { ...selection.options, reasoningLevel: fallback } };
}

export function createZaicodeJobExecutor(deps: ZaicodeRunDispatchDeps): ZaicodeJobExecutor {
  return async ({ job, agent }): Promise<ZaicodeJobExecutionHandle> => {
    const services = deps.resolveServices({
      workspacePath: job.workspacePath,
      ...(job.workspaceIdentity ? { workspaceIdentity: job.workspaceIdentity } : {}),
    });
    const taskService = services.getOptional(IZCodeTaskService);
    if (!taskService) throw new Error("ZAICODE executor: IZCodeTaskService 不可用");
    const jobService = services.getOptional(IZaicodeJobService);

    // 路由抽象（MILESTONE H）：把配置的 agent 路由引用解析成一次执行选择。
    // 未解析（缺完整选择 / 未来后端未实现）时直接失败，让队列记录可解释原因，
    // 绝不把展示用 provider/model 引用伪装成执行身份。
    const routePlan = resolveZaicodRoutePlan({
      agentId: agent.id,
      role: agent.role,
      ...(agent.modelSelection ? { configuredSelection: agent.modelSelection } : {}),
      ...(agent.providerRef ? { providerRef: agent.providerRef } : {}),
      ...(agent.modelRef ? { modelRef: agent.modelRef } : {}),
      ...(agent.backend ? { backend: agent.backend } : {}),
    });
    let resolvedSelection = routePlan.resolvedSelection ?? undefined;
    if (routePlan.failureClassification !== "none") {
      // SRC-038: an agent without a pool borrows ZAICODE's free pool instead of failing.
      const view = await services.getOptional(IModelSelectionService)?.getView().catch(() => null);
      const fallback = view ? pickZaicodeFallbackPool(view.providers) : null;
      if (!fallback) throw new Error(describeZaicodRouteFailure(routePlan, agent.name));
      resolvedSelection = fallback;
    }
    if (resolvedSelection) {
      try {
        const view = await services.getOptional(IModelSelectionService)?.getView();
        const model = view?.providers
          .find((provider) => provider.providerId === resolvedSelection!.providerId)
          ?.models.find((candidate) => candidate.modelId === resolvedSelection!.modelId);
        resolvedSelection = clampZaicodeReasoningLevel(
          resolvedSelection,
          model?.config.optionSpecs.reasoningLevel.values,
        );
      } catch (error) {
        deps.logWarn(`ZAICODE: model catalog unavailable for reasoning check (job=${job.id})`, error);
      }
    }

    // yolo is the ZAICODE default (full access); plan is the only restriction.
    // "auto"/absent keeps the upstream runtime default, which is yolo.
    const mode: "plan" | "yolo" | undefined =
      agent.toolPolicy.permissionMode === "plan"
        ? "plan"
        : agent.toolPolicy.permissionMode === "yolo"
          ? "yolo"
          : undefined;
    // toolPolicy -> runtime 工具面：denylist 优先于 allowlist（denylist ⊲ allowlist）。
    // 客户端先滤掉冲突项，再分别透传；空/未配置列表一律省略，保留上游默认行为。
    const disallowedSet = new Set(agent.toolPolicy.disallowedTools ?? []);
    const allowedTools = (agent.toolPolicy.allowedTools ?? []).filter(
      (toolName) => !disallowedSet.has(toolName),
    );
    const toolAllowlist = allowedTools.length > 0 ? allowedTools : undefined;
    const toolDenylist =
      agent.toolPolicy.disallowedTools && agent.toolPolicy.disallowedTools.length > 0
        ? agent.toolPolicy.disallowedTools
        : undefined;
    // 工具面限制只在真实运行首轮生效：createTask/createSession 不建模 tool allow/deny，
    // 真正落到 runtime 的是下面 sendPrompt -> sendConversationCommandV4 的 toolAllowlist/toolDenylist。
    // 因此这里绝不把 allow/deny 塞进 createTask（那是无效透传，会假装成一道执行边界）。
    const task = await taskService.createTask({
      workspacePath: job.workspacePath,
      ...(job.workspaceIdentity ? { workspaceIdentity: job.workspaceIdentity } : {}),
      ...(resolvedSelection ? { modelSelection: resolvedSelection } : {}),
      ...(mode ? { mode } : {}),
      deferPersistenceUntilFirstPrompt: true,
    });
    const taskId = task.taskId;
    const traceId = task.traceId;
    if (!job.runId) throw new Error(`ZAICODE executor: job ${job.id} 缺少 runId`);
    const runId = job.runId;
    const attempt = job.attempt;

    // T-10: a top-level job whose role may delegate gets its own request folder for this run;
    // a helper gets told who asked and how to report. The queue service decides every request.
    let delegationSection: string | undefined;
    if (jobService && deps.delegationSpool) {
      try {
        if (job.parentJobId) {
          const parent = await jobService.get(job.parentJobId);
          delegationSection = zaicodeChildInstructions({
            parentJobId: job.parentJobId,
            parentTitle: parent?.title ?? "",
          });
        } else {
          const policy = await jobService.getDelegationPolicy();
          if (policy.parentRoles.includes(agent.role) && policy.maxChildrenPerParent > 0) {
            const spoolDir = await deps.delegationSpool.open(job.id, runId, jobService);
            delegationSection = zaicodeDelegationInstructions({ spoolDir, policy });
          }
        }
      } catch (error) {
        deps.logWarn(`ZAICODE: delegation channel unavailable (job=${job.id})`, error);
      }
    }

    if (jobService) {
      const disposable = taskService.onDynamicTaskTerminalOutcome(taskId)((result) => {
        if (result.inputId !== traceId) return;
        disposable.dispose();
        deps.delegationSpool?.close(job.id);
        void jobService
          .reportRunOutcome({
            jobId: job.id,
            runId,
            attempt,
            outcome: result.outcome,
            ...(result.error ? { error: result.error } : {}),
          })
          .catch((error: unknown) => {
            deps.logWarn(`ZAICODE 终态回写失败: job=${job.id}`, error);
          });
      });
    }

    await taskService.sendPrompt({
      taskId,
      traceId,
      content: buildZaicodeJobPrompt({
        jobId: job.id,
        jobTitle: job.title,
        jobInstructions: job.instructions,
        agentInstructions: agent.instructions,
        ...(delegationSection ? { delegationSection } : {}),
      }),
      clientMode: "desktop-continuous",
      ...(resolvedSelection ? { modelSelection: resolvedSelection } : {}),
      ...(toolAllowlist ? { toolAllowlist } : {}),
      ...(toolDenylist ? { toolDenylist } : {}),
    });

    return {
      sessionId: taskId,
      ...(resolvedSelection ? { actualModelSelection: resolvedSelection } : {}),
      stop: async () => {
        deps.delegationSpool?.close(job.id);
        await taskService.stopGeneration({
          taskId,
          workspacePath: job.workspacePath,
          ...(job.workspaceIdentity ? { workspaceIdentity: job.workspaceIdentity } : {}),
        });
      },
    };
  };
}
