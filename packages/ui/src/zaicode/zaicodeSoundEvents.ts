/* eslint-disable max-lines -- the Sounds table definition and its playback engine are one owner of every ZAICODE sound. */
import { useSyncExternalStore } from "react";
import { isZaicodeProductMode } from "@zcode/shared";
import { getTaskNotificationSoundUrl, listTaskNotificationSounds } from "@/lib/taskNotificationSound.js";
import taskNotificationPopUrl from "@/assets/notification-sounds/task-notification-pop.mp3";
import {
  readBundledZaicodeCustomSound,
  readZaicodeCustomSoundBlob,
  readZaicodeSetting,
  ZAICODE_SOUND_CUSTOM_DB,
} from "./zaicodeSettingsSnapshot.js";
import { playZaicodeSound, registerZaicodeSoundPlayer } from "./zaicodeSoundBus.js";
import { isZaicodeSoundQuietNow } from "./zaicodeNotifications.js";

/**
 * ZAICODE sound events, FastPrompter-style: every action has its own row —
 * on/off, sound, gain in dB relative to the master volume, overlay/replace —
 * and nothing about which sound plays is hard-coded at the call site. Call
 * sites only name the event: `playZaicodeSound("session.new")`.
 *
 * Buttons can also opt in declaratively: `data-zaicode-sound="saipen.start"`
 * plays on click through one document-level listener.
 */

export type ZaicodeSoundGroup =
  | "Agent"
  | "Sessions"
  | "Composer"
  | "Sidebar"
  | "Window"
  | "Engines"
  | "SAIMAIL"
  | "Interface";

export interface ZaicodeSoundEventDef {
  id: string;
  group: ZaicodeSoundGroup;
  label: string;
  hint: string;
  /** Pictogram key (see ZaicodeSoundSettings glyphs). */
  glyph: string;
  sound: string;
  enabled: boolean;
  gainDb: number;
}

const fp = (file: string) => `fastprompter:${file}`;

export const ZAICODE_SOUND_EVENTS: readonly ZaicodeSoundEventDef[] = [
  // Agent state (the former cue table)
  { id: "agent.done", group: "Agent", label: "Turn finished", hint: "A session finished its turn", glyph: "check", sound: "default", enabled: true, gainDb: 0 },
  { id: "agent.failed", group: "Agent", label: "Turn failed", hint: "A session ended with an error", glyph: "cross", sound: fp("alert_warn01b.wav"), enabled: true, gainDb: 0 },
  { id: "agent.question", group: "Agent", label: "Question", hint: "An agent asks you something or wants a plan approved", glyph: "question", sound: fp("beep_cyoa_pda_beep2.wav"), enabled: true, gainDb: 0 },
  { id: "agent.human", group: "Agent", label: "Human needed", hint: "An agent needs your permission to continue", glyph: "hand", sound: fp("alert_system_msg.wav"), enabled: true, gainDb: 0 },
  { id: "agent.update", group: "Agent", label: "Progress update", hint: "A progress or feedback update arrived", glyph: "dot", sound: fp("blip1.wav"), enabled: false, gainDb: -6 },
  { id: "agent.started", group: "Agent", label: "Work started", hint: "A session started working after everything was idle", glyph: "play", sound: fp("activated.wav"), enabled: false, gainDb: -6 },
  // Sessions
  { id: "session.new", group: "Sessions", label: "New session", hint: "A new session or draft was created", glyph: "plus", sound: fp("ui_new.wav"), enabled: true, gainDb: -3 },
  { id: "session.open", group: "Sessions", label: "Open session", hint: "You switched to another session", glyph: "swap", sound: fp("button1.wav"), enabled: false, gainDb: -6 },
  { id: "session.archive", group: "Sessions", label: "Archive", hint: "A session or project was archived", glyph: "box", sound: fp("chest_closed.wav"), enabled: true, gainDb: -3 },
  { id: "session.restore", group: "Sessions", label: "Restore / undo archive", hint: "An archived session came back", glyph: "undo", sound: fp("chest_open.wav"), enabled: true, gainDb: -3 },
  { id: "session.rename", group: "Sessions", label: "Rename", hint: "A session got a new title", glyph: "pen", sound: fp("click_soft.wav"), enabled: true, gainDb: -6 },
  { id: "session.pin", group: "Sessions", label: "Pin / unpin", hint: "A session was pinned or unpinned", glyph: "pin", sound: fp("click_tactile_click.wav"), enabled: true, gainDb: -6 },
  // Composer / SAIPEN strip
  { id: "composer.send", group: "Composer", label: "Send prompt", hint: "A prompt was sent", glyph: "send", sound: fp("whoosh_short_whoosh.wav"), enabled: false, gainDb: -8 },
  { id: "saipen.start", group: "Composer", label: "START", hint: "START (goal cc all) was pressed", glyph: "play", sound: fp("com_go.wav"), enabled: true, gainDb: -4 },
  { id: "saipen.step", group: "Composer", label: "STEP", hint: "STEP (cc) was pressed", glyph: "step", sound: fp("menu_mnu_next.wav"), enabled: true, gainDb: -4 },
  { id: "saipen.clear", group: "Composer", label: "CLEAR", hint: "CLEAR was pressed", glyph: "cross", sound: fp("ui_clear.wav"), enabled: true, gainDb: -4 },
  { id: "saipen.mode", group: "Composer", label: "Mode button", hint: "A SAIPEN mode (WIKI, HUNT, ...) was launched", glyph: "grid", sound: fp("menu_launch_select1.wav"), enabled: true, gainDb: -4 },
  // Sidebar
  { id: "sidebar.project", group: "Sidebar", label: "Switch project", hint: "You opened another project", glyph: "folder", sound: fp("Click.wav"), enabled: false, gainDb: -6 },
  { id: "sidebar.drop", group: "Sidebar", label: "Drag & drop", hint: "A project or session was dropped into a new place", glyph: "move", sound: fp("pop_up_08.wav"), enabled: true, gainDb: -6 },
  { id: "sidebar.mode", group: "Sidebar", label: "Group / Project view", hint: "The sidebar switched between Group and Project view", glyph: "list", sound: fp("menu_mnu_click.wav"), enabled: true, gainDb: -8 },
  { id: "sidebar.collapse", group: "Sidebar", label: "Fold / unfold", hint: "A project group was folded or unfolded", glyph: "fold", sound: fp("click_mouse_click2.wav"), enabled: false, gainDb: -10 },
  // Window
  { id: "window.snap", group: "Window", label: "Snap to zone", hint: "Ctrl+Q placed the window into a zone", glyph: "grid", sound: fp("pop_up_02.wav"), enabled: true, gainDb: -3 },
  { id: "window.picker", group: "Window", label: "Zone picker", hint: "The Ctrl+Q zone picker opened", glyph: "grid", sound: fp("menu_launch_upmenu1.wav"), enabled: true, gainDb: -8 },
  { id: "window.preset", group: "Window", label: "Save window preset", hint: "A window position was saved as a preset", glyph: "save", sound: fp("ui_save.wav"), enabled: true, gainDb: -4 },
  { id: "window.drag", group: "Window", label: "Right-drag move", hint: "The window was moved with the right mouse button", glyph: "move", sound: fp("whoosh_digital_small_whoosh.wav"), enabled: false, gainDb: -10 },
  // Engines, workers, limits, autostart
  { id: "engine.select", group: "Engines", label: "Pick engine", hint: "An engine (subscription or model pool) was selected", glyph: "engine", sound: fp("menu_launch_glow1.wav"), enabled: true, gainDb: -6 },
  { id: "worker.launch", group: "Engines", label: "Worker started", hint: "A subscription CLI started as a worker", glyph: "play", sound: fp("rocket_pack_boosters_ready.wav"), enabled: true, gainDb: -6 },
  { id: "worker.exit", group: "Engines", label: "Worker finished", hint: "A worker CLI exited normally", glyph: "check", sound: fp("sentry_finish.wav"), enabled: true, gainDb: -6 },
  { id: "worker.fail", group: "Engines", label: "Worker crashed", hint: "A worker CLI exited with an error", glyph: "cross", sound: fp("denied.wav"), enabled: true, gainDb: -4 },
  { id: "subchat.done", group: "Engines", label: "Subscription chat answered", hint: "A subscription chat turn (no worker) finished", glyph: "check", sound: fp("sentry_finish.wav"), enabled: true, gainDb: -6 },
  { id: "subchat.fail", group: "Engines", label: "Subscription chat failed", hint: "A subscription chat turn ended with an error", glyph: "cross", sound: fp("denied.wav"), enabled: true, gainDb: -4 },
  { id: "worker.fix", group: "Engines", label: "Troubleshoot", hint: "A one-click fix (login / install) started", glyph: "wrench", sound: fp("anvil_use.wav"), enabled: true, gainDb: -8 },
  { id: "limits.refill", group: "Engines", label: "Quota refilled", hint: "A subscription window reset and has quota again", glyph: "battery", sound: fp("success_powerup.wav"), enabled: true, gainDb: -4 },
  { id: "limits.low", group: "Engines", label: "Quota low", hint: "A subscription window dropped under 20%", glyph: "warn", sound: fp("pop_cartoon_pop.wav"), enabled: true, gainDb: -4 },
  { id: "limits.refresh", group: "Engines", label: "Limits refreshed", hint: "A manual quota refresh finished", glyph: "refresh", sound: fp("recharged.wav"), enabled: false, gainDb: -10 },
  { id: "autostart.fire", group: "Engines", label: "Autostart fired", hint: "A scheduled autostart launched its worker", glyph: "clock", sound: fp("NEWDAY.wav"), enabled: true, gainDb: -6 },
  { id: "autostart.missed", group: "Engines", label: "Autostart missed", hint: "A scheduled autostart missed its window", glyph: "clock", sound: fp("warn1.wav"), enabled: true, gainDb: -6 },
  // SAIMAIL
  { id: "saimail.new", group: "SAIMAIL", label: "New letter", hint: "A new SAIMAIL letter arrived", glyph: "mail", sound: fp("downmail.wav"), enabled: true, gainDb: -2 },
  { id: "saimail.open", group: "SAIMAIL", label: "Open inbox", hint: "The SAIMAIL inbox opened", glyph: "mail", sound: fp("NetricsaMessageOpen.wav"), enabled: true, gainDb: -6 },
  // Interface
  { id: "ui.settings", group: "Interface", label: "Settings", hint: "Settings opened", glyph: "gear", sound: fp("panel_open.wav"), enabled: true, gainDb: -8 },
  { id: "ui.copy", group: "Interface", label: "Copy", hint: "Something was copied to the clipboard", glyph: "copy", sound: fp("pop.wav"), enabled: true, gainDb: -8 },
  { id: "ui.hotkey", group: "Interface", label: "Keyboard shortcut", hint: "A keyboard shortcut ran an app command (Settings -> Keyboard)", glyph: "key", sound: fp("menu_mnu_click.wav"), enabled: false, gainDb: -10 },
  { id: "ui.toggle", group: "Interface", label: "Switch on / off", hint: "A ZAICODE switch was flipped", glyph: "toggle", sound: fp("switch_toggle.wav"), enabled: true, gainDb: -10 },
  { id: "todo.tick", group: "Interface", label: "Todo done", hint: "A todo item completed", glyph: "check", sound: fp("tick_on.wav"), enabled: true, gainDb: -8 },
  { id: "problip.goal", group: "Interface", label: "Problip goal", hint: "The problip counter reached a round number", glyph: "star", sound: fp("success_levelup.wav"), enabled: true, gainDb: -4 },
];

const EVENT_BY_ID = new Map(ZAICODE_SOUND_EVENTS.map((event) => [event.id, event]));

export const ZAICODE_SOUND_GAIN_MIN = -24;
export const ZAICODE_SOUND_GAIN_MAX = 12;

export interface ZaicodeSoundEventSetting {
  enabled: boolean;
  sound: string;
  gainDb: number;
  /** replace = stop this event's previous sound first; overlay = let them mix. */
  mode: "overlay" | "replace";
}

export interface ZaicodeSoundSettings {
  /** 0..100 */
  masterVolume: number;
  muted: boolean;
  /** Also play while the ZAICODE window is focused. */
  whenFocused: boolean;
  events: Record<string, ZaicodeSoundEventSetting>;
}

const STORAGE_KEY = "zaicode-sound-events-v1";
const LEGACY_CUES_KEY = "zaicode-cues-v1";
const CHANGE_EVENT = "zaicode-sound-events-changed";

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function defaultZaicodeSoundSettings(): ZaicodeSoundSettings {
  const events: Record<string, ZaicodeSoundEventSetting> = {};
  for (const event of ZAICODE_SOUND_EVENTS) {
    events[event.id] = { enabled: event.enabled, sound: event.sound, gainDb: event.gainDb, mode: "overlay" };
  }
  return { masterVolume: 60, muted: false, whenFocused: true, events };
}

/** Old per-event cue table (0..100 volume) -> rows of the new table. */
function migrateLegacyCues(raw: unknown, into: ZaicodeSoundSettings): ZaicodeSoundSettings {
  const legacy = raw as { enabled?: unknown; whenFocused?: unknown; events?: Record<string, { enabled?: unknown; sound?: unknown; volume?: unknown }> } | null;
  if (!legacy || typeof legacy !== "object") return into;
  const next = { ...into, events: { ...into.events } };
  if (legacy.enabled === false) next.muted = true;
  if (typeof legacy.whenFocused === "boolean") next.whenFocused = legacy.whenFocused;
  for (const [cue, value] of Object.entries(legacy.events ?? {})) {
    const id = `agent.${cue}`;
    const current = next.events[id];
    if (!current || !value) continue;
    const volume = clamp(value.volume, 0, 100, 60);
    next.events[id] = {
      ...current,
      enabled: typeof value.enabled === "boolean" ? value.enabled : current.enabled,
      // "custom" was the file imported for this cue; it keeps playing as the row's own file.
      sound:
        value.sound === "custom"
          ? `custom:${id}`
          : typeof value.sound === "string" && value.sound
            ? value.sound
            : current.sound,
      gainDb: volume <= 0 ? ZAICODE_SOUND_GAIN_MIN : Math.round(20 * Math.log10(volume / 60)),
    };
  }
  return next;
}

export function normalizeZaicodeSoundSettings(raw: unknown): ZaicodeSoundSettings {
  const base = defaultZaicodeSoundSettings();
  if (!raw || typeof raw !== "object") return base;
  const record = raw as Partial<ZaicodeSoundSettings>;
  const events = { ...base.events };
  for (const [id, value] of Object.entries(record.events ?? {})) {
    const current = events[id];
    if (!current || !value || typeof value !== "object") continue;
    events[id] = {
      enabled: typeof value.enabled === "boolean" ? value.enabled : current.enabled,
      sound: typeof value.sound === "string" && value.sound ? value.sound : current.sound,
      gainDb: Math.round(clamp(value.gainDb, ZAICODE_SOUND_GAIN_MIN, ZAICODE_SOUND_GAIN_MAX, current.gainDb) * 2) / 2,
      mode: value.mode === "replace" ? "replace" : "overlay",
    };
  }
  return {
    masterVolume: Math.round(clamp(record.masterVolume, 0, 100, base.masterVolume)),
    muted: record.muted === true,
    whenFocused: record.whenFocused !== false,
    events,
  };
}

let cached: ZaicodeSoundSettings | null = null;

export function readZaicodeSoundSettings(): ZaicodeSoundSettings {
  if (cached) return cached;
  const stored = readZaicodeSetting(STORAGE_KEY);
  if (stored) {
    try {
      cached = normalizeZaicodeSoundSettings(JSON.parse(stored));
      return cached;
    } catch {
      // fall through to defaults
    }
  }
  let legacy: unknown = null;
  try {
    legacy = JSON.parse(readZaicodeSetting(LEGACY_CUES_KEY) ?? "null");
  } catch {
    legacy = null;
  }
  cached = migrateLegacyCues(legacy, defaultZaicodeSoundSettings());
  return cached;
}

function write(next: ZaicodeSoundSettings): void {
  cached = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // applies for this window anyway
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function setZaicodeSoundSettings(patch: Partial<Omit<ZaicodeSoundSettings, "events">>): void {
  write(normalizeZaicodeSoundSettings({ ...readZaicodeSoundSettings(), ...patch }));
}

export function setZaicodeSoundEvent(id: string, patch: Partial<ZaicodeSoundEventSetting>): void {
  const current = readZaicodeSoundSettings();
  const row = current.events[id];
  if (!row) return;
  write(normalizeZaicodeSoundSettings({ ...current, events: { ...current.events, [id]: { ...row, ...patch } } }));
}

export function setAllZaicodeSoundEvents(enabled: boolean): void {
  const current = readZaicodeSoundSettings();
  const events: Record<string, ZaicodeSoundEventSetting> = {};
  for (const [id, row] of Object.entries(current.events)) events[id] = { ...row, enabled };
  write({ ...current, events });
}

export function resetZaicodeSoundSettings(): void {
  write(defaultZaicodeSoundSettings());
}

export function useZaicodeSoundSettings(): ZaicodeSoundSettings {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener(CHANGE_EVENT, listener);
      return () => window.removeEventListener(CHANGE_EVENT, listener);
    },
    readZaicodeSoundSettings,
    readZaicodeSoundSettings,
  );
}

export function zaicodeSoundEventDef(id: string): ZaicodeSoundEventDef | undefined {
  return EVENT_BY_ID.get(id);
}

export function listZaicodeSoundFiles(): readonly { id: string; label: string }[] {
  return [{ id: "default", label: "(notification pop)" }, ...listTaskNotificationSounds()];
}

export function zaicodeSoundUrl(sound: string): string | null {
  if (sound === "default") return taskNotificationPopUrl;
  if (sound.startsWith("custom:")) return customUrls.get(sound) ?? readBundledZaicodeCustomSound(sound);
  return getTaskNotificationSoundUrl(sound);
}

// --- your own files (IndexedDB), one per event: sound id "custom:<event id>" ---

const CUSTOM_STORE = "sounds";
const customUrls = new Map<string, string>();
const customNamesKey = "zaicode-sound-custom-names";

function openCustomDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ZAICODE_SOUND_CUSTOM_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(CUSTOM_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function resolveSoundUrl(sound: string): Promise<string | null> {
  if (!sound.startsWith("custom:")) return zaicodeSoundUrl(sound);
  const known = customUrls.get(sound);
  if (known) return known;
  const blob = await readZaicodeCustomSoundBlob(sound).catch(() => null);
  // No file in this installation: the release snapshot may carry it.
  if (!blob) return readBundledZaicodeCustomSound(sound);
  const url = URL.createObjectURL(blob);
  customUrls.set(sound, url);
  return url;
}

function parseNames(raw: string | null): Record<string, string> {
  try {
    const parsed = JSON.parse(raw ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function readZaicodeCustomSoundNames(): Record<string, string> {
  const names: Record<string, string> = {};
  // File names of cues imported before the Sounds table (row `agent.<cue>`).
  const legacy = parseNames(readZaicodeSetting(LEGACY_CUES_KEY)) as { customNames?: unknown };
  if (legacy.customNames && typeof legacy.customNames === "object") {
    for (const [cue, name] of Object.entries(legacy.customNames as Record<string, unknown>)) {
      if (typeof name === "string" && name) names[`agent.${cue}`] = name;
    }
  }
  return { ...names, ...parseNames(readZaicodeSetting(customNamesKey)) };
}

/** Stores `file` as event `id`'s own sound and selects it. */
export async function importZaicodeSoundFile(id: string, file: File): Promise<void> {
  if (!/\.(wav|mp3|ogg)$/i.test(file.name)) throw new Error("Choose a WAV, MP3 or OGG file.");
  const sound = `custom:${id}`;
  const db = await openCustomDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(CUSTOM_STORE, "readwrite");
      transaction.objectStore(CUSTOM_STORE).put(file, sound);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
  const previous = customUrls.get(sound);
  if (previous) URL.revokeObjectURL(previous);
  customUrls.delete(sound);
  buffers.delete(previous ?? "");
  try {
    localStorage.setItem(customNamesKey, JSON.stringify({ ...readZaicodeCustomSoundNames(), [id]: file.name }));
  } catch {
    // the name is cosmetic
  }
  setZaicodeSoundEvent(id, { sound });
}

// ---------------------------------------------------------------------------
// Playback: WebAudio so +dB is real gain, not a clamped HTMLAudio volume
// ---------------------------------------------------------------------------

let context: AudioContext | null = null;
const buffers = new Map<string, Promise<AudioBuffer | null>>();
const playing = new Map<string, Set<AudioBufferSourceNode>>();
const lastPlayedAt = new Map<string, number>();
const DEBOUNCE_MS = 120;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") return null;
  if (!context) context = new AudioContext();
  if (context.state === "suspended") void context.resume().catch(() => undefined);
  return context;
}

function loadBuffer(url: string): Promise<AudioBuffer | null> {
  const known = buffers.get(url);
  if (known) return known;
  const ctx = audioContext();
  if (!ctx) return Promise.resolve(null);
  const promise = fetch(url)
    .then((response) => response.arrayBuffer())
    .then((data) => ctx.decodeAudioData(data))
    .catch(() => null);
  buffers.set(url, promise);
  return promise;
}

export function zaicodeGainFactor(masterVolume: number, gainDb: number): number {
  return (Math.max(0, Math.min(100, masterVolume)) / 100) * 10 ** (gainDb / 20);
}

/** Plays event `id`. `preview` ignores the switches and the focus rule. */
export async function playZaicodeSoundAsync(
  id: string,
  options: { preview?: boolean; sound?: string } = {},
): Promise<boolean> {
  const settings = readZaicodeSoundSettings();
  const row = settings.events[id];
  if (!row) return false;
  if (!options.preview) {
    if (!isZaicodeProductMode() || settings.muted || !row.enabled || isZaicodeSoundQuietNow()) return false;
    if (!settings.whenFocused && typeof document !== "undefined" && document.hasFocus()) return false;
    const now = Date.now();
    if (now - (lastPlayedAt.get(id) ?? 0) < DEBOUNCE_MS) return false;
    lastPlayedAt.set(id, now);
  }
  const url = await resolveSoundUrl(options.sound ?? row.sound);
  const ctx = audioContext();
  if (!url || !ctx) return false;
  const buffer = await loadBuffer(url);
  if (!buffer) return false;
  if (row.mode === "replace") stopZaicodeSound(id);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = zaicodeGainFactor(settings.masterVolume, row.gainDb);
  source.connect(gain).connect(ctx.destination);
  const set = playing.get(id) ?? new Set<AudioBufferSourceNode>();
  set.add(source);
  playing.set(id, set);
  source.onended = () => set.delete(source);
  source.start();
  return true;
}

const channels = new Map<string, AudioBufferSourceNode>();

/**
 * Plays a library sound (or an own file) outside the event table: timers,
 * interval reminders, the picker's audition. `volume` 0..1 is scaled by the
 * master volume; `channel` stops the previous sound on the same channel, so
 * scrolling through the picker never piles clips on top of each other.
 */
export async function playZaicodeSoundFile(
  sound: string,
  options: { volume?: number; gainDb?: number; preview?: boolean; channel?: string } = {},
): Promise<boolean> {
  const settings = readZaicodeSoundSettings();
  if (!options.preview && (!isZaicodeProductMode() || settings.muted || isZaicodeSoundQuietNow())) return false;
  const url = await resolveSoundUrl(sound);
  const ctx = audioContext();
  if (!url || !ctx) return false;
  const buffer = await loadBuffer(url);
  if (!buffer) return false;
  if (options.channel) stopZaicodeSoundChannel(options.channel);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  const level = options.volume === undefined ? 1 : Math.max(0, Math.min(1, options.volume));
  gain.gain.value = zaicodeGainFactor(settings.masterVolume, options.gainDb ?? 0) * level;
  source.connect(gain).connect(ctx.destination);
  const key = options.channel ?? "file";
  const set = playing.get(key) ?? new Set<AudioBufferSourceNode>();
  set.add(source);
  playing.set(key, set);
  if (options.channel) channels.set(options.channel, source);
  source.onended = () => {
    set.delete(source);
    if (options.channel && channels.get(options.channel) === source) channels.delete(options.channel);
  };
  source.start();
  return true;
}

export function stopZaicodeSoundChannel(channel: string): void {
  const source = channels.get(channel);
  if (!source) return;
  try {
    source.stop();
  } catch {
    // already stopped
  }
  channels.delete(channel);
}

registerZaicodeSoundPlayer((id, options) => {
  void playZaicodeSoundAsync(id, options).catch(() => undefined);
});

export { playZaicodeSound };

export function stopZaicodeSound(id: string): void {
  for (const source of playing.get(id) ?? []) {
    try {
      source.stop();
    } catch {
      // already stopped
    }
  }
  playing.get(id)?.clear();
}

export function stopAllZaicodeSounds(): void {
  for (const id of playing.keys()) stopZaicodeSound(id);
}

/** One capture listener: any element with data-zaicode-sound plays that event on click. */
let declarativeInstalled = false;

export function installZaicodeDeclarativeSounds(): void {
  if (declarativeInstalled || typeof document === "undefined") return;
  declarativeInstalled = true;
  document.addEventListener("copy", () => playZaicodeSound("ui.copy"), true);
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-zaicode-sound]") : null;
      const id = target?.getAttribute("data-zaicode-sound");
      if (id && !(target as HTMLButtonElement | null)?.disabled) playZaicodeSound(id);
    },
    true,
  );
}

export function zaicodeSoundDiagnostics(): string {
  const settings = readZaicodeSoundSettings();
  const lines = [
    `master=${settings.masterVolume}% muted=${settings.muted} whenFocused=${settings.whenFocused}`,
    ...ZAICODE_SOUND_EVENTS.map((event) => {
      const row = settings.events[event.id]!;
      const ok = zaicodeSoundUrl(row.sound) ? "ok" : "MISSING";
      return `${event.id.padEnd(18)} ${row.enabled ? "on " : "off"} ${String(row.gainDb).padStart(5)} dB ${row.mode.padEnd(7)} ${row.sound} [${ok}]`;
    }),
  ];
  return lines.join("\n");
}
