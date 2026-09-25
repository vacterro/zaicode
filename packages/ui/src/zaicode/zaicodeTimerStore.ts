import { create } from "zustand";
import { setZaicodeHour12 } from "@zcode/shared";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import {
  createZaicodeTimer,
  loadZaicodeTimers,
  shiftZaicodeTimer,
  snoozeZaicodeTimer,
  ZAICODE_TIMER_DEFAULT_SOUND,
  type ZaicodeTimer,
  type ZaicodeTimerInput,
} from "./zaicodeTimers.js";
import { loadZaicodeIntervalRules, type ZaicodeIntervalRule } from "./zaicodeIntervalRules.js";
import {
  createZaicodeProductivity,
  zaicodeProductivityPersisted,
  type ZaicodeProductivityTimer,
} from "./zaicodeProductivity.js";

/**
 * Timers state: alarms + calendar events (one list, `kind` tells them apart),
 * interval reminders, the productivity timer, the Temp Timer template and the
 * title-bar clock layout. Persisted per machine; the engine
 * (useZaicodeTimerEngine) fires them.
 */

export interface ZaicodeTempTimerTemplate {
  name: string;
  description: string;
  /** Minutes added per Shift+Click / quick button. */
  incrementMinutes: number;
  deleteAfterFire: boolean;
  sound: string;
  volume: number;
  showNotification: boolean;
  showInTopBar: boolean;
}

/** What the title-bar clock shows, left to right. */
export interface ZaicodeClockPrefs {
  enabled: boolean;
  showDate: boolean;
  showTime: boolean;
  showSeconds: boolean;
  showDaypart: boolean;
  showNextTimer: boolean;
  showTempTimer: boolean;
  showProductivity: boolean;
  showInterval: boolean;
  /** Nearest subscription reset among the engines. */
  showNextReset: boolean;
  /** Countdowns keep the minute field on long waits ("4d 11h 05m"). */
  longMinutes: boolean;
  /** 12-hour clock (5:05 pm) everywhere ZAICODE shows a time of day. */
  hour12: boolean;
  showWeekday: boolean;
  showYear: boolean;
  /** ISO week number (W39). */
  showWeekNumber: boolean;
  /** Local time zone name, so a wrong zone is visible at a glance. */
  showTimeZone: boolean;
}

export const ZAICODE_TEMP_TIMER_DEFAULTS: ZaicodeTempTimerTemplate = {
  name: "Temp Timer",
  description: "",
  incrementMinutes: 15,
  deleteAfterFire: false,
  sound: ZAICODE_TIMER_DEFAULT_SOUND,
  volume: 0.5,
  showNotification: true,
  showInTopBar: true,
};

export const ZAICODE_CLOCK_DEFAULTS: ZaicodeClockPrefs = {
  enabled: true,
  showDate: true,
  showTime: true,
  showSeconds: false,
  showDaypart: true,
  showNextTimer: true,
  showTempTimer: true,
  showProductivity: true,
  showInterval: true,
  showNextReset: true,
  longMinutes: false,
  hour12: false,
  showWeekday: false,
  showYear: false,
  showWeekNumber: false,
  showTimeZone: false,
};

const TIMERS_KEY = "zaicode-timers-v1";
const PREFS_KEY = "zaicode-timer-prefs-v1";

function readJson(key: string): unknown {
  try {
    return JSON.parse(readZaicodeSetting(key) ?? "null");
  } catch {
    return null;
  }
}

function pickBooleans<T extends object>(defaults: T, raw: unknown): T {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const next = { ...defaults } as Record<string, unknown>;
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof value === "boolean" && typeof record[key] === "boolean") next[key] = record[key];
    if (typeof value === "string" && typeof record[key] === "string" && record[key]) next[key] = record[key];
    if (typeof value === "number" && typeof record[key] === "number" && Number.isFinite(record[key])) next[key] = record[key];
  }
  return next as T;
}

export function normalizeZaicodeTempTemplate(raw: unknown): ZaicodeTempTimerTemplate {
  const next = pickBooleans(ZAICODE_TEMP_TIMER_DEFAULTS, raw);
  return {
    ...next,
    incrementMinutes: Math.max(1, Math.min(24 * 60, Math.round(next.incrementMinutes))),
    volume: Math.max(0, Math.min(1, next.volume)),
  };
}

interface Persisted {
  timers: ZaicodeTimer[];
  intervalRules: ZaicodeIntervalRule[];
  productivity: ZaicodeProductivityTimer;
  temp: ZaicodeTempTimerTemplate;
  clock: ZaicodeClockPrefs;
  /** One-shot timers that fired unseen; the clock shows them red until opened. */
  missed: string[];
}

function load(): Persisted {
  const prefs = readJson(PREFS_KEY) as Record<string, unknown> | null;
  const missed = Array.isArray(prefs?.missed) ? prefs.missed.filter((id): id is string => typeof id === "string") : [];
  return {
    timers: loadZaicodeTimers(readJson(TIMERS_KEY)),
    intervalRules: loadZaicodeIntervalRules(prefs?.intervalRules),
    productivity: createZaicodeProductivity(prefs?.productivity ?? null),
    temp: normalizeZaicodeTempTemplate(prefs?.temp),
    clock: withHour12(pickBooleans(ZAICODE_CLOCK_DEFAULTS, prefs?.clock)),
    missed,
  };
}

/** Every time display formats through @zcode/shared: keep its 12/24-hour switch on the stored setting. */
function withHour12(clock: ZaicodeClockPrefs): ZaicodeClockPrefs {
  setZaicodeHour12(clock.hour12);
  return clock;
}

const lastWritten = new Map<string, string>();

/** Writes only what changed: the productivity countdown ticks every second but persists nothing new. */
function writeIfChanged(key: string, value: string): void {
  if (lastWritten.get(key) === value) return;
  lastWritten.set(key, value);
  localStorage.setItem(key, value);
}

function save(state: Persisted): void {
  try {
    writeIfChanged(TIMERS_KEY, JSON.stringify(state.timers));
    writeIfChanged(
      PREFS_KEY,
      JSON.stringify({
        intervalRules: state.intervalRules,
        productivity: zaicodeProductivityPersisted(state.productivity),
        temp: state.temp,
        clock: state.clock,
        missed: state.missed,
      }),
    );
  } catch {
    // the in-memory copy still runs this session
  }
}

interface ZaicodeTimerState extends Persisted {
  /** Bumped by the dialog opener; the dialog picks the tab. */
  dialogTab: ZaicodeTimerTab | null;
  openDialog: (tab?: ZaicodeTimerTab) => void;
  closeDialog: () => void;
  setTimers: (update: (timers: ZaicodeTimer[]) => ZaicodeTimer[]) => void;
  addTimer: (input: ZaicodeTimerInput) => ZaicodeTimer;
  updateTimer: (id: string, patch: Partial<ZaicodeTimer>) => void;
  removeTimer: (id: string) => void;
  toggleTimer: (id: string) => void;
  snoozeTimer: (id: string, minutes: number) => void;
  shiftTimer: (id: string, minutes: number) => void;
  setIntervalRules: (rules: ZaicodeIntervalRule[]) => void;
  setProductivity: (update: (timer: ZaicodeProductivityTimer) => ZaicodeProductivityTimer) => void;
  setTemp: (patch: Partial<ZaicodeTempTimerTemplate>) => void;
  setClock: (patch: Partial<ZaicodeClockPrefs>) => void;
  /** Creates or extends the one Temp Timer by `minutes` (default: the template's increment). */
  addTempTimer: (minutes?: number) => ZaicodeTimer;
  removeTempTimer: () => void;
  setMissed: (ids: string[]) => void;
}

export type ZaicodeTimerTab = "alarms" | "interval" | "temp" | "productivity" | "calendar";

export const useZaicodeTimers = create<ZaicodeTimerState>((set, get) => {
  const commit = (patch: Partial<Persisted>) => {
    set(patch);
    const state = get();
    save(state);
  };
  return {
    ...load(),
    dialogTab: null,
    openDialog: (tab = "alarms") => set({ dialogTab: tab, missed: [] }),
    closeDialog: () => set({ dialogTab: null }),
    setTimers: (update) => commit({ timers: update(get().timers) }),
    addTimer: (input) => {
      const timer = createZaicodeTimer(input);
      commit({ timers: [...get().timers, timer] });
      return timer;
    },
    updateTimer: (id, patch) =>
      commit({ timers: get().timers.map((timer) => (timer.id === id ? { ...timer, ...patch, id } : timer)) }),
    removeTimer: (id) => commit({ timers: get().timers.filter((timer) => timer.id !== id) }),
    toggleTimer: (id) =>
      commit({
        timers: get().timers.map((timer) => (timer.id === id ? { ...timer, enabled: !timer.enabled } : timer)),
      }),
    snoozeTimer: (id, minutes) =>
      commit({
        timers: get().timers.map((timer) => (timer.id === id ? snoozeZaicodeTimer(timer, minutes, Date.now()) : timer)),
        missed: get().missed.filter((missed) => missed !== id),
      }),
    shiftTimer: (id, minutes) =>
      commit({
        timers: get().timers.map((timer) => (timer.id === id ? shiftZaicodeTimer(timer, minutes, Date.now()) : timer)),
      }),
    setIntervalRules: (intervalRules) => commit({ intervalRules }),
    setProductivity: (update) => commit({ productivity: update(get().productivity) }),
    setTemp: (patch) => {
      const temp = normalizeZaicodeTempTemplate({ ...get().temp, ...patch });
      // the live Temp Timer follows its template
      const timers = get().timers.map((timer) =>
        timer.temporary
          ? {
              ...timer,
              name: temp.name,
              description: temp.description,
              sound: temp.sound,
              volume: temp.volume,
              showNotification: temp.showNotification,
              showInTopBar: temp.showInTopBar,
              deleteAfterFire: temp.deleteAfterFire,
            }
          : timer,
      );
      commit({ temp, timers });
    },
    setClock: (patch) => commit({ clock: withHour12({ ...get().clock, ...patch }) }),
    addTempTimer: (minutes) => {
      const temp = get().temp;
      const step = Math.max(1, Math.round(minutes ?? temp.incrementMinutes)) * 60_000;
      const now = Date.now();
      const existing = get().timers.find((timer) => timer.temporary);
      // Future time is extended, never replaced; a fired Temp Timer re-arms from now.
      if (existing) {
        const base = existing.fired || existing.target <= now || !existing.enabled ? now : existing.target;
        const next = { ...existing, target: base + step, fired: false, enabled: true };
        commit({ timers: get().timers.map((timer) => (timer.id === existing.id ? next : timer)) });
        return next;
      }
      const timer = createZaicodeTimer({
        name: temp.name,
        description: temp.description,
        target: now + step,
        repeat: "once",
        sound: temp.sound,
        volume: temp.volume,
        showNotification: temp.showNotification,
        showInTopBar: temp.showInTopBar,
        temporary: true,
        deleteAfterFire: temp.deleteAfterFire,
      });
      commit({ timers: [...get().timers, timer] });
      return timer;
    },
    removeTempTimer: () => commit({ timers: get().timers.filter((timer) => !timer.temporary) }),
    setMissed: (missed) => commit({ missed }),
  };
});

export function readZaicodeTempTimer(timers: readonly ZaicodeTimer[]): ZaicodeTimer | null {
  return timers.find((timer) => timer.temporary) ?? null;
}
