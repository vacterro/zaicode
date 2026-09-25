/**
 * Per-profile settings bundles (SRC-043), pure: the store half is
 * zaicodeProfiles.ts (switch = save this bundle, put the other in place,
 * reload).
 */

/**
 * What a profile keeps for itself ("a profile saves everything individually"):
 * every ZAICODE preference -- theme colours, fonts, sounds, hotkeys, layout,
 * highlights, meters, workers, SAIHOME layout, the composer -- plus upstream's
 * own appearance keys (theme, language, UI size, sidebar width). Live facts
 * stay shared by every profile: MAIN sessions, todo progress, the running
 * timers and alarms, schedules, journals, session roles, switched-off
 * projects, and own sound files (they live in one IndexedDB store).
 */
export const ZAICODE_PROFILE_KEYS: readonly string[] = [
  "zaicode-ui-prefs-v1",
  "zaicode-sidebar-prefs-v1",
  "zaicode-cues-v1",
  "zaicode-icon-overrides",
  "zaicode-audio-v1",
  "zaicode-palette",
  "zaicode-crisp",
  "zaicode-font-settings",
  "zaicode-list-label-width",
  "zaicode-default-model",
  "zaicode-auto-session-title",
  "zaicode-help-hidden",
  "zaicode-sound-events-v1",
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
  "zaicode-saipen-log-order-v1",
  "zaicode-lights-v1",
  "zaicode-composer-prefs-v1",
  "zaicode-dispatch-prefs-v1",
  "zaicode-home-v1",
  "zaicode-active-engine",
  "zaicode-notification-sound",
  "zaicode-notification-custom-sound-name",
  "zaicode-saipen-pane-open-v1",
  "zaicode-todo-window",
  "zcode-theme",
  "zcode-locale-preference",
  "zcode-ui-font-size-px",
  "zcode:workspace-shell:sidebar-width-px",
  "zcode-sidebar-task-preferences",
  "zcode-notification-enabled",
  "zcode-notification-sound-enabled",
  "zcode-code-preview-settings",
  "zcode-performance-mode",
];

const BUNDLE_PREFIX = "zaicode-profile-bundle:";

/** A profile's settings; `null` = the key was unset (the release default applies). */
export interface ZaicodeProfileBundle {
  version: 1;
  values: Record<string, string | null>;
}

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem" | "removeItem">;

export function captureZaicodeProfileBundle(storage: ReadStorage): ZaicodeProfileBundle {
  const values: Record<string, string | null> = {};
  for (const key of ZAICODE_PROFILE_KEYS) values[key] = storage.getItem(key);
  return { version: 1, values };
}

/** Puts a bundle's values in place; keys it does not know are left alone. */
export function applyZaicodeProfileBundle(storage: WriteStorage, bundle: ZaicodeProfileBundle): void {
  for (const key of ZAICODE_PROFILE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(bundle.values, key)) continue;
    const value = bundle.values[key];
    if (value === null || value === undefined) storage.removeItem(key);
    else storage.setItem(key, value);
  }
}

export function parseZaicodeProfileBundle(raw: string | null): ZaicodeProfileBundle | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; values?: unknown };
    if (parsed.version !== 1 || !parsed.values || typeof parsed.values !== "object") return null;
    const values: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(parsed.values as Record<string, unknown>)) {
      if (typeof value === "string" || value === null) values[key] = value;
    }
    return { version: 1, values };
  } catch {
    return null;
  }
}

export function zaicodeProfileBundleKey(profileId: string): string {
  return `${BUNDLE_PREFIX}${profileId}`;
}
