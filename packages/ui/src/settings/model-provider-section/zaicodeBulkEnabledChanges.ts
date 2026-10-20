import type { ProviderSettingsFormModel } from "@/lib/providerSettingsFormTypes.js";

/**
 * REQ-007: the bulk change set as a pure projection over the snapshot the
 * operator saw -- only models whose effective enabled flag actually flips.
 * One call site, one coherent set, tested without mounting the settings UI.
 */
export function zaicodeBulkEnabledChanges(
  models: Pick<ProviderSettingsFormModel, "modelId" | "config">[],
  enabled: boolean,
  onlyModelId?: string,
): { modelId: string; enabled: boolean }[] {
  return models
    .map((model) => ({
      modelId: model.modelId,
      enabled: onlyModelId ? model.modelId === onlyModelId : enabled,
    }))
    .filter((change) => {
      const current = models.find((model) => model.modelId === change.modelId);
      return !!current && (current.config.enabled !== false) !== change.enabled;
    });
}
