/* eslint-disable max-lines -- FastPrompter timers.py ported rule for rule; the scheduling rules share private helpers and stay one owner module. */
/**
 * Timers (FastPrompter's timers.py, ported rule for rule). A timer is a name
 * plus an absolute local moment, optionally repeating, with its own sound and
 * colour. Pure: no React, no storage, so every scheduling rule is testable.
 *
 * Colour has two modes: `static` (one colour) and `temperature` (cool while
 * the wait is long, warming as it closes in).
 */
import { formatZaicodeTimeOfDay } from "@zcode/shared";

export type ZaicodeTimerRepeat = "once" | "interval" | "daily" | "weekly" | "monthly" | "yearly";
export const ZAICODE_TIMER_REPEATS: readonly ZaicodeTimerRepeat[] = [
  "once",
  "interval",
  "daily",
  "weekly",
  "monthly",
  "yearly",
];
export type ZaicodeTimerKind = "alarm" | "calendar";
export type ZaicodeTimerColorMode = "static" | "temperature";
export type ZaicodeTimerSoundMode = "single" | "pool";

export const ZAICODE_TIMER_DEFAULT_INTERVAL_MINUTES = 5 * 60;
export const ZAICODE_TIMER_DEFAULT_COLOR = "#6aa9ff";
export const ZAICODE_TIMER_MAX_SOUND_RULES = 10;
export const ZAICODE_TIMER_DEFAULT_SOUND = "fastprompter:tick_on.wav";

/** One row of a random sound pool, active inside a daily time window. */
export interface ZaicodeTimerSoundRule {
  sound: string;
  enabled: boolean;
  allDay: boolean;
  /** Minute of day, 0..1439. */
  startMinute: number;
  endMinute: number;
  /** 0..1, or null = the timer's own volume. */
  volume: number | null;
}

export interface ZaicodeTimer {
  id: string;
  name: string;
  description: string;
  /** Absolute moment, epoch ms. */
  target: number;
  repeat: ZaicodeTimerRepeat;
  sound: string;
  /** 0..1 */
  volume: number;
  colorMode: ZaicodeTimerColorMode;
  color: string;
  enabled: boolean;
  fired: boolean;
  intervalMinutes: number;
  kind: ZaicodeTimerKind;
  showNotification: boolean;
  showInTopBar: boolean;
  /** Recurrence anchor date, YYYY-MM-DD (the day the series started). */
  repeatAnchor: string;
  soundMode: ZaicodeTimerSoundMode;
  soundRules: ZaicodeTimerSoundRule[];
  /** The one Temp Timer (Shift+Click on the clock adds to it). */
  temporary: boolean;
  deleteAfterFire: boolean;
}

const TEMPERATURE_STOPS: readonly (readonly [number, string])[] = [
  [24 * 3600, "#4a90d9"],
  [6 * 3600, "#46b98a"],
  [2 * 3600, "#d9c04a"],
  [30 * 60, "#e08a3c"],
  [0, "#e05555"],
];

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [0, 2, 4].map((index) => Number.parseInt(clean.slice(index, index + 2), 16) || 0) as [
    number,
    number,
    number,
  ];
}

export function blendZaicodeHex(from: string, to: string, t: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const k = Math.max(0, Math.min(1, t));
  return `#${a
    .map((value, index) => Math.round(value + (b[index]! - value) * k).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Blue a day out, green hours out, yellow soon, orange very soon, red minutes out. */
export function zaicodeTemperatureColor(remainingSeconds: number): string {
  const rem = Math.max(0, remainingSeconds);
  if (rem >= TEMPERATURE_STOPS[0]![0]) return TEMPERATURE_STOPS[0]![1];
  for (let index = 0; index < TEMPERATURE_STOPS.length - 1; index += 1) {
    const [hiS, hiC] = TEMPERATURE_STOPS[index]!;
    const [loS, loC] = TEMPERATURE_STOPS[index + 1]!;
    if (rem <= hiS && rem >= loS) {
      const span = hiS - loS;
      return blendZaicodeHex(hiC, loC, span <= 0 ? 0 : (hiS - rem) / span);
    }
  }
  return TEMPERATURE_STOPS[TEMPERATURE_STOPS.length - 1]![1];
}

// ---------------------------------------------------------------------------
// Healing: persisted data never takes the list down
// ---------------------------------------------------------------------------

function healBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "true" || text === "1") return true;
    if (text === "false" || text === "0") return false;
    return fallback;
  }
  if (value === 0 || value === 1) return value === 1;
  return fallback;
}

/** 0..1; the legacy integer scale 0..10 is divided by ten; null stays null. */
export function healZaicodeVolume(raw: unknown): number | null {
  if (raw === null || raw === undefined || typeof raw === "boolean") return null;
  const value = typeof raw === "string" ? Number(raw.trim()) : typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(value)) return null;
  if (value > 1 && value <= 10 && Number.isInteger(value)) return value / 10;
  return Math.max(0, Math.min(1, value));
}

function clampMinute(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1439, Math.trunc(number))) : fallback;
}

export function healZaicodeSoundRules(raw: unknown): ZaicodeTimerSoundRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: ZaicodeTimerSoundRule[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.sound !== "string" || !record.sound) continue;
    rules.push({
      sound: record.sound,
      enabled: healBool(record.enabled, true),
      allDay: healBool(record.allDay, true),
      startMinute: clampMinute(record.startMinute, 0),
      endMinute: clampMinute(record.endMinute, 0),
      volume: healZaicodeVolume(record.volume),
    });
    if (rules.length >= ZAICODE_TIMER_MAX_SOUND_RULES) break;
  }
  return rules;
}

export function zaicodeDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDateKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getMonth() === Number(match[2]) - 1 ? date : null;
}

let idCounter = 0;
export function createZaicodeTimerId(): string {
  idCounter += 1;
  return `${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export type ZaicodeTimerInput = Partial<ZaicodeTimer> & { name?: string; target: number };

/** A complete timer from partial fields, with FastPrompter's defaults. */
export function createZaicodeTimer(input: ZaicodeTimerInput): ZaicodeTimer {
  const healed = healZaicodeTimer({ ...input, id: input.id ?? createZaicodeTimerId() });
  if (!healed) throw new Error("A timer needs a valid target moment.");
  return healed;
}

/** Returns null for anything malformed: a corrupt entry must not take the list down. */
export function healZaicodeTimer(raw: unknown): ZaicodeTimer | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const target = typeof record.target === "number" ? record.target : Number.NaN;
  if (!Number.isFinite(target)) return null;
  if (record.name !== undefined && typeof record.name !== "string") return null;
  const repeat = ZAICODE_TIMER_REPEATS.includes(record.repeat as ZaicodeTimerRepeat)
    ? (record.repeat as ZaicodeTimerRepeat)
    : "once";
  const interval = Number(record.intervalMinutes);
  const anchor =
    typeof record.repeatAnchor === "string" && parseDateKey(record.repeatAnchor)
      ? record.repeatAnchor
      : zaicodeDateKey(new Date(target));
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id : createZaicodeTimerId(),
    name: (typeof record.name === "string" ? record.name.trim() : "") || "Timer",
    description: typeof record.description === "string" ? record.description.trim() : "",
    target,
    repeat,
    sound: typeof record.sound === "string" && record.sound ? record.sound : ZAICODE_TIMER_DEFAULT_SOUND,
    volume: healZaicodeVolume(record.volume) ?? 0.5,
    colorMode: record.colorMode === "static" ? "static" : "temperature",
    color: typeof record.color === "string" && /^#[0-9a-f]{6}$/i.test(record.color) ? record.color : ZAICODE_TIMER_DEFAULT_COLOR,
    enabled: healBool(record.enabled, true),
    fired: healBool(record.fired, false),
    // a zero or negative period would make advance() spin forever
    intervalMinutes: Number.isFinite(interval) ? Math.max(1, Math.trunc(interval)) : ZAICODE_TIMER_DEFAULT_INTERVAL_MINUTES,
    kind: record.kind === "calendar" ? "calendar" : "alarm",
    showNotification: healBool(record.showNotification, true),
    showInTopBar: healBool(record.showInTopBar, true),
    repeatAnchor: anchor,
    soundMode: record.soundMode === "pool" ? "pool" : "single",
    soundRules: healZaicodeSoundRules(record.soundRules),
    temporary: healBool(record.temporary, false),
    deleteAfterFire: healBool(record.deleteAfterFire, false),
  };
}

/** Parses the stored list; duplicate or empty ids get a fresh one, content is kept. */
export function loadZaicodeTimers(raw: unknown): ZaicodeTimer[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ZaicodeTimer[] = [];
  for (const entry of raw) {
    const timer = healZaicodeTimer(entry);
    if (!timer) continue;
    if (seen.has(timer.id)) timer.id = createZaicodeTimerId();
    seen.add(timer.id);
    out.push(timer);
  }
  return out;
}

// ---------------------------------------------------------------------------
// State and scheduling
// ---------------------------------------------------------------------------

export function zaicodeTimerRemaining(timer: ZaicodeTimer, now: number): number {
  return (timer.target - now) / 1000;
}

export function isZaicodeTimerDue(timer: ZaicodeTimer, now: number): boolean {
  return timer.enabled && !timer.fired && timer.target <= now;
}

export function zaicodeTimerColor(timer: ZaicodeTimer, now: number): string {
  return timer.colorMode === "static" ? timer.color : zaicodeTemperatureColor(zaicodeTimerRemaining(timer, now));
}

/**
 * Push the timer back, always LATER: a fired alarm rings again in N minutes,
 * one still counting down gets N minutes on top of its target (resetting it to
 * now+N would drag a timer due in two hours to ten minutes away).
 */
export function snoozeZaicodeTimer(timer: ZaicodeTimer, minutes: number, now: number): ZaicodeTimer {
  const step = Math.max(1, Math.trunc(minutes) || 10) * 60_000;
  return { ...timer, target: Math.max(timer.target, now) + step, fired: false, enabled: true };
}

/** Moves the target by +-minutes, whatever now is. */
export function shiftZaicodeTimer(timer: ZaicodeTimer, minutes: number, now: number): ZaicodeTimer {
  const target = timer.target + Math.trunc(minutes) * 60_000;
  return { ...timer, target, fired: target > now ? false : timer.fired };
}

function anchorDate(timer: ZaicodeTimer): Date {
  const anchor = parseDateKey(timer.repeatAnchor);
  if (anchor) return anchor;
  const target = new Date(timer.target);
  return new Date(target.getFullYear(), target.getMonth(), target.getDate());
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function nextMonthlyAfter(timer: ZaicodeTimer, after: number): number {
  const anchor = anchorDate(timer);
  const target = new Date(timer.target);
  const afterDate = new Date(after);
  const anchorIndex = anchor.getFullYear() * 12 + anchor.getMonth();
  let k = Math.max(0, afterDate.getFullYear() * 12 + afterDate.getMonth() - anchorIndex);
  for (;;) {
    const index = anchorIndex + k;
    const year = Math.floor(index / 12);
    const month = index % 12;
    const day = Math.min(anchor.getDate(), daysInMonth(year, month));
    const candidate = new Date(year, month, day, target.getHours(), target.getMinutes(), target.getSeconds()).getTime();
    if (candidate > after) return candidate;
    k += 1;
  }
}

function nextYearlyAfter(timer: ZaicodeTimer, after: number): number {
  const anchor = anchorDate(timer);
  const target = new Date(timer.target);
  for (let k = 0; k < 4000; k += 1) {
    const year = anchor.getFullYear() + k;
    const day = Math.min(anchor.getDate(), daysInMonth(year, anchor.getMonth()));
    const candidate = new Date(year, anchor.getMonth(), day, target.getHours(), target.getMinutes(), target.getSeconds()).getTime();
    if (candidate > after) return candidate;
  }
  return after + 366 * 86_400_000;
}

/** Adds whole calendar days in local time (DST-safe, unlike +86 400 000). */
function addLocalDays(epoch: number, days: number): number {
  const date = new Date(epoch);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/**
 * Rolls a repeating timer to its next occurrence strictly after `now`. Loops
 * rather than adding one period: after a week closed, a daily timer lands in
 * the future and does not fire once per missed day. A one-shot becomes fired.
 */
export function advanceZaicodeTimer(timer: ZaicodeTimer, now: number): ZaicodeTimer {
  if (timer.repeat === "once") return { ...timer, fired: true };
  if (timer.repeat === "monthly" || timer.repeat === "yearly") {
    if (timer.target > now) return { ...timer, fired: false };
    const next = timer.repeat === "monthly" ? nextMonthlyAfter : nextYearlyAfter;
    let target = next(timer, timer.target);
    while (target <= now) target = next(timer, target);
    return { ...timer, target, fired: false };
  }
  let target = timer.target;
  if (timer.repeat === "interval") {
    const step = Math.max(1, timer.intervalMinutes) * 60_000;
    if (target <= now) target += Math.ceil((now - target + 1) / step) * step;
  } else {
    const days = timer.repeat === "weekly" ? 7 : 1;
    while (target <= now) target = addLocalDays(target, days);
  }
  return { ...timer, target, fired: false };
}

/** A one-shot copy for THIS occurrence of a fired repeating timer; the series stays on schedule. */
export function snoozeCloneZaicodeTimer(timer: ZaicodeTimer, minutes: number, now: number): ZaicodeTimer {
  return createZaicodeTimer({
    ...timer,
    id: createZaicodeTimerId(),
    target: now + Math.max(1, Math.trunc(minutes) || 10) * 60_000,
    repeat: "once",
    enabled: true,
    fired: false,
    temporary: false,
    deleteAfterFire: true,
    soundRules: timer.soundRules.map((rule) => ({ ...rule })),
  });
}

/** Every timer that came due, with repeats already rolled past now. */
export function collectDueZaicodeTimers(
  timers: readonly ZaicodeTimer[],
  now: number,
): { fired: ZaicodeTimer[]; timers: ZaicodeTimer[] } {
  const fired: ZaicodeTimer[] = [];
  const next: ZaicodeTimer[] = [];
  for (const timer of timers) {
    if (!isZaicodeTimerDue(timer, now)) {
      next.push(timer);
      continue;
    }
    fired.push(timer);
    if (timer.repeat === "once" && timer.deleteAfterFire) continue;
    next.push(advanceZaicodeTimer(timer, now));
  }
  return { fired, timers: next };
}

/** The soonest live timer (the one worth showing); `topBarOnly` skips hidden ones. */
export function nextDueZaicodeTimer(
  timers: readonly ZaicodeTimer[],
  options: { topBarOnly?: boolean } = {},
): ZaicodeTimer | null {
  let best: ZaicodeTimer | null = null;
  for (const timer of timers) {
    if (!timer.enabled || timer.fired) continue;
    if (options.topBarOnly && !timer.showInTopBar) continue;
    if (!best || timer.target < best.target) best = timer;
  }
  return best;
}

/** "4d 11h", "2h 05m", "45s", "now". `minutes` keeps the minute field on long waits. */
export function formatZaicodeRemaining(seconds: number, options: { short?: boolean; minutes?: boolean } = {}): string {
  const total = Math.max(0, Math.trunc(seconds));
  if (total <= 0) return "now";
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  if (d) return options.minutes ? `${d}d ${h}h ${pad(m)}m` : options.short ? `${d}d` : `${d}d ${h}h`;
  if (h) return options.short && !options.minutes ? `${h}h` : `${h}h ${pad(m)}m`;
  if (m) return options.short && !options.minutes ? `${m}m` : `${m}m ${pad(s)}s`;
  return `${s}s`;
}

function clock(epoch: number): string {
  return formatZaicodeTimeOfDay(new Date(epoch));
}

/** Plain words for rows and tooltips: what it is and when it lands. */
export function describeZaicodeTimer(timer: ZaicodeTimer, now: number): string {
  const rem = zaicodeTimerRemaining(timer, now);
  let when = "now";
  if (rem > 0) {
    const mins = Math.floor(rem / 60);
    if (mins < 60) when = `in ${mins}m`;
    else {
      const hours = Math.floor(mins / 60);
      const rest = mins % 60;
      when = rest ? `in ${hours}h ${String(rest).padStart(2, "0")}m` : `in ${hours}h`;
    }
  }
  const bits = [`${timer.name} - ${when} (at ${clock(timer.target)})`];
  if (timer.repeat === "interval") {
    bits.push(timer.intervalMinutes % 60 === 0 ? `every ${timer.intervalMinutes / 60}h` : `every ${timer.intervalMinutes}m`);
  } else if (timer.repeat !== "once") bits.push(timer.repeat);
  if (!timer.enabled) bits.push("paused");
  return bits.join(" - ");
}

// ---------------------------------------------------------------------------
// Calendar queries (anchor-based: advancing a timer never rewrites its history)
// ---------------------------------------------------------------------------

function sameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export function zaicodeTimerOccursOn(timer: ZaicodeTimer, date: Date): boolean {
  if (timer.repeat === "once") return sameDay(new Date(timer.target), date);
  const anchor = anchorDate(timer);
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (day < anchor) return false;
  switch (timer.repeat) {
    case "daily":
    case "interval":
      return true;
    case "weekly":
      return Math.round((day.getTime() - anchor.getTime()) / 86_400_000) % 7 === 0;
    case "monthly":
      return day.getDate() === Math.min(anchor.getDate(), daysInMonth(day.getFullYear(), day.getMonth()));
    case "yearly":
      return (
        day.getMonth() === anchor.getMonth() &&
        day.getDate() === Math.min(anchor.getDate(), daysInMonth(day.getFullYear(), anchor.getMonth()))
      );
    default:
      return false;
  }
}

/** Days of `(year, month0)` on which the timer recurs. */
export function zaicodeTimerDaysInMonth(timer: ZaicodeTimer, year: number, month0: number): number[] {
  const days: number[] = [];
  for (let day = 1; day <= daysInMonth(year, month0); day += 1) {
    if (zaicodeTimerOccursOn(timer, new Date(year, month0, day))) days.push(day);
  }
  return days;
}

// ---------------------------------------------------------------------------
// Sound policy: one fixed sound, or a random pool with time windows
// ---------------------------------------------------------------------------

function ruleCovers(rule: ZaicodeTimerSoundRule, minute: number): boolean {
  if (rule.allDay) return true;
  // start == end without all-day is an invalid zero-length window: it matches nothing.
  if (rule.startMinute === rule.endMinute) return false;
  if (rule.startMinute < rule.endMinute) return minute >= rule.startMinute && minute < rule.endMinute;
  return minute >= rule.startMinute || minute < rule.endMinute;
}

/**
 * The sound to play at `when`: SINGLE = the timer's own; POOL = a random
 * eligible row. A pool with nothing eligible is SILENT on purpose (time-specific
 * silence must be expressible), so there is no fallback to the timer's sound.
 */
export function chooseZaicodeTimerSound(
  timer: ZaicodeTimer,
  when: Date,
  random: () => number = Math.random,
): { sound: string; volume: number } | null {
  if (timer.soundMode === "single") return { sound: timer.sound, volume: timer.volume };
  const minute = when.getHours() * 60 + when.getMinutes();
  const eligible = timer.soundRules.filter((rule) => rule.enabled && ruleCovers(rule, minute));
  if (eligible.length === 0) return null;
  const rule = eligible[Math.min(eligible.length - 1, Math.floor(random() * eligible.length))]!;
  return { sound: rule.sound, volume: rule.volume ?? timer.volume };
}
