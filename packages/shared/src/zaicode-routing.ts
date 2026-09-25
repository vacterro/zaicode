import type { ModelSelection } from "./model-selection.js";
import type { ZaicodeAgentRole } from "./zaicode-agents.js";

/**
 * ZAICODE 路由抽象（handoff MILESTONE H）。
 *
 * 这是一个窄接口：现在只把「配置的 agent 路由引用」解析成「运行时可用的一次
 * provider/model 选择」。模型池（9router combo，如 SAIFREN / SAIOPP）以
 * provider 下的模型出现，所以「选池」就是一次完整的 provider/model 选择。
 * 没有完整选择时返回 `route-unresolved`，绝不伪造执行身份。
 *
 * 只做规划与分类；真正的 provider/模型执行仍归上游 provider 架构。
 */
export const ZAICODE_ROUTE_BACKENDS = ["direct", "saifren", "sairoute", "9router"] as const;

export type ZaicodeRouteBackend = (typeof ZAICODE_ROUTE_BACKENDS)[number];

export type ZaicodeRouteFailureClassification = "none" | "route-unresolved";

export type ZaicodeRouteFallbackReason = "selection-missing";

export interface ZaicodeRoutePlanInput {
  agentId: string;
  role: ZaicodeAgentRole;
  /** agent 定义里配置的选择（意图）；这是唯一能变成执行身份的来源。 */
  configuredSelection?: ModelSelection;
  providerRef?: string;
  modelRef?: string;
  /** 持久化的路由意图标签；缺省 direct。所有值都通过配置的 provider/model（池）执行。 */
  backend?: ZaicodeRouteBackend;
}

export interface ZaicodeRoutePlan {
  requestedAgentId: string;
  requestedRole: ZaicodeAgentRole;
  backend: ZaicodeRouteBackend;
  /** 配置意图：与 resolved 分开保留，UI 禁止把配置值显示成执行值。 */
  configuredRoute: {
    selection?: ModelSelection;
    providerRef?: string;
    modelRef?: string;
  };
  resolvedSelection: ModelSelection | null;
  fallbackReason: ZaicodeRouteFallbackReason | null;
  /** 实际执行身份；未解析时为 `unresolved`。 */
  executionIdentity: string;
  failureClassification: ZaicodeRouteFailureClassification;
}

export function resolveZaicodRoutePlan(input: ZaicodeRoutePlanInput): ZaicodeRoutePlan {
  const backend = input.backend ?? "direct";
  const configuredRoute = {
    ...(input.configuredSelection ? { selection: input.configuredSelection } : {}),
    ...(input.providerRef ? { providerRef: input.providerRef } : {}),
    ...(input.modelRef ? { modelRef: input.modelRef } : {}),
  };

  // ZAICODE pool 模型：SAIFREN / SAIOPP 等是 9router 里的 combo（模型池），
  // 通过一个普通的自定义 provider（例如 SAIRoute → 9router）以「模型」形式暴露。
  // 因此所有后端都走同一条已实现路径：配置的 provider/model 选择就是池选择。
  // 旧的 saifren/sairoute/9router 值只作为历史意图保留，不再让派发失败。
  if (!input.configuredSelection) {
    // 没有完整选择就没有可执行身份；providerRef/modelRef 只是展示引用，
    // 不能合成 ModelSelection（那等于伪造执行路由）。
    return {
      requestedAgentId: input.agentId,
      requestedRole: input.role,
      backend,
      configuredRoute,
      resolvedSelection: null,
      fallbackReason: "selection-missing",
      executionIdentity: `${backend}:unresolved`,
      failureClassification: "route-unresolved",
    };
  }

  return {
    requestedAgentId: input.agentId,
    requestedRole: input.role,
    backend,
    configuredRoute,
    resolvedSelection: input.configuredSelection,
    fallbackReason: null,
    executionIdentity: `${backend}:${input.configuredSelection.providerId}/${input.configuredSelection.modelId}`,
    failureClassification: "none",
  };
}

/** 队列/派发失败原因的统一投影；路由未解析时返回稳定分类文本。 */
export function describeZaicodRouteFailure(plan: ZaicodeRoutePlan, agentName: string): string {
  if (plan.failureClassification === "none") return "";
  return `route-unresolved: agent '${agentName}' has no model pool selected (pick a pool such as SAIRoute / SAIFREN in the agent editor)`;
}

/**
 * SRC-038: an agent without a pool used to fail with `route-unresolved`. A
 * hit-and-go agent should just run, so it borrows ZAICODE's free pool
 * (SAIFREN on the SAIRoute provider, then SAIOPP); only a machine without
 * any pool still fails.
 */
export function pickZaicodeFallbackPool(
  providers: readonly { providerId: string; providerName?: string | null | undefined; models: readonly { modelId: string }[] }[],
  pools: readonly string[] = ["SAIFREN", "SAIOPP"],
): { providerId: string; modelId: string } | null {
  const ordered = [...providers].sort(
    (left, right) => Number(right.providerName === "SAIRoute") - Number(left.providerName === "SAIRoute"),
  );
  for (const pool of pools) {
    const provider = ordered.find((candidate) => candidate.models.some((model) => model.modelId === pool));
    if (provider) return { providerId: provider.providerId, modelId: pool };
  }
  return null;
}
