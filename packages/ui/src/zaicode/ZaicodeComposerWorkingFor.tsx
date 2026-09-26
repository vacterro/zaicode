import { useRef } from "react";
import { formatZaicodeDuration } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZaicodeGatedNow } from "./zaicodeNowGate.js";
import { ZaicodeWorkingIcon } from "./ZaicodeWorkingIcon.js";

/**
 * SRC-051: "working for" mini on the chatbox — how long the open chat's turn
 * has been running, next to the model controls. Same read-out as the project
 * row (formatZaicodeDuration, minute buckets), so the two never disagree; the
 * tick is change-gated (T-67), one render a minute, not one a second.
 */
export function ZaicodeComposerWorkingFor({ running, className }: { running: boolean; className?: string }) {
  const anchor = useRef(0);
  if (running && anchor.current === 0) anchor.current = Date.now();
  if (!running) anchor.current = 0;
  // Minute buckets only: formatZaicodeDuration never shows seconds.
  const now = useZaicodeGatedNow(() => 60_000);
  if (!running) return null;
  const duration = Math.max(0, now - anchor.current);
  return (
    <span
      className={cn("flex shrink-0 items-center gap-1 text-ui-xs tabular-nums text-foreground-subtle", className)}
      data-zaicode-composer-working-for={Math.floor(duration / 60_000)}
      title="How long this turn has been running"
    >
      <ZaicodeWorkingIcon className="size-3" />
      {formatZaicodeDuration(duration)}
    </span>
  );
}
