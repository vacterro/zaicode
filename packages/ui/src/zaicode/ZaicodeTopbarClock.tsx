import { useEffect, useState } from "react";
import { effectiveZaicodeWindows, formatZaicodeTimeOfDay, zaicodeIsoWeek, zaicodeTimeZoneName } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";
import {
  describeZaicodeTimer,
  formatZaicodeRemaining,
  nextDueZaicodeTimer,
  zaicodeTimerColor,
} from "./zaicodeTimers.js";
import { zaicodeIntervalRemaining } from "./zaicodeIntervalRules.js";
import { describeZaicodeProductivity, formatZaicodeClock, toggleZaicodeProductivity } from "./zaicodeProductivity.js";
import { readZaicodeTempTimer, useZaicodeTimers, type ZaicodeClockPrefs } from "./zaicodeTimerStore.js";
import { useZaicodeEngines, visibleZaicodeAccounts } from "./zaicodeEngines.js";
import { ZaicodePrefCheck, ZaicodePrefHeading, ZaicodeRightClickSettings } from "./ZaicodePrefControls.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";

/**
 * FastPrompter's header clock in the title bar: date · time · part of day,
 * the nearest timer in its heat colour, the Temp Timer, the productivity
 * phase, an interval countdown and the nearest subscription reset.
 * Click: Timers. Shift+Click: Temp Timer +N min. Ctrl+Click: start / pause
 * the productivity timer. Right-click: what to show.
 */

const DAYPARTS: readonly [number, string][] = [
  [5, "Night"],
  [12, "Morning"],
  [17, "Day"],
  [22, "Evening"],
  [24, "Night"],
];

export function zaicodeDaypart(hour: number): string {
  return DAYPARTS.find(([until]) => hour < until)?.[1] ?? "Night";
}

/** FastPrompter's header colours for the interval reminder and the work / break timer. */
export const ZAICODE_CLOCK_INTERVAL_COLOR = "#7fae7f";

export function zaicodeProductivityColor(timer: { phase: string; state: string; alarmPending: boolean }): string {
  if (timer.alarmPending) return "#e05555";
  if (timer.state === "paused") return "#888888";
  return timer.phase === "work" ? "#6aa9ff" : "#e0a03c";
}

export interface ZaicodeNextReset {
  accountShort: string;
  accountLabel: string;
  vendor: string;
  windowLabel: string;
  at: number;
}

/** Nearest moment any subscription window refills (only windows that are not full). */
export function useZaicodeNextReset(now: number): ZaicodeNextReset | null {
  const engines = useZaicodeEngines();
  let best: ZaicodeNextReset | null = null;
  for (const account of visibleZaicodeAccounts(engines)) {
    const snapshot = engines.limits[account.id];
    if (!snapshot) continue;
    for (const window of effectiveZaicodeWindows(snapshot.windows, now)) {
      if (window.resetsAt === null || window.resetsAt <= now) continue;
      if (window.remainingPercent === null || window.remainingPercent >= 100) continue;
      if (!best || window.resetsAt < best.at) {
        best = { accountShort: account.short, accountLabel: account.label, vendor: account.vendor, windowLabel: window.label, at: window.resetsAt };
      }
    }
  }
  return best;
}

/** Clock options (right-click the clock, or Settings -> Timers). */
export function ZaicodeClockSettingsPanel() {
  const clock = useZaicodeTimers((state) => state.clock);
  const setClock = useZaicodeTimers((state) => state.setClock);
  const row = (key: keyof ZaicodeClockPrefs, label: string, hint?: string) => (
    <ZaicodePrefCheck key={key} checked={clock[key]} onChange={(value) => setClock({ [key]: value })} label={label} {...(hint ? { hint } : {})} />
  );
  return (
    <>
      {row("enabled", "Show the clock in the title bar")}
      <ZaicodePrefHeading>CLOCK</ZaicodePrefHeading>
      {row("showDate", "Date (25 Sep)")}
      {row("showWeekday", "Day of the week (Fri)")}
      {row("showYear", "Year (25 Sep 2026)")}
      {row("showWeekNumber", "Week number (W39, ISO)")}
      {row("showTime", "Time")}
      {row("hour12", "12-hour clock (5:05 pm)", "Every time ZAICODE shows: clock, timers, limit resets")}
      {row("showSeconds", "Seconds")}
      {row("showTimeZone", "Time zone (EEST / GMT+3)", "Shows at a glance when the app runs in a zone other than yours")}
      {row("showDaypart", "Part of day (Morning / Day / Evening / Night)")}
      <ZaicodePrefHeading>COUNTDOWNS</ZaicodePrefHeading>
      {row("showNextTimer", "Nearest timer / alarm", "In its heat colour: blue far away, red minutes away")}
      {row("showTempTimer", "Temp Timer")}
      {row("showProductivity", "Productivity (work / break)")}
      {row("showInterval", "Interval reminder", "Rules with “Show in top bar”")}
      {row("showNextReset", "Nearest subscription reset (own timer)", "Its own title-bar timer; hover lists every coming reset (FastPrompter's Nearest resets)")}
      {row("longMinutes", "Keep minutes on long waits (4d 11h 05m)")}
    </>
  );
}

export function ZaicodeTopbarClock({ useWindowsCaptionSpacing = false }: { useWindowsCaptionSpacing?: boolean }) {
  const store = useZaicodeTimers();
  const clock = store.clock;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const nextReset = useZaicodeNextReset(now);
  if (!clock.enabled) return null;

  const date = new Date(now);
  const temp = readZaicodeTempTimer(store.timers);
  const next = nextDueZaicodeTimer(store.timers.filter((timer) => !timer.temporary), { topBarOnly: true });
  const productivity = store.productivity;
  const intervalRule = store.intervalRules
    .map((rule) => ({ rule, remaining: zaicodeIntervalRemaining(rule, date) }))
    .find((entry) => entry.remaining !== null);
  const format = (seconds: number) => formatZaicodeRemaining(seconds, { minutes: clock.longMinutes });
  const missed = store.missed.length > 0;

  const time = clock.showTime ? formatZaicodeTimeOfDay(date, { seconds: clock.showSeconds, hour12: clock.hour12 }) : "";
  const dateText = clock.showDate
    ? date.toLocaleDateString("en-GB", {
        ...(clock.showWeekday ? { weekday: "short" as const } : {}),
        day: "numeric",
        month: "short",
        ...(clock.showYear ? { year: "numeric" as const } : {}),
      })
    : clock.showWeekday
      ? date.toLocaleDateString("en-GB", { weekday: "short" })
      : "";
  const zone = zaicodeTimeZoneName(date);
  const head = [
    dateText,
    clock.showWeekNumber ? `W${zaicodeIsoWeek(date)}` : "",
    time,
    clock.showTimeZone ? zone : "",
    clock.showDaypart ? zaicodeDaypart(date.getHours()) : "",
  ].filter(Boolean);

  const tip = [
    `${date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} · ${formatZaicodeTimeOfDay(date, { seconds: true, hour12: clock.hour12 })} · week ${zaicodeIsoWeek(date)}`,
    `Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}${zone ? ` (${zone})` : ""}`,
    next ? `Next: ${describeZaicodeTimer(next, now)}` : "No timer set",
    temp ? `Temp Timer: ${temp.fired ? "done" : format((temp.target - now) / 1000)}` : "",
    productivity.state !== "idle" ? `Productivity: ${describeZaicodeProductivity(productivity)}` : "",
    intervalRule ? `${intervalRule.rule.name}: ${format(intervalRule.remaining ?? 0)}` : "",
    nextReset ? `Next reset: ${nextReset.accountLabel} ${nextReset.windowLabel} in ${format((nextReset.at - now) / 1000)}` : "",
    missed ? `${store.missed.length} alarm(s) went off while you were away` : "",
  ].filter(Boolean);
  tip.push("", `Click: Timers · Shift+Click: Temp Timer +${store.temp.incrementMinutes}m · Ctrl+Click: work / break start-pause · Right-click: what to show`);

  return (
    <ZaicodeRightClickSettings title="Title-bar clock" panel={<ZaicodeClockSettingsPanel />} align="end">
      <button
        type="button"
        data-zaicode-clock
        title={tip.join("\n")}
        className={cn(
          "flex h-8 shrink-0 items-center gap-2 px-1.5 text-ui-xs tabular-nums text-foreground-subtle hover:bg-hover",
          missed && "outline outline-1 outline-[#ff7b6b]",
          useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
        )}
        onClick={(event) => {
          if (event.shiftKey) {
            store.addTempTimer();
            playZaicodeSound("ui.toggle");
            return;
          }
          if (event.ctrlKey || event.metaKey) {
            store.setProductivity(toggleZaicodeProductivity);
            playZaicodeSound("ui.toggle");
            return;
          }
          store.openDialog("alarms");
        }}
      >
        {missed ? <span className="text-[#ff7b6b]">!</span> : null}
        {head.length > 0 ? <span className="text-foreground">{head.join(" · ")}</span> : null}
        {clock.showNextTimer && next ? (
          <span className="font-semibold" style={{ color: zaicodeTimerColor(next, now) }}>
            {format((next.target - now) / 1000)}
          </span>
        ) : null}
        {clock.showTempTimer && temp && temp.showInTopBar ? (
          <span className="font-semibold" style={{ color: temp.fired ? "#ff7b6b" : zaicodeTimerColor(temp, now) }}>
            ⟲ {temp.fired ? "done" : format((temp.target - now) / 1000)}
          </span>
        ) : null}
        {clock.showProductivity && productivity.showInTopBar && productivity.state !== "idle" ? (
          <span className="font-semibold" style={{ color: zaicodeProductivityColor(productivity) }}>
            {formatZaicodeClock(productivity.remaining)} {productivity.phase}
            {productivity.state === "paused" ? " ॥" : ""}
          </span>
        ) : null}
        {clock.showInterval && intervalRule ? (
          <span className="font-semibold" style={{ color: ZAICODE_CLOCK_INTERVAL_COLOR }}>
            ↻ {format(intervalRule.remaining ?? 0)}
          </span>
        ) : null}
      </button>
    </ZaicodeRightClickSettings>
  );
}
