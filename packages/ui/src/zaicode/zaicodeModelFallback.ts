import { isOfficialGlmAccountProviderId } from "@zcode/provider";
import {
  pickZaicodeFallbackPool,
  providerQuotaCircuit,
  getRouteHealth,
  selectNextEligibleComboModel,
  type RouteHealthState,
} from "@zcode/shared";

/**
 * ZAICODE model fallback: official GLM providers (`account:zai-*` /
 * `account:bigmodel-*`, account/plan based) are never the default and never a
 * dead end. When a session on GLM hits a quota/limit wall, the composer
 * switches to the next usable model: the operator's own providers
 * (SAIFREN first, then another usable configured route).
 */
export const ZAICODE_FALLBACK_QUOTA_KINDS: ReadonlySet<string> = new Set([
  "model-exhausted",
  "daily-exhausted",
  "provider-limited",
  "concurrent-limit",
]);

export const isOfficialGlmProvider = isOfficialGlmAccountProviderId;

interface FallbackView {
  readonly preferredSelection?: { readonly providerId: string; readonly modelId: string };
  readonly providers: readonly {
    readonly providerId: string;
    readonly models: readonly { readonly modelId: string }[];
  }[];
}

/**
 * Picks the next eligible model within a 9router combo or advances to another eligible route
 * using the router-aware circuit breaker.
 */
export function pickZaicodeRouterComboFailover(params: {
  comboId: string;
  comboModels: readonly string[];
  currentModelId?: string;
  routerUrl?: string;
  now?: number;
}): {
  modelId: string | null;
  state: RouteHealthState;
  reason: string;
  allInCooldown: boolean;
  earliestProbeAt: number | null;
} {
  const selection = selectNextEligibleComboModel({
    models: params.comboModels,
    comboId: params.comboId,
    routerUrl: params.routerUrl,
    currentModelId: params.currentModelId,
    now: params.now,
  });

  return {
    modelId: selection.selectedModelId,
    state: selection.state,
    reason: selection.reason,
    allInCooldown: selection.allInCooldown,
    earliestProbeAt: selection.earliestProbeAt,
  };
}

/**
 * SAIFREN has priority over paid routes. Other routes are used only if no free pool is usable.
 *
 * `excludeProviderId` is the route already known dead. Handing it back as the fallback would
 * make the resolver refuse the move and leave the turn on the very wall it was rescued from.
 */
export function pickZaicodeFallbackModel(
  view: FallbackView | null,
  excludeProviderId?: string,
  now = Date.now(),
): { providerId: string; modelId: string } | null {
  if (!view) return null;
  const usable = (providerId: string): boolean =>
    !isOfficialGlmProvider(providerId) &&
    providerId !== excludeProviderId &&
    !providerQuotaCircuit(providerId, now);
  const providers = view.providers.filter((provider) => usable(provider.providerId));
  const pool = pickZaicodeFallbackPool(providers, ["SAIFREN", "SAIOPP"], { now });
  if (pool) return pool;
  const preferred = view.preferredSelection;
  if (
    preferred &&
    providers.some(
      (provider) =>
        provider.providerId === preferred.providerId &&
        provider.models.some((model) => model.modelId === preferred.modelId),
    )
  ) {
    const health = getRouteHealth({ comboId: preferred.providerId, modelId: preferred.modelId }, now);
    if (health.state !== "QUARANTINED" && health.state !== "PERMANENTLY_INVALID" && health.state !== "COOLDOWN") {
      return { providerId: preferred.providerId, modelId: preferred.modelId };
    }
  }
  for (const provider of providers) {
    const model = provider.models.find((m) => {
      const h = getRouteHealth({ comboId: provider.providerId, modelId: m.modelId }, now);
      return h.state !== "QUARANTINED" && h.state !== "PERMANENTLY_INVALID" && h.state !== "COOLDOWN";
    }) ?? provider.models[0];
    if (model) return { providerId: provider.providerId, modelId: model.modelId };
  }
  return null;
}

