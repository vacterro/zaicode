import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { useProviderSettingsServiceView } from "@/hooks/useProviderSettingsView.js";
import { resolveProviderSettingsFormProviders } from "@/lib/providerSettingsFormProjection.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";
import {
  buildPoolGroups,
  type ZaicodePoolGroup,
  type ZaicodePoolOption,
} from "./zaicodeRoutingModel.js";
import { ZaicodeIcon } from "./zaicodeIconSlots.js";

export interface ZaicodePoolSelection {
  providerId: string;
  providerLabel: string;
  modelId: string;
  reasoningLevels: readonly string[];
}

/** Reads the configured providers and projects them into pool groups. */
export function useZaicodePoolGroups(): { groups: ZaicodePoolGroup[]; loading: boolean } {
  const { providerSettingsService } = useServices();
  const read = useProviderSettingsServiceView(providerSettingsService);
  const view = read.state.status === "ready" ? read.state.view : null;
  const groups = useMemo(
    () =>
      buildPoolGroups(
        resolveProviderSettingsFormProviders({ view }).map((provider) => ({
          providerId: provider.providerId,
          providerName: getProviderFormLabel(provider),
          enabled: provider.enabled,
          models: provider.models,
        })),
      ),
    [view],
  );
  return { groups, loading: read.state.status === "loading" };
}

function PoolButton({
  option,
  selected,
  onSelect,
}: {
  option: ZaicodePoolOption;
  selected: boolean;
  onSelect: (option: ZaicodePoolOption) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Button
      type="button"
      size="sm"
      variant={selected ? "secondary" : "ghost"}
      aria-pressed={selected}
      className={cn(
        "h-auto min-w-0 w-full justify-start py-1 text-left",
        selected && "bg-selected text-foreground",
      )}
      onClick={() => onSelect(option)}
    >
      <span className="flex min-w-0 flex-col">
        <span className="break-all whitespace-normal leading-tight">{option.modelId}</span>
        {option.hintId ? (
          <span className="truncate text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: option.hintId })}
          </span>
        ) : null}
      </span>
    </Button>
  );
}

/**
 * Pool picker: 9router-backed providers (SAIRoute) are listed first with their
 * pools (SAIFREN, SAIOPP, ...) as direct choices; every other provider model is
 * available under "Other models".
 */
export function ZaicodePoolPicker({
  groups,
  loading,
  providerId,
  modelId,
  onChange,
}: {
  groups: readonly ZaicodePoolGroup[];
  loading: boolean;
  providerId: string;
  modelId: string;
  onChange: (selection: ZaicodePoolSelection) => void;
}) {
  const { intl } = useZCodeIntl();
  const [showOther, setShowOther] = useState(false);
  const routerGroups = groups.filter((group) => group.isRouter);
  const otherGroups = groups.filter((group) => !group.isRouter);
  const isSelected = (option: ZaicodePoolOption) =>
    option.providerId === providerId && option.modelId === modelId;
  const select = (option: ZaicodePoolOption) =>
    onChange({
      providerId: option.providerId,
      providerLabel: option.providerLabel,
      modelId: option.modelId,
      reasoningLevels: option.reasoningLevels,
    });
  const selectedInOther = otherGroups.some((group) => group.options.some(isSelected));

  if (loading) {
    return (
      <p className="text-ui-xs text-foreground-subtlest">
        {intl.formatMessage({ id: "common.loading" })}
      </p>
    );
  }

  if (groups.length === 0) {
    return (
      <p className="text-ui-xs text-foreground-subtlest">
        {intl.formatMessage({ id: "zaicode.pool.none" })}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {routerGroups.map((group) => (
        <div key={group.providerId} className="flex flex-col gap-1">
          <span className="flex items-center gap-1 text-ui-xs text-foreground-subtle">
            <ZaicodeIcon slot="pool.router" className="size-3" />
            {group.providerLabel}
          </span>
          <div className="grid grid-cols-1 gap-1 min-[28rem]:grid-cols-2">
            {group.options.map((option) => (
              <PoolButton
                key={`${option.providerId}/${option.modelId}`}
                option={option}
                selected={isSelected(option)}
                onSelect={select}
              />
            ))}
          </div>
        </div>
      ))}
      {routerGroups.length === 0 ? (
        <p className="text-ui-xs text-foreground-subtlest">
          {intl.formatMessage({ id: "zaicode.pool.noRouter" })}
        </p>
      ) : null}
      {otherGroups.length > 0 ? (
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="justify-start"
            aria-expanded={showOther || selectedInOther}
            onClick={() => setShowOther((value) => !value)}
          >
            <ZaicodeIcon slot="pool.other" className="size-3" />
            {intl.formatMessage({ id: "zaicode.pool.otherModels" })}
          </Button>
          {showOther || selectedInOther
            ? otherGroups.map((group) => (
                <div key={group.providerId} className="flex flex-col gap-1 pl-2">
                  <span className="text-ui-xs text-foreground-subtle">{group.providerLabel}</span>
                  <div className="grid grid-cols-1 gap-1 min-[28rem]:grid-cols-2">
                    {group.options.map((option) => (
                      <PoolButton
                        key={`${option.providerId}/${option.modelId}`}
                        option={option}
                        selected={isSelected(option)}
                        onSelect={select}
                      />
                    ))}
                  </div>
                </div>
              ))
            : null}
        </div>
      ) : null}
    </div>
  );
}
