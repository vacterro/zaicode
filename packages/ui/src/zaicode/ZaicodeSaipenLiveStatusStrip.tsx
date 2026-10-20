import { useCallback, type ReactNode } from "react";
import { ChevronDown, ChevronRight, EyeOff, Info, UserCheck } from "lucide-react";
import { useZaicodeSaipen } from "./zaicodeSaipen.js";
import { useZaicodeProjectRuntime } from "./zaicodeProjectRuntime.js";
import { useZaicodeUiPrefs } from "./zaicodeUiPrefs.js";
import { openZaicodeSaipenView } from "./zaicodeActions.js";
import { ZaicodeSaipenStatusShell } from "./ZaicodeSaipenStatusSettings.js";
import {
  ZaicodeSaipenStatusExpanded,
  zaicodeStatusVariantClasses,
} from "./ZaicodeSaipenStatusExpanded.js";
import {
  extractZaicodeSaipenRefusal,
  extractZaicodeSaipenResult,
  formatFreshness,
  isZaicodeNeedUser,
  resolveZaicodeLiveStatus,
} from "./zaicodeSaipenStatusModel.js";

export {
  extractZaicodeSaipenRefusal,
  extractZaicodeSaipenResult,
  formatFreshness,
  isZaicodeNeedUser,
  resolveZaicodeLiveStatus,
} from "./zaicodeSaipenStatusModel.js";

export interface ZaicodeSaipenLiveStatusStripProps {
  workspacePath?: string;
  workspaceIdentity?: string;
  inSubagentDrilldown?: boolean;
}

export function ZaicodeSaipenLiveStatusStrip({
  workspacePath,
  workspaceIdentity,
  inSubagentDrilldown,
}: ZaicodeSaipenLiveStatusStripProps): ReactNode {
  const prefs = useZaicodeUiPrefs();
  const snapshot = useZaicodeSaipen(workspacePath ?? "", workspaceIdentity);
  const runtime = useZaicodeProjectRuntime(workspacePath ?? "", workspaceIdentity, snapshot);

  const toggleView = useCallback(() => {
    const current = prefs.saipenStatusView;
    const next =
      current === "collapsed" ? "compact" : current === "compact" ? "expanded" : "collapsed";
    prefs.update({ saipenStatusView: next });
  }, [prefs]);

  const setView = useCallback(
    (view: "compact" | "expanded" | "collapsed") => {
      prefs.update({ saipenStatusView: view });
    },
    [prefs],
  );

  const viewMode = prefs.saipenStatusView ?? "compact";
  const stripStyle = {
    fontSize: `${prefs.saipenStatusFontSize}px`,
    paddingRight: "calc(var(--zaicode-status-lane, 0px) + 0.75rem)",
  };

  const hideView = useCallback(() => {
    prefs.update({ saipenStatusView: "off" });
  }, [prefs]);

  // If nested subagent drilldown or no workspacePath, do not render unrelated status
  if (!workspacePath || inSubagentDrilldown) {
    return null;
  }

  // Off: nothing renders. Turn it back on in Settings -> Layout & home.
  if (viewMode === "off") {
    return null;
  }

  // If project has no .saipen/ at all and no read error, do not fabricate protocol data
  if (!snapshot) {
    return (
      <ZaicodeSaipenStatusShell>
        <div
          data-testid="zaicode-saipen-live-status-strip"
          data-zaicode-status-strip="true"
          data-saipen-status="uninitialized"
          className="w-full flex shrink-0 items-center justify-between border-b border-border bg-background px-3 py-1 text-[1em] text-foreground-subtle"
          style={stripStyle}
        >
          <span className="flex items-center gap-1.5">
            <Info className="size-3 text-foreground-subtlest" />
            <span>No SAIPEN protocol memory in project (UNINITIALIZED)</span>
          </span>
        </div>
      </ZaicodeSaipenStatusShell>
    );
  }

  const needUser = isZaicodeNeedUser(snapshot);
  const result = extractZaicodeSaipenResult(snapshot);
  const refusal = extractZaicodeSaipenRefusal(snapshot);
  const { status, variant } = resolveZaicodeLiveStatus(snapshot, runtime?.verdict ?? null);

  const nextAction = snapshot.projection?.nextAction ?? snapshot.nextAction ?? "None";
  const activeTicket = snapshot.doing?.id ?? snapshot.projection?.claimedTicket;
  const activeTicketTitle = snapshot.doing?.title;

  // Collapsed Mode: minimal slim bar
  if (viewMode === "collapsed") {
    return (
      <ZaicodeSaipenStatusShell>
        <div
          data-testid="zaicode-saipen-live-status-strip"
          data-zaicode-status-strip="true"
          data-status-view="collapsed"
          className="w-full flex h-6 shrink-0 items-center justify-between border-b border-border bg-background/80 px-2 text-[1em] select-none"
          style={stripStyle}
        >
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            <button
              type="button"
              onClick={toggleView}
              aria-expanded={false}
              title="Expand SAIPEN live status"
              className="flex items-center gap-1 text-foreground-subtlest hover:text-foreground"
            >
              <ChevronRight className="size-3" />
              <span className="font-mono text-[0.9em] tracking-wider uppercase text-foreground-subtle">
                SAIPEN
              </span>
            </button>
            <span
              className={`rounded-xs border px-1 py-0.5 text-[0.9em] uppercase font-mono ${zaicodeStatusVariantClasses(variant)}`}
              title={`Status: ${status}`}
            >
              {status}
            </span>
            {needUser ? (
              <span
                className="flex items-center gap-1 rounded-xs border border-orange-500/50 bg-orange-500/20 px-1 py-0.5 font-bold text-[0.9em] text-orange-400"
                title="Authoritative human action required"
              >
                <UserCheck className="size-2.5" />
                <span>NEED USER</span>
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => setView("compact")}
            className="text-[0.9em] text-foreground-subtlest hover:text-foreground"
            title="Restore status bar"
          >
            Show
          </button>
          <button
            type="button"
            onClick={hideView}
            className="text-foreground-subtlest hover:text-foreground"
            title="Hide the SAIPEN status strip (turn it back on in Settings → Layout & home)"
            aria-label="Hide SAIPEN status strip"
          >
            <EyeOff className="size-3" />
          </button>
        </div>
      </ZaicodeSaipenStatusShell>
    );
  }

  // Expanded Mode: detailed panel
  if (viewMode === "expanded") {
    return (
      <ZaicodeSaipenStatusShell>
        <ZaicodeSaipenStatusExpanded
          snapshot={snapshot}
          verdict={runtime?.verdict ?? null}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          stripStyle={stripStyle}
          onToggle={toggleView}
          onCompact={() => setView("compact")}
          onHide={hideView}
        />
      </ZaicodeSaipenStatusShell>
    );
  }

  // Compact Mode: single horizontal row (~28-34px)
  return (
    <ZaicodeSaipenStatusShell>
      <div
        data-testid="zaicode-saipen-live-status-strip"
        data-zaicode-status-strip="true"
        data-status-view="compact"
        role="region"
        aria-label="SAIPEN Live Status"
        className="w-full @container/status-strip flex min-h-7 shrink-0 items-center justify-between gap-x-2 border-b border-border bg-background px-3 py-1 text-[1em]"
        style={stripStyle}
      >
        <div className="flex min-w-0 flex-1 items-center gap-x-2 overflow-hidden">
          {/* Collapse toggle button */}
          <button
            type="button"
            onClick={toggleView}
            aria-expanded={false}
            title="Expand status details or click again to collapse"
            className="flex shrink-0 items-center text-foreground-subtlest hover:text-foreground"
          >
            <ChevronRight className="size-3" />
          </button>

          {/* P0: STATUS */}
          <span
            className={`shrink-0 rounded-xs border px-1.5 py-0.5 text-[0.9em] uppercase font-mono ${zaicodeStatusVariantClasses(variant)}`}
            title={`Status: ${status}`}
          >
            {status}
          </span>

          {/* P0: NEED USER badge when authoritative human intervention is required */}
          {needUser ? (
            <span
              className="flex shrink-0 items-center gap-1 rounded-xs border border-orange-500/60 bg-orange-500/20 px-1.5 py-0.5 font-bold text-[0.9em] text-orange-400"
              title="Operator intervention required"
            >
              <UserCheck className="size-2.5" />
              <span>NEED USER</span>
            </span>
          ) : null}

          {/* P1: NEXT EXACT ACTION preview */}
          <div
            className="min-w-0 max-w-[40%] shrink truncate font-mono text-[1em] text-foreground-subtle"
            title={`NEXT EXACT ACTION: ${nextAction}`}
          >
            <span className="text-foreground-subtlest mr-1 text-[0.9em] uppercase">NEXT:</span>
            <span className="text-foreground select-all">{nextAction}</span>
          </div>

          {/* P1: RESULT (structured authoritative result or 'Not reported') */}
          <div
            className="hidden @[480px]/status-strip:flex min-w-0 max-w-[25%] shrink truncate text-[1em]"
            title={`RESULT: ${result}`}
          >
            <span className="text-foreground-subtlest mr-1 text-[0.9em] uppercase">RES:</span>
            <span
              className={
                result === "Not reported"
                  ? "text-foreground-subtlest italic truncate"
                  : "text-foreground truncate"
              }
            >
              {result}
            </span>
          </div>

          {/* P2: Phase & Ticket */}
          {activeTicket ? (
            <span
              className="hidden @[640px]/status-strip:inline-block shrink-0 rounded-xs border border-border px-1 py-0.2 font-mono text-[0.9em] text-foreground-subtle truncate max-w-[120px]"
              title={`Active ticket: ${activeTicket}${activeTicketTitle ? ` (${activeTicketTitle})` : ""}`}
            >
              {activeTicket}
            </span>
          ) : null}

          {/* Refusal indicator if present */}
          {refusal ? (
            <span
              className="shrink-0 rounded-xs border border-destructive/50 bg-destructive/15 px-1 py-0.2 font-mono text-[0.9em] font-bold text-destructive truncate max-w-[160px]"
              title={`Refusal: ${refusal}`}
            >
              REFUSAL
            </span>
          ) : null}

          {/* P3: Wide viewport details */}
          <span className="hidden @[900px]/status-strip:inline-flex shrink-0 items-center gap-1 text-[0.9em] text-foreground-subtlest font-mono">
            {snapshot.owner ? <span>{snapshot.owner}</span> : null}
            {snapshot.lastActionTime || snapshot.projection?.readAt ? (
              <span>
                · {formatFreshness(snapshot.projection?.readAt ?? snapshot.lastActionTime)}
              </span>
            ) : null}
          </span>
        </div>

        {/* Right actions: Details, Expand, Hide */}
        <div className="flex shrink-0 items-center gap-1.5 pl-1">
          <button
            type="button"
            onClick={() => openZaicodeSaipenView(workspacePath, workspaceIdentity)}
            className="hidden @[380px]/status-strip:flex items-center gap-1 text-[0.9em] text-foreground-subtle hover:text-foreground"
            title="Open SAIPEN Inspector details"
          >
            <span>Details</span>
          </button>
          <button
            type="button"
            onClick={() => setView("expanded")}
            aria-label="Expand SAIPEN live status"
            title="Expand status details"
            className="text-foreground-subtlest hover:text-foreground"
          >
            <ChevronDown className="size-3" />
          </button>
          <button
            type="button"
            onClick={hideView}
            className="hidden @[380px]/status-strip:flex text-foreground-subtlest hover:text-foreground"
            title="Hide the SAIPEN status strip (turn it back on in Settings → Layout & home)"
            aria-label="Hide SAIPEN status strip"
          >
            <EyeOff className="size-3" />
          </button>
        </div>
      </div>
    </ZaicodeSaipenStatusShell>
  );
}
