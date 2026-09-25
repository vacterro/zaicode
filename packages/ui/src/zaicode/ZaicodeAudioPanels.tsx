/* eslint-disable max-lines -- ZAICODE audio panels (director, problip, ambience) read and write one audio settings store; kept together so that store has one UI surface. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Metronome, Play, Square } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZaicodeRunningSessions } from "./zaicodeSidebarPrefs.js";
import {
  PROBLIP_GOAL,
  PROBLIP_INTERVALS,
  PROBLIP_SOUNDS,
  isZaicodeAmbiencePreviewing,
  listAmbienceSounds,
  playProblipCue,
  problipStats,
  resetZaicodeProblipCounters,
  setZaicodeAmbience,
  setZaicodeAmbiencePreview,
  setZaicodeAmbienceWorking,
  setZaicodeProblip,
  stopAllZaicodeAudio,
  syncZaicodeProblip,
  useZaicodeAmbienceStatus,
  useZaicodeAudio,
  type ProblipIntervalMode,
} from "./zaicodeAudio.js";
import { playZaicodeCue } from "./zaicodeCues.js";
import { ZaicodeSoundPicker } from "./ZaicodeSoundPicker.js";
import {
  ZAICODE_SOUND_EVENTS,
  setZaicodeSoundSettings,
  useZaicodeSoundSettings,
} from "./zaicodeSoundEvents.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import { useTabStore } from "@/store/TabStoreProvider.js";

const buttonClass =
  "border border-border bg-card px-2 py-0.5 text-ui-xs text-foreground hover:bg-hover disabled:opacity-40";
const stepClass =
  "flex h-5 w-5 items-center justify-center border border-border bg-card text-foreground hover:bg-hover disabled:opacity-40";

/**
 * Always-mounted driver: ambience follows "is anything working", Problip
 * follows its switch, and the "Work started" cue fires on idle -> working.
 */
export function ZaicodeAudioDirector() {
  const working = useZaicodeRunningSessions((state) => state.sessions.length > 0);
  const { problip } = useZaicodeAudio();
  const wasWorkingRef = useRef(working);
  useEffect(() => {
    setZaicodeAmbienceWorking(working);
    if (working && !wasWorkingRef.current) void playZaicodeCue("started");
    wasWorkingRef.current = working;
  }, [working]);
  useEffect(() => {
    syncZaicodeProblip();
  }, [problip.running]);
  return null;
}

function Stepper({
  value,
  min,
  max,
  suffix,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  suffix?: string;
  label: string;
  onChange: (value: number) => void;
}) {
  return (
    <span className="flex items-center gap-1" role="group" aria-label={label}>
      <button type="button" className={stepClass} disabled={value <= min} onClick={() => onChange(value - 1)} aria-label={`${label} -1`}>
        −
      </button>
      <span className="min-w-10 text-center tabular-nums">
        {value}
        {suffix}
      </span>
      <button type="button" className={stepClass} disabled={value >= max} onClick={() => onChange(value + 1)} aria-label={`${label} +1`}>
        +
      </button>
    </span>
  );
}

/** Full Problip controls: start/stop/test, interval, sound pool, volume, courtesy, statistics. */
export function ZaicodeProblipPanel({ className }: { className?: string }) {
  const { problip, problipDays } = useZaicodeAudio();
  const stats = problipStats(problipDays);
  const [message, setMessage] = useState("");
  return (
    <div className={cn("flex flex-col gap-2 text-ui-xs text-foreground", className)} data-zaicode-problip-panel>
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            "min-w-10 border px-1 text-center",
            problip.running
              ? "border-[var(--color-success)] text-[var(--color-success)]"
              : "border-border text-foreground-subtlest",
          )}
        >
          {problip.running ? "ON" : "OFF"}
        </span>
        <button type="button" className={buttonClass} disabled={problip.running} onClick={() => setZaicodeProblip({ running: true })}>
          Start
        </button>
        <button type="button" className={buttonClass} disabled={!problip.running} onClick={() => setZaicodeProblip({ running: false })}>
          Stop
        </button>
        <button
          type="button"
          className={buttonClass}
          title="Play one Problip sound now. No statistics, no interval change."
          onClick={() => void playProblipCue({ test: true }).then((ok) => setMessage(ok ? "" : "Could not play"))}
        >
          Test
        </button>
        {problip.showCounter ? (
          <span className="ml-auto tabular-nums text-foreground-subtle">{stats.today} today</span>
        ) : null}
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-foreground-subtle">Interval</span>
        <select
          className="border border-border bg-background px-1 py-0.5 text-foreground"
          value={problip.interval}
          onChange={(event) => setZaicodeProblip({ interval: event.target.value as ProblipIntervalMode })}
        >
          {PROBLIP_INTERVALS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {problip.interval === "MANUAL" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground-subtle">From</span>
          <Stepper label="From seconds" value={problip.manualFrom} min={1} max={3600} suffix=" s" onChange={(manualFrom) => setZaicodeProblip({ manualFrom })} />
          <span className="text-foreground-subtle">to</span>
          <Stepper label="To seconds" value={problip.manualTo} min={1} max={3600} suffix=" s" onChange={(manualTo) => setZaicodeProblip({ manualTo })} />
        </div>
      ) : null}
      <fieldset className="flex flex-col gap-1">
        <legend className="text-foreground-subtle">Sound pool</legend>
        <div className="grid grid-cols-3 gap-x-2 gap-y-0.5">
          {PROBLIP_SOUNDS.map((sound) => {
            const checked = problip.sounds.includes(sound.id);
            return (
              <label key={sound.id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    setZaicodeProblip({
                      sounds: checked
                        ? problip.sounds.filter((id) => id !== sound.id)
                        : [...problip.sounds, sound.id],
                    })
                  }
                />
                <span className="truncate">{sound.label}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <label className="flex items-center gap-2">
        <span className="w-12 shrink-0 text-foreground-subtle">Volume</span>
        <input
          type="range"
          min={0}
          max={100}
          value={problip.volume}
          className="min-w-0 flex-1"
          onChange={(event) => setZaicodeProblip({ volume: Number(event.target.value) })}
        />
        <span className="w-8 text-right tabular-nums">{problip.volume}%</span>
      </label>
      <label className="flex items-center gap-1.5" title="A scheduled cue stands down instead of talking over another sound.">
        <input type="checkbox" checked={problip.skipWhileBusy} onChange={(event) => setZaicodeProblip({ skipWhileBusy: event.target.checked })} />
        Skip while another sound plays
      </label>
      <label className="flex items-center gap-1.5">
        <input type="checkbox" checked={problip.runOnLaunch} onChange={(event) => setZaicodeProblip({ runOnLaunch: event.target.checked })} />
        Keep running across restarts
      </label>
      <label className="flex items-center gap-1.5">
        <input type="checkbox" checked={problip.showCounter} onChange={(event) => setZaicodeProblip({ showCounter: event.target.checked })} />
        Show counter
      </label>
      <div className="flex flex-col gap-1 border border-border p-1.5 bg-background">
        <div className="flex items-center justify-between text-foreground-subtle">
          <span>Goal: {PROBLIP_GOAL.toLocaleString()} blips</span>
          <span className="font-mono text-foreground">
            {((stats.total / PROBLIP_GOAL) * 100).toFixed(2)}%
          </span>
        </div>
        <div className="h-1.5 w-full bg-border/40 overflow-hidden">
          <div
            className="h-full bg-[var(--color-success)] transition-all"
            style={{ width: `${Math.min(100, (stats.total / PROBLIP_GOAL) * 100)}%` }}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-3 tabular-nums text-foreground-subtle">
        <span>Today: {stats.today.toLocaleString()}</span>
        <span>Week: {stats.week.toLocaleString()}</span>
        <span>Month: {stats.month.toLocaleString()}</span>
        <span>Total: {stats.total.toLocaleString()}</span>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className={buttonClass} onClick={stopAllZaicodeAudio} title="Silence Problip and ambience at once">
          STOP ALL SOUND
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={resetZaicodeProblipCounters}
          title="Reset all problip counters back to zero"
        >
          Reset counters
        </button>
        <span role="status" className="text-destructive">{message}</span>
      </div>
      <p className="text-foreground-subtlest">
        Problip plays one short cue at your chosen interval so a long working session keeps its rhythm.
      </p>
    </div>
  );
}

const AMBIENCE_STATE_TEXT: Record<string, string> = {
  off: "Off — ambience is switched off.",
  silent: "Silent — starts by itself when an agent starts working.",
  blocked: "Waiting for your first click or key (the system blocks sound until then).",
  missing: "The selected sound file is missing — pick another one.",
};

function soundLabel(id: string): string {
  return id.replace(/^fastprompter:/, "");
}

/**
 * Ambience settings: background layer while agents work. Everything applies
 * live: click a sound to switch to it even while it plays, volume moves at
 * once, and the status line always says what is playing and why.
 */
export function ZaicodeAmbiencePanel() {
  const { ambience } = useZaicodeAudio();
  const status = useZaicodeAmbienceStatus();
  const sounds = useMemo(() => listAmbienceSounds(), []);
  const [search, setSearch] = useState("");
  const [previewing, setPreviewing] = useState(isZaicodeAmbiencePreviewing);
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return query
      ? sounds.filter((sound) => sound.id === ambience.sound || sound.label.toLocaleLowerCase().includes(query))
      : sounds;
  }, [ambience.sound, search, sounds]);
  const volumeMilli = Math.round(ambience.volume * 1000);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, []);
  // Leaving the settings page ends a preview; work-driven playback keeps going.
  useEffect(() => () => setZaicodeAmbiencePreview(false), []);
  const togglePreview = (on: boolean) => {
    setPreviewing(on);
    setZaicodeAmbiencePreview(on);
  };
  const playing = status.state === "playing";

  return (
    <div className="flex flex-col gap-2 text-ui-xs text-foreground" data-zaicode-ambience-panel>
      <div
        role="status"
        className={cn(
          "flex items-center gap-2 border px-2 py-1",
          playing ? "border-[var(--color-success)]" : "border-border",
        )}
        data-zaicode-ambience-state={status.state}
      >
        <span
          className={cn("size-2 shrink-0 border border-black", playing && "animate-pulse")}
          style={{
            background: playing
              ? "var(--color-success)"
              : status.state === "blocked" || status.state === "missing"
                ? "var(--color-warning)"
                : "var(--color-foreground-subtlest)",
          }}
        />
        <span className="min-w-0 flex-1">
          {playing
            ? `Playing ${soundLabel(status.sound)} at ${status.volume.toFixed(3)} — ${
                status.reason === "preview" ? "preview" : "agents are working"
              }`
            : AMBIENCE_STATE_TEXT[status.state]}
        </span>
      </div>
      <label className="flex items-center gap-1.5">
        <input type="checkbox" checked={ambience.enabled} onChange={(event) => setZaicodeAmbience({ enabled: event.target.checked })} />
        Play while agents work (fades in when work starts, out when everything is idle)
      </label>
      <div className="flex flex-col gap-1">
        <span className="flex items-center justify-between text-foreground-subtle">
          <span>
            Sound: <strong className="font-normal text-foreground">{soundLabel(ambience.sound)}</strong>
          </span>
          <span>{sounds.length} sounds · click to switch, ▶ to listen</span>
        </span>
        <input
          className="border border-border bg-background px-1 py-0.5 text-foreground"
          placeholder="Search…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="max-h-40 overflow-y-auto border border-border bg-background" role="listbox">
          {visible.map((sound) => {
            const selected = sound.id === ambience.sound;
            return (
              <div
                key={sound.id}
                className={cn("flex items-center", selected ? "bg-selected" : "hover:bg-hover")}
              >
                <button
                  type="button"
                  className="flex size-5 shrink-0 items-center justify-center text-foreground-subtle hover:text-foreground"
                  title="Switch to this sound and listen"
                  onClick={() => {
                    setZaicodeAmbience({ sound: sound.id });
                    togglePreview(true);
                  }}
                >
                  <Play className="size-3" />
                </button>
                <button
                  ref={selected ? selectedRef : undefined}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={cn("min-w-0 flex-1 truncate px-1 text-left", selected && "text-foreground")}
                  onClick={() => setZaicodeAmbience({ sound: sound.id })}
                >
                  {sound.label}
                  {selected ? "  ◀" : ""}
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-12 shrink-0 text-foreground-subtle">Volume</span>
        <Stepper
          label="Ambience volume (thousandths)"
          value={volumeMilli}
          min={0}
          max={1000}
          onChange={(value) => setZaicodeAmbience({ volume: value / 1000 })}
        />
        <input
          type="range"
          min={0}
          max={200}
          value={Math.min(200, volumeMilli)}
          className="min-w-0 flex-1"
          onChange={(event) => setZaicodeAmbience({ volume: Number(event.target.value) / 1000 })}
        />
        <span className="w-12 text-right tabular-nums">{ambience.volume.toFixed(3)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-foreground-subtle">Fade in</span>
        <Stepper label="Fade in (0.5 s steps)" value={ambience.fadeInMs / 500} min={0} max={20} onChange={(value) => setZaicodeAmbience({ fadeInMs: value * 500 })} />
        <span className="text-foreground-subtle">× 0.5 s · Fade out</span>
        <Stepper label="Fade out (0.5 s steps)" value={ambience.fadeOutMs / 500} min={0} max={20} onChange={(value) => setZaicodeAmbience({ fadeOutMs: value * 500 })} />
        <span className="text-foreground-subtle">× 0.5 s</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={cn(buttonClass, "flex items-center gap-1", previewing && "border-[var(--color-success)]")}
          onClick={() => togglePreview(!previewing)}
        >
          {previewing ? <Square className="size-3" /> : <Play className="size-3" />}
          {previewing ? "Stop preview" : "Preview"}
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() => {
            setPreviewing(false);
            stopAllZaicodeAudio();
          }}
        >
          STOP ALL SOUND
        </button>
      </div>
    </div>
  );
}

/**
 * Ambience, the minimum: on / off, which loop (the sound picker opens on the
 * long sounds; a click or the wheel plays them), how loud, a preview. Sits next to
 * Problip in Settings -> Sounds; fades keep their values from the full panel.
 */
export function ZaicodeAmbienceCompact() {
  const { ambience } = useZaicodeAudio();
  const status = useZaicodeAmbienceStatus();
  const [previewing, setPreviewing] = useState(isZaicodeAmbiencePreviewing);
  useEffect(() => () => setZaicodeAmbiencePreview(false), []);
  const togglePreview = (on: boolean) => {
    setPreviewing(on);
    setZaicodeAmbiencePreview(on);
  };
  const playing = status.state === "playing";
  const volumeMilli = Math.round(ambience.volume * 1000);
  return (
    <div className="flex flex-col gap-2 text-ui-xs text-foreground" data-zaicode-ambience-compact>
      <label className="flex items-center gap-1.5">
        <input type="checkbox" checked={ambience.enabled} onChange={(event) => setZaicodeAmbience({ enabled: event.target.checked })} />
        Play a quiet loop while agents work
      </label>
      <div className="flex items-center gap-2">
        <span className="w-12 shrink-0 text-foreground-subtle">Sound</span>
        <ZaicodeSoundPicker
          className="min-w-0 flex-1"
          value={ambience.sound}
          preferKind="ambience"
          previewVolume={Math.max(0.05, ambience.volume)}
          disabled={!ambience.enabled}
          onChange={(sound) => setZaicodeAmbience({ sound })}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="w-12 shrink-0 text-foreground-subtle">Volume</span>
        <input
          type="range"
          min={0}
          max={200}
          value={Math.min(200, volumeMilli)}
          className="min-w-0 flex-1"
          disabled={!ambience.enabled}
          onChange={(event) => setZaicodeAmbience({ volume: Number(event.target.value) / 1000 })}
        />
        <span className="w-10 text-right tabular-nums">{ambience.volume.toFixed(3)}</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={cn(buttonClass, "flex items-center gap-1", previewing && "border-[var(--color-success)]")}
          onClick={() => togglePreview(!previewing)}
        >
          {previewing ? <Square className="size-3" /> : <Play className="size-3" />}
          {previewing ? "Stop" : "Preview"}
        </button>
        <span className={cn("min-w-0 truncate", playing ? "text-foreground" : "text-foreground-subtle")} role="status">
          {playing
            ? `Playing — ${status.reason === "preview" ? "preview" : "agents are working"}`
            : AMBIENCE_STATE_TEXT[status.state]}
        </span>
      </div>
    </div>
  );
}

/**
 * The per-event sound table lives in Settings -> Sounds (every action has its
 * own row); the notifications page only keeps the master switches and a jump.
 */
export function ZaicodeSoundsShortcut() {
  const settings = useZaicodeSoundSettings();
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const enabledCount = Object.values(settings.events).filter((row) => row.enabled).length;
  return (
    <div className="flex flex-wrap items-center gap-3 text-ui-xs text-foreground" data-zaicode-cue-panel>
      <label className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={!settings.muted}
          onChange={(event) => setZaicodeSoundSettings({ muted: !event.target.checked })}
        />
        ZAICODE sounds on
      </label>
      <span className="text-foreground-subtle">
        {enabledCount} of {ZAICODE_SOUND_EVENTS.length} actions have a sound · master {settings.masterVolume}%
      </span>
      <button
        type="button"
        className="border border-border px-2 py-0.5 hover:bg-hover"
        onClick={() => {
          setPendingSettingsSection("zaicodeSounds");
          openSettingsTab();
        }}
      >
        Open Sounds…
      </button>
    </div>
  );
}

function formatProblipBadge(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * Footer button next to Settings: opens the Problip panel; shows ON state and
 * today's count. Right-click opens the full Ambience settings (SRC-038).
 */
export function ZaicodeProblipButton() {
  const { problip, problipDays } = useZaicodeAudio();
  const stats = problipStats(problipDays);
  const today = stats.today;
  const total = stats.total;
  const [ambienceOpen, setAmbienceOpen] = useState(false);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  return (
    <Popover open={ambienceOpen} onOpenChange={setAmbienceOpen}>
      <PopoverAnchor asChild>
        <span className="flex">
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Problip ${problip.running ? "on" : "off"}`}
          title={`Problip — ${problip.running ? "running" : "stopped"}. Today: ${today.toLocaleString()} · Total: ${total.toLocaleString()} / ${PROBLIP_GOAL.toLocaleString()} goal. Click: Problip. Right-click: Ambience.`}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setAmbienceOpen(true);
          }}
          className={cn(
            "relative flex size-8 items-center justify-center text-foreground-subtle hover:bg-hover hover:text-foreground",
            problip.running && "text-[var(--color-success)]",
          )}
          data-zaicode-problip-button
        >
          <Metronome className="size-4" />
          {problip.running && problip.showCounter && today > 0 ? (
            <span className="absolute -bottom-0.5 -right-0.5 bg-background px-0.5 text-[9px] leading-none tabular-nums text-foreground">
              {formatProblipBadge(today)}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80 border border-border bg-popover p-3">
        <div className="mb-2 text-ui-sm text-foreground">PROBLIP</div>
        <ZaicodeProblipPanel />
      </PopoverContent>
    </Popover>
        </span>
      </PopoverAnchor>
      <PopoverContent side="top" align="end" className="w-96 border border-border bg-popover p-3" data-zaicode-ambience-popover>
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-ui-sm text-foreground">AMBIENCE</span>
          <button
            type="button"
            className="border border-border px-1.5 text-ui-xs text-foreground-subtle hover:bg-hover hover:text-foreground"
            onClick={() => {
              setAmbienceOpen(false);
              setPendingSettingsSection("zaicodeSounds");
              openSettingsTab();
            }}
          >
            All sounds…
          </button>
        </div>
        <ZaicodeAmbiencePanel />
      </PopoverContent>
    </Popover>
  );
}
