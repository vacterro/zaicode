import { create } from "zustand";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";

/**
 * Session diamond colours (SRC-049). The ◆ / ◇ before a session title tells
 * which model the chat works with: yellow = SAIFREN (the free pool), orange =
 * SAIOPP (the paid pool, "the serious one"), any other model its own stable
 * colour. Everything is the operator's to change; an empty colour means the
 * built-in default. Role glyphs (TEST, WIKI, ...) keep their role colour.
 */

export type ZaicodeOtherModelColors = "auto" | "single";

export interface ZaicodeDiamondRule {
  /** Case-insensitive part of the model id ("claude", "gpt-5", "glm"). */
  match: string;
  color: string;
}

export interface ZaicodeDiamondPrefs {
  /** Colour diamonds by the chat's model; off = the old gold MAIN / grey side diamonds. */
  byModel: boolean;
  saifren: string;
  saiopp: string;
  /** Other models: one colour each (stable per model) or all the same colour. */
  others: ZaicodeOtherModelColors;
  othersColor: string;
  /** Checked first, top to bottom. */
  rules: ZaicodeDiamondRule[];
}

export const ZAICODE_DIAMOND_DEFAULT_SAIFREN = "var(--zaicode-highlight, var(--color-warning))";
export const ZAICODE_DIAMOND_DEFAULT_SAIOPP = "#e0884a";
export const ZAICODE_DIAMOND_DEFAULT_OTHER = "#58a6d8";
/** Stable colours for other models: no yellow or orange, those two are the pools'. */
const OTHER_HUES = ["#58a6d8", "#7fc35a", "#a78bda", "#4fc0b5", "#e0665a", "#6aa5e8", "#b8b09a", "#c77dba"];

export const ZAICODE_DIAMOND_DEFAULT_PREFS: ZaicodeDiamondPrefs = {
  byModel: true,
  saifren: "",
  saiopp: "",
  others: "auto",
  othersColor: "",
  rules: [],
};

const STORAGE_KEY = "zaicode-diamonds-v1";
const COLOR_PATTERN = /^(#[0-9a-f]{3,8}|var\(--[a-z0-9-]+(,\s*[^)]*)?\)|rgb\([\d\s,.%]+\))$/i;

function color(value: unknown): string {
  return typeof value === "string" && COLOR_PATTERN.test(value.trim()) ? value.trim() : "";
}

export function normalizeZaicodeDiamondPrefs(raw: unknown): ZaicodeDiamondPrefs {
  const d = ZAICODE_DIAMOND_DEFAULT_PREFS;
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ZaicodeDiamondPrefs, unknown>>;
  const rules = Array.isArray(r.rules)
    ? r.rules
        .map((rule) => {
          const entry = (rule && typeof rule === "object" ? rule : {}) as Record<string, unknown>;
          return {
            match: typeof entry.match === "string" ? entry.match.trim().slice(0, 80) : "",
            color: color(entry.color),
          };
        })
        .filter((rule) => rule.match && rule.color)
        .slice(0, 24)
    : [];
  return {
    byModel: typeof r.byModel === "boolean" ? r.byModel : d.byModel,
    saifren: color(r.saifren),
    saiopp: color(r.saiopp),
    others: r.others === "single" ? "single" : "auto",
    othersColor: color(r.othersColor),
    rules,
  };
}

/** The model part of a task model ("custom-12/SAIOPP$enabled" -> "saiopp"), lower case. */
export function zaicodeModelKey(model: string | null | undefined): string {
  if (!model) return "";
  const last = model.slice(model.lastIndexOf("/") + 1);
  return last.split("$")[0]!.trim().toLowerCase();
}

function stableHue(key: string): string {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) | 0;
  return OTHER_HUES[Math.abs(hash) % OTHER_HUES.length]!;
}

/**
 * Colour of a session's diamond for its model, or null when the model is
 * unknown or colouring by model is off (the glyph then keeps its default).
 */
export function zaicodeDiamondColor(model: string | null | undefined, prefs: ZaicodeDiamondPrefs): string | null {
  if (!prefs.byModel) return null;
  const key = zaicodeModelKey(model);
  if (!key) return null;
  const full = (model ?? "").toLowerCase();
  for (const rule of prefs.rules) if (full.includes(rule.match.toLowerCase())) return rule.color;
  if (key === "saifren") return prefs.saifren || ZAICODE_DIAMOND_DEFAULT_SAIFREN;
  if (key === "saiopp") return prefs.saiopp || ZAICODE_DIAMOND_DEFAULT_SAIOPP;
  if (prefs.others === "single") return prefs.othersColor || ZAICODE_DIAMOND_DEFAULT_OTHER;
  return stableHue(key);
}

/** Short name of what a diamond colour stands for (tooltips). */
export function zaicodeDiamondLabel(model: string | null | undefined): string {
  const key = zaicodeModelKey(model);
  if (key === "saifren") return "SAIFREN";
  if (key === "saiopp") return "SAIOPP";
  return key ? model!.slice(model!.lastIndexOf("/") + 1).split("$")[0]! : "";
}

function load(): ZaicodeDiamondPrefs {
  try {
    return normalizeZaicodeDiamondPrefs(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null"));
  } catch {
    return normalizeZaicodeDiamondPrefs(null);
  }
}

interface ZaicodeDiamondPrefsState extends ZaicodeDiamondPrefs {
  update: (patch: Partial<ZaicodeDiamondPrefs>) => void;
  reset: () => void;
}

export const useZaicodeDiamondPrefs = create<ZaicodeDiamondPrefsState>((set, get) => {
  const persist = (next: ZaicodeDiamondPrefs) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Preference only; the in-memory copy still applies.
    }
    set(next);
  };
  return {
    ...load(),
    update: (patch) => {
      const { update: _update, reset: _reset, ...current } = get();
      persist(normalizeZaicodeDiamondPrefs({ ...current, ...patch }));
    },
    reset: () => persist(normalizeZaicodeDiamondPrefs(null)),
  };
});

/** The diamond colour for a model, live with the settings. */
export function useZaicodeDiamondColor(model: string | null | undefined): string | null {
  return useZaicodeDiamondPrefs((state) => zaicodeDiamondColor(model, state));
}

/** Live preset apply (T-208): take the stored diamond colours without reloading the window. */
export function reloadZaicodeDiamondColors(): void {
  useZaicodeDiamondPrefs.setState(load());
}
