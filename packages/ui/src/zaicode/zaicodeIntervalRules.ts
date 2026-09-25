import { healZaicodeVolume } from "./zaicodeTimers.js";

/**
 * Interval notifications (FastPrompter's hourly chime rules): a sound every N
 * minutes, either on the clock boundary (:00, :30, ...) or N minutes after the
 * last one, optionally only inside active hours. Several rules may collide on
 * one boundary: the topmost fires, the others are marked as done for that tick.
 */

export type ZaicodeIntervalAlign = "clock" | "elapsed";

export interface ZaicodeIntervalRule {
  id: string;
  name: string;
  minutes: number;
  enabled: boolean;
  sound: string;
  volume: number;
  showNotification: boolean;
  showInTopBar: boolean;
  alignMode: ZaicodeIntervalAlign;
  allDay: boolean;
  /** Minute of day, inclusive bounds; a window past midnight wraps. */
  startMinute: number;
  endMinute: number;
  /** Epoch ms of the last fire (elapsed mode). */
  lastFired: number;
  /** "YYYY-MM-DD HH:MM" of the last clock-boundary fire (dedup per minute). */
  lastFiredMinute: string;
}

const fp = (file: string) => `fastprompter:${file}`;

export const ZAICODE_INTERVAL_DEFAULT_RULE: ZaicodeIntervalRule = {
  id: "interval_default_1",
  name: "Hourly Reminder",
  minutes: 60,
  enabled: false,
  sound: fp("NEWDAY.wav"),
  volume: 0.3,
  showNotification: false,
  showInTopBar: false,
  alignMode: "clock",
  allDay: true,
  startMinute: 0,
  endMinute: 1439,
  lastFired: 0,
  lastFiredMinute: "",
};

let counter = 0;
function newId(): string {
  counter += 1;
  return `interval_${Date.now().toString(36)}${counter}`;
}

function flag(value: unknown, fallback: boolean): boolean {
  if (typeof value === "string") return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
  return typeof value === "boolean" ? value : fallback;
}

function minute(value: unknown, fallback: number): number {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? Math.max(0, Math.min(1439, number)) : fallback;
}

export function healZaicodeIntervalRule(raw: unknown): ZaicodeIntervalRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const minutes = Math.trunc(Number(r.minutes));
  const lastFired = Number(r.lastFired);
  return {
    id: typeof r.id === "string" && r.id ? r.id : newId(),
    name: typeof r.name === "string" && r.name ? r.name : "Interval",
    minutes: Number.isFinite(minutes) ? Math.max(1, minutes) : 60,
    enabled: flag(r.enabled, true),
    sound: typeof r.sound === "string" && r.sound ? r.sound : ZAICODE_INTERVAL_DEFAULT_RULE.sound,
    volume: healZaicodeVolume(r.volume) ?? 0.5,
    showNotification: flag(r.showNotification, false),
    showInTopBar: flag(r.showInTopBar, false),
    alignMode: r.alignMode === "elapsed" ? "elapsed" : "clock",
    allDay: flag(r.allDay, true),
    startMinute: minute(r.startMinute, 0),
    endMinute: minute(r.endMinute, 1439),
    lastFired: Number.isFinite(lastFired) ? lastFired : 0,
    lastFiredMinute: typeof r.lastFiredMinute === "string" ? r.lastFiredMinute : "",
  };
}

/** Healed list; non-objects dropped, duplicate ids collapsed (first wins). */
export function loadZaicodeIntervalRules(raw: unknown): ZaicodeIntervalRule[] {
  if (!Array.isArray(raw)) return [{ ...ZAICODE_INTERVAL_DEFAULT_RULE }];
  const seen = new Set<string>();
  const out: ZaicodeIntervalRule[] = [];
  for (const entry of raw) {
    const rule = healZaicodeIntervalRule(entry);
    if (!rule || seen.has(rule.id)) continue;
    seen.add(rule.id);
    out.push(rule);
  }
  return out;
}

function inActiveHours(rule: ZaicodeIntervalRule, minuteOfDay: number): boolean {
  if (rule.allDay) return true;
  if (rule.startMinute <= rule.endMinute) return minuteOfDay >= rule.startMinute && minuteOfDay <= rule.endMinute;
  return minuteOfDay >= rule.startMinute || minuteOfDay <= rule.endMinute;
}

function minuteKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Runs one 1 s tick: returns the rule to fire (topmost of the colliding ones,
 * or null) and the rules with their last-fired marks updated. Clock rules fire
 * on the minute crossing, not on second 0, so a late tick still catches the
 * boundary exactly once.
 */
export function tickZaicodeIntervalRules(
  rules: readonly ZaicodeIntervalRule[],
  now: Date,
): { fire: ZaicodeIntervalRule | null; rules: ZaicodeIntervalRule[]; changed: boolean } {
  const nowMs = now.getTime();
  const key = minuteKey(now);
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  let changed = false;
  let fire: ZaicodeIntervalRule | null = null;
  const next = rules.map((rule) => {
    if (!rule.enabled || !inActiveHours(rule, minuteOfDay)) return rule;
    if (rule.alignMode === "elapsed") {
      if (rule.lastFired <= 0) {
        changed = true;
        return { ...rule, lastFired: nowMs };
      }
      if (nowMs - rule.lastFired < rule.minutes * 60_000) return rule;
      changed = true;
      const updated = { ...rule, lastFired: nowMs };
      fire ??= updated;
      return updated;
    }
    const boundary = rule.minutes <= 1440 ? minuteOfDay % rule.minutes === 0 : minuteOfDay === 0;
    if (!boundary || rule.lastFiredMinute === key) return rule;
    changed = true;
    const updated = { ...rule, lastFired: nowMs, lastFiredMinute: key };
    fire ??= updated;
    return updated;
  });
  return { fire, rules: next, changed };
}

/** Seconds to the next eligible occurrence, or null when it must not show in the top bar. */
export function zaicodeIntervalRemaining(rule: ZaicodeIntervalRule, now: Date): number | null {
  if (!rule.enabled || !rule.showInTopBar) return null;
  if (rule.alignMode === "elapsed") {
    if (rule.lastFired <= 0) return rule.minutes * 60;
    return Math.max(0, (rule.lastFired + rule.minutes * 60_000 - now.getTime()) / 1000);
  }
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  let nextMinute: number;
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (rule.minutes <= 1440) {
    nextMinute = (Math.floor(minuteOfDay / rule.minutes) + 1) * rule.minutes;
  } else {
    nextMinute = 1440;
  }
  if (nextMinute >= 1440) {
    day.setDate(day.getDate() + 1);
    nextMinute %= 1440;
  }
  // an occurrence outside the active hours is impossible: never advertise it
  if (!inActiveHours(rule, nextMinute)) return null;
  day.setHours(Math.floor(nextMinute / 60), nextMinute % 60, 0, 0);
  return Math.max(0, (day.getTime() - now.getTime()) / 1000);
}

/** FastPrompter's Presets… menu. */
export const ZAICODE_INTERVAL_PRESETS: readonly { id: string; label: string; rules: () => ZaicodeIntervalRule[] }[] = [
  {
    id: "chime",
    label: "24h Chime (Genie / NewDay / Owl)",
    rules: () =>
      [
        { name: "Noon (12:00)", sound: fp("GENIE.wav"), allDay: false, startMinute: 720, endMinute: 779 },
        { name: "Morning (07:00 - 11:00)", sound: fp("NEWDAY.wav"), allDay: false, startMinute: 420, endMinute: 719 },
        { name: "Day & Evening (13:00 - 21:00)", sound: fp("NEWDAY.wav"), allDay: false, startMinute: 780, endMinute: 1319 },
        { name: "Night (22:00 - 06:00)", sound: fp("alert_owl2.wav"), allDay: false, startMinute: 1320, endMinute: 419 },
      ].map((rule) => ({ ...ZAICODE_INTERVAL_DEFAULT_RULE, ...rule, id: newId(), enabled: true, volume: 0.05, showNotification: true })),
  },
  {
    id: "workday",
    label: "Workday Hours (09:00 - 18:00)",
    rules: () => [
      { ...ZAICODE_INTERVAL_DEFAULT_RULE, id: newId(), name: "Workday (09:00 - 18:00)", enabled: true, volume: 0.05, showNotification: true, allDay: false, startMinute: 540, endMinute: 1079 },
    ],
  },
  {
    id: "hourly",
    label: "Hourly Bell (24/7)",
    rules: () => [
      { ...ZAICODE_INTERVAL_DEFAULT_RULE, id: newId(), name: "Hourly Bell (24/7)", enabled: true, volume: 0.05, showNotification: true },
    ],
  },
  {
    id: "pomodoro",
    label: "Pomodoro Focus (every 25 m)",
    rules: () => [
      { ...ZAICODE_INTERVAL_DEFAULT_RULE, id: newId(), name: "Pomodoro Focus (25m)", minutes: 25, enabled: true, sound: fp("QUEST.wav"), volume: 0.05, showNotification: true, showInTopBar: true, alignMode: "elapsed" },
    ],
  },
  {
    id: "night",
    label: "Night Owl (22:00 - 06:00)",
    rules: () => [
      { ...ZAICODE_INTERVAL_DEFAULT_RULE, id: newId(), name: "Night Owl (22:00 - 06:00)", enabled: true, sound: fp("alert_owl2.wav"), volume: 0.05, showNotification: true, allDay: false, startMinute: 1320, endMinute: 419 },
    ],
  },
];

export function newZaicodeIntervalRule(): ZaicodeIntervalRule {
  return { ...ZAICODE_INTERVAL_DEFAULT_RULE, id: newId(), name: "Every New Hour", enabled: true };
}
