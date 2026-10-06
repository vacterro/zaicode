import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ZaicodeRightClickSettings } from "./ZaicodePrefControls.js";
import { ZAICODE_MODEL_BUTTONS_MAX, type ZaicodeModelButton } from "./zaicodeModelButtonsModel.js";

/** T-136: the composer's model choice as buttons when there are only a few models. */
export function ZaicodeModelButtons({
  buttons,
  value,
  disabled,
  onSelect,
}: {
  buttons: readonly ZaicodeModelButton[];
  value: string;
  disabled?: boolean;
  onSelect: (value: string) => void;
}) {
  return (
    // SRC-151:R011: these buttons own a setting (when buttons replace the
    // picker), so a right-click on them opens that setting next to them.
    <ZaicodeRightClickSettings
      title="Model buttons"
      preferenceKey="modelButtons"
      align="start"
      className="min-w-0"
      panel={
        <div className="flex flex-col gap-1 text-ui-xs text-foreground-subtle">
          <span>
            This row is drawn because the whole choice fits in {ZAICODE_MODEL_BUTTONS_MAX} models. One
            more model and ZAICODE goes back to the picker, so the row never runs out of room.
          </span>
          <span className="text-foreground-subtlest">
            {buttons.length} shown now. Left click a button to pick that model; the picker beside them
            manages which models exist.
          </span>
        </div>
      }
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1" data-zaicode-model-buttons={buttons.length}>
        {buttons.map((button) => {
          const selected = button.value === value;
          return (
            <Button
              key={button.value}
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              title={button.title}
              aria-pressed={selected}
              data-zaicode-model-button={button.value}
              data-selected={selected ? "true" : undefined}
              className={cn(
                "h-7 max-w-[12rem] rounded-md border px-2 text-ui-sm",
                selected
                  ? "border-foreground-subtle bg-surface font-semibold text-foreground"
                  : "border-border text-foreground-subtle hover:text-foreground",
              )}
              onClick={() => {
                if (!selected) onSelect(button.value);
              }}
            >
              <span className="truncate">{button.label}</span>
            </Button>
          );
        })}
      </div>
    </ZaicodeRightClickSettings>
  );
}
