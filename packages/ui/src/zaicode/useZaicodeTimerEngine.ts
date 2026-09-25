import { useEffect } from "react";
import { isZaicodeProductMode } from "@zcode/shared";
import {
  chooseZaicodeTimerSound,
  collectDueZaicodeTimers,
  snoozeCloneZaicodeTimer,
  type ZaicodeTimer,
} from "./zaicodeTimers.js";
import { tickZaicodeIntervalRules } from "./zaicodeIntervalRules.js";
import { acknowledgeZaicodeProductivity, tickZaicodeProductivity } from "./zaicodeProductivity.js";
import { useZaicodeTimers } from "./zaicodeTimerStore.js";
import { notifyZaicode } from "./zaicodeNotifications.js";
import { playZaicodeSoundFile } from "./zaicodeSoundEvents.js";

const SNOOZE_CHOICES = [5, 10, 30] as const;
/** A ringing productivity alarm repeats this often until acknowledged. */
const RING_EVERY_MS = 12_000;

function fireTimer(timer: ZaicodeTimer, now: number): void {
  const choice = chooseZaicodeTimerSound(timer, new Date(now));
  if (choice) void playZaicodeSoundFile(choice.sound, { volume: choice.volume, channel: `timer:${timer.id}` });
  if (!timer.showNotification) return;
  const store = useZaicodeTimers.getState();
  notifyZaicode("timer.fire", {
    header: timer.temporary ? "Temp Timer" : timer.kind === "calendar" ? "Calendar" : "Timer",
    title: timer.name,
    body: timer.description,
    status: "Time's up",
    key: `timer:${timer.id}`,
    actions: [
      ...SNOOZE_CHOICES.map((minutes) => ({
        label: `+${minutes}m`,
        run: () => {
          const current = useZaicodeTimers.getState();
          // A repeating timer already rolled to its next occurrence: snooze a one-shot copy.
          if (timer.repeat !== "once") current.setTimers((timers) => [...timers, snoozeCloneZaicodeTimer(timer, minutes, Date.now())]);
          else if (current.timers.some((candidate) => candidate.id === timer.id)) current.snoozeTimer(timer.id, minutes);
          else current.setTimers((timers) => [...timers, { ...snoozeCloneZaicodeTimer(timer, minutes, Date.now()), temporary: timer.temporary }]);
        },
      })),
      { label: "Timers…", run: () => store.openDialog(timer.kind === "calendar" ? "calendar" : timer.temporary ? "temp" : "alarms") },
    ],
  });
}

/**
 * The 1 s heartbeat behind every timer: alarms and calendar events, interval
 * reminders and the productivity timer. Elapsed wall-clock time drives the
 * productivity phases, so a stalled window never loses a minute. Mount once.
 */
export function useZaicodeTimerEngine(): void {
  useEffect(() => {
    if (typeof window === "undefined" || !isZaicodeProductMode()) return;
    let last = Date.now();
    let lastRing = 0;
    const tick = () => {
      const now = Date.now();
      const elapsed = (now - last) / 1000;
      last = now;
      const state = useZaicodeTimers.getState();

      const due = collectDueZaicodeTimers(state.timers, now);
      if (due.fired.length > 0) {
        state.setTimers(() => due.timers);
        const unseen = document.hasFocus() ? [] : due.fired.filter((timer) => timer.repeat === "once").map((timer) => timer.id);
        if (unseen.length > 0) state.setMissed([...new Set([...state.missed, ...unseen])]);
        for (const timer of due.fired) fireTimer(timer, now);
      }

      const interval = tickZaicodeIntervalRules(state.intervalRules, new Date(now));
      if (interval.changed) state.setIntervalRules(interval.rules);
      if (interval.fire) {
        void playZaicodeSoundFile(interval.fire.sound, { volume: interval.fire.volume, channel: "interval" });
        if (interval.fire.showNotification) {
          notifyZaicode("interval.fire", { header: "Interval", title: interval.fire.name, status: "Interval reached", key: "interval" });
        }
      }

      const productivity = state.productivity;
      if (productivity.state === "running") {
        const result = tickZaicodeProductivity(productivity, elapsed);
        state.setProductivity(() => result.timer);
        for (const phase of result.ended) {
          const sound = phase === "work" ? result.timer.workSound : result.timer.breakSound;
          if (result.timer.soundEnabled) void playZaicodeSoundFile(sound, { volume: result.timer.volume, channel: "productivity" });
          lastRing = now;
          if (result.timer.showNotification) {
            notifyZaicode("productivity.phase", {
              header: "Productivity",
              title: phase === "work" ? "Work phase done" : "Break is over",
              body: phase === "work" ? (result.timer.breaksEnabled ? "Take a break." : "Press Start for the next round.") : "Back to work.",
              status: `${result.timer.completedCycles} rounds done`,
              key: "productivity",
              actions: result.timer.repeatAlarm
                ? [{ label: "Silence", run: () => useZaicodeTimers.getState().setProductivity(acknowledgeZaicodeProductivity) }]
                : [],
            });
          }
        }
      }
      const ringing = useZaicodeTimers.getState().productivity;
      if (ringing.alarmPending && ringing.repeatAlarm && ringing.soundEnabled && now - lastRing >= RING_EVERY_MS) {
        lastRing = now;
        const sound = ringing.alarmPhase === "break" ? ringing.breakSound : ringing.workSound;
        void playZaicodeSoundFile(sound, { volume: ringing.volume, channel: "productivity" });
      }
    };
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);
}
