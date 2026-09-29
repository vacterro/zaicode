import { useSyncExternalStore } from "react";
import { parseModelPickerValue } from "@zcode/shared";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import {
  ZAICODE_HIGHLIGHT_COLORS,
  ZAICODE_HIGHLIGHT_EFFECTS,
  ZAICODE_HIGHLIGHT_SHAPES,
  ZAICODE_HIGHLIGHT_TARGETS,
  ZAICODE_HIGHLIGHT_DEFAULTS,
  type ZaicodeHighlightColor,
  type ZaicodeHighlightEffect,
  type ZaicodeHighlightRule,
  type ZaicodeHighlightShape,
  type ZaicodeHighlightTarget,
} from "./zaicodeHighlights.js";

/**
 * Per-model appearance (Wave 4, part C): which highlight and which worker
 * icon a model wears while it is the one actually working.
 *
 * Two things this file is careful about, because confusing them is the whole
 * bug class it exists to prevent:
 *
 * 1. THE MODEL IS NOT THE PICKER. `zaicodeDefaultModel` is the operator's
 *    SELECTION; `task.model` is what actually executed the work. Appearance
 *    follows the second. There is deliberately no import of the default-model
 *    store here, and a control asserts the resolver's answer does not move
 *    when the picker does.
 * 2. THE IDENTITY IS NOT THE LABEL. A model is keyed by provider id + model
 *    id, never by a display string, so "SAIFREN" the label and whatever the
 *    provider renames it to next month cannot silently merge two models.
 *
 * The fallback chain is exactly the wave's: an exact model in Separate mode,
 * then the global Default, then what the product ships.
 */

export interface ZaicodeModelIdentity {
  providerId: string;
  modelId: string;
}

/** The settings key for one model. Stable across renames of the display name. */
export function zaicodeModelIdentityKey(identity: ZaicodeModelIdentity | null): string {
  if (!identity) return "";
  return `${identity.providerId.trim().toLowerCase()}::${identity.modelId.trim().toLowerCase()}`;
}

/** A picker string ("custom-12/SAIOPP$enabled") as a stable identity. */
export function parseZaicodeModelIdentity(model: string | null | undefined): ZaicodeModelIdentity | null {
  if (!model) return null;
  const parsed = parseModelPickerValue(model);
  const providerId = parsed?.providerId?.trim();
  const modelId = parsed?.modelId?.trim();
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

/**
 * The targets a per-model override can diverge on: the same list the global
 * Highlights editor offers, so one model can change one target without the
 * settings growing a second vocabulary.
 */
export const ZAICODE_MODEL_APPEARANCE_KEYS = ZAICODE_HIGHLIGHT_TARGETS.map((target) => target.id);

export type ZaicodeModelAppearanceMode = "default" | "separate";

export interface ZaicodeModelAppearanceOverride {
  mode: ZaicodeModelAppearanceMode;
  /**
   * Only the targets this model diverges on, in the SAME rule vocabulary the
   * global Highlights editor already speaks -- a partial rule, so a model can
   * change one colour without restating effects and shapes.
   */
  highlight?: Partial<Record<ZaicodeHighlightTarget, Partial<ZaicodeHighlightRule>>>;
  /** A bundled icon id, an image URL, or a data: image -- the safe asset rules. */
  workerIcon?: string;
}

export interface ZaicodeModelAppearancePrefs {
  /** What every model wears unless it says otherwise. */
  global: {
    mode: ZaicodeModelAppearanceMode;
    highlight: Partial<Record<ZaicodeHighlightTarget, Partial<ZaicodeHighlightRule>>>;
    workerIcon: string;
  };
  models: Record<string, ZaicodeModelAppearanceOverride>;
}

export const ZAICODE_MODEL_APPEARANCE_DEFAULTS: ZaicodeModelAppearancePrefs = {
  global: { mode: "default", highlight: {}, workerIcon: "" },
  models: {},
};

/** What the product ships when neither the model nor the global says otherwise. */
export const ZAICODE_APPEARANCE_FALLBACK = Object.freeze({
  highlight: {} as Partial<Record<ZaicodeHighlightTarget, Partial<ZaicodeHighlightRule>>>,
  workerIcon: "",
});

/** The product's own rule for a target: what "no override" resolves to. */
export function zaicodeShippedHighlight(): Record<ZaicodeHighlightTarget, ZaicodeHighlightRule> {
  return { ...ZAICODE_HIGHLIGHT_DEFAULTS };
}

const TARGET_IDS = new Set<string>(ZAICODE_HIGHLIGHT_TARGETS.map((target) => target.id));
const EFFECT_IDS = new Set<string>(ZAICODE_HIGHLIGHT_EFFECTS.map((effect) => effect.id));
const SHAPE_IDS = new Set<string>(ZAICODE_HIGHLIGHT_SHAPES.map((shape) => shape.id));
const COLOR_IDS = new Set<string>(ZAICODE_HIGHLIGHT_COLORS.map((color) => color.id));
const MAX_MODELS = 200;
const MAX_ASSET = 1024 * 1024;

/**
 * The same rule the working-icon normalizer uses -- an asset is a data:/URL
 * image or a bundled `builtin:` id, never code. `builtin:` was missing here at
 * first and it is the form the bundled icons actually arrive in, so every
 * bundled icon silently fell through to the shipped one.
 */
export function isZaicodeImageAsset(value: string): boolean {
  return /^(data:image\/|https?:\/\/|\.{0,2}\/|\/|builtin:)/i.test(value.trim());
}

/** One partial rule, validated against the same vocabularies the editor uses. */
function cleanRule(raw: unknown): Partial<ZaicodeHighlightRule> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const out: Partial<ZaicodeHighlightRule> = {};
  if (typeof value.enabled === "boolean") out.enabled = value.enabled;
  if (Array.isArray(value.effects)) {
    const effects = value.effects.filter((effect): effect is ZaicodeHighlightEffect => EFFECT_IDS.has(String(effect)));
    if (effects.length > 0) out.effects = effects;
  }
  if (Array.isArray(value.shapes)) {
    const shapes = value.shapes.filter((shape): shape is ZaicodeHighlightShape => SHAPE_IDS.has(String(shape)));
    if (shapes.length > 0) out.shapes = shapes;
  }
  if (typeof value.color === "string" && COLOR_IDS.has(value.color)) out.color = value.color as ZaicodeHighlightColor;
  if (typeof value.custom === "string" && /^(#[0-9a-fA-F]{3,8}|[a-z]+|var\(--[a-z0-9-]+\))$/i.test(value.custom.trim())) {
    out.custom = value.custom.trim();
  }
  if (typeof value.strength === "number" && Number.isFinite(value.strength)) {
    out.strength = Math.min(100, Math.max(10, value.strength));
  }
  if (typeof value.seconds === "number" && Number.isFinite(value.seconds)) {
    out.seconds = Math.min(10, Math.max(0.1, value.seconds));
  }
  if (typeof value.keepMoving === "boolean") out.keepMoving = value.keepMoving;
  return Object.keys(out).length > 0 ? out : null;
}

/** Only the targets the operator named, each a PARTIAL rule over the shared one. */
function cleanHighlight(
  raw: unknown,
): Partial<Record<ZaicodeHighlightTarget, Partial<ZaicodeHighlightRule>>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Partial<Record<ZaicodeHighlightTarget, Partial<ZaicodeHighlightRule>>> = {};
  for (const [target, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!TARGET_IDS.has(target)) continue;
    const rule = cleanRule(value);
    if (rule) out[target as ZaicodeHighlightTarget] = rule;
  }
  return out;
}

function cleanAsset(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ASSET) return "";
  return isZaicodeImageAsset(trimmed) ? trimmed : "";
}

export function normalizeZaicodeModelAppearancePrefs(raw: unknown): ZaicodeModelAppearancePrefs {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const globalRaw = source.global && typeof source.global === "object" ? (source.global as Record<string, unknown>) : {};
  const models: Record<string, ZaicodeModelAppearanceOverride> = {};
  for (const [key, value] of Object.entries(
    source.models && typeof source.models === "object" ? (source.models as Record<string, unknown>) : {},
  )) {
    if (Object.keys(models).length >= MAX_MODELS) break;
    if (typeof key !== "string" || !key.trim() || !value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    // A refused asset is ABSENT, not an empty string: "" would later read as
    // "the operator set this to nothing" instead of "they set nothing".
    const icon = cleanAsset(entry.workerIcon);
    models[key.trim().toLowerCase()] = {
      mode: entry.mode === "separate" ? "separate" : "default",
      ...(entry.highlight ? { highlight: cleanHighlight(entry.highlight) } : {}),
      ...(icon ? { workerIcon: icon } : {}),
    };
  }
  return {
    global: {
      mode: globalRaw.mode === "separate" ? "separate" : "default",
      highlight: cleanHighlight(globalRaw.highlight),
      workerIcon: cleanAsset(globalRaw.workerIcon),
    },
    models,
  };
}

export interface ZaicodeEffectiveAppearance {
  mode: ZaicodeModelAppearanceMode;
  highlight: Partial<Record<ZaicodeHighlightTarget, Partial<ZaicodeHighlightRule>>>;
  /** "" means the global worker icon, and "" there means the shipped one. */
  workerIcon: string;
}

/**
 * The wave's fallback chain, in order: the model's own Separate override, the
 * global Default, the shipped product fallback. `model` is the model that
 * actually executed the work.
 */
export function resolveZaicodeModelAppearance(
  prefs: ZaicodeModelAppearancePrefs,
  model: string | null | undefined,
): ZaicodeEffectiveAppearance {
  const identity = parseZaicodeModelIdentity(model);
  const key = zaicodeModelIdentityKey(identity);
  const override = key ? prefs.models[key] : undefined;

  if (override?.mode === "separate") {
    return {
      mode: "separate",
      // A Separate model starts from the global highlight and overrides only
      // what it names, so adding a new highlight target later still works.
      highlight: { ...prefs.global.highlight, ...(override.highlight ?? {}) },
      workerIcon: override.workerIcon ?? "",
    };
  }
  return { mode: "default", highlight: prefs.global.highlight, workerIcon: prefs.global.workerIcon };
}

/** The shipped working icon, used when neither the model nor the global set one. */
export const ZAICODE_SHIPPED_WORKER_ICON = "zaicode-working.png";

/**
 * The worker icon URL to render, with the chain's last step made explicit: a
 * Separate model's own asset, else the global one, else the shipped one. A
 * missing or invalid asset resolves to the next step instead of rendering a
 * broken image, which is why the check is here and not in the component.
 */
export function resolveZaicodeWorkerIconUrl(
  prefs: ZaicodeModelAppearancePrefs,
  model: string | null | undefined,
  shippedUrl: string,
  bundledUrl: (id: string) => string | null = () => null,
): string {
  const appearance = resolveZaicodeModelAppearance(prefs, model);
  // A `builtin:` id that does not resolve is NOT a usable src: returning the
  // literal id would render a broken image, so it falls through the chain
  // exactly like a missing asset does.
  const resolveAsset = (asset: string): string | null => {
    if (!asset) return null;
    if (!asset.startsWith("builtin:")) return asset;
    return bundledUrl(asset.slice("builtin:".length));
  };
  return resolveAsset(appearance.workerIcon) ?? resolveAsset(prefs.global.workerIcon) ?? shippedUrl;
}

/** Every model the operator has an override for, for the settings list. */
export function listZaicodeModelOverrides(prefs: ZaicodeModelAppearancePrefs): { key: string; override: ZaicodeModelAppearanceOverride }[] {
  return Object.entries(prefs.models)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, override]) => ({ key, override }));
}

const APPEARANCE_KEY = "zaicode-model-appearance-v1";
export const ZAICODE_MODEL_APPEARANCE_CHANGED_EVENT = "zaicode-model-appearance-changed";

let cached: ZaicodeModelAppearancePrefs | null = null;

export function readZaicodeModelAppearancePrefs(): ZaicodeModelAppearancePrefs {
  if (cached) return cached;
  try {
    const stored = readZaicodeSetting(APPEARANCE_KEY);
    cached = stored ? normalizeZaicodeModelAppearancePrefs(JSON.parse(stored)) : ZAICODE_MODEL_APPEARANCE_DEFAULTS;
  } catch {
    cached = ZAICODE_MODEL_APPEARANCE_DEFAULTS;
  }
  return cached;
}

/**
 * The prefs as live React state, the same contract `useZaicodeSoundSettings`
 * has: one write dispatches one event, and every subscribed control re-renders
 * from the cache in the same tick. Without this the Settings screen read the
 * prefs once at mount, so a Separate toggle only showed up whenever some
 * unrelated store next re-rendered the page.
 */
export function useZaicodeModelAppearancePrefs(): ZaicodeModelAppearancePrefs {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener(ZAICODE_MODEL_APPEARANCE_CHANGED_EVENT, listener);
      return () => window.removeEventListener(ZAICODE_MODEL_APPEARANCE_CHANGED_EVENT, listener);
    },
    readZaicodeModelAppearancePrefs,
    readZaicodeModelAppearancePrefs,
  );
}

/** One write, one notification: the resolver's input never half-updates. */
export function writeZaicodeModelAppearancePrefs(
  update: (current: ZaicodeModelAppearancePrefs) => ZaicodeModelAppearancePrefs,
): ZaicodeModelAppearancePrefs {
  const next = normalizeZaicodeModelAppearancePrefs(update(readZaicodeModelAppearancePrefs()));
  cached = next;
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(next));
  } catch {
    // Applies for this window; the next start reads what did land.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ZAICODE_MODEL_APPEARANCE_CHANGED_EVENT));
  return next;
}

export function setZaicodeGlobalAppearance(patch: Partial<ZaicodeModelAppearancePrefs["global"]>): void {
  writeZaicodeModelAppearancePrefs((current) => ({ ...current, global: { ...current.global, ...patch } }));
}

/**
 * Upsert one model's override by its stable identity, so the settings screen
 * never has to know how a picker string is parsed to name a model.
 */
export function setZaicodeModelAppearance(
  identity: ZaicodeModelIdentity,
  override: Partial<ZaicodeModelAppearanceOverride> | null,
): void {
  const key = zaicodeModelIdentityKey(identity);
  if (!key) return;
  writeZaicodeModelAppearancePrefs((current) => {
    const models = { ...current.models };
    if (override === null) delete models[key];
    else models[key] = { ...(models[key] ?? { mode: "default" }), ...override };
    return { ...current, models };
  });
}
