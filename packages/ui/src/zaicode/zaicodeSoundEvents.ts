/* eslint-disable max-lines -- the playback engine: AudioContext, decoding, the mixer and the URL/IndexedDB side of a sound. The table it plays from is in zaicodeSoundSettingsModel. */
import { isZaicodeProductMode } from "@zcode/shared";
import { getTaskNotificationSoundUrl, listTaskNotificationSounds } from "@/lib/taskNotificationSound.js";
import taskNotificationPopUrl from "@/assets/notification-sounds/task-notification-pop.mp3";
import {
  readBundledZaicodeCustomSound,
  readZaicodeCustomSoundBlob,
  readZaicodeSetting,
  ZAICODE_SOUND_CUSTOM_DB,
} from "./zaicodeSettingsSnapshot.js";
import { zaicodeSoundEntry } from "./zaicodeSoundCatalog.js";
import { addZaicodePoolMember } from "./zaicodeSoundPoolActions.js";
import { playZaicodeSound, registerZaicodeSoundAudible, registerZaicodeSoundPlayer, zaicodeDirectSoundPlayedSince } from "./zaicodeSoundBus.js";
import { isZaicodeSoundQuietNow } from "./zaicodeNotifications.js";
import { zaicodeSoundConditionsAllow } from "./zaicodeSoundConditions.js";
import { cachedZaicodeCustomSoundUrl, onZaicodeCustomSoundUrlRevoked, resolveZaicodeCustomSoundUrl } from "./zaicodeCustomSounds.js";
import { ZAICODE_CLICKABLE, zaicodeChangeSoundFor, zaicodeClickSoundFor } from "./zaicodeSoundVoices.js";
import { decideZaicodeSound, type ZaicodeSoundOverlap, type ZaicodeSoundRequest } from "./zaicodeSoundPolicy.js";
import {
  CHANGE_EVENT,
  LEGACY_CUES_KEY,
  STORAGE_KEY,
  ZAICODE_SOUND_EVENTS,
  ZAICODE_SOUND_GAIN_MAX,
  ZAICODE_SOUND_GAIN_MIN,
  resetZaicodeSoundSettings,
  setAllZaicodeSoundEvents,
  setZaicodeSoundEvent,
  setZaicodeSoundSettings,
  zaicodePoolSharesForEvent,
  isZaicodeInterfaceSound,
  migrateProjectSwitchCue,
  normalizeZaicodeSoundSettings,
  readZaicodeSoundSettings,
  zaicodeEffectiveGainDb,
  zaicodeSoundsForEvent,
  zaicodeSoundForEvent,
  zaicodeSetPoolWeight,
  ZAICODE_SOUND_SELECTION_MODES,
} from "./zaicodeSoundSettingsModel.js";

export * from "./zaicodeSoundSettingsModel.js";

export function listZaicodeSoundFiles(): readonly { id: string; label: string }[] {
  return [{ id: "default", label: "(notification pop)" }, ...listTaskNotificationSounds()];
}

export function zaicodeSoundUrl(sound: string): string | null {
  if (sound === "default") return taskNotificationPopUrl;
  if (sound.startsWith("custom:")) return customUrls.get(sound) ?? readBundledZaicodeCustomSound(sound);
  // A file of the customization folder plays once it was read (resolveSoundUrl reads it); null until then.
  if (sound.startsWith("customization:")) return cachedZaicodeCustomSoundUrl(sound);
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

export async function resolveSoundUrl(sound: string): Promise<string | null> {
  if (sound.startsWith("customization:")) return resolveZaicodeCustomSoundUrl(sound);
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

/**
 * Puts `blob` in place as event `id`'s own file and forgets what was cached of the old one. Selects nothing:
 * the import button selects the sound afterwards, a preset restoring a sound brings its own settings.
 */
export async function storeZaicodeOwnSound(id: string, blob: Blob, name: string): Promise<void> {
  const sound = `custom:${id}`;
  const db = await openCustomDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(CUSTOM_STORE, "readwrite");
      transaction.objectStore(CUSTOM_STORE).put(blob, sound);
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
    localStorage.setItem(customNamesKey, JSON.stringify({ ...readZaicodeCustomSoundNames(), [id]: name }));
  } catch {
    // the name is cosmetic
  }
}

/** Stores `file` as event `id`'s own sound and selects it. */
export async function importZaicodeSoundFile(id: string, file: File): Promise<void> {
  if (!/\.(wav|mp3|ogg)$/i.test(file.name)) throw new Error("Choose a WAV, MP3 or OGG file.");
  await storeZaicodeOwnSound(id, file, file.name);
  setZaicodeSoundEvent(id, { sound: `custom:${id}` });
  // In a pool the row's own sound is only a fallback: the file has to become a member to be heard.
  if (readZaicodeSoundSettings().events[id]?.soundMode === "pool") addZaicodePoolMember(id, `custom:${id}`);
}

const OWN_SOUND_MIME: Record<string, string> = { wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg" };

function ownSoundMime(name: string): string {
  return OWN_SOUND_MIME[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ""] ?? "audio/wav";
}

/**
 * The bytes of an own sound (`custom:<event id>`) and the name it came with; null when this installation has
 * none. A file the release snapshot carries counts: a preset made from it must bring the sound along.
 */
export async function readZaicodeOwnSound(sound: string): Promise<{ bytes: Uint8Array; name: string; mime: string } | null> {
  const name = readZaicodeCustomSoundNames()[sound.slice("custom:".length)] ?? `${sound.slice("custom:".length)}.wav`;
  const blob = await readZaicodeCustomSoundBlob(sound).catch(() => null);
  if (blob) return { bytes: new Uint8Array(await blob.arrayBuffer()), name, mime: blob.type || ownSoundMime(name) };
  const bundled = /^data:([^;,]*);base64,(.*)$/s.exec(readBundledZaicodeCustomSound(sound) ?? "");
  if (!bundled) return null;
  const raw = atob(bundled[2]!);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return { bytes, name, mime: bundled[1] || ownSoundMime(name) };
}

// ---------------------------------------------------------------------------
// Playback: WebAudio so +dB is real gain, not a clamped HTMLAudio volume
// ---------------------------------------------------------------------------

let context: AudioContext | null = null;
const buffers = new Map<string, Promise<AudioBuffer | null>>();
// A customization file that changed or went away has a new URL next time: its decoded copy is dead weight.
onZaicodeCustomSoundUrlRevoked((url) => void buffers.delete(url));
const CHOKE_FADE_S = 0.015;

interface Voice {
  /** Event id, or a file sound's channel: the same key is "the same sound". */
  key: string;
  source: AudioBufferSourceNode;
  /** The gain behind the source, so a cut sound fades instead of clicking off. */
  gain: GainNode;
  interface: boolean;
  /** Follows the overlap rule (previews and the game do not). */
  pooled: boolean;
  done: boolean;
}

/** Every sound ringing now, oldest first. */
const voices: Voice[] = [];
/** Sounds waiting for their turn (overlap "queue"), the next one first. */
const waiting: { key: string; start: () => void }[] = [];
/** While a new sound cuts others, the line must not move into the gap. */
let holdLine = 0;

function finishVoice(voice: Voice): void {
  if (voice.done) return;
  voice.done = true;
  const index = voices.indexOf(voice);
  if (index >= 0) voices.splice(index, 1);
  if (voice.pooled) advanceLine();
}

function advanceLine(): void {
  while (holdLine === 0 && waiting.length > 0 && !voices.some((voice) => voice.pooled)) waiting.shift()!.start();
}

/** Fades a voice out over a few ms (a cut, a steal, the one-at-a-time rule). */
function fadeVoice(voice: Voice, ctx: AudioContext): void {
  try {
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, ctx.currentTime);
    voice.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + CHOKE_FADE_S);
    voice.source.stop(ctx.currentTime + CHOKE_FADE_S);
  } catch {
    // already stopped
  }
  finishVoice(voice);
}

function stopVoices(match: (voice: Voice) => boolean): void {
  for (const voice of voices.filter(match)) {
    try {
      voice.source.stop();
    } catch {
      // already stopped
    }
    finishVoice(voice);
  }
}

function startVoice(
  ctx: AudioContext,
  key: string,
  buffer: AudioBuffer,
  level: number,
  flags: { interface: boolean; pooled: boolean; rate?: number },
): void {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  // SAIPEGGLE's rising peg notes (SRC-062): the same clip, played faster = higher.
  const rate = flags.rate && flags.rate > 0 ? Math.min(4, Math.max(0.25, flags.rate)) : 1;
  source.playbackRate.value = rate;
  const gain = ctx.createGain();
  gain.gain.value = level;
  source.connect(gain).connect(ctx.destination);
  const voice: Voice = { key, source, gain, interface: flags.interface, pooled: flags.pooled, done: false };
  voices.push(voice);
  source.onended = () => finishVoice(voice);
  // A sound whose "ended" never arrives (a sleeping audio device) must not hold the line forever.
  setTimeout(() => finishVoice(voice), (buffer.duration / rate) * 1000 + 300);
  source.start();
}

/**
 * Starts a sound through the overlap rule. `start` plays it (it is called now,
 * or later from the line); false = dropped (the line is full, or the same
 * sound already waits).
 */
function admitSound(ctx: AudioContext, request: ZaicodeSoundRequest, pooled: boolean, start: () => void): boolean {
  if (!pooled) {
    // Outside the rule "replace" (or a channel) still means one at a time for this sound.
    if (request.replaceOwn) stopVoices((voice) => voice.key === request.key);
    start();
    return true;
  }
  const settings = readZaicodeSoundSettings();
  const pool = voices.filter((voice) => voice.pooled);
  const decision = decideZaicodeSound(
    { overlap: settings.overlap, limit: settings.overlapLimit, interfaceOneAtATime: settings.interfaceOneAtATime },
    pool,
    waiting.map((entry) => entry.key),
    request,
  );
  if (!decision.play) {
    if (decision.wait) waiting.push({ key: request.key, start });
    return decision.wait;
  }
  holdLine += 1;
  try {
    for (const index of decision.stop) fadeVoice(pool[index]!, ctx);
    start();
  } finally {
    holdLine -= 1;
  }
  advanceLine();
  return true;
}
const lastPlayedAt = new Map<string, number>();
const DEBOUNCE_MS = 120;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") return null;
  if (!context) context = new AudioContext();
  if (context.state === "suspended") void context.resume().catch(() => undefined);
  return context;
}

/**
 * SRC-051: decode every enabled cue up front. The first play used to eat a
 * fetch + decodeAudioData round trip (hundreds of ms on a cold start), which
 * read as "the switch sound lags or does not play at all".
 */
export function preheatZaicodeSounds(): void {
  const settings = readZaicodeSoundSettings();
  for (const [id, row] of Object.entries(settings.events)) {
    if (!row.enabled) continue;
    // A pool is warmed member by member, so its first draw is not the one
    // that pays for a decode.
    for (const sound of zaicodeSoundsForEvent(id)) {
      void resolveSoundUrl(sound)
        .then((url) => (url ? loadBuffer(url) : null))
        .catch(() => undefined);
    }
  }
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
    if (!isZaicodeProductMode() || settings.muted || !row.enabled) return false;
    const now = Date.now();
    const last = lastPlayedAt.get(id) ?? 0;
    // T-134: quiet hours, the focus rule and the row's own conditions (background only, through quiet hours, cooldown).
    const verdict = zaicodeSoundConditionsAllow(row, {
      focused: typeof document !== "undefined" && document.hasFocus(),
      quietNow: isZaicodeSoundQuietNow(),
      whenFocusedGlobal: settings.whenFocused,
      now,
      lastPlayedAt: last,
    });
    if (!verdict.play) return false;
    if (now - last < DEBOUNCE_MS) return false;
    lastPlayedAt.set(id, now);
  }
  const url = await resolveSoundUrl(options.sound ?? zaicodeSoundForEvent(id) ?? row.sound);
  const ctx = audioContext();
  if (!url || !ctx) return false;
  const buffer = await loadBuffer(url);
  if (!buffer) return false;
  // SRC-051: a suspended context (autoplay policy, machine wake) must be
  // running before start(), or the cue is silently swallowed.
  if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
  if (ctx.state !== "running") return false;
  const request = { key: id, interface: isZaicodeInterfaceSound(id), replaceOwn: row.mode === "replace" };
  return admitSound(ctx, request, !options.preview, () => {
    // A sound that waited in line checks the switches again when its turn comes.
    const now = readZaicodeSoundSettings();
    if (!options.preview && (now.muted || (isZaicodeSoundQuietNow() && now.events[id]?.throughQuiet !== true))) return;
    startVoice(ctx, id, buffer, zaicodeGainFactor(now.masterVolume, zaicodeEffectiveGainDb(now.events[id] ?? row)), {
      interface: request.interface,
      pooled: !options.preview,
    });
  });
}

/**
 * Plays a library sound (or an own file) outside the event table: timers,
 * interval reminders, the picker's audition, SAIPEGGLE. `volume` 0..1 is
 * scaled by the master volume; `channel` stops the previous sound on the same
 * channel, so scrolling through the picker never piles clips on top of each
 * other. Timers and reminders follow the overlap rule; previews and `ownMix`
 * (a game mixing its own sounds) do not.
 */
export async function playZaicodeSoundFile(
  sound: string,
  options: { volume?: number; gainDb?: number; preview?: boolean; channel?: string; rate?: number; ownMix?: boolean } = {},
): Promise<boolean> {
  const settings = readZaicodeSoundSettings();
  if (!options.preview && (!isZaicodeProductMode() || settings.muted || isZaicodeSoundQuietNow())) return false;
  const url = await resolveSoundUrl(sound);
  const ctx = audioContext();
  if (!url || !ctx) return false;
  const buffer = await loadBuffer(url);
  if (!buffer) return false;
  const pooled = !options.preview && !options.ownMix;
  const level = options.volume === undefined ? 1 : Math.max(0, Math.min(1, options.volume));
  const request = { key: options.channel ?? `file:${sound}`, interface: false, replaceOwn: Boolean(options.channel) };
  return admitSound(ctx, request, pooled, () => {
    const now = readZaicodeSoundSettings();
    if (pooled && (now.muted || isZaicodeSoundQuietNow())) return;
    startVoice(ctx, request.key, buffer, zaicodeGainFactor(now.masterVolume, options.gainDb ?? 0) * level, {
      interface: false,
      pooled,
      ...(options.rate ? { rate: options.rate } : {}),
    });
  });
}

export function stopZaicodeSoundChannel(channel: string): void {
  stopVoices((voice) => voice.key === channel);
}

registerZaicodeSoundPlayer((id, options) => {
  void playZaicodeSoundAsync(id, options).catch(() => undefined);
});
registerZaicodeSoundAudible((id) => {
  const settings = readZaicodeSoundSettings();
  return !settings.muted && settings.events[id]?.enabled === true;
});

// SRC-051: warm decode of every enabled cue now, and again whenever the table
// changes (a cue the operator just enabled must not lag on its first play).
if (typeof window !== "undefined") {
  preheatZaicodeSounds();
  window.addEventListener(CHANGE_EVENT, preheatZaicodeSounds);
}

export { playZaicodeSound };

export function stopZaicodeSound(id: string): void {
  for (let index = waiting.length - 1; index >= 0; index -= 1) if (waiting[index]!.key === id) waiting.splice(index, 1);
  stopVoices((voice) => voice.key === id);
}

/** STOP ALL SOUNDS: the line is emptied first, so nothing waiting starts in the silence. */
export function stopAllZaicodeSounds(): void {
  waiting.length = 0;
  stopVoices(() => true);
}

const DIALOG = "[role='dialog'], [role='alertdialog']";

/** Whether an element added to or removed from <body> is (or holds) a dialog. */
function holdsDialog(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  return node.matches(DIALOG) || node.querySelector(DIALOG) !== null;
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
  // The click flips aria-expanded before the bubbling listener runs, so the
  // state before the click is read in the capture phase.
  let expandedBefore: string | null = null;
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      expandedBefore = target?.closest("[aria-expanded]")?.getAttribute("aria-expanded") ?? null;
    },
    true,
  );
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || zaicodeDirectSoundPlayedSince(Date.now() - 80)) return;
    const id = zaicodeClickSoundFor(target, expandedBefore);
    if (id) playZaicodeSound(id);
  });
  document.addEventListener("change", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || zaicodeDirectSoundPlayedSince(Date.now() - 80)) return;
    const id = zaicodeChangeSoundFor(target, target as HTMLInputElement);
    if (id) playZaicodeSound(id);
  });
  document.addEventListener("contextmenu", () => {
    if (!zaicodeDirectSoundPlayedSince(Date.now() - 80)) playZaicodeSound("ui.contextMenu");
  });
  document.addEventListener("paste", () => playZaicodeSound("ui.paste"), true);
  // A disabled control swallows its click; the press itself still arrives.
  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("button:disabled, [aria-disabled='true']")) playZaicodeSound("ui.denied");
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        playZaicodeSound("ui.escape");
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, [contenteditable='true']")) playZaicodeSound("ui.typing");
    },
    true,
  );
  document.addEventListener("pointerover", (event) => {
    const target = event.target instanceof Element ? event.target.closest(ZAICODE_CLICKABLE) : null;
    const from = event.relatedTarget instanceof Element ? event.relatedTarget.closest(ZAICODE_CLICKABLE) : null;
    if (target && target !== from && !target.matches(":disabled")) playZaicodeSound("ui.hover");
  });
  // Dialogs, popovers and menus are portalled straight into <body>. They
  // announce themselves as echoes: after the click that opened them, the
  // click's own sound is the only one heard.
  if (typeof MutationObserver !== "undefined" && document.body) {
    new MutationObserver((records) => {
      let opened = false;
      let closed = false;
      for (const record of records) {
        for (const node of record.addedNodes) opened ||= holdsDialog(node);
        for (const node of record.removedNodes) closed ||= holdsDialog(node);
      }
      if (opened) playZaicodeSound("ui.dialogOpen", { echo: true });
      else if (closed) playZaicodeSound("ui.dialogClose", { echo: true });
    }).observe(document.body, { childList: true });
  }
}

export function zaicodeSoundDiagnostics(): string {
  const settings = readZaicodeSoundSettings();
  const lines = [
    `master=${settings.masterVolume}% muted=${settings.muted} whenFocused=${settings.whenFocused} interfaceOneAtATime=${settings.interfaceOneAtATime} overlap=${settings.overlap}/${settings.overlapLimit} ringing=${voices.length} waiting=${waiting.length}`,
    ...ZAICODE_SOUND_EVENTS.map((event) => {
      const row = settings.events[event.id]!;
      const ok = zaicodeSoundUrl(row.sound) || (row.sound.startsWith("customization:") && zaicodeSoundEntry(row.sound)) ? "ok" : "MISSING";
      return `${event.id.padEnd(18)} ${row.enabled ? "on " : "off"} ${String(row.gainDb).padStart(5)} dB ${row.mode.padEnd(7)} ${row.sound} [${ok}]`;
    }),
  ];
  return lines.join("\n");
}
