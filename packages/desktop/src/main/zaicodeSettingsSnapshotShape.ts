/**
 * T-229 deep audit (F6): the Save All writer is an IPC boundary. It receives an
 * arbitrary JSON string from the renderer and writes it into the *source tree*
 * defaults file that the next build ships (`zaicodeSettingsDefaults.json`), plus a
 * userData backup. It used to check only the payload size and that it parsed as an
 * object, so any renderer-side bug could persist arbitrary content as a released
 * default.
 *
 * The renderer's own allowlist lives in the renderer bundle and cannot be imported
 * here. What this module can enforce is the SHAPE the reader depends on, so a
 * snapshot that the reader could never consume is refused before a single byte is
 * written:
 *
 *   - `version` is exactly 1 (the only schema the reader knows);
 *   - `settings` is a flat string map inside the documented `zaicode-*` namespace;
 *   - `cueAudio` is a flat string map (its keys are cue ids and `custom:<event>`,
 *     so there is no namespace to check: bounded length and count only);
 *   - both maps are bounded, so a runaway renderer cannot inflate the shipped file.
 *
 * Deliberately no electron and no filesystem here: the decision is pure so it can be
 * exercised directly instead of asserted through the writer's source text.
 */

/** Matches the reader's key space: every entry in the renderer allowlist. */
const SETTING_KEY_PATTERN = /^zaicode-[a-z0-9-]+$/;

export const ZAICODE_SNAPSHOT_MAX_SETTINGS_KEYS = 200;
export const ZAICODE_SNAPSHOT_MAX_CUE_AUDIO_KEYS = 200;
export const ZAICODE_SNAPSHOT_MAX_KEY_LENGTH = 120;
export const ZAICODE_SNAPSHOT_VERSION = 1;

export type ZaicodeSnapshotShapeResult = { ok: true } | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringMapProblem(
  value: unknown,
  label: string,
  options: { keyPattern: RegExp | null; maxKeys: number; maxKeyLength: number },
): string | null {
  if (value === undefined) return null;
  if (!isPlainObject(value)) return `${label} must be an object of strings.`;
  const keys = Object.keys(value);
  if (keys.length > options.maxKeys) return `${label} holds more than ${options.maxKeys} entries.`;
  for (const key of keys) {
    if (!key || key.length > options.maxKeyLength) return `${label} has an entry with an unusable key.`;
    if (options.keyPattern && !options.keyPattern.test(key)) {
      return `${label} has an entry outside the ZAICODE key namespace: ${key}`;
    }
    if (typeof value[key] !== "string") return `${label}.${key} is not a string.`;
  }
  return null;
}

/**
 * The shape gate the writer runs before it touches disk. A refusal names what is
 * wrong so the operator sees a reason instead of a silent no-op.
 */
export function validateZaicodeSettingsSnapshotShape(parsed: unknown): ZaicodeSnapshotShapeResult {
  if (!isPlainObject(parsed)) return { ok: false, reason: "Snapshot must be an object." };
  if (parsed.version !== ZAICODE_SNAPSHOT_VERSION) {
    return { ok: false, reason: `Snapshot version must be ${ZAICODE_SNAPSHOT_VERSION}.` };
  }
  if (!isPlainObject(parsed.settings)) {
    return { ok: false, reason: "Snapshot settings must be an object of strings." };
  }
  const settingsProblem = stringMapProblem(parsed.settings, "settings", {
    keyPattern: SETTING_KEY_PATTERN,
    maxKeys: ZAICODE_SNAPSHOT_MAX_SETTINGS_KEYS,
    maxKeyLength: ZAICODE_SNAPSHOT_MAX_KEY_LENGTH,
  });
  if (settingsProblem) return { ok: false, reason: settingsProblem };
  const cueProblem = stringMapProblem(parsed.cueAudio, "cueAudio", {
    keyPattern: null,
    maxKeys: ZAICODE_SNAPSHOT_MAX_CUE_AUDIO_KEYS,
    maxKeyLength: ZAICODE_SNAPSHOT_MAX_KEY_LENGTH,
  });
  if (cueProblem) return { ok: false, reason: cueProblem };
  return { ok: true };
}
