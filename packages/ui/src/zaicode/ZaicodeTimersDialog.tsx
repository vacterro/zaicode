import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZaicodeTimers, type ZaicodeTimerTab } from "./zaicodeTimerStore.js";
import { ZaicodeAlarmsTab, ZaicodeCalendarTab } from "./ZaicodeTimersAlarms.js";
import { ZaicodeIntervalTab, ZaicodeProductivityTab, ZaicodeTempTab } from "./ZaicodeTimersOther.js";

/** FastPrompter's Timers window, tab for tab. */

const TABS: readonly { id: ZaicodeTimerTab; label: string; hint: string }[] = [
  { id: "alarms", label: "Alarms", hint: "One-off and repeating alarms, limit resets" },
  { id: "interval", label: "Interval reminders", hint: "A sound every N minutes, on the clock or elapsed" },
  { id: "temp", label: "Temp Timer", hint: "One quick countdown; Shift+Click the clock adds to it" },
  { id: "productivity", label: "Productivity", hint: "Work / break phases" },
  { id: "calendar", label: "Calendar", hint: "Events by date, with markers" },
];

export function ZaicodeTimersPanel({ initialTab = "alarms" }: { initialTab?: ZaicodeTimerTab }) {
  const [tab, setTab] = useState<ZaicodeTimerTab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  return (
    <div className="flex min-h-0 flex-col gap-2 text-ui-xs text-foreground" data-zaicode-timers>
      <div className="flex flex-wrap gap-px border-b border-border" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            title={entry.hint}
            className={cn(
              "-mb-px border border-b-0 px-2 py-0.5",
              tab === entry.id
                ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-card text-foreground"
                : "border-transparent text-foreground-subtle hover:text-foreground",
            )}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 overflow-y-auto">
        {tab === "alarms" ? <ZaicodeAlarmsTab /> : null}
        {tab === "interval" ? <ZaicodeIntervalTab /> : null}
        {tab === "temp" ? <ZaicodeTempTab /> : null}
        {tab === "productivity" ? <ZaicodeProductivityTab /> : null}
        {tab === "calendar" ? <ZaicodeCalendarTab /> : null}
      </div>
    </div>
  );
}

/** The floating Timers window, opened from the clock, a hotkey or a notification. Mount once. */
export function ZaicodeTimersWindow() {
  const tab = useZaicodeTimers((state) => state.dialogTab);
  const close = useZaicodeTimers((state) => state.closeDialog);
  useEffect(() => {
    if (!tab) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Esc inside an open sound picker closes only the picker.
      if (event.key === "Escape" && !document.querySelector("[data-slot='popover-content']")) close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, tab]);
  if (!tab || typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div
        role="dialog"
        aria-label="Timers"
        className="flex max-h-[92vh] w-[min(780px,96vw)] flex-col border border-[var(--zaicode-highlight,var(--color-border-hover))] bg-background text-foreground"
      >
        <div className="flex items-center justify-between border-b border-border bg-card px-2 py-1">
          <span className="text-ui-sm text-foreground">Timers</span>
          <span className="text-ui-xs text-foreground-subtlest">Esc closes · everything saves as you type</span>
          <button type="button" aria-label="Close" className="flex size-5 items-center justify-center text-foreground-subtle hover:bg-hover" onClick={close}>
            <X className="size-3.5" />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto p-2">
          <ZaicodeTimersPanel initialTab={tab} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
