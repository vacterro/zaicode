import type { ImportPreview } from "./zaicodePresetApply.js";
import type { ZaicodePreset } from "./zaicodePresetFile.js";

/** The words the presets menu shows, kept apart from React so they can be checked. */

export function formatSoundSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ownSoundsLabel(count: number): string {
  return `${count} own sound${count === 1 ? "" : "s"}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "29 Sep 2026" whatever the machine's locale says; empty for the placeholder date of a file that named none. */
export function presetDateLabel(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time) || time < 86_400_000) return "";
  const date = new Date(time);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** The grey line under a preset's name. */
export function presetMeta(preset: Pick<ZaicodePreset, "createdAt" | "assets">): string {
  return [presetDateLabel(preset.createdAt), preset.assets.length > 0 ? ownSoundsLabel(preset.assets.length) : ""].filter(Boolean).join(" · ");
}

/** What importing a file would do, in the order a person decides: what changes, what comes along, what was left out. */
export function importPreviewLines(preview: ImportPreview, sectionTitle: string): string[] {
  const lines = [
    preview.changes === 0
      ? `${sectionTitle} is set exactly like this already.`
      : `Would change ${preview.changes} stored setting${preview.changes === 1 ? "" : "s"} of ${sectionTitle} (not applied until you say so).`,
  ];
  if (preview.sounds.length > 0) {
    lines.push(`Brings ${ownSoundsLabel(preview.sounds.length)}: ${preview.sounds.map((sound) => `${sound.name} (${formatSoundSize(sound.bytes)})`).join(", ")}.`);
  }
  return lines;
}

/** Saving or exporting could not keep some own sounds: the person hears which events will be silent. */
export function missingSoundsNote(missing: readonly string[], when: "saved" | "exported"): string {
  if (missing.length === 0) return "";
  const names = missing.map((id) => id.replace(/^[a-z]+:/, "")).join(", ");
  return ` No sound file for ${names} in this installation, so ${missing.length === 1 ? "that event is" : "those events are"} silent when it is used elsewhere. Pick the sound again and update the preset${when === "exported" ? " before sharing" : ""}.`;
}
