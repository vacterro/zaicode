import { useEffect, useState, type KeyboardEvent } from "react";
import { cn } from "@/components/lib/utils.js";
import {
  formatZaicodeClockMinute,
  formatZaicodeDay,
  parseZaicodeClockText,
  parseZaicodeDayText,
  stepZaicodeClockMinute,
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
 */

const fieldClass = "min-w-0 border bg-background px-1 py-0.5 tabular-nums text-foreground disabled:opacity-40";

export function ZaicodeTimeField({
  minute,
  onChange,
  onClear,
  disabled,
  className,
  title,
  ariaLabel,
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
}) {
  const shown = minute === null ? "" : formatZaicodeClockMinute(minute);
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
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
    const base = parsed ?? minute ?? 0;
    const step =
      event.key === "ArrowUp" ? (event.shiftKey ? 10 : 1)
      : event.key === "ArrowDown" ? (event.shiftKey ? -10 : -1)
      : event.key === "PageUp" ? 60
      : event.key === "PageDown" ? -60
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
    <input
      type="text"
      inputMode="numeric"
      spellCheck={false}
      maxLength={8}
      disabled={disabled}
      aria-label={ariaLabel ?? "Time (HH:MM, 24-hour)"}
      aria-invalid={invalid || undefined}
      title={title ?? "HH:MM, 24-hour. Type 7, 0730 or 07:30 · Up/Down: 1 min · Shift: 10 min · PgUp/PgDn: 1 h"}
      className={cn(fieldClass, "w-[48px] text-center", invalid ? "border-destructive" : "border-border", className)}
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
  const shownDay = value === null ? "" : formatZaicodeDay(day);
  const [text, setText] = useState(shownDay);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(shownDay);
  }, [editing, shownDay]);
  const parsedDay = parseZaicodeDayText(text, day.year);
  const invalid = editing && text.trim() !== "" && parsedDay === null;
  const applyDay = () => {
    setEditing(false);
    if (parsedDay) onChange(zaicodeMomentOf(parsedDay, minute));
    else setText(shownDay);
  };
  const shiftDay = (delta: number) => {
    const next = new Date(day.year, day.month - 1, day.day + delta);
    onChange(zaicodeMomentOf(zaicodeDayOf(next), minute));
  };
  const button = "border border-border bg-card px-1 leading-4 text-foreground hover:bg-hover";
  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)} data-zaicode-moment-field>
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
        className={cn(fieldClass, "w-[86px] text-center", invalid ? "border-destructive" : "border-border")}
        value={text}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          setEditing(true);
          setText(event.target.value);
        }}
        onBlur={applyDay}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            applyDay();
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
