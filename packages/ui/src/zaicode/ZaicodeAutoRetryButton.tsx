import { RefreshCwIcon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  useZaicodeUiPrefs,
  zaicodeAutoRetryPatch,
  zaicodeAutoRetryScopeLabel,
  zaicodeAutoRetryScopeNext,
} from "./zaicodeUiPrefs.js";
import { zaicodeEffectiveAutoRetry, zaicodeEffectiveAutoRetryFor, useZaicodeRetryLedger } from "./zaicodeRetryPolicy.js";
import { useZaicodeAutoContinue } from "./zaicodeAutoContinue.js";
import { useZaicodeAuditStore } from "./zaicodeAuditStore.js";

/**
 * SRC-135: the Auto retry switch next to the composer send control, highlighted while
 * it is on so nobody has to walk to Settings to learn whether a failed turn will be
 * retried. The small switch beside it picks the reach: this project/session only, or
 * every ZAICODE session and project at once.
 */
export function ZaicodeAutoRetryButton({ projectKey, sessionId }: { projectKey: string; sessionId?: string | null }) {
  const prefs = useZaicodeUiPrefs();
  const update = useZaicodeUiPrefs((state) => state.update);
  const masterOn = useZaicodeAuditStore((state) => state.smartMode);
  const sessionMode = useZaicodeAutoContinue((state) => sessionId ? state.modes[sessionId] : undefined);
  const halted = useZaicodeRetryLedger((state) => state.halted);
  const effective = zaicodeEffectiveAutoRetry(prefs, projectKey, sessionId, { masterOn, sessionMode, halted });
  const enabled = effective.enabled;
  const scopeTitle = `Edit ${zaicodeAutoRetryScopeLabel(prefs.autoRetryScope)}; effective preference inherited from ${effective.source}`;
  const title = enabled ? "Auto retry on — a failed turn is sent again by itself" : `Auto retry off · ${effective.reason}`;
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
          disabled={prefs.autoRetryScope === "session" && !sessionId}
          title={title}
          className={cn("cursor-pointer", enabled && "bg-selected text-foreground")}
          onClick={() => update(zaicodeAutoRetryPatch(prefs, projectKey, !effective.preference, sessionId))}
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
          className="cursor-pointer px-1 text-ui-xs"
          onClick={() => { const next = zaicodeAutoRetryScopeNext(prefs.autoRetryScope); update({ autoRetryScope: next === "session" && !sessionId ? "global" : next }); }}
        >
          {zaicodeAutoRetryScopeLabel(prefs.autoRetryScope)}
        </Button>
      </ControlHintTooltip>
      {prefs.autoRetryScope !== "global" ? <Button type="button" variant="ghost" size="sm" className="px-1 text-ui-xs" disabled={prefs.autoRetryScope === "session" && !sessionId} title="Remove this override and inherit" onClick={() => {
        if (prefs.autoRetryScope === "session" && !sessionId) return;
        if (prefs.autoRetryScope === "session" && sessionId) { const next = { ...prefs.autoRetrySessions }; delete next[sessionId]; update({ autoRetrySessions: next }); }
        else { const next = { ...prefs.autoRetryProjects }; delete next[projectKey]; update({ autoRetryProjects: next }); }
      }}>Inherit</Button> : null}
    </div>
  );
}

/** The same answer the button shows, for callers outside React (the retry watcher). */
export function zaicodeAutoRetryOn(projectKey: string, sessionId?: string): boolean {
  return zaicodeEffectiveAutoRetryFor(projectKey, sessionId).enabled;
}
