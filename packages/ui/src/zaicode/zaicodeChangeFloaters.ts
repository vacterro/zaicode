import { create } from "zustand";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";

/**
 * RPG change numbers (SRC-060): when an agent adds lines, a green "+N" floats
 * up from the Changes counter like healing; removed lines fly off as a red
 * "-N" like damage. Everything about it is the operator's: on/off, which side,
 * style, distance, duration, size, merge window, critical hits, colours,
 * outline, counter flash and sound. Settings -> Highlights & motion.
 */

export type ZaicodeFloaterStyle = "rise" | "pop" | "drift" | "arcade";
export const ZAICODE_FLOATER_STYLES: readonly { id: ZaicodeFloaterStyle; label: string; hint: string }[] = [
  { id: "rise", label: "Rise", hint: "Floats straight up and fades, like a heal number" },
  { id: "pop", label: "Pop", hint: "Pops out big, settles, then fades" },
  { id: "drift", label: "Drift", hint: "Floats up and drifts sideways, like a damage number" },
  { id: "arcade", label: "Arcade", hint: "Slams in with a shake, then rises" },
];

export type ZaicodeFloaterSuffix = "none" | "hp" | "lines";

export interface ZaicodeChangeFloaterPrefs {
  enabled: boolean;
  style: ZaicodeFloaterStyle;
  /** Added lines float as "+N" (heal). */
  showHeal: boolean;
  /** Removed lines float as "-N" (damage). */
  showDamage: boolean;
  distancePx: number;
  durationMs: number;
  /** Text size, percent of the counter's own size. */
  scalePct: number;
  /** A burst of at least this many lines is a critical hit (bigger, "!"); 0 = never. */
  critAt: number;
  /** Changes within this window add up to one number instead of a stream of small ones. */
  mergeMs: number;
  /** Most numbers on screen at once; the oldest goes first. */
  maxFloaters: number;
  /** Empty = the theme's diff colours. */
  healColor: string;
  damageColor: string;
  /** A dark outline around the digits, as in games. */
  outline: boolean;
  /** The counter itself flashes when it changes. */
  flashCounter: boolean;
  /** Plays the Heal / Damage rows of the Sounds table. */
  sound: boolean;
  suffix: ZaicodeFloaterSuffix;
}

export const ZAICODE_FLOATER_DEFAULTS: ZaicodeChangeFloaterPrefs = {
  enabled: true,
  style: "rise",
  showHeal: true,
  showDamage: true,
  distancePx: 28,
  durationMs: 1400,
  scalePct: 120,
  critAt: 100,
  mergeMs: 400,
  maxFloaters: 6,
  healColor: "",
  damageColor: "",
  outline: true,
  flashCounter: true,
  sound: true,
  suffix: "none",
};

export const ZAICODE_FLOATER_LIMITS = {
  distancePx: [8, 80],
  durationMs: [400, 4000],
  scalePct: [80, 300],
  critAt: [0, 5000],
  mergeMs: [0, 3000],
  maxFloaters: [1, 12],
} as const;

const HEX = /^#[0-9a-f]{6}$/i;

function clampNumber(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

export function normalizeZaicodeFloaterPrefs(raw: unknown): ZaicodeChangeFloaterPrefs {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = ZAICODE_FLOATER_DEFAULTS;
  const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  const color = (value: unknown) => (typeof value === "string" && HEX.test(value) ? value.toLowerCase() : "");
  return {
    enabled: flag(r.enabled, d.enabled),
    style: ZAICODE_FLOATER_STYLES.some((style) => style.id === r.style) ? (r.style as ZaicodeFloaterStyle) : d.style,
    showHeal: flag(r.showHeal, d.showHeal),
    showDamage: flag(r.showDamage, d.showDamage),
    distancePx: clampNumber(r.distancePx, ZAICODE_FLOATER_LIMITS.distancePx, d.distancePx),
    durationMs: clampNumber(r.durationMs, ZAICODE_FLOATER_LIMITS.durationMs, d.durationMs),
    scalePct: clampNumber(r.scalePct, ZAICODE_FLOATER_LIMITS.scalePct, d.scalePct),
    critAt: clampNumber(r.critAt, ZAICODE_FLOATER_LIMITS.critAt, d.critAt),
    mergeMs: clampNumber(r.mergeMs, ZAICODE_FLOATER_LIMITS.mergeMs, d.mergeMs),
    maxFloaters: clampNumber(r.maxFloaters, ZAICODE_FLOATER_LIMITS.maxFloaters, d.maxFloaters),
    healColor: color(r.healColor),
    damageColor: color(r.damageColor),
    outline: flag(r.outline, d.outline),
    flashCounter: flag(r.flashCounter, d.flashCounter),
    sound: flag(r.sound, d.sound),
    suffix: r.suffix === "hp" || r.suffix === "lines" ? r.suffix : d.suffix,
  };
}

export interface ZaicodeChangeCounts {
  added: number;
  removed: number;
}

/**
 * What changed between two readings of the counter. The first reading of a
 * counter (`previous` null) and a counter that went down (a commit, a revert,
 * another session opened) never produce numbers.
 */
export function zaicodeChangeDelta(
  previous: ZaicodeChangeCounts | null,
  next: ZaicodeChangeCounts,
): { heal: number; damage: number } {
  if (!previous) return { heal: 0, damage: 0 };
  return {
    heal: Math.max(0, next.added - previous.added),
    damage: Math.max(0, next.removed - previous.removed),
  };
}

export interface ZaicodeFloater {
  kind: "heal" | "damage";
  amount: number;
  crit: boolean;
  text: string;
}

/** The numbers one (merged) burst shows, by the operator's settings. */
export function zaicodeFloatersFor(
  delta: { heal: number; damage: number },
  prefs: ZaicodeChangeFloaterPrefs,
): ZaicodeFloater[] {
  if (!prefs.enabled) return [];
  const suffix = prefs.suffix === "hp" ? " HP" : prefs.suffix === "lines" ? " lines" : "";
  const make = (kind: "heal" | "damage", amount: number): ZaicodeFloater => {
    const crit = prefs.critAt > 0 && amount >= prefs.critAt;
    return { kind, amount, crit, text: `${kind === "heal" ? "+" : "-"}${amount}${suffix}${crit ? "!" : ""}` };
  };
  const floaters: ZaicodeFloater[] = [];
  if (prefs.showHeal && delta.heal > 0) floaters.push(make("heal", delta.heal));
  if (prefs.showDamage && delta.damage > 0) floaters.push(make("damage", delta.damage));
  return floaters;
}

const STORAGE_KEY = "zaicode-change-floaters-v1";

function load(): ZaicodeChangeFloaterPrefs {
  try {
    return normalizeZaicodeFloaterPrefs(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null"));
  } catch {
    return { ...ZAICODE_FLOATER_DEFAULTS };
  }
}

interface ZaicodeFloaterStore extends ZaicodeChangeFloaterPrefs {
  update: (patch: Partial<ZaicodeChangeFloaterPrefs>) => void;
  reset: () => void;
}

export const useZaicodeChangeFloaters = create<ZaicodeFloaterStore>((set, get) => {
  const persist = (next: ZaicodeChangeFloaterPrefs) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Applies for this window anyway.
    }
    set(next);
  };
  return {
    ...load(),
    update: (patch) => {
      const { update: _update, reset: _reset, ...current } = get();
      persist(normalizeZaicodeFloaterPrefs({ ...current, ...patch }));
    },
    reset: () => persist({ ...ZAICODE_FLOATER_DEFAULTS }),
  };
});
