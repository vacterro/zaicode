import { Button } from "@/components/ui/button.js";
import { ZaicodeClockSettingsPanel } from "@/zaicode/ZaicodeTopbarClock.js";
import { ZaicodeTimersPanel } from "@/zaicode/ZaicodeTimersDialog.js";
import { useZaicodeTimers } from "@/zaicode/zaicodeTimerStore.js";

/**
 * Settings -> Timers: the same tabs as the Timers window (alarms, interval
 * reminders, Temp Timer, productivity, calendar) plus what the title-bar
 * clock shows.
 */
export function ZaicodeTimersSettings() {
  const openDialog = useZaicodeTimers((state) => state.openDialog);
  return (
    <div className="flex flex-col gap-4 text-ui-xs" data-zaicode-timers-settings>
      <section className="flex flex-col gap-2 border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-ui-lg text-foreground">Timers</h2>
            <p className="mt-1 max-w-[580px] text-foreground-subtle">
              Alarms, repeating reminders, a quick Temp Timer, work / break phases and calendar events — FastPrompter&apos;s
              timers. They ring with their own sound, show a card (Settings → Notifications) and count down in the title
              bar clock. Everything saves as you type.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => openDialog("alarms")}>
            Open as a window
          </Button>
        </div>
        <ZaicodeTimersPanel />
      </section>
      <section className="flex max-w-[480px] flex-col gap-1.5 border border-border bg-card p-4">
        <h2 className="text-ui-lg text-foreground">Title-bar clock</h2>
        <p className="text-foreground-subtle">
          Click the clock: Timers · Shift+Click: Temp Timer +N min · Ctrl+Click: start / pause work · right-click: this list.
        </p>
        <ZaicodeClockSettingsPanel />
      </section>
    </div>
  );
}
