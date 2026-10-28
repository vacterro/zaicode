import bundled from "./zaicodeSettingsDefaults.json" with { type: "json" };

/** Only durable ZAICODE preferences belong in a release snapshot.
 * T-223: exported so the Save All coverage test pins the allowlist. */
export const ZAICODE_SAVE_ALL_SETTING_KEYS = [
  "zaicode-ui-prefs-v1",
  "zaicode-sidebar-prefs-v1",
  // Wave 4: virtual folders and pins are organization metadata about a
  // project, and ride a profile like every other ZAICODE preference.
  "zaicode-project-folders-v1",
  "zaicode-diamonds-v1",
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
  "zaicode-saipen-ticket-order-v1",
  "zaicode-lights-v1",
  "zaicode-model-appearance-v1",
  "zaicode-lights-presets-v1",
  "zaicode-composer-prefs-v1",
  "zaicode-saiasui-settings-v1",
  "zaicode-protrail-v1",
  // T-226: the durable families the T-223 audit named but the first allowlist
  // missed; each one's store reads through readZaicodeSetting, so the snapshot
  // default actually lands (the other named families read raw localStorage and
  // would be dead entries until their readers move to readZaicodeSetting).
  "zaicode-auto-continue-v1",
  "zaicode-auto-goal-v1",
  "zaicode-autostart-v1",
  "zaicode-change-floaters-v1",
  "zaicode-dispatch-prefs-v1",
  "zaicode-engine-bar-v1",
  "zaicode-header-title-v1",
  "zaicode-home-v1",
  "zaicode-icon-profiles-v1",
  "zaicode-size",
  "zaicode-presentation",
  "zaicode-active-engine",
  "zaicode-scheduler-marks-v1",
  "zaicode-session-text-v1",
  "zaicode-session-text-presets-v1",
  "zaicode-saipeggle-v1",
  "zaicode-presets-v1",
] as const;

type Snapshot = { version: 1; settings: Record<string, string>; cueAudio: Record<string, string> };

const defaults = bundled as Snapshot;

/** Current installation wins. Bundled values fill only missing preferences. */
export function readZaicodeSetting(key: string): string | null {
  // 存储被禁用时读取会抛异常；可选音效预热不能因此阻断工作区加载。
  try {
    const current = localStorage.getItem(key);
    if (current !== null) return current;
  } catch {
    // Bundled defaults remain usable without browser storage.
  }
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

/**
 * T-245 / SRC-160:R005: a release snapshot carries durable preferences only. Some
 * allowlisted families also hold state about one session or one run — per-session
 * overrides, already-fired markers, run history, the operator's last click. The names
 * below are that whole class; per family, the ones it actually holds.
 */
const ZAICODE_SNAPSHOT_EPHEMERAL_NAMES: readonly string[] = [
  "autoRetrySessions",
  "schedulerIneligible",
  "firedEvents",
  "lastRunAt",
  "lastResult",
  "runs",
  "lastFired",
  "lastFiredMinute",
  "lastProject",
  "lastView",
];

/** A family absent here ships verbatim — but only after the session scan passes it. */
const ZAICODE_SNAPSHOT_EPHEMERAL_FIELDS: Record<string, readonly string[]> = {
  "zaicode-ui-prefs-v1": ["autoRetrySessions", "schedulerIneligible"],
  "zaicode-autostart-v1": ["firedEvents", "lastRunAt", "lastResult", "runs"],
  "zaicode-timer-prefs-v1": ["lastFired", "lastFiredMinute"],
  "zaicode-dispatch-prefs-v1": ["lastProject"],
  "zaicode-home-v1": ["lastView"],
  // A preset bundles other families' payloads, so it carries their volatile fields too.
  "zaicode-presets-v1": [...ZAICODE_SNAPSHOT_EPHEMERAL_NAMES],
};

/** `sess_<uuid>` is one session's key wherever it turns up. */
const ZAICODE_SNAPSHOT_SESSION_KEY = /^sess_/;

/** Remove `fields` from `value` at every depth; arrays are mapped, scalars untouched. */
function stripEphemeralFields(value: unknown, fields: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((row) => stripEphemeralFields(row, fields));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (fields.includes(key)) continue;
    out[key] = stripEphemeralFields(child, fields);
  }
  return out;
}

/** Path of the first session key or volatile field left anywhere, or null when clean. */
function findEphemeralPayload(value: unknown, path: string): string | null {
  if (Array.isArray(value)) {
    for (const [index, row] of value.entries()) {
      const found = findEphemeralPayload(row, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (ZAICODE_SNAPSHOT_SESSION_KEY.test(key) || ZAICODE_SNAPSHOT_EPHEMERAL_NAMES.includes(key)) {
      return `${path}.${key}`;
    }
    const found = findEphemeralPayload(child, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

/**
 * What a family actually contributes to the snapshot. Its declared volatile fields are
 * stripped first; a family that still carries session state after that is REFUSED — left
 * out with a warning — instead of shipped. A family the table does not know is refused the
 * same way, so a new session-scoped field fails closed rather than becoming a factory
 * default; the shipped-defaults regression test walks every family so this stays visible.
 */
function projectZaicodeSnapshotFamily(key: string, value: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value; // Not JSON: it cannot carry a nested session key.
  }
  const fields = ZAICODE_SNAPSHOT_EPHEMERAL_FIELDS[key];
  const projected = fields ? stripEphemeralFields(parsed, fields) : parsed;
  const leftover = findEphemeralPayload(projected, key);
  if (leftover) {
    console.warn(`[zaicode] Save All refused ${key}: it carries session state (${leftover}).`);
    return null;
  }
  return fields ? JSON.stringify(projected) : value;
}

export async function captureZaicodeSettingsSnapshot(): Promise<string> {
  const settings: Record<string, string> = {};
  const cueAudio: Record<string, string> = {};
  for (const key of ZAICODE_SAVE_ALL_SETTING_KEYS) {
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
      const projected = projectZaicodeSnapshotFamily(key, value);
      if (projected !== null) settings[key] = projected;
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
