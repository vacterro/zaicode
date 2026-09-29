import { getZaicodeCustomizationBridge, getZaicodeCustomizationInfo, openZaicodeCustomizationFolder } from "./zaicodeCustomSounds.js";

/**
 * The presets folder as the presets menu uses it (T-126): `customization\presets`, where an export lands with one
 * click and where a preset somebody sent is dropped to be found again under Import. Only the desktop app has it;
 * the menu takes it as an optional prop, so without it (the web build, a test) export stays a download and the
 * file picker stays the way in.
 */
export interface PresetFolder {
  /** File names in the folder, newest first. */
  list(): Promise<string[]>;
  /** The text of one file; null when it is gone or unreadable. */
  read(name: string): Promise<string | null>;
  /** Saves under `fileName` (a different file with that name pushes it to `name (2).json`); null = could not. */
  save(fileName: string, text: string): Promise<{ name: string; created: boolean } | null>;
  /** Shows one file selected in the file manager. */
  show(name: string): void;
  /** Opens the folder itself. */
  open(): void;
  /** Where it is, for the words on screen; null when unknown. */
  location(): Promise<string | null>;
  /** Called (debounced by main) whenever a file appears, changes or goes; returns the way to stop. */
  onChange(callback: () => void): () => void;
}

/** The desktop's presets folder, or null when there is no desktop. */
export function zaicodePresetFolder(): PresetFolder | null {
  const bridge = getZaicodeCustomizationBridge();
  if (!bridge?.listZaicodeCustomPresets || !bridge.readZaicodeCustomPreset || !bridge.writeZaicodeCustomPreset) return null;
  return {
    list: async () => (await bridge.listZaicodeCustomPresets!().catch(() => [])).map((entry) => entry.name),
    read: async (name) => {
      const result = await bridge.readZaicodeCustomPreset!(name).catch(() => null);
      return result?.ok ? result.text : null;
    },
    save: async (fileName, text) => {
      const result = await bridge.writeZaicodeCustomPreset!({ name: fileName, text }).catch(() => null);
      return result?.ok ? { name: result.path, created: result.created } : null;
    },
    show: (name) => void openZaicodeCustomizationFolder({ kind: "presets", file: name }),
    open: () => void openZaicodeCustomizationFolder({ kind: "presets" }),
    location: async () => (await getZaicodeCustomizationInfo())?.presetsDir ?? null,
    onChange: (callback) =>
      bridge.onZaicodeCustomizationChanged?.((change) => {
        if (change === "presets") callback();
      }) ?? (() => undefined),
  };
}

export type ExportPlacement = { where: "folder"; name: string } | { where: "download"; fallback: boolean };

/**
 * Where an exported preset goes: into the presets folder when there is one (one click, nothing to answer), else
 * a download. A folder that refuses the write is not a lost export: it is downloaded instead and `fallback` says
 * why, so the message can tell the person the folder did not work.
 */
export async function placeExportedPreset(
  folder: PresetFolder | null,
  fileName: string,
  text: string,
  download: (fileName: string, text: string) => void,
): Promise<ExportPlacement> {
  const saved = folder ? await folder.save(fileName, text) : null;
  if (saved) return { where: "folder", name: saved.name };
  download(fileName, text);
  return { where: "download", fallback: folder !== null };
}
