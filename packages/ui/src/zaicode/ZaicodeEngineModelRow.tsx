import { Route } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { ZaicodePrefCheck, ZaicodeRightClickSettings } from "./ZaicodePrefControls.js";
import {
  ZAICODE_ENGINE_BAR_MAX_MODELS,
  useZaicodeEngineBarPrefs,
  zaicodeEngineBarLabel,
  zaicodeEngineBarModels,
  zaicodeEngineBarModelKey,
} from "./zaicodeEngineBarPrefs.js";
import type { ZaicodeDefaultModel } from "./zaicodeDefaultModel.js";
import type { ZaicodePoolGroup, ZaicodePoolOption } from "./zaicodeRoutingModel.js";

/** Existing model catalog projected into configurable quick choices, with the selected effort. */
export function ZaicodeEngineModelRow({
  groups,
  providerAccount,
  selectedModel,
  activeEngine,
  selectModel,
}: {
  groups: readonly ZaicodePoolGroup[];
  providerAccount: Record<string, string>;
  selectedModel: ZaicodeDefaultModel | null;
  activeEngine: string | null;
  selectModel: (option: ZaicodePoolOption, reasoningLevel?: string) => void;
}) {
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const barPrefs = useZaicodeEngineBarPrefs();
  const group = groups[0];
  const pools = zaicodeEngineBarModels(groups, barPrefs, providerAccount);
  const options = groups.flatMap((entry) => entry.options);
  const selectedOption = options.find(
    (option) =>
      option.providerId === selectedModel?.providerId && option.modelId === selectedModel.modelId,
  );
  return (
    <>
      {group ? (
        <ZaicodeRightClickSettings
          title="Which models show here"
          hint="Choose up to eight models, including subscriptions. The rest stay in the model picker."
          className="w-full"
          panel={
            <div
              className="flex max-h-80 flex-col gap-1 overflow-y-auto"
              data-zaicode-engine-bar-pools
            >
              {options.map((option) => {
                const shown = pools.some(
                  (pool) => zaicodeEngineBarModelKey(pool) === zaicodeEngineBarModelKey(option),
                );
                return (
                  <ZaicodePrefCheck
                    key={zaicodeEngineBarModelKey(option)}
                    checked={shown}
                    disabled={!shown && pools.length >= ZAICODE_ENGINE_BAR_MAX_MODELS}
                    onChange={(checked) =>
                      barPrefs.update({
                        modelButtons: checked
                          ? [
                              ...pools.map(({ providerId, modelId }) => ({ providerId, modelId })),
                              { providerId: option.providerId, modelId: option.modelId },
                            ]
                          : pools
                              .filter(
                                (pool) =>
                                  zaicodeEngineBarModelKey(pool) !==
                                  zaicodeEngineBarModelKey(option),
                              )
                              .map(({ providerId, modelId }) => ({ providerId, modelId })),
                      })
                    }
                    label={`${option.providerLabel} / ${option.displayName || option.modelId}`}
                  />
                );
              })}
              <ZaicodePrefCheck
                checked={barPrefs.showSubs}
                onChange={(showSubs) => barPrefs.update({ showSubs })}
                label="Subscription tiles (C1, C2, …) below"
              />
              <button
                type="button"
                className="self-start border border-border px-1.5 text-foreground-subtle hover:bg-hover hover:text-foreground"
                onClick={() => barPrefs.update({ pools: null, modelButtons: null })}
              >
                Default pools + subscriptions
              </button>
            </div>
          }
        >
          <div
            className="flex w-full min-w-0 items-center gap-1"
            title={`In-app model pools (${group.providerLabel}). Right-click: which models show here.`}
          >
            {/* SRC-061: the provider is a small button that opens its settings, not a truncated label. */}
            <button
              type="button"
              className="flex size-5 shrink-0 items-center justify-center border border-border text-foreground-subtle hover:bg-hover hover:text-foreground"
              title={
                group.isRouter
                  ? `${group.providerLabel}: providers, keys, pools and subscriptions — opens Settings → Router`
                  : `${group.providerLabel}: opens Settings → Engines`
              }
              aria-label={`${group.providerLabel} settings`}
              data-zaicode-sound="ui.settings"
              onClick={() => {
                setPendingSettingsSection(group.isRouter ? "zaicodeRouter" : "zaicodeEngines");
                openSettingsTab();
              }}
            >
              <Route className="size-3" />
            </button>
            <div
              className="flex min-w-0 flex-1 flex-wrap gap-px"
              role="radiogroup"
              aria-label="In-app model pools"
            >
              {pools.map((option) => {
                const active =
                  activeEngine === null &&
                  selectedModel?.providerId === option.providerId &&
                  selectedModel.modelId === option.modelId;
                return (
                  <button
                    key={`${option.providerId}/${option.modelId}`}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={cn(
                      "min-w-0 flex-1 truncate border px-1.5 py-0.5 text-center",
                      active
                        ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
                        : "border-border bg-transparent text-foreground-subtle hover:bg-hover hover:text-foreground",
                    )}
                    title={`Use ${option.providerLabel} / ${option.modelId} in this chat`}
                    onClick={() => selectModel(option)}
                  >
                    {option.providerId in providerAccount ? `${option.providerLabel} · ` : ""}
                    {option.displayName || zaicodeEngineBarLabel(option.modelId)}
                  </button>
                );
              })}
            </div>
          </div>
        </ZaicodeRightClickSettings>
      ) : null}
      {selectedOption ? (
        <div className="flex min-w-0 items-center gap-1" data-zaicode-engine-selection>
          <span
            className="min-w-0 flex-1 truncate"
            title={`${selectedOption.providerLabel} / ${selectedOption.modelId}`}
          >
            {selectedOption.providerLabel} / {selectedOption.displayName || selectedOption.modelId}
          </span>
          {selectedOption.reasoningLevels.length > 1 ? (
            <select
              aria-label="Model effort"
              className="min-w-0 border border-border bg-background text-ui-xs"
              value={
                selectedModel?.reasoningLevel ??
                (selectedOption.reasoningLevels.includes("medium")
                  ? "medium"
                  : selectedOption.reasoningLevels[0])
              }
              onChange={(event) => selectModel(selectedOption, event.target.value)}
            >
              {selectedOption.reasoningLevels.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
