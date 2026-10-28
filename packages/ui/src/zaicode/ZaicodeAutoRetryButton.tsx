import { useRef, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  ZAICODE_UI_PREFS_STORAGE_KEY,
  useZaicodeUiPrefs,
  zaicodeAutoRetryEffectiveLabel,
  zaicodeAutoRetryEffectiveScope,
} from "./zaicodeUiPrefs.js";
import { zaicodeAutoRetryEnabled } from "./zaicodeUiPrefs.js";
import {
  zaicodeAutoRetryToggle,
  zaicodeEffectiveAutoRetry,
  zaicodeEffectiveAutoRetryFor,
  useZaicodeRetryLedger,
} from "./zaicodeRetryPolicy.js";
import { useZaicodeAutoContinue } from "./zaicodeAutoContinue.js";
import { useZaicodeAuditStore } from "./zaicodeAuditStore.js";
import { ZaicodeRightClickSettings } from "./ZaicodePrefControls.js";
import { openZaicodeSettings, openZaicodeWorkspaceView } from "./zaicodeActions.js";

/**
 * Fresh REQ-001: one predictable interaction contract (was SRC-135/T-201/T-217).
 * The primary switch toggles the EFFECTIVE answer by writing the scope that
 * owns it (session > project > global). The scope pill names the effective
 * scope explicitly ("This project" / "Inherited: Global OFF"), never a bare
 * "Global default" while a hidden override decides. All surfaces (tooltip,
 * highlight, icon, text, persisted prefs) derive from the same effective state.
 * Rapid clicks are fenced by a bounded pending lock; a persistence failure
 * restores the previous snapshot and surfaces the failure in the tooltip.
 */
/**
 * The button's one-line answer, derived from the effective projection and nothing else. Exported
 * so every surface that prints "what Auto retry is doing now" can be checked against it instead of
 * re-deriving its own string (SRC-161:REQ-002).
 */
export function zaicodeAutoRetryTitle(effective: ReturnType<typeof zaicodeEffectiveAutoRetry>): string {
  return effective.enabled
    ? "Auto retry on — a failed turn is sent again by itself"
    : `Auto retry off · ${effective.reason}`;
}

export function ZaicodeAutoRetryButton({ projectKey, sessionId }: { projectKey: string; sessionId?: string | null }) {
  const prefs = useZaicodeUiPrefs();
  const update = useZaicodeUiPrefs((state) => state.update);
  const masterOn = useZaicodeAuditStore((state) => state.smartMode);
  const sessionMode = useZaicodeAutoContinue((state) => sessionId ? state.modes[sessionId] : undefined);
  const halted = useZaicodeRetryLedger((state) => state.halted);
  const effective = zaicodeEffectiveAutoRetry(prefs, projectKey, sessionId, { masterOn, sessionMode, halted });
  const enabled = effective.enabled;
  const effectiveScope = zaicodeAutoRetryEffectiveScope(prefs, projectKey, sessionId);
  const effectiveLabel = zaicodeAutoRetryEffectiveLabel(prefs, projectKey, sessionId);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const lockRef = useRef(false);
  const failTimer = useRef<number | null>(null);
  const baseTitle = zaicodeAutoRetryTitle(effective);
  const title = pending ? "Saving auto retry…" : failed ? `Auto retry save failed — restored ${effective.preference ? "ON" : "OFF"} · ${effectiveLabel}` : baseTitle;
  const scopeTitle = `Effective: ${effectiveLabel} (${effective.preference ? "ON" : "OFF"}). The switch always edits the scope that owns this answer; Inherit clears the override.`;
  const toggleEffective = () => {
    if (lockRef.current) return;
    lockRef.current = true;
    setPending(true);
    setFailed(false);
    const snapshot = { autoRetry: prefs.autoRetry, autoRetryProjects: prefs.autoRetryProjects, autoRetrySessions: prefs.autoRetrySessions };
    // SRC-162: flip the EFFECTIVE answer, not the bare preference. Flipping the preference while
    // the sidebar Auto (or the stop-all) held the answer off left the button "off" on every click.
    const toggle = zaicodeAutoRetryToggle(prefs, projectKey, sessionId, effective);
    const next = toggle.next;
    try {
      update(toggle.patch);
      if (toggle.resumeHalt) useZaicodeRetryLedger.getState().resume();
      if (toggle.clearSessionOff && sessionId) useZaicodeAutoContinue.getState().setMode(sessionId, "default");
      // The UI already derives from the store; verify the persisted copy agrees.
      try {
        const raw = localStorage.getItem(ZAICODE_UI_PREFS_STORAGE_KEY);
        if (raw) {
          const persisted = JSON.parse(raw) as { autoRetry?: unknown; autoRetryProjects?: Record<string, unknown>; autoRetrySessions?: Record<string, unknown> };
          const persistedPref = zaicodeAutoRetryEnabled(
            { autoRetry: persisted.autoRetry === true, autoRetryScope: prefs.autoRetryScope, autoRetryProjects: (persisted.autoRetryProjects ?? {}) as Record<string, boolean>, autoRetrySessions: (persisted.autoRetrySessions ?? {}) as Record<string, boolean> },
            projectKey,
            sessionId,
          );
          if (persistedPref !== next) throw new Error("persisted preference diverged");
        }
      } catch {
        update(snapshot);
        setFailed(true);
        if (failTimer.current) window.clearTimeout(failTimer.current);
        failTimer.current = window.setTimeout(() => setFailed(false), 4000);
      }
    } catch {
      try { update(snapshot); } catch { /* restore best-effort; failure already surfaced */ }
      setFailed(true);
      if (failTimer.current) window.clearTimeout(failTimer.current);
      failTimer.current = window.setTimeout(() => setFailed(false), 4000);
    } finally {
      // Bounded pending window: fences rapid double clicks, then releases.
      window.setTimeout(() => { lockRef.current = false; setPending(false); }, 150);
    }
  };
  return (
    <div
      className="group/retry flex items-center"
      data-zaicode-auto-retry-scope={effectiveScope}
      data-zaicode-auto-retry-pending={pending ? "true" : "false"}
      data-composer-collapse-priority="4"
    >
      <ZaicodeRightClickSettings
        title="Auto retry"
        preferenceKey="retry"
        hint="Left-click turns Auto retry on or off here; the label beside it says which scope owns the answer. Right-click opens this panel."
        panel={<ZaicodeAutoRetryPanel effectiveLabel={effectiveLabel} preference={effective.preference} masterOn={masterOn} />}
        side="top"
      >
      <ControlHintTooltip title={title}>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          data-testid="zaicode-auto-retry"
          data-zaicode-auto-retry={enabled ? "on" : "off"}
          aria-label={title}
          aria-pressed={enabled}
          disabled={pending}
          title={title}
          className={cn("cursor-pointer", enabled && "bg-selected text-foreground", pending && "opacity-60")}
          onClick={toggleEffective}
        >
          <RefreshCwIcon className="size-4" />
          <span className="sr-only">{title}</span>
        </Button>
      </ControlHintTooltip>
      </ZaicodeRightClickSettings>
      <ControlHintTooltip title={scopeTitle}>
        <span
          data-testid="zaicode-auto-retry-scope"
          aria-label={scopeTitle}
          title={scopeTitle}
          className="px-1 text-ui-xs text-foreground-subtle group-data-[composer-compact=true]/retry:hidden"
        >
          {effectiveLabel}
        </span>
      </ControlHintTooltip>
      {effectiveScope !== "global" ? <Button type="button" variant="ghost" size="sm" className="px-1 text-ui-xs group-data-[composer-compact=true]/retry:hidden" title="Remove this override and inherit" onClick={() => {
        if (effectiveScope === "session" && sessionId) { const next = { ...prefs.autoRetrySessions }; delete next[sessionId]; update({ autoRetrySessions: next }); }
        else if (effectiveScope === "project") { const next = { ...prefs.autoRetryProjects }; delete next[projectKey]; update({ autoRetryProjects: next }); }
      }}>Inherit</Button> : null}
    </div>
  );
}

/**
 * The Auto retry settings panel body. Exported so the reachability contract (the route to the
 * gate this button does not own) is testable without a DOM.
 *
 * The effective answer is ANDed with the sidebar's Auto, which this button neither owns nor can
 * write: without naming that owner and leading to it, the button reads as a stuck
 * "Auto retry off · Sidebar Auto is off" that no click changes (SRC-161:REQ-002).
 */
export function ZaicodeAutoRetryPanel({
  effectiveLabel,
  preference,
  masterOn,
}: {
  effectiveLabel: string;
  preference: boolean;
  masterOn: boolean;
}) {
  return (
    <div className="flex max-w-[260px] flex-col items-start gap-1 text-ui-sm">
      <span>
        Effective now: {effectiveLabel} ({preference ? "ON" : "OFF"}). Inherit clears the override.
      </span>
      {masterOn ? null : (
        <span data-zaicode-auto-retry-master-off className="text-foreground-subtle">
          Sidebar Auto is off, so the inherited global default does not send by itself. A click on
          the button turns retry ON for this project anyway; or turn Auto on in Audits.
        </span>
      )}
      <Button type="button" variant="ghost" size="sm" className="px-1 text-ui-xs" onClick={() => openZaicodeSettings("zaicodeWorkers")}>
        Open retry settings
      </Button>
      {masterOn ? null : (
        <Button type="button" variant="ghost" size="sm" className="px-1 text-ui-xs" onClick={() => openZaicodeWorkspaceView()}>
          Open Audits (sidebar Auto)
        </Button>
      )}
    </div>
  );
}

/** The same answer the button shows, for callers outside React (the retry watcher). */
export function zaicodeAutoRetryOn(projectKey: string, sessionId?: string): boolean {
  return zaicodeEffectiveAutoRetryFor(projectKey, sessionId).enabled;
}
