import { useEffect, useMemo, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import {
  describeZaicodeTimer,
  formatZaicodeRemaining,
  zaicodeDateKey,
  zaicodeTimerColor,
  zaicodeTimerDaysInMonth,
  zaicodeTimerOccursOn,
  ZAICODE_TIMER_DEFAULT_COLOR,
  ZAICODE_TIMER_DEFAULT_SOUND,
  ZAICODE_TIMER_REPEATS,
  type ZaicodeTimer,
  type ZaicodeTimerKind,
} from "./zaicodeTimers.js";
import { resolveZaicodeTarget, zaicodeQuickMoment, ZAICODE_DURATION_PRESETS } from "./zaicodeDuration.js";
import { useZaicodeTimers } from "./zaicodeTimerStore.js";
import {
  formatTimerMoment,
  REPEAT_LABELS,
  TimerBehaviorEditor,
  TimerButton,
  TimerCheck,
  TimerGroup,
  timerInputClass,
  toDateTimeLocal,
  type TimerBehavior,
} from "./ZaicodeTimerParts.js";
import { ZaicodeMomentField } from "./ZaicodeTimeFields.js";

const TEST_DELAY_S = 3;

interface Draft extends TimerBehavior {
  name: string;
  description: string;
  when: string;
  repeat: ZaicodeTimer["repeat"];
  intervalMinutes: number;
  enabled: boolean;
}

function blankDraft(): Draft {
  return {
    name: "",
    description: "",
    when: "",
    repeat: "once",
    intervalMinutes: 300,
    enabled: true,
    showNotification: true,
    showInTopBar: true,
    colorMode: "temperature",
    color: ZAICODE_TIMER_DEFAULT_COLOR,
    volume: 0.5,
    sound: ZAICODE_TIMER_DEFAULT_SOUND,
    soundMode: "single",
    soundRules: [],
  };
}

function draftOf(timer: ZaicodeTimer): Draft {
  return {
    name: timer.name,
    description: timer.description,
    when: toDateTimeLocal(timer.target).replace("T", " "),
    repeat: timer.repeat,
    intervalMinutes: timer.intervalMinutes,
    enabled: timer.enabled,
    showNotification: timer.showNotification,
    showInTopBar: timer.showInTopBar,
    colorMode: timer.colorMode,
    color: timer.color,
    volume: timer.volume,
    sound: timer.sound,
    soundMode: timer.soundMode,
    soundRules: timer.soundRules.map((rule) => ({ ...rule })),
  };
}

export function useNowTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** Form shared by Alarms and Calendar: name, when, repeat, then notification & sound. */
function TimerForm({
  kind,
  editing,
  draft,
  setDraft,
  onCommit,
  onNew,
}: {
  kind: ZaicodeTimerKind;
  editing: ZaicodeTimer | null;
  draft: Draft;
  setDraft: (patch: Partial<Draft>) => void;
  onCommit: () => void;
  onNew: () => void;
}) {
  const preview = draft.when.trim() ? resolveZaicodeTarget(draft.when.replace("T", " ")) : null;
  const setMoment = (date: Date) => setDraft({ when: toDateTimeLocal(date.getTime()).replace("T", " ") });
  const store = useZaicodeTimers();
  return (
    <div className="grid grid-cols-2 gap-2">
      <TimerGroup title={kind === "calendar" ? "Event details & timing" : "Alarm details & timing"}>
        <input className={timerInputClass} placeholder={kind === "calendar" ? "Event name" : "Name (e.g. Claude limit)"} value={draft.name} onChange={(event) => setDraft({ name: event.target.value })} />
        <input className={timerInputClass} placeholder="Description (optional, shown in the notification)" value={draft.description} onChange={(event) => setDraft({ description: event.target.value })} />
        <div className="grid grid-cols-4 gap-px">
          {(["10m", "1h", "tonight", "tomorrow"] as const).map((quick) => (
            <TimerButton key={quick} onClick={() => setMoment(zaicodeQuickMoment(quick))}>
              {quick === "10m" ? "in 10m" : quick === "1h" ? "in 1h" : quick}
            </TimerButton>
          ))}
        </div>
        <div className="flex gap-1">
          <input
            className={cn(timerInputClass, "flex-1")}
            placeholder="4 days 11 hours / 18:30 / tomorrow 9:00"
            value={draft.when}
            onChange={(event) => setDraft({ when: event.target.value })}
            onKeyDown={(event) => {
              event.stopPropagation();
              // Enter adds (or saves) straight from the text, like the button.
              if (event.key === "Enter" && preview) onCommit();
            }}
          />
          <select
            className={timerInputClass}
            value=""
            title="Ready-made delays"
            onChange={(event) => event.target.value && setDraft({ when: event.target.value })}
          >
            <option value="">Preset</option>
            {ZAICODE_DURATION_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <select className={timerInputClass} value={draft.repeat} onChange={(event) => setDraft({ repeat: event.target.value as Draft["repeat"] })} title="How often it repeats">
            {ZAICODE_TIMER_REPEATS.map((repeat) => (
              <option key={repeat} value={repeat}>
                {REPEAT_LABELS[repeat]}
              </option>
            ))}
          </select>
          {draft.repeat === "interval" ? (
            <label className="flex items-center gap-1 text-foreground-subtle" title="The quota window length, e.g. 300 = every 5 hours from the moment above">
              every
              <input type="number" min={1} className={cn(timerInputClass, "w-16")} value={draft.intervalMinutes} onChange={(event) => setDraft({ intervalMinutes: Math.max(1, Number(event.target.value) || 1) })} />
              min
            </label>
          ) : null}
          <TimerCheck checked={draft.enabled} onChange={(enabled) => setDraft({ enabled })} label="Enabled" />
        </div>
        <div className="flex items-center gap-1">
          <ZaicodeMomentField className="flex-1" value={preview ? preview.getTime() : null} onChange={(epoch) => setMoment(new Date(epoch))} />
          <TimerButton onClick={() => setMoment(new Date())}>Now</TimerButton>
        </div>
        <span className={preview ? "text-foreground-subtle" : "text-[#ff9a66]"}>
          {draft.when.trim() ? (preview ? `→ ${formatTimerMoment(preview.getTime())} (${formatZaicodeRemaining((preview.getTime() - Date.now()) / 1000)})` : "Not a time I understand") : "Type a delay or a clock time, or use the buttons."}
        </span>
      </TimerGroup>
      <TimerGroup title="Notification & sound">
        <TimerBehaviorEditor value={draft} onChange={setDraft} />
        <div className="mt-auto flex justify-end gap-1">
          <TimerButton
            title={`Fires a copy in ${TEST_DELAY_S} seconds`}
            onClick={() =>
              store.addTimer({ ...draft, name: draft.name || "Test", kind, target: Date.now() + TEST_DELAY_S * 1000, repeat: "once", deleteAfterFire: true, showInTopBar: false })
            }
          >
            Test
          </TimerButton>
          <TimerButton onClick={onNew}>New</TimerButton>
          <TimerButton
            active
            disabled={!preview}
            title={preview ? undefined : "Set the moment first: type a delay or a time, pick a quick button, or fill the date and time"}
            onClick={onCommit}
          >
            {editing ? "Save" : kind === "calendar" ? "Add event" : "Add"}
          </TimerButton>
        </div>
      </TimerGroup>
    </div>
  );
}

function useTimerEditor(kind: ZaicodeTimerKind) {
  const store = useZaicodeTimers();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraftState] = useState<Draft>(blankDraft);
  const editing = store.timers.find((timer) => timer.id === editingId) ?? null;
  const setDraft = (patch: Partial<Draft>) => setDraftState((current) => ({ ...current, ...patch }));
  const reset = () => {
    setEditingId(null);
    setDraftState(blankDraft());
  };
  const edit = (timer: ZaicodeTimer) => {
    setEditingId(timer.id);
    setDraftState(draftOf(timer));
  };
  const commit = () => {
    const target = resolveZaicodeTarget(draft.when.replace("T", " "));
    if (!target) return;
    const fields = {
      name: draft.name.trim() || (kind === "calendar" ? "Event" : "Timer"),
      description: draft.description,
      target: target.getTime(),
      repeat: draft.repeat,
      intervalMinutes: draft.intervalMinutes,
      enabled: draft.enabled,
      showNotification: draft.showNotification,
      showInTopBar: draft.showInTopBar,
      colorMode: draft.colorMode,
      color: draft.color,
      volume: draft.volume,
      sound: draft.sound,
      soundMode: draft.soundMode,
      soundRules: draft.soundRules,
      kind,
      fired: false,
    };
    if (editing) store.updateTimer(editing.id, { ...fields, repeatAnchor: zaicodeDateKey(target) });
    else store.addTimer(fields);
    reset();
  };
  return { store, editing, draft, setDraft, reset, edit, commit, selectedId: editingId };
}

function RowActions({ timer, onEdit }: { timer: ZaicodeTimer | null; onEdit: () => void }) {
  const store = useZaicodeTimers();
  return (
    <div className="flex flex-wrap gap-1">
      <TimerButton disabled={!timer} onClick={onEdit}>Edit</TimerButton>
      <TimerButton disabled={!timer} onClick={() => timer && store.toggleTimer(timer.id)}>
        {timer?.enabled === false ? "Enable" : "Disable"}
      </TimerButton>
      <TimerButton disabled={!timer} title="Push back 10 minutes" onClick={() => timer && store.snoozeTimer(timer.id, 10)}>+10m</TimerButton>
      <TimerButton disabled={!timer} title="Pull forward 10 minutes" onClick={() => timer && store.shiftTimer(timer.id, -10)}>-10m</TimerButton>
      <TimerButton disabled={!timer} onClick={() => timer && store.removeTimer(timer.id)}>Delete</TimerButton>
    </div>
  );
}

function TimerTable({ timers, selectedId, onSelect, onOpen, now }: { timers: readonly ZaicodeTimer[]; selectedId: string | null; onSelect: (timer: ZaicodeTimer) => void; onOpen: (timer: ZaicodeTimer) => void; now: number }) {
  return (
    <div className="max-h-[150px] min-h-[80px] overflow-y-auto border border-border bg-background">
      <div className="sticky top-0 grid grid-cols-[1fr_110px_120px] bg-card px-1 text-foreground-subtlest">
        <span>Name</span>
        <span>Time</span>
        <span>Remaining</span>
      </div>
      {timers.length === 0 ? <div className="px-1 text-foreground-subtlest">Nothing here yet.</div> : null}
      {[...timers]
        .sort((left, right) => left.target - right.target)
        .map((timer) => (
          <button
            key={timer.id}
            type="button"
            title={describeZaicodeTimer(timer, now)}
            className={cn("grid w-full grid-cols-[1fr_110px_120px] px-1 text-left hover:bg-hover", timer.id === selectedId && "bg-selected")}
            style={{ color: timer.enabled ? zaicodeTimerColor(timer, now) : undefined }}
            onClick={() => onSelect(timer)}
            onDoubleClick={() => onOpen(timer)}
          >
            <span className={cn("truncate", !timer.enabled && "text-foreground-subtlest")}>
              {timer.name}
              {timer.repeat !== "once" ? <span className="text-foreground-subtlest"> · {REPEAT_LABELS[timer.repeat].toLowerCase()}</span> : null}
            </span>
            <span className="tabular-nums">{formatTimerMoment(timer.target)}</span>
            <span className="tabular-nums">{!timer.enabled ? "paused" : timer.fired ? "done" : formatZaicodeRemaining((timer.target - now) / 1000)}</span>
          </button>
        ))}
    </div>
  );
}

export function ZaicodeAlarmsTab() {
  const editor = useTimerEditor("alarm");
  const now = useNowTick();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const alarms = editor.store.timers.filter((timer) => timer.kind === "alarm" && !timer.temporary);
  const selected = alarms.find((timer) => timer.id === selectedId) ?? null;
  return (
    <div className="flex flex-col gap-2">
      <TimerTable timers={alarms} selectedId={selectedId} onSelect={(timer) => setSelectedId(timer.id)} onOpen={editor.edit} now={now} />
      <div className="flex justify-between">
        <RowActions timer={selected} onEdit={() => selected && editor.edit(selected)} />
        <TimerButton onClick={editor.reset}>New</TimerButton>
      </div>
      <TimerForm kind="alarm" editing={editor.editing} draft={editor.draft} setDraft={editor.setDraft} onCommit={editor.commit} onNew={editor.reset} />
    </div>
  );
}

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

export function ZaicodeCalendarTab() {
  const editor = useTimerEditor("calendar");
  const now = useNowTick();
  const today = new Date();
  const [month, setMonth] = useState(() => ({ year: today.getFullYear(), month0: today.getMonth() }));
  const [day, setDay] = useState(() => today.getDate());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const events = editor.store.timers.filter((timer) => timer.kind === "calendar");
  const marked = useMemo(() => {
    const days = new Set<number>();
    for (const event of events) for (const value of zaicodeTimerDaysInMonth(event, month.year, month.month0)) days.add(value);
    return days;
  }, [events, month]);
  const selectedDate = new Date(month.year, month.month0, day);
  const onDay = events.filter((event) => zaicodeTimerOccursOn(event, selectedDate));
  const selected = events.find((event) => event.id === selectedId) ?? null;
  const firstWeekday = (new Date(month.year, month.month0, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(month.year, month.month0 + 1, 0).getDate();
  const shift = (delta: number) =>
    setMonth((current) => {
      const index = current.year * 12 + current.month0 + delta;
      return { year: Math.floor(index / 12), month0: ((index % 12) + 12) % 12 };
    });
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[200px_1fr] gap-2">
        <div className="flex flex-col gap-1 border border-border p-1">
          <div className="flex items-center justify-between">
            <TimerButton onClick={() => shift(-1)}>‹</TimerButton>
            <span className="text-foreground">{new Date(month.year, month.month0, 1).toLocaleString(undefined, { month: "long", year: "numeric" })}</span>
            <TimerButton onClick={() => shift(1)}>›</TimerButton>
          </div>
          <div className="grid grid-cols-7 gap-px text-center">
            {WEEKDAYS.map((weekday) => (
              <span key={weekday} className="text-foreground-subtlest">{weekday}</span>
            ))}
            {Array.from({ length: firstWeekday }, (_, index) => <span key={`gap-${index}`} />)}
            {Array.from({ length: daysInMonth }, (_, index) => index + 1).map((value) => {
              const isToday = value === today.getDate() && month.month0 === today.getMonth() && month.year === today.getFullYear();
              return (
                <button
                  key={value}
                  type="button"
                  className={cn(
                    "border leading-4",
                    value === day ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected" : "border-transparent hover:bg-hover",
                    isToday ? "text-[#f0c850]" : "text-foreground",
                    marked.has(value) && "underline decoration-[#e08a3c] decoration-2",
                  )}
                  onClick={() => setDay(value)}
                >
                  {value}
                </button>
              );
            })}
          </div>
          <TimerButton onClick={() => { setMonth({ year: today.getFullYear(), month0: today.getMonth() }); setDay(today.getDate()); }}>Today</TimerButton>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-foreground-subtle">{selectedDate.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })} · {onDay.length} event(s)</span>
          <TimerTable timers={onDay} selectedId={selectedId} onSelect={(timer) => setSelectedId(timer.id)} onOpen={editor.edit} now={now} />
          <div className="flex justify-between">
            <RowActions timer={selected} onEdit={() => selected && editor.edit(selected)} />
            <TimerButton
              onClick={() => {
                editor.reset();
                const at = new Date(month.year, month.month0, day, 9, 0);
                editor.setDraft({ when: toDateTimeLocal(at.getTime()).replace("T", " ") });
              }}
            >
              New event
            </TimerButton>
          </div>
        </div>
      </div>
      <TimerForm kind="calendar" editing={editor.editing} draft={editor.draft} setDraft={editor.setDraft} onCommit={editor.commit} onNew={editor.reset} />
    </div>
  );
}

