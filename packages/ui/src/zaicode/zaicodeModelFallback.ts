import { isOfficialGlmAccountProviderId } from "@zcode/provider";

/**
 * ZAICODE model fallback: official GLM providers (`account:zai-*` /
 * `account:bigmodel-*`, account/plan based) are never the default and never a
 * dead end. When a session on GLM hits a quota/limit wall, the composer
 * switches to the next usable model: the operator's own providers
 * (SAIRoute / SAIFREN / ...), in registry order.
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
 * First non-GLM model: the host's preferred selection if it is one, else registry order.
 *
 * `excludeProviderId` is the route already known dead. Handing it back as the fallback would
 * make the resolver refuse the move and leave the turn on the very wall it was rescued from.
 */
export function pickZaicodeFallbackModel(
  view: FallbackView | null,
  excludeProviderId?: string,
): { providerId: string; modelId: string } | null {
  if (!view) return null;
  const usable = (providerId: string): boolean =>
    !isOfficialGlmProvider(providerId) && providerId !== excludeProviderId;
  const preferred = view.preferredSelection;
  if (preferred && usable(preferred.providerId)) {
    return { providerId: preferred.providerId, modelId: preferred.modelId };
  }
  for (const provider of view.providers) {
    if (!usable(provider.providerId)) continue;
    const model = provider.models[0];
    if (model) return { providerId: provider.providerId, modelId: model.modelId };
  }
  return null;
}
