import bundled from "./zaicodeSettingsDefaults.json" with { type: "json" };

/** Only durable ZAICODE preferences belong in a release snapshot. */
const SETTING_KEYS = [
  "zaicode-ui-prefs-v1",
  "zaicode-sidebar-prefs-v1",
  "zaicode-profiles",
  "zaicode-cues-v1",
  "zaicode-icon-overrides",
  "zaicode-audio-v1",
  "zaicode-palette",
  "zaicode-crisp",
  "zaicode-bevels",
  "zaicode-bevel-rows",
  "zaicode-font-settings",
  "zaicode-list-label-width",
  "zaicode-default-model",
  "zaicode-auto-session-title",
  "zaicode-help-hidden",
  "zaicode-sound-events-v1",
  "zaicode-sound-custom-names",
  "zaicode-fancyzones-settings",
  "zaicode-limit-meter-style",
  "zaicode-meter-prefs-v1",
  "zaicode-workers-prefs-v1",
  "zaicode-layout-v1",
  "zaicode-hotkeys-v1",
  "zaicode-notifications-v1",
  "zaicode-timer-prefs-v1",
  "zaicode-sound-picker-v1",
  "zaicode-color-studio-v1",
  "zaicode-avatar-uploads",
  "zaicode-saipen-log-order-v1",
  "zaicode-lights-v1",
  "zaicode-lights-presets-v1",
  "zaicode-composer-prefs-v1",
] as const;

type Snapshot = { version: 1; settings: Record<string, string>; cueAudio: Record<string, string> };

const defaults = bundled as Snapshot;

/** Current installation wins. Bundled values fill only missing preferences. */
export function readZaicodeSetting(key: string): string | null {
  const current = localStorage.getItem(key);
  if (current !== null) return current;
  return Object.prototype.hasOwnProperty.call(defaults.settings, key)
    ? defaults.settings[key] ?? null
    : null;
}

export function readBundledZaicodeCueAudio(event: string): string | null {
  return defaults.cueAudio[event] ?? null;
}

/** Sounds-table own files: key `custom:<event id>`. */
export const ZAICODE_SOUND_CUSTOM_DB = "zaicode-sound-custom";
/** Pre-Sounds-table cue files (T-32): key `<cue>` for row `agent.<cue>`. */
const LEGACY_CUE_AUDIO_DB = "zaicode-cue-audio";

function readAudioBlob(dbName: string, key: string): Promise<Blob | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("sounds");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("sounds", "readonly");
      const get = transaction.objectStore("sounds").get(key);
      get.onsuccess = () => resolve(get.result instanceof Blob ? get.result : null);
      get.onerror = () => reject(get.error);
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => db.close();
    };
  });
}

function legacyCueKey(sound: string): string | null {
  return sound.startsWith("custom:agent.") ? sound.slice("custom:agent.".length) : null;
}

/**
 * The stored file behind a `custom:<event id>` sound. An agent cue imported
 * before the Sounds table existed still lives in the old cue database.
 */
export async function readZaicodeCustomSoundBlob(sound: string): Promise<Blob | null> {
  const own = await readAudioBlob(ZAICODE_SOUND_CUSTOM_DB, sound);
  if (own) return own;
  const legacy = legacyCueKey(sound);
  return legacy ? readAudioBlob(LEGACY_CUE_AUDIO_DB, legacy) : null;
}

/** Release default for a `custom:<event id>` sound (data URL), if the snapshot carried one. */
export function readBundledZaicodeCustomSound(sound: string): string | null {
  const legacy = legacyCueKey(sound);
  return readBundledZaicodeCueAudio(sound) ?? (legacy ? readBundledZaicodeCueAudio(legacy) : null);
}

function asDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function captureZaicodeSettingsSnapshot(): Promise<string> {
  const settings: Record<string, string> = {};
  const cueAudio: Record<string, string> = {};
  for (const key of SETTING_KEYS) {
    const value = readZaicodeSetting(key);
    if (value === null) continue;
    if (key === "zaicode-audio-v1") {
      try {
        const audio = JSON.parse(value) as Record<string, unknown>;
        delete audio.problipDays;
        if (audio.problip && typeof audio.problip === "object") {
          audio.problip = { ...audio.problip, running: false };
        }
        settings[key] = JSON.stringify(audio);
      } catch {
        // Skip malformed settings; the corresponding feature already falls back.
      }
    } else {
      settings[key] = value;
    }
  }
  const cues = settings["zaicode-cues-v1"];
  if (cues) {
    let events: Record<string, { sound?: string }> = {};
    try {
      const parsed = JSON.parse(cues) as { events?: Record<string, { sound?: string }> } | null;
      events = parsed?.events ?? {};
    } catch {
      delete settings["zaicode-cues-v1"];
    }
    for (const [event, setting] of Object.entries(events)) {
      if (setting.sound !== "custom") continue;
      const blob = await readAudioBlob(LEGACY_CUE_AUDIO_DB, event);
      const sound = blob ? await asDataUrl(blob) : readBundledZaicodeCueAudio(event);
      if (!sound) throw new Error(`Custom sound for ${event} is missing; choose a new file before saving.`);
      cueAudio[event] = sound;
    }
  }
  // Own files picked in the Sounds table travel with the release like the old cue files.
  const soundEvents = settings["zaicode-sound-events-v1"];
  if (soundEvents) {
    let rows: Record<string, { sound?: unknown }> = {};
    try {
      const parsed = JSON.parse(soundEvents) as { events?: Record<string, { sound?: unknown }> } | null;
      rows = parsed?.events ?? {};
    } catch {
      delete settings["zaicode-sound-events-v1"];
    }
    for (const row of Object.values(rows)) {
      const sound = row?.sound;
      if (typeof sound !== "string" || !sound.startsWith("custom:") || cueAudio[sound]) continue;
      const blob = await readZaicodeCustomSoundBlob(sound);
      const data = blob ? await asDataUrl(blob) : readBundledZaicodeCustomSound(sound);
      if (!data) {
        throw new Error(`Own sound for ${sound.slice("custom:".length)} is missing; choose the file again before saving.`);
      }
      cueAudio[sound] = data;
    }
  }
  return JSON.stringify({ version: 1, settings, cueAudio } satisfies Snapshot);
}
