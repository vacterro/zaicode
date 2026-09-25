/* eslint-disable max-lines -- ZAICODE audio store owns problip counters, ambience playback and their settings in one module so each has a single owner. */
import { notifyZaicode } from "./zaicodeNotifications.js";
import { useSyncExternalStore } from "react";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import { listTaskNotificationSounds } from "@/lib/taskNotificationSound.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";

/**
 * ZAICODE audio, ported from FastPrompter:
 *
 * AMBIENCE — one looping background layer that fades in when work starts
 * (at least one session running) and fades out when everything is idle.
 * Default: computalk1.wav at volume 0.03. Sound, volume and fades are settings.
 *
 * PROBLIP — a courtesy metronome: one short blip at the chosen interval
 * (random 4-7 s, fixed 5/10/15/20/30 s, pulse 5 s / 10-20 s, or a manual
 * range) from a pool of six sounds. "Skip while busy" never talks over other
 * audio. Start / Stop / Test, counters per day / week / month / total.
 *
 * Settings are renderer-local (localStorage) and apply live.
 */

// ---------------------------------------------------------------------------
// Sound catalog
// ---------------------------------------------------------------------------

const problipFiles = import.meta.glob("../assets/fastprompter-sounds/problip/*.wav", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

function problipUrl(file: string): string | null {
  const entry = Object.entries(problipFiles).find(([path]) => path.endsWith(`/${file}`));
  return entry?.[1] ?? null;
}

export const PROBLIP_SOUNDS = [
  { id: "sound_original", label: "Original Blip", file: "blip01.wav" },
  { id: "sound_glass", label: "Glass", file: "blip_glass.wav" },
  { id: "sound_wood", label: "Wood", file: "blip_wood.wav" },
  { id: "sound_soft_bell", label: "Soft Bell", file: "blip_soft_bell.wav" },
  { id: "sound_bonk", label: "Bonk", file: "blip_bonk.wav" },
  { id: "sound_space", label: "Space", file: "blip_space.wav" },
] as const;

export type ProblipIntervalMode =
  | "RANDOM_4_7"
  | "FIXED_5S"
  | "FIXED_10S"
  | "FIXED_15S"
  | "FIXED_20S"
  | "FIXED_30S"
  | "PULSE"
  | "MANUAL";

export const PROBLIP_INTERVALS: readonly { id: ProblipIntervalMode; label: string }[] = [
  { id: "RANDOM_4_7", label: "Random 4-7 s" },
  { id: "FIXED_5S", label: "Every 5 s" },
  { id: "FIXED_10S", label: "Every 10 s" },
  { id: "FIXED_15S", label: "Every 15 s" },
  { id: "FIXED_20S", label: "Every 20 s" },
  { id: "FIXED_30S", label: "Every 30 s" },
  { id: "PULSE", label: "Pulse 5 s / 10-20 s" },
  { id: "MANUAL", label: "Manual range" },
];

/** Ambience candidates: the whole ported FastPrompter collection. */
export function listAmbienceSounds(): readonly { id: string; label: string }[] {
  return listTaskNotificationSounds();
}

const ambienceFiles = import.meta.glob("../assets/fastprompter-sounds/**/*.{wav,mp3,ogg}", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

function ambienceUrl(id: string): string | null {
  const rel = id.replace(/^fastprompter:/, "");
  const entry = Object.entries(ambienceFiles).find(([path]) =>
    path.endsWith(`/fastprompter-sounds/${rel}`),
  );
  return entry?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface ZaicodeAmbienceSettings {
  enabled: boolean;
  sound: string;
  /** 0..1 linear gain. */
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
}

export interface ZaicodeProblipSettings {
  running: boolean;
  runOnLaunch: boolean;
  interval: ProblipIntervalMode;
  manualFrom: number;
  manualTo: number;
  sounds: string[];
  /** 0..100 percent. */
  volume: number;
  skipWhileBusy: boolean;
  showCounter: boolean;
}

export interface ZaicodeAudioSettings {
  ambience: ZaicodeAmbienceSettings;
  problip: ZaicodeProblipSettings;
  /** yyyy-mm-dd -> blips played that day. */
  problipDays: Record<string, number>;
}

const STORAGE_KEY = "zaicode-audio-v1";
const CHANGE_EVENT = "zaicode-audio-changed";

const DEFAULT_SETTINGS: ZaicodeAudioSettings = {
  ambience: {
    enabled: true,
    sound: "fastprompter:computalk1.wav",
    volume: 0.03,
    fadeInMs: 1500,
    fadeOutMs: 2500,
  },
  problip: {
    running: false,
    runOnLaunch: false,
    interval: "RANDOM_4_7",
    manualFrom: 4,
    manualTo: 7,
    sounds: ["sound_original"],
    volume: 5,
    skipWhileBusy: true,
    showCounter: true,
  },
  problipDays: {},
};

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function normalize(raw: Partial<ZaicodeAudioSettings> | null): ZaicodeAudioSettings {
  const a = { ...DEFAULT_SETTINGS.ambience, ...raw?.ambience };
  const p = { ...DEFAULT_SETTINGS.problip, ...raw?.problip };
  const from = Math.round(clamp(p.manualFrom, 1, 3600, 4));
  const to = Math.round(clamp(p.manualTo, 1, 3600, 7));
  const sounds = Array.isArray(p.sounds)
    ? p.sounds.filter((id): id is string => PROBLIP_SOUNDS.some((sound) => sound.id === id))
    : [];
  const days: Record<string, number> = {};
  for (const [day, count] of Object.entries(raw?.problipDays ?? {})) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof count === "number" && count > 0) days[day] = count;
  }
  return {
    ambience: {
      enabled: a.enabled !== false,
      sound: typeof a.sound === "string" && a.sound ? a.sound : DEFAULT_SETTINGS.ambience.sound,
      volume: clamp(a.volume, 0, 1, DEFAULT_SETTINGS.ambience.volume),
      fadeInMs: Math.round(clamp(a.fadeInMs, 0, 10_000, 1500)),
      fadeOutMs: Math.round(clamp(a.fadeOutMs, 0, 10_000, 2500)),
    },
    problip: {
      running: p.running === true,
      runOnLaunch: p.runOnLaunch === true,
      interval: PROBLIP_INTERVALS.some((option) => option.id === p.interval)
        ? p.interval
        : "RANDOM_4_7",
      manualFrom: Math.min(from, to),
      manualTo: Math.max(from, to),
      sounds: sounds.length > 0 ? sounds : ["sound_original"],
      volume: Math.round(clamp(p.volume, 0, 100, 5)),
      skipWhileBusy: p.skipWhileBusy !== false,
      showCounter: p.showCounter !== false,
    },
    problipDays: days,
  };
}

let cached: ZaicodeAudioSettings | null = null;

export function readZaicodeAudio(): ZaicodeAudioSettings {
  if (cached) return cached;
  try {
    cached = normalize(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null"));
    // "Run on launch" decides whether a previous session's running state survives a restart.
    if (!cached.problip.runOnLaunch) cached = { ...cached, problip: { ...cached.problip, running: false } };
  } catch {
    cached = normalize(null);
  }
  return cached;
}

function write(next: ZaicodeAudioSettings): void {
  cached = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Settings still apply for this window.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function setZaicodeAmbience(patch: Partial<ZaicodeAmbienceSettings>): void {
  const current = readZaicodeAudio();
  write(normalize({ ...current, ambience: { ...current.ambience, ...patch } }));
}

export function setZaicodeProblip(patch: Partial<ZaicodeProblipSettings>): void {
  const current = readZaicodeAudio();
  write(normalize({ ...current, problip: { ...current.problip, ...patch } }));
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

export function useZaicodeAudio(): ZaicodeAudioSettings {
  return useSyncExternalStore(subscribe, readZaicodeAudio, readZaicodeAudio);
}

// ---------------------------------------------------------------------------
// Problip statistics
// ---------------------------------------------------------------------------

function dayKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function problipStats(days: Readonly<Record<string, number>>, now = new Date()) {
  const today = dayKey(now);
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const week = dayKey(weekStart);
  const month = today.slice(0, 7);
  let total = 0;
  let weekCount = 0;
  let monthCount = 0;
  for (const [day, count] of Object.entries(days)) {
    total += count;
    if (day >= week && day <= today) weekCount += count;
    if (day.startsWith(month)) monthCount += count;
  }
  return { today: days[today] ?? 0, week: weekCount, month: monthCount, total };
}

export const PROBLIP_GOAL = 1_000_000;
export const PROBLIP_MAX_STACK = 100_000_000;

export function resetZaicodeProblipCounters(): void {
  const current = readZaicodeAudio();
  write({
    ...current,
    problipDays: {},
  });
}

function recordBlip(): void {
  const current = readZaicodeAudio();
  const key = dayKey(new Date());
  const nextCount = Math.min(PROBLIP_MAX_STACK, (current.problipDays[key] ?? 0) + 1);
  const total = Object.values(current.problipDays).reduce((sum, count) => sum + count, 0) + 1;
  if (total >= 1000 && /^[1-9]0*$/.test(String(total))) {
    playZaicodeSound("problip.goal");
    notifyZaicode("problip.goal", { header: "Problip", title: `${total} problips`, key: "problip-goal" });
  }
  write({
    ...current,
    problipDays: { ...current.problipDays, [key]: nextCount },
  });
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

/**
 * AMBIENCE ENGINE — one reconciler, one truth.
 *
 * Two reasons can want the layer: `working` (an agent session runs) and
 * `preview` (the operator pressed Preview). reconcileAmbience() compares what
 * should play (reason, sound, volume) with what plays and fixes the difference:
 * a new sound crossfades in right away, a volume change applies within 150 ms,
 * no reason fades out. Every change in the settings calls it, so the sound can
 * be changed while it plays and nothing ever stays "locked" on an old file.
 * The live status (playing / silent / blocked / missing) is published for the UI.
 */
export type ZaicodeAmbienceState = "off" | "silent" | "playing" | "blocked" | "missing";

export interface ZaicodeAmbienceStatus {
  state: ZaicodeAmbienceState;
  reason: "working" | "preview" | null;
  sound: string;
  volume: number;
}

let ambienceWorking = false;
let ambiencePreview = false;
let ambienceAudio: HTMLAudioElement | null = null;
let ambienceSrc = "";
let ambienceTarget = 0;
let ambienceBlocked = false;
let transientPlaying = 0;
const fadeTimers = new Map<HTMLAudioElement, number>();
const statusListeners = new Set<() => void>();
let ambienceStatus: ZaicodeAmbienceStatus = { state: "silent", reason: null, sound: "", volume: 0 };

const FADE_STEP_MS = 50;
const QUICK_FADE_MS = 150;

function publishAmbienceStatus(next: ZaicodeAmbienceStatus): void {
  const current = ambienceStatus;
  if (
    current.state === next.state &&
    current.reason === next.reason &&
    current.sound === next.sound &&
    current.volume === next.volume
  ) {
    return;
  }
  ambienceStatus = next;
  for (const listener of statusListeners) listener();
}

export function useZaicodeAmbienceStatus(): ZaicodeAmbienceStatus {
  return useSyncExternalStore(
    (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    () => ambienceStatus,
    () => ambienceStatus,
  );
}

function fadeTo(audio: HTMLAudioElement, target: number, durationMs: number, onDone?: () => void): void {
  const running = fadeTimers.get(audio);
  if (running !== undefined) window.clearInterval(running);
  const from = audio.volume;
  const steps = Math.max(1, Math.round(durationMs / FADE_STEP_MS));
  let step = 0;
  const timer = window.setInterval(() => {
    step += 1;
    audio.volume = Math.min(1, Math.max(0, from + ((target - from) * step) / steps));
    if (step >= steps) {
      window.clearInterval(timer);
      fadeTimers.delete(audio);
      onDone?.();
    }
  }, FADE_STEP_MS);
  fadeTimers.set(audio, timer);
}

function retireAmbience(audio: HTMLAudioElement, fadeMs: number): void {
  fadeTo(audio, 0, fadeMs, () => {
    audio.pause();
    audio.removeAttribute("src");
  });
}

let gestureRetryInstalled = false;
function retryOnNextGesture(): void {
  if (gestureRetryInstalled) return;
  gestureRetryInstalled = true;
  const retry = () => {
    gestureRetryInstalled = false;
    window.removeEventListener("pointerdown", retry, true);
    window.removeEventListener("keydown", retry, true);
    ambienceBlocked = false;
    reconcileAmbience();
  };
  window.addEventListener("pointerdown", retry, true);
  window.addEventListener("keydown", retry, true);
}

/** Brings the ambience layer in line with the current reasons and settings. Idempotent. */
export function reconcileAmbience(): void {
  if (typeof Audio === "undefined") return;
  const { ambience } = readZaicodeAudio();
  const reason: ZaicodeAmbienceStatus["reason"] = ambiencePreview
    ? "preview"
    : ambienceWorking && ambience.enabled
      ? "working"
      : null;
  const url = ambienceUrl(ambience.sound);
  const idleState: ZaicodeAmbienceState = ambience.enabled ? "silent" : "off";

  if (!reason || !url || ambience.volume <= 0) {
    if (ambienceAudio) {
      retireAmbience(ambienceAudio, reason ? QUICK_FADE_MS : ambience.fadeOutMs);
      ambienceAudio = null;
      ambienceSrc = "";
      ambienceTarget = 0;
    }
    publishAmbienceStatus({
      state: reason && !url ? "missing" : idleState,
      reason: reason && !url ? reason : null,
      sound: ambience.sound,
      volume: ambience.volume,
    });
    return;
  }

  if (ambienceAudio && ambienceSrc !== url) {
    // 播放中换声音：旧的快速淡出、新的立即接上，不会卡在旧文件上。
    retireAmbience(ambienceAudio, QUICK_FADE_MS);
    ambienceAudio = null;
    ambienceTarget = 0;
  }
  if (!ambienceAudio) {
    const audio = new Audio(url);
    audio.loop = true;
    audio.volume = 0;
    ambienceAudio = audio;
    ambienceSrc = url;
    ambienceTarget = ambience.volume;
    void audio
      .play()
      .then(() => {
        if (ambienceAudio !== audio) return;
        ambienceBlocked = false;
        fadeTo(audio, ambienceTarget, reason === "preview" ? QUICK_FADE_MS : ambience.fadeInMs);
        reconcileAmbience();
      })
      .catch(() => {
        // Autoplay before the first user gesture is refused: say so, retry on the next click/key.
        if (ambienceAudio !== audio) return;
        ambienceAudio = null;
        ambienceSrc = "";
        ambienceBlocked = true;
        retryOnNextGesture();
        reconcileAmbience();
      });
  } else if (ambienceTarget !== ambience.volume) {
    ambienceTarget = ambience.volume;
    fadeTo(ambienceAudio, ambience.volume, QUICK_FADE_MS);
  }
  publishAmbienceStatus({
    state: ambienceBlocked && !ambienceAudio ? "blocked" : ambienceAudio && !ambienceAudio.paused ? "playing" : "silent",
    reason,
    sound: ambience.sound,
    volume: ambience.volume,
  });
}

/** Agents started / stopped working (driven by the sidebar's running-session list). */
export function setZaicodeAmbienceWorking(working: boolean): void {
  if (ambienceWorking === working) return;
  ambienceWorking = working;
  reconcileAmbience();
}

/** Operator preview: plays the selected sound until stopped, regardless of work. */
export function setZaicodeAmbiencePreview(on: boolean): void {
  if (ambiencePreview === on) return;
  ambiencePreview = on;
  reconcileAmbience();
}

export function isZaicodeAmbiencePreviewing(): boolean {
  return ambiencePreview;
}

/** Backwards-compatible entry used by older callers: same as setZaicodeAmbienceWorking. */
export function setZaicodeAmbienceActive(active: boolean): void {
  setZaicodeAmbienceWorking(active);
}

// Settings changes (sound, volume, enabled) apply immediately, even mid-playback.
if (typeof window !== "undefined") {
  window.addEventListener(CHANGE_EVENT, () => reconcileAmbience());
}

/** Plays one Problip cue now. Returns false when skipped (busy) or unplayable. */
export async function playProblipCue(options: { test?: boolean } = {}): Promise<boolean> {
  const { problip } = readZaicodeAudio();
  if (!options.test && problip.skipWhileBusy && transientPlaying > 0) return false;
  const pool = PROBLIP_SOUNDS.filter((sound) => problip.sounds.includes(sound.id));
  const choice = pool[Math.floor(Math.random() * pool.length)] ?? PROBLIP_SOUNDS[0];
  const url = problipUrl(choice.file);
  if (!url) return false;
  const audio = new Audio(url);
  audio.volume = problip.volume / 100;
  transientPlaying += 1;
  const release = () => {
    transientPlaying = Math.max(0, transientPlaying - 1);
  };
  audio.addEventListener("ended", release, { once: true });
  audio.addEventListener("error", release, { once: true });
  try {
    await audio.play();
  } catch {
    release();
    return false;
  }
  if (!options.test) recordBlip();
  return true;
}

function randomBetween(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min));
}

/** Next wait for the configured interval. `pulseShort` alternates in PULSE mode. */
export function nextProblipDelayMs(settings: ZaicodeProblipSettings, pulseShort: boolean): number {
  switch (settings.interval) {
    case "FIXED_5S":
      return 5_000;
    case "FIXED_10S":
      return 10_000;
    case "FIXED_15S":
      return 15_000;
    case "FIXED_20S":
      return 20_000;
    case "FIXED_30S":
      return 30_000;
    case "PULSE":
      return pulseShort ? 5_000 : randomBetween(10_000, 20_000);
    case "MANUAL":
      return randomBetween(settings.manualFrom * 1000, settings.manualTo * 1000);
    default:
      return randomBetween(4_000, 7_000);
  }
}

/**
 * The single Problip scheduler: one single-shot timer re-armed after every
 * cue, never catching up on missed intervals. Driven by `running`.
 */
let problipTimer: number | null = null;
let problipPulseShort = true;

function armProblip(initial: boolean): void {
  const { problip } = readZaicodeAudio();
  if (!problip.running) return;
  const delay = initial ? 500 : nextProblipDelayMs(problip, problipPulseShort);
  if (!initial && problip.interval === "PULSE") problipPulseShort = !problipPulseShort;
  problipTimer = window.setTimeout(() => {
    problipTimer = null;
    void playProblipCue().finally(() => armProblip(false));
  }, delay);
}

export function syncZaicodeProblip(): void {
  const { problip } = readZaicodeAudio();
  if (problip.running && problipTimer === null) {
    problipPulseShort = true;
    armProblip(true);
  } else if (!problip.running && problipTimer !== null) {
    window.clearTimeout(problipTimer);
    problipTimer = null;
  }
}

/** Silences everything at once: ambience (work + preview) and Problip. */
export function stopAllZaicodeAudio(): void {
  setZaicodeProblip({ running: false });
  syncZaicodeProblip();
  ambiencePreview = false;
  if (ambienceAudio) {
    retireAmbience(ambienceAudio, QUICK_FADE_MS);
    ambienceAudio = null;
    ambienceSrc = "";
  }
  ambienceTarget = 0;
  // Work keeps wanting the layer; STOP ALL silences it until work restarts.
  ambienceWorking = false;
  publishAmbienceStatus({ ...ambienceStatus, state: "silent", reason: null });
}
