/**
 * Human duration and clock-time parsing (FastPrompter's duration.py). Accepts
 * what people type when they want a reminder:
 *
 *   "4 days 11 hours"  "4d 11h"  "90m"  "1h30"  "2 недели 3 дня"  "45 мин"
 *   "1.5h"  "18:30"  "tomorrow 9:00"  "завтра 09:00"  "2026-09-25 11:00"
 *
 * Anything unparseable returns null rather than a guess: a timer that fires
 * at the wrong moment is worse than one that refuses to be created.
 */

const UNITS: readonly (readonly [readonly string[], number])[] = [
  [["weeks", "week", "wk", "w", "недел", "nädal", "näd"], 7 * 86_400],
  [["days", "day", "d", "дней", "дня", "день", "д", "päeva", "päev", "p"], 86_400],
  [["hours", "hour", "hrs", "hr", "h", "часов", "часа", "час", "ч", "tundi", "tund", "t"], 3600],
  [["minutes", "minute", "mins", "min", "m", "минут", "мин", "м", "minutit", "minut"], 60],
  [["seconds", "second", "secs", "sec", "s", "секунд", "сек", "с", "sekundit", "sek"], 1],
];

const UNIT_LOOKUP = new Map<string, number>();
for (const [names, seconds] of UNITS) for (const name of names) UNIT_LOOKUP.set(name, seconds);

const PART = /(\d+(?:[.,]\d+)?)\s*([a-zа-яёõäöü]*)/giu;
const CLOCK = /^\s*(\d{1,2})\s*[:.]\s*(\d{2})\s*$/;
const DATE_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})[\st]*/;
const HM_SHORTHAND = /^\s*(\d{1,2})\s*[hч]\s*(\d{1,2})\s*$/i;
const TOMORROW = ["tomorrow", "tmr", "завтра", "homme"];
const TODAY = ["today", "сегодня", "täna"];
const MAX_SECONDS = 365 * 86_400;

function matchUnit(word: string): number | null {
  const lower = word.toLowerCase();
  if (!lower) return null;
  const direct = UNIT_LOOKUP.get(lower);
  if (direct !== undefined) return direct;
  // prefix match for inflected forms ("недели", "минуток")
  for (const [names, seconds] of UNITS) {
    for (const name of names) if (name.length > 1 && lower.startsWith(name)) return seconds;
  }
  return null;
}

function between(text: string): boolean {
  const rest = text.replace(/[\s,;+&]+/g, " ").trim();
  return rest === "" || rest === "and" || rest === "и" || rest === "ja";
}

/** "4 days 11 hours" -> milliseconds. Null if nothing usable. */
export function parseZaicodeDuration(text: string): number | null {
  const s = text.trim().toLowerCase();
  if (!s) return null;
  const shorthand = HM_SHORTHAND.exec(s);
  if (shorthand) {
    const minutes = Number(shorthand[2]);
    if (minutes >= 60) return null;
    return (Number(shorthand[1]) * 3600 + minutes * 60) * 1000;
  }
  let total = 0;
  let matched = false;
  let lastEnd = 0;
  let pending: number | null = null;
  for (const match of s.matchAll(PART)) {
    if (!between(s.slice(lastEnd, match.index))) return null;
    lastEnd = (match.index ?? 0) + match[0].length;
    const value = Number(match[1]!.replace(",", "."));
    const word = match[2] ?? "";
    const unit = matchUnit(word);
    if (unit === null) {
      if (word) return null; // a word we do not know: refuse, never guess
      if (pending !== null) return null; // "4 5" is not a duration
      pending = value;
      matched = true;
      continue;
    }
    total += value * unit;
    matched = true;
  }
  if (!between(s.slice(lastEnd)) || !matched) return null;
  // a lone number means minutes ("45"), and "1h 30" means 30 minutes too
  if (pending !== null) total += pending * 60;
  if (total <= 0 || total > MAX_SECONDS) return null;
  return Math.round(total) * 1000;
}

/** Absolute moment: "18:30" (tomorrow if already past), "tomorrow 9:00", "2026-09-25 11:00". */
export function parseZaicodeWhen(text: string, now: Date = new Date()): Date | null {
  let s = text.trim().toLowerCase();
  if (!s) return null;
  const iso = DATE_ISO.exec(s);
  if (iso) {
    const day = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (day.getMonth() !== Number(iso[2]) - 1) return null;
    const rest = s.slice(iso[0].length).trim();
    if (!rest) return day;
    const time = CLOCK.exec(rest);
    if (!time) return null;
    const hour = Number(time[1]);
    const minute = Number(time[2]);
    if (hour > 23 || minute > 59) return null;
    day.setHours(hour, minute, 0, 0);
    return day;
  }
  let dayOffset = 0;
  const tomorrow = TOMORROW.find((word) => s.startsWith(word));
  if (tomorrow) {
    dayOffset = 1;
    s = s.slice(tomorrow.length).trim();
  } else {
    const today = TODAY.find((word) => s.startsWith(word));
    if (today) s = s.slice(today.length).trim();
  }
  const time = CLOCK.exec(s);
  if (!time) return null;
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  if (hour > 23 || minute > 59) return null;
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  target.setDate(target.getDate() + dayOffset);
  if (dayOffset === 0 && target <= now) target.setDate(target.getDate() + 1);
  return target;
}

/**
 * Whatever the user typed as an absolute moment. `preferPast` is for anchors:
 * a window that "started at 09:20" means the 09:20 that already happened.
 */
export function resolveZaicodeTarget(text: string, now: Date = new Date(), preferPast = false): Date | null {
  const when = parseZaicodeWhen(text, now);
  if (when) {
    if (preferPast && when > now) when.setDate(when.getDate() - 1);
    return when;
  }
  const delta = parseZaicodeDuration(text);
  if (delta === null) return null;
  return new Date(now.getTime() + (preferPast ? -delta : delta));
}

/** Ready-made choices, so nobody has to type at all. */
export const ZAICODE_DURATION_PRESETS: readonly { label: string; value: string }[] = [
  { label: "5 minutes", value: "5m" },
  { label: "15 minutes", value: "15m" },
  { label: "30 minutes", value: "30m" },
  { label: "1 hour", value: "1h" },
  { label: "2 hours", value: "2h" },
  { label: "4 hours", value: "4h" },
  { label: "5 hours", value: "5h" },
  { label: "8 hours", value: "8h" },
  { label: "12 hours", value: "12h" },
  { label: "1 day", value: "1d" },
  { label: "2 days", value: "2d" },
  { label: "4 days 11 hours", value: "4d 11h" },
  { label: "1 week", value: "1w" },
];

/** The one-click moments: in 10 m, in 1 h, tonight 22:00, tomorrow 09:00. */
export function zaicodeQuickMoment(kind: "10m" | "1h" | "tonight" | "tomorrow", now: Date = new Date()): Date {
  const target = new Date(now);
  if (kind === "10m") return new Date(now.getTime() + 10 * 60_000);
  if (kind === "1h") return new Date(now.getTime() + 3_600_000);
  if (kind === "tonight") {
    target.setHours(22, 0, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target;
  }
  target.setDate(target.getDate() + 1);
  target.setHours(9, 0, 0, 0);
  return target;
}
