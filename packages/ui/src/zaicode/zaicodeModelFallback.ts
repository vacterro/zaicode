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

/** First non-GLM model: the host's preferred selection if it is one, else registry order. */
export function pickZaicodeFallbackModel(
  view: FallbackView | null,
): { providerId: string; modelId: string } | null {
  if (!view) return null;
  const preferred = view.preferredSelection;
  if (preferred && !isOfficialGlmProvider(preferred.providerId)) {
    return { providerId: preferred.providerId, modelId: preferred.modelId };
  }
  for (const provider of view.providers) {
    if (isOfficialGlmProvider(provider.providerId)) continue;
    const model = provider.models[0];
    if (model) return { providerId: provider.providerId, modelId: model.modelId };
  }
  return null;
}
