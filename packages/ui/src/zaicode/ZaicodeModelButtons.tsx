import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import type { ZaicodeModelButton } from "./zaicodeModelButtonsModel.js";

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
  );
}
