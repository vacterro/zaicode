import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ZaicodePrefCheck, ZaicodeRightClickSettings } from "./ZaicodePrefControls.js";
import { type ZaicodeModelButton } from "./zaicodeModelButtonsModel.js";
import { useZaicodeComposerModelButtonsPrefs } from "./zaicodeComposerModelButtonsPrefs.js";
import { openZaicodeSettings } from "./zaicodeActions.js";

/** T-136: the composer's model choice as buttons when there are only a few models. */
export function ZaicodeModelButtons({
  buttons,
  allEligibleButtons,
  value,
  disabled,
  onSelect,
  onManageModels,
}: {
  buttons: readonly ZaicodeModelButton[];
  allEligibleButtons?: readonly ZaicodeModelButton[];
  value: string;
  disabled?: boolean;
  onSelect: (value: string) => void;
  onManageModels?: () => void;
}) {
  const prefs = useZaicodeComposerModelButtonsPrefs();
  const eligible = allEligibleButtons ?? buttons;
  const hiddenCount = prefs.hiddenButtons?.length ?? 0;

  return (
    // SRC-151:R011: these buttons own a setting (when buttons replace the
    // picker), so a right-click on them opens that setting next to them.
    <ZaicodeRightClickSettings
      title="Model buttons"
      preferenceKey="modelButtons"
      align="start"
      className="min-w-0 shrink"
      hint="Choose which quick buttons show in the toolbar. The rest stay in the model picker."
      panel={
        <div
          className="flex flex-col gap-1.5 text-ui-xs text-foreground-subtle"
          data-zaicode-composer-model-buttons-panel
        >
          <div
            className="flex max-h-80 flex-col gap-1 overflow-y-auto"
            data-zaicode-composer-model-buttons-list
          >
            {eligible.map((button) => {
              const isSelected = button.value === value;
              const isHidden = prefs.hiddenButtons?.includes(button.value) ?? false;
              const isChecked = !isHidden || isSelected;
              return (
                <ZaicodePrefCheck
                  key={button.value}
                  checked={isChecked}
                  disabled={isSelected}
                  hint={isSelected ? "Selected model remains visible" : undefined}
                  onChange={(checked) => {
                    prefs.toggleButton(button.value, checked);
                  }}
                  label={button.title || `${button.owner ? button.owner + " · " : ""}${button.label}`}
                />
              );
            })}
          </div>
          <div className="mt-1 flex items-center gap-2 border-t border-border pt-1.5">
            <button
              type="button"
              className="border border-border px-1.5 py-0.5 text-foreground-subtle hover:bg-hover hover:text-foreground"
              onClick={() => prefs.reset()}
              disabled={hiddenCount === 0}
            >
              Reset defaults
            </button>
            <button
              type="button"
              className="border border-border px-1.5 py-0.5 text-foreground-subtle hover:bg-hover hover:text-foreground"
              onClick={() => {
                if (onManageModels) {
                  onManageModels();
                } else {
                  openZaicodeSettings("zaicodeEngines");
                }
              }}
            >
              Manage models
            </button>
          </div>
        </div>
      }
    >
      {/* 模型名称应在自己的按钮中截断，不能把整个发送簇挤成多层空行。 */}
      <div className="flex min-w-0 items-center gap-1" data-zaicode-model-buttons={buttons.length}>
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
                "h-7 min-w-0 max-w-[12rem] shrink rounded-md border px-2 text-ui-sm",
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
