import { formatZaicodeTimeOfDay } from "@zcode/shared";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { ZaicodeSoundPicker } from "./ZaicodeSoundPicker.js";
import { ZaicodeTimeField } from "./ZaicodeTimeFields.js";
import { playZaicodeSoundFile } from "./zaicodeSoundEvents.js";
import {
  ZAICODE_TIMER_MAX_SOUND_RULES,
  type ZaicodeTimer,
  type ZaicodeTimerSoundRule,
} from "./zaicodeTimers.js";

/** Shared pieces of the Timers window (FastPrompter's timer dialog, one look). */

export function TimerButton({ className, active, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "border px-1.5 py-px leading-4 disabled:opacity-40",
        active
          ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
          : "border-border bg-card text-foreground hover:bg-hover",
        className,
      )}
    />
  );
}

export function TimerGroup({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <fieldset className={cn("flex min-w-0 flex-col gap-1.5 border border-border px-2 pb-2 pt-1", className)}>
      <legend className="px-1 text-foreground-subtle">{title}</legend>
      {children}
    </fieldset>
  );
}

export const timerInputClass = "min-w-0 border border-border bg-background px-1 py-0.5 text-foreground";

export function TimerCheck({ checked, onChange, label, title }: { checked: boolean; onChange: (checked: boolean) => void; label: string; title?: string }) {
  return (
    <label className="flex items-center gap-1.5 text-foreground" title={title}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

export function TimerVolume({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <label className="flex items-center gap-1 text-foreground-subtle" title="Volume 0.00 – 1.00 (times the master volume)">
      Vol
      <input
        type="number"
        min={0}
        max={1}
        step={0.05}
        className={cn(timerInputClass, "w-16")}
        value={value.toFixed(2)}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(Math.max(0, Math.min(1, next)));
        }}
      />
    </label>
  );
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Epoch ms -> value of an <input type="datetime-local">. */
export function toDateTimeLocal(epoch: number): string {
  const date = new Date(epoch);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromDateTimeLocal(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])).getTime();
}

export function minuteToTime(minute: number): string {
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

export function timeToMinute(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  return match ? Math.min(1439, Number(match[1]) * 60 + Number(match[2])) : 0;
}

export function formatTimerMoment(epoch: number): string {
  const date = new Date(epoch);
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${formatZaicodeTimeOfDay(date)}`;
}

export const REPEAT_LABELS: Record<ZaicodeTimer["repeat"], string> = {
  once: "Once",
  interval: "Interval",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
};

/** The "Notification & Sound" block: flags, colour, volume, one sound or a random pool. */
export type TimerBehavior = Pick<
  ZaicodeTimer,
  "showNotification" | "showInTopBar" | "colorMode" | "color" | "volume" | "sound" | "soundMode" | "soundRules"
>;

export function TimerBehaviorEditor({ value, onChange }: { value: TimerBehavior; onChange: (patch: Partial<TimerBehavior>) => void }) {
  const setRule = (index: number, patch: Partial<ZaicodeTimerSoundRule>) =>
    onChange({ soundRules: value.soundRules.map((rule, current) => (current === index ? { ...rule, ...patch } : rule)) });
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <TimerCheck checked={value.showNotification} onChange={(showNotification) => onChange({ showNotification })} label="Show notification" />
        <TimerCheck checked={value.showInTopBar} onChange={(showInTopBar) => onChange({ showInTopBar })} label="Show in top bar" />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <TimerCheck
          checked={value.colorMode === "temperature"}
          onChange={(heat) => onChange({ colorMode: heat ? "temperature" : "static" })}
          label="Heat colour"
          title="Blue a day out, warming to red in the last minutes"
        />
        {value.colorMode === "static" ? (
          <input type="color" value={value.color} onChange={(event) => onChange({ color: event.target.value })} title="Timer colour" />
        ) : null}
        <TimerVolume value={value.volume} onChange={(volume) => onChange({ volume })} />
      </div>
      <TimerCheck
        checked={value.soundMode === "pool"}
        onChange={(pool) =>
          onChange({
            soundMode: pool ? "pool" : "single",
            ...(pool && value.soundRules.length === 0
              ? { soundRules: [{ sound: value.sound, enabled: true, allDay: true, startMinute: 0, endMinute: 0, volume: null }] }
              : {}),
          })
        }
        label="Random sound pool"
        title="Pick a random sound from the rows whose time window covers the moment; none eligible = silent"
      />
      {value.soundMode === "single" ? (
        <div className="flex items-center gap-1">
          <ZaicodeSoundPicker className="flex-1" value={value.sound} onChange={(sound) => onChange({ sound })} previewVolume={value.volume} />
          <TimerButton onClick={() => void playZaicodeSoundFile(value.sound, { volume: value.volume, preview: true, channel: "picker" })}>Test</TimerButton>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="grid grid-cols-[16px_minmax(0,1fr)_28px_48px_48px_46px_24px] items-center gap-1 text-foreground-subtlest">
            <span>On</span>
            <span>Sound</span>
            <span title="All day: the row plays at any time">All</span>
            <span>From</span>
            <span>To</span>
            <span title="Empty = the timer's volume">Vol</span>
            <span />
            {value.soundRules.map((rule, index) => (
              <PoolRow key={index} rule={rule} timerVolume={value.volume} onChange={(patch) => setRule(index, patch)} onRemove={() => onChange({ soundRules: value.soundRules.filter((_, current) => current !== index) })} />
            ))}
          </div>
          <div className="flex gap-1">
            <TimerButton
              disabled={value.soundRules.length >= ZAICODE_TIMER_MAX_SOUND_RULES}
              onClick={() =>
                onChange({
                  soundRules: [...value.soundRules, { sound: value.sound, enabled: true, allDay: true, startMinute: 0, endMinute: 0, volume: null }],
                })
              }
            >
              Add sound
            </TimerButton>
            <span className="text-foreground-subtlest">All = any time · From–To may pass midnight · max {ZAICODE_TIMER_MAX_SOUND_RULES}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function PoolRow({
  rule,
  timerVolume,
  onChange,
  onRemove,
}: {
  rule: ZaicodeTimerSoundRule;
  timerVolume: number;
  onChange: (patch: Partial<ZaicodeTimerSoundRule>) => void;
  onRemove: () => void;
}) {
  // All day is its own switch: 00:00 is an ordinary time (midnight), never "all day" in disguise.
  return (
    <>
      <input type="checkbox" checked={rule.enabled} onChange={(event) => onChange({ enabled: event.target.checked })} />
      <ZaicodeSoundPicker value={rule.sound} onChange={(sound) => onChange({ sound })} previewVolume={rule.volume ?? timerVolume} />
      <input
        type="checkbox"
        className="justify-self-center"
        checked={rule.allDay}
        title="All day: this row may play at any time"
        onChange={(event) =>
          onChange(
            // An empty window (From = To) would never play: unticking All starts from 09:00–18:00.
            !event.target.checked && rule.startMinute === rule.endMinute
              ? { allDay: false, startMinute: 9 * 60, endMinute: 18 * 60 }
              : { allDay: event.target.checked },
          )
        }
      />
      <ZaicodeTimeField minute={rule.startMinute} disabled={rule.allDay} ariaLabel="Plays from" onChange={(startMinute) => onChange({ startMinute })} />
      <ZaicodeTimeField minute={rule.endMinute} disabled={rule.allDay} ariaLabel="Plays until" onChange={(endMinute) => onChange({ endMinute })} />
      <input
        type="number"
        min={0}
        max={1}
        step={0.05}
        placeholder="timer"
        className={timerInputClass}
        value={rule.volume === null ? "" : rule.volume.toFixed(2)}
        onChange={(event) => onChange({ volume: event.target.value === "" ? null : Math.max(0, Math.min(1, Number(event.target.value) || 0)) })}
      />
      <TimerButton onClick={onRemove} title="Remove this row">
        ✕
      </TimerButton>
    </>
  );
}
