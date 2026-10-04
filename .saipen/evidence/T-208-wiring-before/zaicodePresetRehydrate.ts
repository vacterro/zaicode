import { reloadZaicodeAudio } from "./zaicodeAudio.js";
import { reloadZaicodeAppearance } from "./zaicodeAppearance.js";
import { reloadZaicodeColorStudio } from "./zaicodeColorStudio.js";
import { reloadZaicodeComposerPrefs } from "./zaicodeComposerPrefs.js";
import { reloadZaicodeDiamondColors } from "./zaicodeDiamondColors.js";
import { reloadZaicodeDispatchPrefs } from "./zaicodeDispatch.js";
import { reloadZaicodeFancyZones } from "./zaicodeFancyZones.js";
import { reloadZaicodeHotkeys } from "./zaicodeHotkeys.js";
import { reloadZaicodeHomePrefs } from "./home/zaicodeHomePrefs.js";
import { reloadZaicodeLayoutPrefs } from "./zaicodeLayoutPrefs.js";
import { reloadZaicodeMeterPrefs } from "./zaicodeMeterPrefs.js";
import { reloadZaicodeNotifySettings } from "./zaicodeNotifications.js";
import { reloadZaicodeProtrail } from "./protrail/zaicodeProtrailStore.js";
import { reloadZaicodeSoundPickerPrefs } from "./ZaicodeSoundPicker.js";
import { reloadZaicodeSoundSettings } from "./zaicodeSoundEvents.js";
import { reloadZaicodeSidebarPrefs } from "./zaicodeSidebarPrefs.js";
import { reloadZaicodeTimerPrefs } from "./zaicodeTimerStore.js";
import { reloadZaicodeUiPrefs } from "./zaicodeUiPrefs.js";
import { reloadZaicodeWorkerPrefs } from "./zaicodeWorkerPrefs.js";
import type { ZaicodePresetSectionId } from "./zaicodePresetSections.js";

/**
 * Puts freshly written preset values in front of the open window without reloading it (T-208).
 *
 * Before T-208 every section except Sounds answered `rehydrate` with false and the preset system reloaded
 * the whole window to pick the new values up -- a Settings preset restart interrupted everything the
 * operator had open. Each affected store now owns a `reload...` function that re-reads its stored value
 * and notifies its readers; this module routes a section to the stores its keys live in.
 *
 * The stateless notification keys (`zaicode-notification-sound`, `zcode-notification-*`) are read per call
 * and need no hook. Sections with their own preset systems (Highlights & motion, Session text, SAIASUI)
 * write their stores directly and are not routed here.
 */

const RELOADERS: Readonly<Record<ZaicodePresetSectionId, readonly (() => void)[]>> = {
  zaicodeSounds: [reloadZaicodeSoundSettings, reloadZaicodeAudio, reloadZaicodeSoundPickerPrefs],
  zaicodeNotifications: [reloadZaicodeNotifySettings],
  zaicodeColors: [reloadZaicodeColorStudio, reloadZaicodeDiamondColors, reloadZaicodeAppearance],
  zaicodeProtrail: [reloadZaicodeProtrail],
  zaicodeTimers: [reloadZaicodeTimerPrefs],
  zaicodeHotkeys: [reloadZaicodeHotkeys],
  zaicodeSidebar: [reloadZaicodeSidebarPrefs],
  zaicodeLayout: [
    reloadZaicodeLayoutPrefs,
    reloadZaicodeUiPrefs,
    reloadZaicodeComposerPrefs,
    reloadZaicodeHomePrefs,
    reloadZaicodeFancyZones,
  ],
  zaicodeWorkers: [reloadZaicodeWorkerPrefs, reloadZaicodeDispatchPrefs],
  zaicodeEngines: [reloadZaicodeMeterPrefs],
};

/**
 * Re-reads every store the section's keys live in, leaving the existing renderer and runtime attached.
 */
export function rehydrateZaicodePresetSection(section: ZaicodePresetSectionId): void {
  for (const reload of RELOADERS[section]) reload();
}
