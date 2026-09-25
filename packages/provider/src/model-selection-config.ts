import {
  validateModelSelectionOptions,
  type ModelSelection,
  type ProviderRegistryView,
} from "./registry.js";

export type InitialModelSelectionResolution =
  | {
      readonly source: "configured-default" | "registry-fallback";
      readonly selection: ModelSelection;
    }
  | { readonly source: "none" };

interface ModelSelectionCompletionView {
  readonly providers: readonly {
    readonly providerId: string;
    readonly models: readonly {
      readonly modelId: string;
      readonly config: {
        readonly optionSpecs: {
          readonly reasoningLevel: { readonly values: readonly string[] };
        };
      };
    }[];
  }[];
}

/**
 * 与 @zcode/shared 的 isZaicodeProductMode 同义；provider 包不能引入 shared 根入口
 * （会把依赖 node 类型的模块带进本包的类型检查），因此只复刻这段纯判断。
 */
function isZaicodeProductMode(): boolean {
  const globals = globalThis as {
    __ZAICODE_PRODUCT_MODE__?: boolean;
    process?: { env?: Record<string, string | undefined> };
  };
  if (typeof globals.__ZAICODE_PRODUCT_MODE__ === "boolean")
    return globals.__ZAICODE_PRODUCT_MODE__;
  const value = globals.process?.env?.ZCODE_ZAICODE_MODE?.trim().toLowerCase() ?? "";
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

/**
 * 官方 GLM 账号/套餐供应商。注册表里的真实 id 是 `account:zai-*` / `account:bigmodel-*`
 * （BUILTIN_MODEL_PROVIDER_IDS 及 offpeak-idle-plan）；`builtin:*` 只是迁移前的旧 id。
 * 修复依据：此前只认 `builtin:`，真实注册表里一个都匹配不上，默认关闭与额度兜底都不生效。
 */
export function isOfficialGlmAccountProviderId(providerId: string | null | undefined): boolean {
  if (!providerId) return false;
  return providerId.startsWith("account:") || providerId.startsWith("builtin:");
}

/**
 * ZAICODE：官方 GLM 供应商默认关闭——不作为新草稿的隐式默认，
 * 优先使用操作员自己的供应商（SAIRoute/SAIFREN 等）；GLM 仍可手动选择，且在别无可用时兜底。
 */
function isDeferredDefaultProvider(providerId: string): boolean {
  return isZaicodeProductMode() && isOfficialGlmAccountProviderId(providerId);
}

export function resolveInitialModelSelection(input: {
  readonly configuredDefault?: ModelSelection;
  readonly registry: ProviderRegistryView;
}): InitialModelSelectionResolution {
  // 这里只构造 Host 的初始推荐，不解析已有会话意图。失效默认是可丢弃偏好，
  // 应继续按 Registry 顺序推荐；不能把历史选择留空的规则误用于新草稿初始化。
  const configured =
    input.configuredDefault && isSelectable(input.registry, input.configuredDefault)
      ? input.configuredDefault
      : undefined;
  if (configured && !isDeferredDefaultProvider(configured.providerId)) {
    return { source: "configured-default", selection: freezeSelection(configured) };
  }

  // 仅用于全新草稿的 Host 初始推荐；历史未绑定状态不能进入这个初始化分支。
  const preferred = registryFallback(input.registry, (id) => !isDeferredDefaultProvider(id));
  if (preferred) return preferred;
  if (configured) return { source: "configured-default", selection: freezeSelection(configured) };
  return registryFallback(input.registry, () => true) ?? { source: "none" };
}

function registryFallback(
  registry: ProviderRegistryView,
  accept: (providerId: string) => boolean,
): InitialModelSelectionResolution | undefined {
  for (const provider of registry.providers) {
    if (!accept(provider.providerId)) continue;
    if (provider.config.visibility === "hidden") continue;
    for (const model of provider.models) {
      const selection = completeNewModelSelection(registry, {
        providerId: provider.providerId,
        modelId: model.modelId,
      });
      if (selection) return { source: "registry-fallback", selection: freezeSelection(selection) };
    }
  }
  return undefined;
}

/** 仅在用户主动选模型或全新初始化时构造最高档；不能用于恢复/重解析已有选择。 */
export function completeNewModelSelection(
  registry: ModelSelectionCompletionView,
  selection: ModelSelection,
): ModelSelection | undefined {
  const model = registry.providers
    .find((provider) => provider.providerId === selection.providerId)
    ?.models.find((candidate) => candidate.modelId === selection.modelId);
  const reasoningLevel = model?.config.optionSpecs.reasoningLevel.values.at(-1);
  if (!reasoningLevel) return undefined;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    options: { reasoningLevel },
  };
}

/**
 * 规范化一份待提交的 Selection。
 * 已有选择缺失或失效时只保留模型身份，等待用户选择档位；主动选模型另走 completion。
 * 任何执行入口都必须在此之后再次确认 Selection 完整，不能静默补档位。
 */
export function normalizeModelSelection(
  registry: ModelSelectionCompletionView,
  selection: ModelSelection,
): ModelSelection | undefined {
  const model = registry.providers
    .find((provider) => provider.providerId === selection.providerId)
    ?.models.find((candidate) => candidate.modelId === selection.modelId);
  if (!model) return undefined;
  const values = model.config.optionSpecs.reasoningLevel.values;
  const reasoningLevel = selection.options?.reasoningLevel;
  if (reasoningLevel !== undefined && values.includes(reasoningLevel)) return selection;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
  };
}

function isSelectable(registry: ProviderRegistryView, selection: ModelSelection): boolean {
  const provider = registry.providers.find(
    (candidate) => candidate.providerId === selection.providerId,
  );
  if (provider?.config.visibility === "hidden") return false;
  const model = provider?.models.find((candidate) => candidate.modelId === selection.modelId);
  if (!model) return false;
  return validateModelSelectionOptions(model, selection).ok;
}

function freezeSelection(selection: ModelSelection): ModelSelection {
  return Object.freeze({
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: Object.freeze({ ...selection.options }) } : {}),
  });
}
