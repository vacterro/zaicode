import type { CSSProperties, ReactNode } from "react";
import { AlertTriangle, ChevronDown, ExternalLink, EyeOff } from "lucide-react";
import { openZaicodeSaipenView } from "./zaicodeActions.js";
import type { ZaicodeSaipenSnapshot } from "./zaicodeSaipenModel.js";
import {
  extractZaicodeSaipenRefusal,
  extractZaicodeSaipenResult,
  isZaicodeNeedUser,
  resolveZaicodeLiveStatus,
} from "./zaicodeSaipenStatusModel.js";
import type { ZaicodeProjectRuntimeVerdict } from "@zcode/shared";

/** The status word's chrome per state; shared by every strip shape. */
export function zaicodeStatusVariantClasses(
  variant: "default" | "running" | "warning" | "danger" | "success",
): string {
  return {
    default: "bg-muted text-foreground-subtle border-border",
    running: "bg-amber-500/10 text-amber-500 border-amber-500/30",
    warning: "bg-orange-500/15 text-orange-400 border-orange-500/40 font-semibold",
    danger: "bg-destructive/15 text-destructive border-destructive/40 font-semibold",
    success: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  }[variant];
}

/**
 * Expanded strip: every field in a panel, with owner and freshness — the far
 * end of the ⇕ chevron. It recomputes its own verdicts from the snapshot, so
 * the slim and compact rows stay the thin ones.
 */
export function ZaicodeSaipenStatusExpanded({
  snapshot,
  verdict,
  workspacePath,
  workspaceIdentity,
  stripStyle,
  onToggle,
  onCompact,
  onHide,
}: {
  snapshot: ZaicodeSaipenSnapshot;
  verdict: ZaicodeProjectRuntimeVerdict | null;
  workspacePath: string;
  workspaceIdentity?: string;
  stripStyle: CSSProperties;
  onToggle: () => void;
  onCompact: () => void;
  onHide: () => void;
}): ReactNode {
  const needUser = isZaicodeNeedUser(snapshot);
  const result = extractZaicodeSaipenResult(snapshot);
  const refusal = extractZaicodeSaipenRefusal(snapshot);
  const { status, variant } = resolveZaicodeLiveStatus(snapshot, verdict);

  const nextAction = snapshot.projection?.nextAction ?? snapshot.nextAction ?? "None";
  const activeTicket = snapshot.doing?.id ?? snapshot.projection?.claimedTicket;
  const activeTicketTitle = snapshot.doing?.title;
  const phase = snapshot.phase ?? snapshot.projection?.phase;
  const blocker = snapshot.blocker ?? snapshot.projection?.blocker;

  return (
    <div
      data-testid="zaicode-saipen-live-status-strip"
      data-zaicode-status-strip="true"
      data-status-view="expanded"
      role="region"
      aria-label="SAIPEN Live Status Details"
      className="w-full shrink-0 border-b border-border bg-background px-3 py-2 text-[1em] shadow-xs"
      style={stripStyle}
    >
      {/* Header row */}
      <div className="flex items-center justify-between border-b border-border/60 pb-1.5 mb-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={true}
            title="Collapse SAIPEN live status"
            className="flex items-center gap-1 text-foreground-subtle hover:text-foreground"
          >
            <ChevronDown className="size-3.5" />
            <span className="font-mono font-medium tracking-wide uppercase">
              SAIPEN LIVE STATUS
            </span>
          </button>
          <span
            className={`rounded-xs border px-1.5 py-0.5 text-[0.9em] font-mono ${zaicodeStatusVariantClasses(variant)}`}
          >
            {status}
          </span>
          {needUser ? (
            <span className="flex items-center gap-1 rounded-xs border border-orange-500/60 bg-orange-500/20 px-1.5 py-0.5 font-bold text-orange-400">
              <AlertTriangle className="size-3" />
              <span>NEED USER</span>
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => openZaicodeSaipenView(workspacePath, workspaceIdentity)}
            className="flex items-center gap-1 rounded-xs border border-border px-1.5 py-0.5 text-foreground-subtle hover:bg-hover hover:text-foreground"
            title="Open full SAIPEN Inspector pane"
          >
            <ExternalLink className="size-3" />
            <span>Full Details</span>
          </button>
          <button
            type="button"
            onClick={onCompact}
            className="text-foreground-subtlest hover:text-foreground"
            title="Compact view"
          >
            Compact
          </button>
          <button
            type="button"
            onClick={onHide}
            className="text-foreground-subtlest hover:text-foreground"
            title="Hide the SAIPEN status strip (turn it back on in Settings → Layout & home)"
            aria-label="Hide SAIPEN status strip"
          >
            <EyeOff className="size-3" />
          </button>
        </div>
      </div>

      {/* Details Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1.5 text-foreground">
        <div>
          <span className="text-foreground-subtlest font-mono text-[0.9em] uppercase block">
            NEXT EXACT ACTION:
          </span>
          <span className="font-mono text-[1em] select-all text-primary">{nextAction}</span>
        </div>

        <div>
          <span className="text-foreground-subtlest font-mono text-[0.9em] uppercase block">
            RESULT:
          </span>
          <span
            className={
              result === "Not reported" ? "text-foreground-subtlest italic" : "text-foreground"
            }
          >
            {result}
          </span>
        </div>

        <div>
          <span className="text-foreground-subtlest font-mono text-[0.9em] uppercase block">
            PHASE & TICKET:
          </span>
          <span>
            {phase ? `[${phase}] ` : ""}
            {activeTicket ? (
              <span className="font-mono font-medium text-foreground">
                {activeTicket}
                {activeTicketTitle ? `: ${activeTicketTitle}` : ""}
              </span>
            ) : (
              <span className="text-foreground-subtlest italic">No active ticket</span>
            )}
          </span>
        </div>

        {blocker ? (
          <div>
            <span className="text-foreground-subtlest font-mono text-[0.9em] uppercase block">
              BLOCKER:
            </span>
            <span className="text-destructive font-mono">{blocker}</span>
          </div>
        ) : null}

        {refusal ? (
          <div>
            <span className="text-foreground-subtlest font-mono text-[0.9em] uppercase block">
              REFUSAL:
            </span>
            <span className="text-destructive font-mono font-bold">{refusal}</span>
          </div>
        ) : null}

        <div className="text-[0.9em] text-foreground-subtlest md:col-span-2 pt-1 border-t border-border/40 flex flex-wrap items-center gap-x-4 gap-y-1">
          {snapshot.owner ? (
            <span>
              Owner: <span className="font-mono text-foreground-subtle">{snapshot.owner}</span>
            </span>
          ) : null}
          {snapshot.generation ? (
            <span>
              Last event:{" "}
              <span className="font-mono text-foreground-subtle">E-{snapshot.generation}</span>
            </span>
          ) : null}
          {snapshot.updated ? <span>Updated: {snapshot.updated}</span> : null}
          {snapshot.projection?.readAt ? (
            <span>
              Confirmed: {new Date(snapshot.projection.readAt).toLocaleTimeString()} (
              {snapshot.projection.source})
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
