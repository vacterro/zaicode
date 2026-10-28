import { isOfficialGlmAccountProviderId } from "@zcode/provider";
import { pickZaicodeFallbackPool, providerQuotaCircuit } from "@zcode/shared";

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
    return { providerId: preferred.providerId, modelId: preferred.modelId };
  }
  for (const provider of providers) {
    const model = provider.models[0];
    if (model) return { providerId: provider.providerId, modelId: model.modelId };
  }
  return null;
}
