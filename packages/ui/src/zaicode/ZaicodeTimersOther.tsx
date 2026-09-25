import { useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { formatZaicodeRemaining } from "./zaicodeTimers.js";
import {
  newZaicodeIntervalRule,
  ZAICODE_INTERVAL_DEFAULT_RULE,
  ZAICODE_INTERVAL_PRESETS,
  type ZaicodeIntervalRule,
} from "./zaicodeIntervalRules.js";
import {
  acknowledgeZaicodeProductivity,
  applyZaicodeProductivityDurations,
  describeZaicodeProductivity,
  formatZaicodeClock,
  resetZaicodeProductivity,
  skipZaicodeProductivityPhase,
  toggleZaicodeProductivity,
  zaicodeProductivityProgress,
} from "./zaicodeProductivity.js";
import { readZaicodeTempTimer, useZaicodeTimers } from "./zaicodeTimerStore.js";
import { ZaicodeSoundPicker } from "./ZaicodeSoundPicker.js";
import { playZaicodeSoundFile } from "./zaicodeSoundEvents.js";
import { useNowTick } from "./ZaicodeTimersAlarms.js";
import { ZaicodeTimeField } from "./ZaicodeTimeFields.js";
import {
  TimerButton,
  TimerCheck,
  TimerGroup,
  timerInputClass,
  TimerVolume,
} from "./ZaicodeTimerParts.js";

const test = (sound: string, volume: number) => void playZaicodeSoundFile(sound, { volume, preview: true, channel: "picker" });

// ---------------------------------------------------------------------------
// Interval reminders
// ---------------------------------------------------------------------------

export function ZaicodeIntervalTab() {
  const store = useZaicodeTimers();
  const rules = store.intervalRules;
  const [selectedId, setSelectedId] = useState<string | null>(rules[0]?.id ?? null);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const selected = rules.find((rule) => rule.id === selectedId) ?? null;
  const update = (patch: Partial<ZaicodeIntervalRule>) => {
    if (!selected) return;
    store.setIntervalRules(rules.map((rule) => (rule.id === selected.id ? { ...rule, ...patch } : rule)));
  };
  const move = (direction: -1 | 1) => {
    const index = rules.findIndex((rule) => rule.id === selectedId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= rules.length) return;
    const next = [...rules];
    [next[index], next[target]] = [next[target]!, next[index]!];
    store.setIntervalRules(next);
  };
  return (
    <div className="grid grid-cols-[1fr_1.2fr] gap-2">
      <TimerGroup title="Periodic reminders (top row wins a tie)">
        <div className="max-h-[220px] min-h-[120px] overflow-y-auto border border-border bg-background">
          {rules.length === 0 ? <div className="px-1 text-foreground-subtlest">No reminders. + New or Presets…</div> : null}
          {rules.map((rule) => (
            <button
              key={rule.id}
              type="button"
              className={cn("grid w-full grid-cols-[30px_1fr_54px] px-1 text-left hover:bg-hover", rule.id === selectedId && "bg-selected")}
              onClick={() => setSelectedId(rule.id)}
            >
              <span className={rule.enabled ? "text-[#8fd46a]" : "text-foreground-subtlest"}>{rule.enabled ? "ON" : "OFF"}</span>
              <span className="truncate text-foreground">{rule.name}</span>
              <span className="text-right tabular-nums text-foreground-subtle">{rule.minutes}m</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          <TimerButton
            onClick={() => {
              const rule = newZaicodeIntervalRule();
              store.setIntervalRules([...rules, rule]);
              setSelectedId(rule.id);
            }}
          >
            + New
          </TimerButton>
          <TimerButton disabled={!selected} onClick={() => selected && store.setIntervalRules(rules.filter((rule) => rule.id !== selected.id))}>Delete</TimerButton>
          <TimerButton disabled={!selected} onClick={() => move(-1)} title="Higher priority">▲</TimerButton>
          <TimerButton disabled={!selected} onClick={() => move(1)} title="Lower priority">▼</TimerButton>
          <TimerButton title="One hourly NEWDAY reminder (off)" onClick={() => store.setIntervalRules([{ ...ZAICODE_INTERVAL_DEFAULT_RULE }])}>Defaults</TimerButton>
          <TimerButton active={presetsOpen} onClick={() => setPresetsOpen((open) => !open)}>Presets…</TimerButton>
        </div>
        {presetsOpen ? (
          <div className="flex flex-col gap-px border border-border p-1">
            {ZAICODE_INTERVAL_PRESETS.map((preset) => (
              <TimerButton
                key={preset.id}
                className="text-left"
                onClick={() => {
                  const next = preset.rules();
                  store.setIntervalRules(next);
                  setSelectedId(next[0]?.id ?? null);
                  setPresetsOpen(false);
                }}
              >
                {preset.label}
              </TimerButton>
            ))}
          </div>
        ) : null}
      </TimerGroup>
      <TimerGroup title="Interval configuration">
        {selected ? (
          <>
            <div className="flex items-center gap-1">
              <input className={cn(timerInputClass, "flex-1")} value={selected.name} placeholder="Every New Hour" onChange={(event) => update({ name: event.target.value })} />
              <TimerCheck checked={selected.enabled} onChange={(enabled) => update({ enabled })} label="Enabled" />
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-foreground-subtle">Every</span>
              <input type="number" min={1} className={cn(timerInputClass, "w-16")} value={selected.minutes} onChange={(event) => update({ minutes: Math.max(1, Number(event.target.value) || 1) })} />
              <span className="text-foreground-subtle">min</span>
              {[15, 30, 45, 60, 90, 120, 240].map((minutes) => (
                <TimerButton key={minutes} active={selected.minutes === minutes} onClick={() => update({ minutes })}>
                  {minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`}
                </TimerButton>
              ))}
            </div>
            <div className="flex gap-1">
              <TimerButton active={selected.alignMode === "clock"} onClick={() => update({ alignMode: "clock" })} title="On the clock: :00, :30, …">
                Clock boundary (:00)
              </TimerButton>
              <TimerButton active={selected.alignMode === "elapsed"} onClick={() => update({ alignMode: "elapsed", lastFired: 0 })} title="N minutes after the previous one">
                Elapsed from start
              </TimerButton>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <TimerCheck checked={selected.allDay} onChange={(allDay) => update({ allDay })} label="All day (24/7)" />
              <span className={cn("text-foreground-subtle", selected.allDay && "opacity-40")}>From</span>
              <ZaicodeTimeField minute={selected.startMinute} disabled={selected.allDay} ariaLabel="Reminds from" onChange={(startMinute) => update({ startMinute })} />
              <span className={cn("text-foreground-subtle", selected.allDay && "opacity-40")}>To</span>
              <ZaicodeTimeField minute={selected.endMinute} disabled={selected.allDay} ariaLabel="Reminds until" onChange={(endMinute) => update({ endMinute })} />
            </div>
            <div className="flex items-center gap-1">
              <ZaicodeSoundPicker className="flex-1" value={selected.sound} onChange={(sound) => update({ sound })} previewVolume={selected.volume} />
              <TimerVolume value={selected.volume} onChange={(volume) => update({ volume })} />
              <TimerButton onClick={() => test(selected.sound, selected.volume)}>Test</TimerButton>
            </div>
            <div className="flex flex-wrap gap-x-3">
              <TimerCheck checked={selected.showNotification} onChange={(showNotification) => update({ showNotification })} label="Show notification card" />
              <TimerCheck checked={selected.showInTopBar} onChange={(showInTopBar) => update({ showInTopBar })} label="Show in top bar" />
            </div>
            <span className="text-foreground-subtlest">Changes apply at once.</span>
          </>
        ) : (
          <span className="text-foreground-subtlest">Select a reminder on the left.</span>
        )}
      </TimerGroup>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Temp Timer
// ---------------------------------------------------------------------------

export function ZaicodeTempTab() {
  const store = useZaicodeTimers();
  const now = useNowTick();
  const temp = store.temp;
  const live = readZaicodeTempTimer(store.timers);
  return (
    <div className="grid grid-cols-2 gap-2">
      <TimerGroup title="Temp Timer">
        <input className={timerInputClass} value={temp.name} placeholder="Name shown beside the countdown" onChange={(event) => store.setTemp({ name: event.target.value })} />
        <input className={timerInputClass} value={temp.description} placeholder="Optional notification text" onChange={(event) => store.setTemp({ description: event.target.value })} />
        <span className="text-foreground-subtle">Add now</span>
        <div className="grid grid-cols-6 gap-px">
          {[1, 5, 10, 15, 30, 60].map((minutes) => (
            <TimerButton key={minutes} title={`Add ${minutes} minutes`} onClick={() => store.addTempTimer(minutes)}>
              +{minutes}m
            </TimerButton>
          ))}
        </div>
        <label className="flex items-center gap-1 text-foreground-subtle" title="What Shift+Click on the clock and the hotkey add">
          Default add
          <input type="number" min={1} className={cn(timerInputClass, "w-16")} value={temp.incrementMinutes} onChange={(event) => store.setTemp({ incrementMinutes: Number(event.target.value) || 1 })} />
          min
        </label>
        <TimerCheck checked={temp.deleteAfterFire} onChange={(deleteAfterFire) => store.setTemp({ deleteAfterFire })} label="Delete after fire" />
        <div className="border border-border bg-background px-1.5 py-1 text-ui-sm tabular-nums text-foreground" data-zaicode-temp-status>
          {live ? `${live.name} — ${live.fired ? "done" : formatZaicodeRemaining((live.target - now) / 1000)}` : "No Temp Timer running."}
        </div>
        <div className="flex gap-1">
          <TimerButton active onClick={() => store.addTempTimer()}>Start / add</TimerButton>
          <TimerButton disabled={!live} onClick={store.removeTempTimer}>Remove Temp Timer</TimerButton>
          <TimerButton
            title="Fires in 3 seconds"
            onClick={() => store.addTimer({ name: temp.name, description: temp.description, target: Date.now() + 3000, sound: temp.sound, volume: temp.volume, deleteAfterFire: true, showInTopBar: false })}
          >
            Test
          </TimerButton>
        </div>
        <span className="text-foreground-subtlest">Shift+Click the clock in the title bar adds {temp.incrementMinutes} min from anywhere.</span>
      </TimerGroup>
      <TimerGroup title="Notification & sound">
        <TimerCheck checked={temp.showNotification} onChange={(showNotification) => store.setTemp({ showNotification })} label="Show notification" />
        <TimerCheck checked={temp.showInTopBar} onChange={(showInTopBar) => store.setTemp({ showInTopBar })} label="Show in top bar" />
        <div className="flex items-center gap-1">
          <ZaicodeSoundPicker className="flex-1" value={temp.sound} onChange={(sound) => store.setTemp({ sound })} previewVolume={temp.volume} />
          <TimerButton onClick={() => test(temp.sound, temp.volume)}>Test</TimerButton>
        </div>
        <TimerVolume value={temp.volume} onChange={(volume) => store.setTemp({ volume })} />
      </TimerGroup>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Productivity (work / break)
// ---------------------------------------------------------------------------

function MinSec({ label, seconds, onChange }: { label: string; seconds: number; onChange: (seconds: number) => void }) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return (
    <div className="flex items-center gap-1">
      <span className="w-12 text-foreground-subtle">{label}</span>
      <input type="number" min={0} className={cn(timerInputClass, "w-16")} value={minutes} onChange={(event) => onChange(Math.max(0, Number(event.target.value) || 0) * 60 + rest)} />
      <span className="text-foreground-subtle">min</span>
      <input type="number" min={0} max={59} className={cn(timerInputClass, "w-14")} value={rest} onChange={(event) => onChange(minutes * 60 + Math.max(0, Math.min(59, Number(event.target.value) || 0)))} />
      <span className="text-foreground-subtle">sec</span>
    </div>
  );
}

export function ZaicodeProductivityTab() {
  const store = useZaicodeTimers();
  const timer = store.productivity;
  const set = store.setProductivity;
  const progress = zaicodeProductivityProgress(timer);
  return (
    <div className="grid grid-cols-2 gap-2">
      <TimerGroup title="Work / break">
        <div className="flex items-baseline gap-2">
          <span className="text-[28px] leading-none tabular-nums text-foreground">{formatZaicodeClock(timer.remaining)}</span>
          <span className={timer.phase === "work" ? "text-[#f0c850]" : "text-[#8fd46a]"}>{timer.phase}</span>
        </div>
        <span className="relative block h-1.5 border border-border bg-background">
          <span className="absolute inset-y-0 left-0" style={{ width: `${Math.round(progress * 100)}%`, background: timer.phase === "work" ? "#f0c850" : "#8fd46a" }} />
        </span>
        <span className={timer.alarmPending ? "text-[#ff9a66]" : "text-foreground-subtle"}>{describeZaicodeProductivity(timer)}</span>
        <MinSec label="Work" seconds={timer.workSeconds} onChange={(seconds) => set((current) => applyZaicodeProductivityDurations(current, seconds))} />
        <MinSec label="Break" seconds={timer.breakSeconds} onChange={(seconds) => set((current) => applyZaicodeProductivityDurations(current, undefined, seconds))} />
        <div className="flex flex-wrap gap-x-3">
          <TimerCheck checked={timer.breaksEnabled} onChange={(breaksEnabled) => set((current) => ({ ...current, breaksEnabled }))} label="Take breaks" />
          <TimerCheck checked={timer.repeatAlarm} onChange={(repeatAlarm) => set((current) => ({ ...current, repeatAlarm }))} label="Keep ringing" title="Repeat the phase sound until you press Silence or Start" />
        </div>
        <div className="flex flex-wrap gap-1">
          <TimerButton active onClick={() => set(toggleZaicodeProductivity)}>{timer.state === "running" ? "Pause" : timer.state === "idle" ? "Start" : "Resume"}</TimerButton>
          <TimerButton disabled={!timer.alarmPending} onClick={() => set(acknowledgeZaicodeProductivity)}>Silence</TimerButton>
          <TimerButton onClick={() => set(skipZaicodeProductivityPhase)}>Skip phase</TimerButton>
          <TimerButton onClick={() => set(resetZaicodeProductivity)}>Reset</TimerButton>
        </div>
      </TimerGroup>
      <TimerGroup title="Phase completion sounds">
        <TimerCheck checked={timer.soundEnabled} onChange={(soundEnabled) => set((current) => ({ ...current, soundEnabled }))} label="Play sound on phase complete" />
        {(["work", "break"] as const).map((phase) => {
          const sound = phase === "work" ? timer.workSound : timer.breakSound;
          return (
            <div key={phase} className="flex items-center gap-1">
              <span className="w-12 text-foreground-subtle">{phase === "work" ? "Work" : "Break"}</span>
              <ZaicodeSoundPicker
                className="flex-1"
                value={sound}
                previewVolume={timer.volume}
                onChange={(next) => set((current) => (phase === "work" ? { ...current, workSound: next } : { ...current, breakSound: next }))}
              />
              <TimerButton onClick={() => test(sound, timer.volume)}>Test</TimerButton>
            </div>
          );
        })}
        <TimerVolume value={timer.volume} onChange={(volume) => set((current) => ({ ...current, volume }))} />
        <TimerCheck checked={timer.showNotification} onChange={(showNotification) => set((current) => ({ ...current, showNotification }))} label="Show a card when a phase ends" />
        <TimerCheck checked={timer.showInTopBar} onChange={(showInTopBar) => set((current) => ({ ...current, showInTopBar }))} label="Show in top bar while running" />
      </TimerGroup>
    </div>
  );
}
