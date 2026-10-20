import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Clock } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import {
  ZAICODE_PICKER_HOUR_STOPS,
  ZAICODE_PICKER_MINUTE_STEP,
  ZAICODE_PICKER_MINUTE_STOPS,
  formatZaicodeClockMinute,
  formatZaicodeDay,
  parseZaicodeClockText,
  parseZaicodeDayText,
  stepZaicodeClockMinute,
  zaicodeClockParts,
  zaicodeDayOf,
  zaicodeMinuteOf,
  zaicodeMomentOf,
} from "./zaicodeClockText.js";

/**
 * ZAICODE's own time and date fields: plain themed text boxes, 24-hour,
 * square, no browser picker. Type "7", "0730", "7:30" or "00:00"; Enter or
 * leaving the field applies it; Up / Down move one minute (Shift: ten,
 * Page Up / Down: an hour). A value that does not parse is shown in red and
 * never applied, so the stored time never changes by accident.
 *
 * The clock button opens one compact picker (T-319): an hour dial of all 24
 * hours, a minute dial of twelve five-minute stops and a ±1 minute stepper for
 * the exact minute, Done to commit. Typing and every keyboard shortcut stay
 * exactly as they were.
 */

const fieldClass =
  "min-w-0 border bg-background px-1 py-0.5 tabular-nums text-foreground disabled:opacity-40";
const stopClass =
  "min-h-6 min-w-0 border border-border px-1 py-1 text-ui-sm tabular-nums text-foreground-subtle hover:bg-hover hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-foreground";
const stopSelectedClass = "border-border-hover bg-selected text-foreground";

/**
 * The compact picker. It never writes to the schedule by itself: the minute is
 * a local draft until Done, so an accidental open cannot change a stored time,
 * and Cancel / Escape / an outside press all throw the draft away.
 */
export function ZaicodeTimePicker({
  minute,
  onCommit,
  onDismiss,
}: {
  /** Minute of the day the picker opens on. */
  minute: number;
  onCommit: (minute: number) => void;
  onDismiss: () => void;
}) {
  const [draft, setDraft] = useState(minute);
  const { hour, minute: minuteStop } = zaicodeClockParts(draft);
  const anchor = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    anchor.current?.focus();
  }, []);
  return (
    <div
      role="dialog"
      aria-label="Time picker"
      data-zaicode-time-picker="open"
      className="flex min-w-0 flex-col gap-2"
    >
      <div className="flex items-center justify-between gap-1 border-b border-border pb-1">
        <strong className="tabular-nums text-ui-sm" data-zaicode-time-picker-value>
          {formatZaicodeClockMinute(draft)}
        </strong>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className={stopClass}
            aria-label="One minute earlier"
            title="One minute earlier"
            onClick={() => setDraft((value) => stepZaicodeClockMinute(value, -1))}
          >
            −
          </button>
          <button
            type="button"
            className={stopClass}
            aria-label="One minute later"
            title="One minute later"
            onClick={() => setDraft((value) => stepZaicodeClockMinute(value, 1))}
          >
            +
          </button>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-col gap-1" role="group" aria-label="Hour">
          <span className="text-ui-xs text-foreground-subtle">Hour · 00–23</span>
          <div className="grid grid-cols-6 gap-1">
            {ZAICODE_PICKER_HOUR_STOPS.map((value) => (
              <button
                key={value}
                type="button"
                aria-label={`Hour ${String(value).padStart(2, "0")}`}
                aria-pressed={hour === value}
                data-zaicode-time-picker-hour={value}
                className={cn(stopClass, "text-center", hour === value && stopSelectedClass)}
                onClick={() => setDraft(value * 60 + minuteStop)}
              >
                {String(value).padStart(2, "0")}
              </button>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-1" role="group" aria-label="Minute">
          <span className="text-ui-xs text-foreground-subtle">Minute · 00–55</span>
          <div className="grid grid-cols-6 gap-1">
            {ZAICODE_PICKER_MINUTE_STOPS.map((value) => (
              <button
                key={value}
                type="button"
                aria-label={`Minute ${String(value).padStart(2, "0")}`}
                aria-pressed={minuteStop === value}
                data-zaicode-time-picker-minute={value}
                className={cn(stopClass, "text-center", minuteStop === value && stopSelectedClass)}
                onClick={() => setDraft(hour * 60 + value)}
              >
                {String(value).padStart(2, "0")}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-1 border-t border-border pt-1">
        <button
          ref={anchor}
          type="button"
          className={stopClass}
          data-zaicode-time-picker-cancel
          onClick={onDismiss}
        >
          Cancel
        </button>
        <button
          type="button"
          className={cn(stopClass, stopSelectedClass)}
          data-zaicode-time-picker-done
          onClick={() => onCommit(draft)}
        >
          Done
        </button>
      </div>
      <span className="sr-only">
        {`Minute stops every ${ZAICODE_PICKER_MINUTE_STEP} minutes; the plus and minus buttons step one minute.`}
      </span>
    </div>
  );
}

export function ZaicodeTimeField({
  minute,
  onChange,
  onClear,
  disabled,
  className,
  title,
  ariaLabel,
  children,
}: {
  /** null = no time set (shown empty); only meaningful together with onClear. */
  minute: number | null;
  onChange: (minute: number) => void;
  /** When given, emptying the field clears the time instead of restoring it. */
  onClear?: () => void;
  disabled?: boolean;
  className?: string;
  title?: string;
  ariaLabel?: string;
  /** Extra controls rendered inside the field's own box (the picker host). */
  children?: ReactNode;
}) {
  const shown = minute === null ? "" : formatZaicodeClockMinute(minute);
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    if (!editing) setText(shown);
  }, [editing, shown]);
  const parsed = parseZaicodeClockText(text);
  const invalid = editing && text.trim() !== "" && parsed === null;
  const apply = () => {
    setEditing(false);
    if (text.trim() === "" && onClear) {
      if (minute !== null) onClear();
      return;
    }
    if (parsed === null) {
      setText(shown);
      return;
    }
    if (parsed !== minute) onChange(parsed);
    setText(formatZaicodeClockMinute(parsed));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.altKey && event.key === "ArrowDown") {
      event.preventDefault();
      setPicking(true);
      return;
    }
    const base = parsed ?? minute ?? 0;
    const step =
      event.key === "ArrowUp"
        ? event.shiftKey
          ? 10
          : 1
        : event.key === "ArrowDown"
          ? event.shiftKey
            ? -10
            : -1
          : event.key === "PageUp"
            ? 60
            : event.key === "PageDown"
              ? -60
              : 0;
    if (step !== 0) {
      event.preventDefault();
      const next = stepZaicodeClockMinute(base, step);
      setEditing(false);
      setText(formatZaicodeClockMinute(next));
      onChange(next);
    } else if (event.key === "Enter") {
      event.preventDefault();
      apply();
    } else if (event.key === "Escape") {
      setEditing(false);
      setText(shown);
    }
  };
  return (
    <Popover open={picking} onOpenChange={setPicking}>
      <PopoverAnchor asChild>
        <span
          className={cn("inline-flex min-w-0 items-center", className)}
          data-zaicode-time-field-host
        >
          <input
            type="text"
            inputMode="numeric"
            spellCheck={false}
            maxLength={8}
            disabled={disabled}
            aria-label={ariaLabel ?? "Time (HH:MM, 24-hour)"}
            aria-invalid={invalid || undefined}
            title={
              title ??
              "HH:MM, 24-hour. Type 7, 0730 or 07:30 · Up/Down: 1 min · Shift: 10 min · PgUp/PgDn: 1 h"
            }
            className={cn(
              fieldClass,
              "w-[7ch] shrink-0 text-center",
              invalid ? "border-destructive" : "border-border",
            )}
            value={text}
            placeholder="--:--"
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              setEditing(true);
              setText(event.target.value);
            }}
            onBlur={apply}
            onKeyDown={onKeyDown}
            data-zaicode-time-field
          />
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label="Open the time picker"
              aria-expanded={picking}
              title="Open the time picker (HH:MM, 24-hour)"
              className="ml-0.5 shrink-0 border border-border bg-card px-0.5 leading-4 text-foreground hover:bg-hover disabled:opacity-40"
              data-zaicode-time-picker-toggle
            >
              <Clock className="size-3" />
            </button>
          </PopoverTrigger>
          {children}
        </span>
      </PopoverAnchor>
      {picking ? (
        <PopoverContent
          align="end"
          collisionPadding={8}
          className="w-72 max-w-[calc(100vw-16px)] gap-2 rounded-none p-2 shadow-none [animation:none] [transition:none]"
        >
          <ZaicodeTimePicker
            minute={parsed ?? minute ?? 0}
            onCommit={(next) => {
              setPicking(false);
              setEditing(false);
              setText(formatZaicodeClockMinute(next));
              onChange(next);
            }}
            onDismiss={() => setPicking(false)}
          />
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

/** A day (DD.MM.YYYY, ‹ › step a day) and a time, as one local moment. */
export function ZaicodeMomentField({
  value,
  onChange,
  className,
}: {
  /** Epoch ms, or null while nothing is chosen yet. */
  value: number | null;
  onChange: (epoch: number) => void;
  className?: string;
}) {
  const date = new Date(value ?? Date.now());
  const day = zaicodeDayOf(date);
  const minute = value === null ? 9 * 60 : zaicodeMinuteOf(date);
  // T-319: an unset moment shows today's local date, so a new "Once at" row
  // reads as a real date instead of an empty box. It stays a display default:
  // the value is written only when the operator edits the date, steps it, or
  // presses Enter -- never by merely focusing and leaving the field.
  const defaulted = value === null;
  const shownDay = formatZaicodeDay(day);
  const [text, setText] = useState(shownDay);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!editing) setText(shownDay);
  }, [editing, shownDay]);
  const parsedDay = parseZaicodeDayText(text, day.year);
  const invalid = editing && text.trim() !== "" && parsedDay === null;
  /** `explicit` = the operator pressed Enter; a bare focus-and-leave is not a commit. */
  const applyDay = (explicit: boolean) => {
    setEditing(false);
    if (parsedDay && (dirty || explicit || !defaulted)) {
      setDirty(false);
      onChange(zaicodeMomentOf(parsedDay, minute));
      return;
    }
    setText(shownDay);
  };
  const shiftDay = (delta: number) => {
    setDirty(false);
    const next = new Date(day.year, day.month - 1, day.day + delta);
    onChange(zaicodeMomentOf(zaicodeDayOf(next), minute));
  };
  const button = "border border-border bg-card px-1 leading-4 text-foreground hover:bg-hover";
  return (
    <span
      className={cn("flex min-w-0 items-center gap-1", className)}
      data-zaicode-moment-field
      data-zaicode-moment-default={defaulted ? "today" : undefined}
    >
      <button type="button" className={button} title="One day earlier" onClick={() => shiftDay(-1)}>
        ‹
      </button>
      <input
        type="text"
        spellCheck={false}
        maxLength={10}
        placeholder="DD.MM.YYYY"
        aria-label="Date (DD.MM.YYYY)"
        aria-invalid={invalid || undefined}
        title="DD.MM.YYYY (25.09.2026, 25.09 or 2026-09-25)"
        className={cn(
          fieldClass,
          "w-[86px] text-center",
          invalid ? "border-destructive" : "border-border",
          defaulted && "text-foreground-subtle",
        )}
        value={text}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          setEditing(true);
          setDirty(true);
          setText(event.target.value);
        }}
        onBlur={() => applyDay(false)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            applyDay(true);
          } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            shiftDay(event.key === "ArrowUp" ? 1 : -1);
          }
        }}
      />
      <button type="button" className={button} title="One day later" onClick={() => shiftDay(1)}>
        ›
      </button>
      <ZaicodeTimeField minute={minute} onChange={(next) => onChange(zaicodeMomentOf(day, next))} />
    </span>
  );
}
