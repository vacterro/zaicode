import { useRef } from "react";
import { formatZaicodeDuration } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZaicodeGatedNow } from "./zaicodeNowGate.js";
import { zaicodeRunClock } from "./zaicodeRunClock.js";
import { ZaicodeWorkingIcon } from "./ZaicodeWorkingIcon.js";
import { useZaicodePresenceSession, zaicodePresenceOverridesWorking } from "./zaicodeConnectionPresence.js";

/**
 * SRC-051: "working for" mini on the chatbox — how long the open chat has been
 * working, next to the model controls. Same read-out as the project row
 * (formatZaicodeDuration, minute buckets), so the two never disagree; the tick
 * is change-gated (T-67), one render a minute, not one a second.
 *
 * SRC-058: the start comes from the run clock the sidebar feeds, so opening a
 * session that has been working for an hour shows an hour, not 0m. The local
 * mount anchor is only the fallback for a session the clock has not seen yet,
 * and it is never written back, so it cannot overwrite a better start.
 */
export function ZaicodeComposerWorkingFor({
  sessionId,
  running,
  className,
}: {
  sessionId?: string | null;
  running: boolean;
  className?: string;
}) {
  const anchor = useRef(0);
  if (running && anchor.current === 0) anchor.current = Date.now();
  if (!running) anchor.current = 0;
  // Minute buckets only: formatZaicodeDuration never shows seconds.
  const now = useZaicodeGatedNow(() => 60_000);
  // Fresh REQ-005: the same presence every working surface reads. While the
  // API connection is lost and recovery runs, this slot shows Reconnecting /
  // Fallback active / waiting states instead of the ordinary Working readout.
  const presence = useZaicodePresenceSession(sessionId, running);
  if (!running) return null;
  if (zaicodePresenceOverridesWorking(presence)) {
    return (
      <span
        className={cn("group/working flex shrink-0 items-center gap-1 text-ui-xs tabular-nums text-foreground-subtle", className)}
        data-zaicode-presence={presence.kind}
        data-composer-collapse-priority="3"
        title={presence.detail ?? presence.label ?? "Connection state"}
      >
        <ZaicodeWorkingIcon sessionId={sessionId} className="size-3" />
        <span className="group-data-[composer-compact=true]/working:hidden">
          {presence.label}
        </span>
      </span>
    );
  }
  const since = (sessionId ? zaicodeRunClock.sinceOf(sessionId) : 0) || anchor.current;
  const duration = Math.max(0, now - since);
  return (
    // 时长是侧栏项目行的复读，所以它是第一个让位的 rung：窄行只留工作指示点，
    // 读数在侧栏仍然逐字相同，收起不会让两处说法分叉。
    <span
      className={cn("group/working flex shrink-0 items-center gap-1 text-ui-xs tabular-nums text-foreground-subtle", className)}
      data-zaicode-composer-working-for={Math.floor(duration / 60_000)}
      data-composer-collapse-priority="3"
      title="How long this session has been working"
    >
      <ZaicodeWorkingIcon sessionId={sessionId} className="size-3" />
      <span className="group-data-[composer-compact=true]/working:hidden">
        {formatZaicodeDuration(duration)}
      </span>
    </span>
  );
}
