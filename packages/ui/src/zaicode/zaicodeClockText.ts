/**
 * Typed clock times and dates for ZAICODE's own time fields (the native
 * <input type="time"> follows the Windows locale: AM/PM columns, no way to
 * type 00, a white picker with rounded corners). These parse what people
 * actually type and always answer in 24-hour HH:MM / DD.MM.YYYY.
 */

const pad = (value: number) => String(value).padStart(2, "0");

export const ZAICODE_MINUTES_PER_DAY = 1440;

/** Minute of the day -> "HH:MM" (always 24-hour, zero-padded). */
export function formatZaicodeClockMinute(minute: number): string {
  const safe = ((Math.trunc(minute) % ZAICODE_MINUTES_PER_DAY) + ZAICODE_MINUTES_PER_DAY) % ZAICODE_MINUTES_PER_DAY;
  return `${pad(Math.floor(safe / 60))}:${pad(safe % 60)}`;
}

/**
 * "7" "07" "0" "00" -> whole hours; "730" "0730" -> 07:30; "7:30" "7.30"
 * "7h30" "07 30" -> 07:30; "12am" -> 00:00, "1:05 pm" -> 13:05. Anything
 * else (or an hour past 23 / minute past 59) is null, never a guess.
 */
export function parseZaicodeClockText(text: string): number | null {
  const raw = text.trim().toLowerCase();
  if (!raw) return null;
  const meridiem = /\s*(am|pm|a|p)$/.exec(raw);
  const body = meridiem ? raw.slice(0, meridiem.index).trim() : raw;
  let hours: number;
  let minutes: number;
  const separated = /^(\d{1,2})\s*[:.h ]\s*(\d{1,2})$/.exec(body);
  if (separated) {
    hours = Number(separated[1]);
    minutes = Number(separated[2]);
  } else if (/^\d{1,4}$/.test(body)) {
    if (body.length <= 2) {
      hours = Number(body);
      minutes = 0;
    } else {
      hours = Number(body.slice(0, body.length - 2));
      minutes = Number(body.slice(-2));
    }
  } else {
    return null;
  }
  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    const pm = meridiem[1]!.startsWith("p");
    hours = (hours % 12) + (pm ? 12 : 0);
  }
  if (hours > 23) return null;
  return hours * 60 + minutes;
}

/** Arrow-key step: wraps round midnight in both directions. */
export function stepZaicodeClockMinute(minute: number, delta: number): number {
  return (((minute + delta) % ZAICODE_MINUTES_PER_DAY) + ZAICODE_MINUTES_PER_DAY) % ZAICODE_MINUTES_PER_DAY;
}

export interface ZaicodeDayParts {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
}

export function formatZaicodeDay(parts: ZaicodeDayParts): string {
  return `${pad(parts.day)}.${pad(parts.month)}.${parts.year}`;
}

export function zaicodeDayOf(date: Date): ZaicodeDayParts {
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

function validDay(parts: ZaicodeDayParts): ZaicodeDayParts | null {
  if (parts.month < 1 || parts.month > 12 || parts.day < 1) return null;
  const last = new Date(parts.year, parts.month, 0).getDate();
  return parts.day <= last ? parts : null;
}

/**
 * "25.09.2026" "25/09/2026" "25-09-2026" "2026-09-25", and without a year
 * ("25.09") the given year. Impossible dates (31.02) are null.
 */
export function parseZaicodeDayText(text: string, fallbackYear: number): ZaicodeDayParts | null {
  const raw = text.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (iso) return validDay({ year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) });
  const dotted = /^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2}|\d{4}))?$/.exec(raw);
  if (!dotted) return null;
  const yearText = dotted[3];
  const year = yearText === undefined ? fallbackYear : yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
  return validDay({ year, month: Number(dotted[2]), day: Number(dotted[1]) });
}

/** Local wall-clock moment from a day and a minute of that day. */
export function zaicodeMomentOf(day: ZaicodeDayParts, minute: number): number {
  return new Date(day.year, day.month - 1, day.day, Math.floor(minute / 60), minute % 60, 0, 0).getTime();
}

export function zaicodeMinuteOf(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}
