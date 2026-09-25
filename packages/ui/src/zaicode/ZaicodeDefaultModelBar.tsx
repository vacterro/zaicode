import { cn } from "@/components/lib/utils.js";
import { useZaicodePoolGroups } from "./ZaicodePoolPicker.js";
import { setZaicodeDefaultModel, useZaicodeDefaultModel } from "./zaicodeDefaultModel.js";

/** Up to this many choices render as one-click buttons; more fall back to a list box. */
const MAX_BUTTONS = 4;

/**
 * Sidebar top: which model every NEW session starts on. The router provider's
 * pools (SAIRoute: SAIFREN / SAIOPP) come first, so switching the default is
 * one click with no combobox while the choice stays small.
 */
export function ZaicodeDefaultModelBar() {
  const { groups } = useZaicodePoolGroups();
  const selected = useZaicodeDefaultModel();
  const group = groups[0];
  if (!group) return null;
  const options = group.options;
  const isSelected = (providerId: string, modelId: string) =>
    selected?.providerId === providerId && selected.modelId === modelId;
  const title = `Default model for new sessions (${group.providerLabel}). Click the active one again to clear.`;

  return (
    <div
      className="flex min-w-0 items-center gap-1 px-2 py-1 text-ui-xs"
      data-zaicode-default-model
      title={title}
    >
      <span className="shrink-0 text-foreground-subtlest" aria-hidden="true">
        {group.providerLabel}
      </span>
      {options.length <= MAX_BUTTONS ? (
        <div className="flex min-w-0 flex-1 flex-wrap gap-px" role="radiogroup" aria-label={title}>
          {options.map((option) => {
            const active = isSelected(option.providerId, option.modelId);
            return (
              <button
                key={`${option.providerId}/${option.modelId}`}
                type="button"
                role="radio"
                aria-checked={active}
                className={cn(
                  "min-w-[64px] flex-1 truncate border px-1.5 py-0.5 text-center",
                  active
                    ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
                    : "border-border bg-transparent text-foreground-subtle hover:bg-hover hover:text-foreground",
                )}
                onClick={() =>
                  setZaicodeDefaultModel(
                    active ? null : { providerId: option.providerId, modelId: option.modelId },
                  )
                }
              >
                {option.modelId}
              </button>
            );
          })}
        </div>
      ) : (
        <select
          className="min-w-0 flex-1 border border-border bg-background px-1 py-0.5 text-foreground"
          aria-label={title}
          value={selected ? `${selected.providerId}\u0000${selected.modelId}` : ""}
          onChange={(event) => {
            const [providerId, modelId] = event.target.value.split("\u0000");
            setZaicodeDefaultModel(providerId && modelId ? { providerId, modelId } : null);
          }}
        >
          <option value="">(last used)</option>
          {options.map((option) => (
            <option
              key={`${option.providerId}/${option.modelId}`}
              value={`${option.providerId}\u0000${option.modelId}`}
            >
              {option.modelId}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
