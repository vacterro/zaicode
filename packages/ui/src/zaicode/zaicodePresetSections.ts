/**
 * Which stored settings each Settings section owns, for presets (T-125).
 *
 * A preset is one section's keys and nothing else: no live facts (running timers, sessions, schedules),
 * no credentials, nothing bound to this machine (paths, accounts). The list is closed on purpose: a file an
 * import reads can never write a key outside it, whatever the file says. Sections that already have a
 * complete preset system of their own -- Highlights & motion (built-ins, save, export, import) and Session
 * text (built-ins, save, whole-set file) -- keep it and are not listed; General, Router and Help hold no
 * looks worth sharing (the router holds keys).
 */

export type ZaicodePresetSectionId =
  | "zaicodeSounds"
  | "zaicodeNotifications"
  | "zaicodeColors"
  | "zaicodeProtrail"
  | "zaicodeTimers"
  | "zaicodeHotkeys"
  | "zaicodeSidebar"
  | "zaicodeLayout"
  | "zaicodeWorkers"
  | "zaicodeEngines";

export interface ZaicodePresetSection {
  id: ZaicodePresetSectionId;
  /** As Settings names the section. */
  title: string;
  /** localStorage keys the section owns; absent from storage = the release default. */
  keys: readonly string[];
  /**
   * Per key: dotted paths inside its JSON that belong to THIS machine or to right now -- a running flag, a
   * counter, the last view, project paths, a command to run. They are never captured, never compared, never
   * written to a file, and an apply leaves the value the page has now: sharing a look must not stop a running
   * Problip, hand over the project list, or plant a command in someone's Dispatch launchers.
   */
  local?: Readonly<Record<string, readonly string[]>>;
}

export const ZAICODE_PRESET_SECTIONS: readonly ZaicodePresetSection[] = [
  {
    id: "zaicodeSounds",
    title: "Sounds",
    // The event table (single sound or pool, gain, mix), Problip and Ambience, the picker's favourites.
    keys: ["zaicode-sound-events-v1", "zaicode-audio-v1", "zaicode-sound-picker-v1"],
    // Problip's running state and its day counters are facts about today, not part of a sound setup.
    local: { "zaicode-audio-v1": ["problipDays", "problip.running"] },
  },
  {
    id: "zaicodeNotifications",
    title: "Notifications",
    keys: ["zaicode-notifications-v1", "zaicode-notification-sound", "zcode-notification-enabled", "zcode-notification-sound-enabled"],
  },
  {
    id: "zaicodeColors",
    title: "Colors",
    keys: [
      "zaicode-palette",
      "zaicode-crisp",
      "zaicode-bevels",
      "zaicode-bevel-rows",
      "zaicode-font-settings",
      "zaicode-list-label-width",
      "zaicode-color-studio-v1",
      "zaicode-diamonds-v1",
    ],
  },
  { id: "zaicodeProtrail", title: "ProTrail", keys: ["zaicode-protrail-v1"] },
  { id: "zaicodeTimers", title: "Timers", keys: ["zaicode-timer-prefs-v1"] },
  { id: "zaicodeHotkeys", title: "Hotkeys", keys: ["zaicode-hotkeys-v1"] },
  // `groups` maps this machine's project paths to slots: not a look, and not for anyone else's eyes.
  { id: "zaicodeSidebar", title: "Sidebar", keys: ["zaicode-sidebar-prefs-v1"], local: { "zaicode-sidebar-prefs-v1": ["groups"] } },
  {
    id: "zaicodeLayout",
    title: "Layout & home",
    keys: ["zaicode-layout-v1", "zaicode-ui-prefs-v1", "zaicode-composer-prefs-v1", "zaicode-home-v1", "zaicode-fancyzones-settings"],
    local: { "zaicode-home-v1": ["lastView"], "zaicode-fancyzones-settings": ["fastIndex"] },
  },
  {
    id: "zaicodeWorkers",
    title: "Workers & terminal",
    keys: ["zaicode-workers-prefs-v1", "zaicode-dispatch-prefs-v1"],
    // A launcher is a command line that Dispatch runs: a shared file must never add one. `lastProject` is a path.
    local: { "zaicode-dispatch-prefs-v1": ["lastProject", "launchers"] },
  },
  // The account in use is a choice bound to this machine's accounts and stays out; the meters' look travels.
  { id: "zaicodeEngines", title: "Engines & limits", keys: ["zaicode-meter-prefs-v1", "zaicode-limit-meter-style"] },
];

const BY_ID = new Map<string, ZaicodePresetSection>(ZAICODE_PRESET_SECTIONS.map((section) => [section.id, section]));

export function zaicodePresetSection(id: string): ZaicodePresetSection | undefined {
  return BY_ID.get(id);
}

export function isZaicodePresetSection(id: string): id is ZaicodePresetSectionId {
  return BY_ID.has(id);
}
