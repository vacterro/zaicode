import { RefreshCwIcon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  useZaicodeUiPrefs,
  zaicodeAutoRetryEnabled,
  zaicodeAutoRetryPatch,
  zaicodeAutoRetryScopeLabel,
  zaicodeAutoRetryScopeNext,
  type ZaicodeUiPrefs,
} from "./zaicodeUiPrefs.js";

/**
 * SRC-135: the Auto retry switch next to the composer send control, highlighted while
 * it is on so nobody has to walk to Settings to learn whether a failed turn will be
 * retried. The small switch beside it picks the reach: this project/session only, or
 * every ZAICODE session and project at once.
 */
export function ZaicodeAutoRetryButton({ projectKey }: { projectKey: string }) {
  const prefs = useZaicodeUiPrefs();
  const update = useZaicodeUiPrefs((state) => state.update);
  const enabled = zaicodeAutoRetryEnabled(prefs, projectKey);
  const scopeTitle = prefs.autoRetryScope === "global"
    ? "Auto retry applies to every ZAICODE session and project"
    : "Auto retry applies to this project/session only";
  const title = enabled ? "Auto retry on — a failed turn is sent again by itself" : "Auto retry off";
  return (
    <div className="flex items-center" data-zaicode-auto-retry-scope={prefs.autoRetryScope}>
      <ControlHintTooltip title={title}>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          data-testid="zaicode-auto-retry"
          data-zaicode-auto-retry={enabled ? "on" : "off"}
          aria-label={title}
          aria-pressed={enabled}
          title={title}
          className={cn("cursor-pointer", enabled && "bg-selected text-foreground")}
          onClick={() => update(zaicodeAutoRetryPatch(prefs, projectKey, !enabled))}
        >
          <RefreshCwIcon className="size-4" />
          <span className="sr-only">{title}</span>
        </Button>
      </ControlHintTooltip>
      <ControlHintTooltip title={`${scopeTitle}. Click to switch.`}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="zaicode-auto-retry-scope"
          aria-label={scopeTitle}
          title={`${scopeTitle}. Click to switch.`}
          className="cursor-pointer px-1 text-xs"
          onClick={() => update({ autoRetryScope: zaicodeAutoRetryScopeNext(prefs.autoRetryScope) })}
        >
          {zaicodeAutoRetryScopeLabel(prefs.autoRetryScope)}
        </Button>
      </ControlHintTooltip>
    </div>
  );
}

/** The same answer the button shows, for callers outside React (the retry watcher). */
export function zaicodeAutoRetryOn(projectKey: string): boolean {
  const state = useZaicodeUiPrefs.getState() as ZaicodeUiPrefs;
  return zaicodeAutoRetryEnabled(state, projectKey);
}
