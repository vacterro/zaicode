import type { ZaicodeRouteBackend } from "@zcode/shared";

/**
 * ZAICODE pool model.
 *
 * SAIFREN / SAIOPP are 9router combos (model pools). 9router is reached through
 * one ordinary custom provider (named e.g. "SAIRoute"), and each combo shows up
 * as a model of that provider. Picking a pool is therefore one complete
 * provider/model selection: `SAIRoute / SAIFREN`, `SAIRoute / SAIOPP`, ...
 * Any other provider model can be picked the same way (a single-model "pool").
 *
 * The persisted backend enum (direct|saifren|sairoute|9router) is kept only as
 * an intent label: 9router-backed providers save `sairoute`, everything else
 * saves `direct`. Execution always goes through the selected provider/model.
 */

export interface ZaicodePoolProviderInput {
  providerId: string;
  providerName?: string | null;
  enabled: boolean;
  models: readonly {
    modelId: string;
    selectable: boolean;
    config?: { optionSpecs?: { reasoningLevel?: { values?: readonly string[] | null } | null } | null };
  }[];
}

export interface ZaicodePoolOption {
  providerId: string;
  providerLabel: string;
  modelId: string;
  reasoningLevels: readonly string[];
  /** i18n id of a short pool description, only for well-known pools. */
  hintId: string | null;
}

export interface ZaicodePoolGroup {
  providerId: string;
  providerLabel: string;
  /** true when this provider fronts 9router (SAIRoute style pool provider). */
  isRouter: boolean;
  options: ZaicodePoolOption[];
}

const ROUTER_PROVIDER_PATTERN = /sairoute|9router|sai-route/i;

/** Known 9router combos; keys are lower-case model ids. */
const KNOWN_POOL_HINTS: Readonly<Record<string, string>> = {
  saifren: "zaicode.pool.hint.saifren",
  saiopp: "zaicode.pool.hint.saiopp",
};

export function poolHintId(modelId: string): string | null {
  return KNOWN_POOL_HINTS[modelId.trim().toLowerCase()] ?? null;
}

export function isRouterProvider(providerId: string, providerLabel?: string | null): boolean {
  return (
    ROUTER_PROVIDER_PATTERN.test(providerId) || ROUTER_PROVIDER_PATTERN.test(providerLabel ?? "")
  );
}

/** Router providers first (they carry the named pools), then the rest in given order. */
export function buildPoolGroups(
  providers: readonly ZaicodePoolProviderInput[],
): ZaicodePoolGroup[] {
  const groups = providers
    .filter((provider) => provider.enabled)
    .map((provider) => {
      const providerLabel = provider.providerName?.trim() || provider.providerId;
      return {
        providerId: provider.providerId,
        providerLabel,
        isRouter: isRouterProvider(provider.providerId, providerLabel),
        options: provider.models
          .filter((model) => model.selectable)
          .map((model) => ({
            providerId: provider.providerId,
            providerLabel,
            modelId: model.modelId,
            reasoningLevels: model.config?.optionSpecs?.reasoningLevel?.values ?? [],
            hintId: poolHintId(model.modelId),
          })),
      };
    })
    .filter((group) => group.options.length > 0);
  return [
    ...groups.filter((group) => group.isRouter),
    ...groups.filter((group) => !group.isRouter),
  ];
}

/** Backend intent label saved with the agent for a chosen pool. */
export function backendForPool(
  providerId: string,
  providerLabel?: string | null,
): ZaicodeRouteBackend {
  return isRouterProvider(providerId, providerLabel) ? "sairoute" : "direct";
}

/**
 * Legacy agents saved `saifren` as backend with no selection. Suggest the
 * matching pool so the editor can preselect it instead of showing nothing.
 */
export function legacyPoolModelId(backend: ZaicodeRouteBackend): string | null {
  return backend === "saifren" ? "SAIFREN" : null;
}

/** Find the pool option matching a legacy backend inside the available groups. */
export function findLegacyPoolOption(
  backend: ZaicodeRouteBackend,
  groups: readonly ZaicodePoolGroup[],
): ZaicodePoolOption | null {
  const modelId = legacyPoolModelId(backend);
  if (!modelId) return null;
  for (const group of groups) {
    const match = group.options.find(
      (option) => option.modelId.toLowerCase() === modelId.toLowerCase(),
    );
    if (match) return match;
  }
  return null;
}

/** "SAIRoute / SAIFREN" style label for a configured selection. */
export function formatPoolLabel(providerLabel: string, modelId: string): string {
  return `${providerLabel} / ${modelId}`;
}

/** The ZAICODE provider that fronts 9router: named like SAIRoute or pointing at 9router's port. */
export function findZaicodeRouterProvider<T extends { providerId: string; providerName?: string | null; config: unknown }>(
  providers: readonly T[],
  routerUrl: string | null,
): T | null {
  const port = routerUrl ? /:(\d+)/.exec(routerUrl.replace(/^[a-z]+:\/\//, ""))?.[1] ?? null : null;
  return (
    providers.find((provider) => {
      const baseUrl = String((provider.config as { api?: { baseUrl?: unknown } }).api?.baseUrl ?? "");
      return port !== null && new RegExp(`(localhost|127\\.0\\.0\\.1):${port}(/|$)`).test(baseUrl);
    }) ??
    providers.find((provider) => isRouterProvider(provider.providerId, provider.providerName)) ??
    null
  );
}
