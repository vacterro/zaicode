import manifest from "./zaicodeSoundManifest.json" with { type: "json" };

/**
 * The bundled sound library as a picker sees it: every file with its length
 * and a kind, so a 0.2 s click, a 6 s jingle, a 55 s rain loop and a voice
 * line are never one alphabetical wall. Lengths come from
 * zaicodeSoundManifest.json (scripts/zaicode-sound-manifest.mjs).
 */

export type ZaicodeSoundKind = "click" | "alert" | "jingle" | "long" | "ambience" | "voice";

export const ZAICODE_SOUND_KINDS: readonly { id: ZaicodeSoundKind; label: string; hint: string }[] = [
  { id: "click", label: "Clicks", hint: "Under half a second: clicks, blips, ticks" },
  { id: "alert", label: "Alerts", hint: "Half a second to 1.5 s: pops, chimes, beeps" },
  { id: "jingle", label: "Jingles", hint: "1.5 to 5 s: short melodies and stings" },
  { id: "long", label: "Long", hint: "5 to 15 s: fanfares, themes, music" },
  { id: "ambience", label: "Ambience", hint: "Loops and anything over 15 s: background layers" },
  { id: "voice", label: "Voice", hint: "Spoken lines (HEV / VOX / G-Man)" },
];

const AMBIENCE_NAME = /(^|\/)(loop|computalk|cicada|rain)/i;

/** Kind of one library file from its path and length in seconds. */
export function categorizeZaicodeSound(relativePath: string, seconds: number): ZaicodeSoundKind {
  if (/^_vault\/(fvox|vox|gman)\//i.test(relativePath)) return "voice";
  if (seconds > 15 || AMBIENCE_NAME.test(relativePath)) return "ambience";
  if (seconds < 0) return "alert";
  if (seconds < 0.5) return "click";
  if (seconds < 1.5) return "alert";
  if (seconds < 5) return "jingle";
  return "long";
}

/** "0.4s", "6s", "1:12". */
export function formatZaicodeSoundLength(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "?";
  if (seconds < 1) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export interface ZaicodeSoundEntry {
  /** Stored sound id, `fastprompter:<relative path>`. */
  id: string;
  /** File name without folders or extension. */
  name: string;
  /** Folder inside the library ("" for the root). */
  folder: string;
  seconds: number;
  kind: ZaicodeSoundKind;
}

const lengths = manifest as Record<string, number>;

let catalog: ZaicodeSoundEntry[] | null = null;

export function listZaicodeSoundCatalog(): readonly ZaicodeSoundEntry[] {
  if (catalog) return catalog;
  catalog = Object.entries(lengths)
    // The vault keeps a duplicate of the cs_style pack; the root copy is the one to pick.
    .filter(([path]) => !path.startsWith("_vault/cs_style/"))
    .map(([path, seconds]) => {
      const slash = path.lastIndexOf("/");
      const file = path.slice(slash + 1);
      return {
        id: `fastprompter:${path}`,
        name: file.replace(/(\.wav)?\.(wav|mp3|ogg)$/i, ""),
        folder: slash < 0 ? "" : path.slice(0, slash),
        seconds,
        kind: categorizeZaicodeSound(path, seconds),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  return catalog;
}

export function zaicodeSoundEntry(id: string): ZaicodeSoundEntry | undefined {
  return listZaicodeSoundCatalog().find((entry) => entry.id === id);
}

/** Human label of any stored sound id. */
export function zaicodeSoundDisplayName(id: string): string {
  if (id === "default") return "notification pop";
  if (id.startsWith("custom:")) return "own file";
  const entry = zaicodeSoundEntry(id);
  if (entry) return entry.folder ? `${entry.name} · ${entry.folder.replace(/^_vault\//, "")}` : entry.name;
  return id.replace(/^fastprompter:/, "");
}
