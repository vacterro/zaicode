import { useEffect, useState } from "react";
import { RotateCw, Square } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { useZaicodeRetryLedger } from "./zaicodeRetryPolicy.js";
import { useZaicodeUiPrefs } from "./zaicodeUiPrefs.js";

/**
 * SRC-082: an automatic retry that nobody can see is a hole. While any session has a
 * retry scheduled, this row says how many, when the next one goes out, and stops them
 * all with one click (and keeps them stopped until the same button turns them back on).
 * Nothing is drawn when nothing is scheduled and nothing is halted.
 */
export function ZaicodeRetryLedgerChip() {
  const pending = useZaicodeRetryLedger((state) => state.pending);
  const halted = useZaicodeRetryLedger((state) => state.halted);
  const [now, setNow] = useState(() => Date.now());
  const entries = Object.values(pending).sort((left, right) => left.nextAt - right.nextAt);
  const active = entries.length > 0;
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  if (!active && !halted) return null;

  const stopAll = () => {
    // Persisted: the setting goes off too, so a restart does not bring the knocking back.
    useZaicodeUiPrefs.getState().update({ autoRetry: false });
    useZaicodeRetryLedger.getState().halt();
    toast("Automatic retries stopped for every session. Turn them back on here or in Settings > Workers.", { durationMs: 6000 });
  };
  const resume = () => {
    useZaicodeUiPrefs.getState().update({ autoRetry: true });
    useZaicodeRetryLedger.getState().resume();
  };
  const next = entries[0];
  const seconds = next ? Math.max(0, Math.ceil((next.nextAt - now) / 1000)) : 0;
  const title = halted
    ? "Automatic retries are stopped. Click to allow them again (they still need the sidebar Auto ON)."
    : [
        "Scheduled to retry by themselves (click: stop them all):",
        ...entries.map((entry) => `${entry.title} · attempt ${entry.attempt} in ${Math.max(0, Math.ceil((entry.nextAt - now) / 1000))} s (${entry.source})`),
      ].join("\n");

  return (
    <div className="px-2 pb-1.5" data-zaicode-retry-ledger={halted ? "halted" : entries.length}>
      <button
        type="button"
        className={cn(
          "flex h-6 w-full min-w-0 items-center justify-center gap-1.5 border px-2 text-ui-xs",
          halted ? "border-border text-foreground-subtle hover:bg-hover" : "border-[var(--color-warning)] text-[var(--color-warning)] hover:bg-hover",
        )}
        title={title}
        onClick={halted ? resume : stopAll}
      >
        {halted ? <Square className="size-3 shrink-0" /> : <RotateCw className="size-3 shrink-0" />}
        <span className="truncate">
          {halted ? "AUTO-RETRY STOPPED · click to allow" : `RETRY ${entries.length} · next ${seconds} s · click to stop all`}
        </span>
      </button>
    </div>
  );
}
