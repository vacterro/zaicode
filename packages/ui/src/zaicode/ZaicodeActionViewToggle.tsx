import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZaicodeUiPrefs } from "./zaicodeUiPrefs.js";
import { ZaicodeRightClickSettings } from "./ZaicodePrefControls.js";

/**
 * SRC-113: Compact / Full for the whole sidebar.
 *
 * A button or menu line can carry a condition (T-134: only while working, only
 * while idle, only on hover), so a configured action can be completely absent
 * from a moment where the user is looking for it. Full ignores those
 * conditions and draws every ticked entry; Compact restores them. An unticked
 * entry stays hidden in both -- this reveals what is configured, it does not
 * add anything.
 *
 * The message box has its own Compact/Full (next to START); this one is the
 * sidebar's, and the two do not depend on each other.
 */
export function ZaicodeActionViewToggle({ className }: { className?: string }) {
  const view = useZaicodeUiPrefs((state) => state.actionView);
  const update = useZaicodeUiPrefs((state) => state.update);
  const full = view === "full";
  return (
    <ZaicodeRightClickSettings
      title="Compact / Full"
      preferenceKey="actionView"
      hint="Compact keeps every button and menu line conditional exactly as you set it (only while working, only while idle, only on hover). Full shows all of them at once. A button you unticked stays hidden in both."
      panel={
        <span className="block max-w-[260px] text-ui-sm">
          Compact honours each entry's own condition. Full shows every ticked button and menu
          line at once, so nothing you configured hides behind a moment. Right-click the header,
          footer or menu to edit which entries exist and what they say.
        </span>
      }
      align="end"
      className={cn("shrink-0", className)}
    >
      <button
        type="button"
        className="flex size-6 shrink-0 items-center justify-center border border-border text-foreground-subtle hover:bg-hover hover:text-foreground"
        title={
          full
            ? "Full view: every ticked button and menu line is on screen. Click for Compact."
            : "Compact view: buttons and menu lines follow their own conditions. Click for Full."
        }
        aria-pressed={full}
        onClick={() => update({ actionView: full ? "compact" : "full" })}
        data-zaicode-action-view={view}
      >
        {full ? <ChevronsUpDown className="size-3.5" /> : <ChevronsDownUp className="size-3.5" />}
      </button>
    </ZaicodeRightClickSettings>
  );
}