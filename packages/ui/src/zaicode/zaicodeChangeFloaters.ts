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

/** When one burst has both: which number goes first (SRC-062: "first minus, then plus, so they don't pile up"). */
export type ZaicodeFloaterOrder = "damage-first" | "heal-first" | "together";
export const ZAICODE_FLOATER_ORDERS: readonly { value: ZaicodeFloaterOrder; label: string; hint: string }[] = [
  { value: "damage-first", label: "- then +", hint: "The red -N first, the green +N after the gap" },
  { value: "heal-first", label: "+ then -", hint: "The green +N first, the red -N after the gap" },
  { value: "together", label: "Together", hint: "Both at once, side by side" },
];

/** The chat's numbers may use the counter's style or their own. */
export type ZaicodeChatFloaterStyle = "same" | ZaicodeFloaterStyle;

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
  /**
   * Keep the numbers moving while the calm interface (Layout & home) or the
   * system's reduced-motion setting stops every other animation (SRC-062).
   */
  ignoreReducedMotion: boolean;
  order: ZaicodeFloaterOrder;
  /** Gap between the first and the second number of one burst. */
  sequenceGapMs: number;
  /** In the chat (SRC-062): an agent's Edit row plays its own +N / -N when the file changes. */
  chatEnabled: boolean;
  /** Only when the row is on screen; a change far up the scroll stays quiet. */
  chatOnlyVisible: boolean;
  /** Only while the ZAICODE window has focus. */
  chatOnlyFocused: boolean;
  /** A change smaller than this many lines (added + removed) stays quiet; 0 = every change. */
  chatMinLines: number;
  /** An edit older than this (seconds) never plays: reopening an old chat stays silent. */
  chatFreshSec: number;
  /** Wait this long after the row shows its numbers. */
  chatDelayMs: number;
  /** Several edits at once play one after another, this far apart. */
  chatStaggerMs: number;
  /** Most edits waiting to play; the oldest waiting one is dropped. */
  chatQueueMax: number;
  chatStyle: ZaicodeChatFloaterStyle;
  chatScalePct: number;
  chatDistancePx: number;
  chatDurationMs: number;
  chatSound: boolean;
  /** The row's own +N -M flashes as its numbers fly. */
  chatFlashRow: boolean;
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
  ignoreReducedMotion: true,
  order: "damage-first",
  sequenceGapMs: 450,
  chatEnabled: true,
  chatOnlyVisible: true,
  chatOnlyFocused: false,
  chatMinLines: 1,
  chatFreshSec: 45,
  chatDelayMs: 150,
  chatStaggerMs: 350,
  chatQueueMax: 10,
  chatStyle: "same",
  chatScalePct: 100,
  chatDistancePx: 22,
  chatDurationMs: 1200,
  chatSound: true,
  chatFlashRow: true,
};

export const ZAICODE_FLOATER_LIMITS = {
  distancePx: [8, 80],
  durationMs: [400, 4000],
  scalePct: [80, 300],
  critAt: [0, 5000],
  mergeMs: [0, 3000],
  maxFloaters: [1, 12],
  sequenceGapMs: [0, 2000],
  chatMinLines: [0, 1000],
  chatFreshSec: [5, 600],
  chatDelayMs: [0, 3000],
  chatStaggerMs: [0, 3000],
  chatQueueMax: [1, 30],
  chatScalePct: [60, 300],
  chatDistancePx: [8, 80],
  chatDurationMs: [400, 4000],
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
    ignoreReducedMotion: flag(r.ignoreReducedMotion, d.ignoreReducedMotion),
    order: ZAICODE_FLOATER_ORDERS.some((order) => order.value === r.order) ? (r.order as ZaicodeFloaterOrder) : d.order,
    sequenceGapMs: clampNumber(r.sequenceGapMs, ZAICODE_FLOATER_LIMITS.sequenceGapMs, d.sequenceGapMs),
    chatEnabled: flag(r.chatEnabled, d.chatEnabled),
    chatOnlyVisible: flag(r.chatOnlyVisible, d.chatOnlyVisible),
    chatOnlyFocused: flag(r.chatOnlyFocused, d.chatOnlyFocused),
    chatMinLines: clampNumber(r.chatMinLines, ZAICODE_FLOATER_LIMITS.chatMinLines, d.chatMinLines),
    chatFreshSec: clampNumber(r.chatFreshSec, ZAICODE_FLOATER_LIMITS.chatFreshSec, d.chatFreshSec),
    chatDelayMs: clampNumber(r.chatDelayMs, ZAICODE_FLOATER_LIMITS.chatDelayMs, d.chatDelayMs),
    chatStaggerMs: clampNumber(r.chatStaggerMs, ZAICODE_FLOATER_LIMITS.chatStaggerMs, d.chatStaggerMs),
    chatQueueMax: clampNumber(r.chatQueueMax, ZAICODE_FLOATER_LIMITS.chatQueueMax, d.chatQueueMax),
    chatStyle:
      r.chatStyle === "same" || ZAICODE_FLOATER_STYLES.some((style) => style.id === r.chatStyle)
        ? (r.chatStyle as ZaicodeChatFloaterStyle)
        : d.chatStyle,
    chatScalePct: clampNumber(r.chatScalePct, ZAICODE_FLOATER_LIMITS.chatScalePct, d.chatScalePct),
    chatDistancePx: clampNumber(r.chatDistancePx, ZAICODE_FLOATER_LIMITS.chatDistancePx, d.chatDistancePx),
    chatDurationMs: clampNumber(r.chatDurationMs, ZAICODE_FLOATER_LIMITS.chatDurationMs, d.chatDurationMs),
    chatSound: flag(r.chatSound, d.chatSound),
    chatFlashRow: flag(r.chatFlashRow, d.chatFlashRow),
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

/**
 * When each number of one burst starts, by the operator's order and gap:
 * "- then +" plays the red number first and the green one `sequenceGapMs`
 * later, so a burst never piles both on one spot.
 */
export function zaicodeFloaterSchedule(
  floaters: readonly ZaicodeFloater[],
  prefs: Pick<ZaicodeChangeFloaterPrefs, "order" | "sequenceGapMs">,
): { floater: ZaicodeFloater; delayMs: number }[] {
  if (prefs.order === "together" || floaters.length < 2) return floaters.map((floater) => ({ floater, delayMs: 0 }));
  const first = prefs.order === "damage-first" ? "damage" : "heal";
  const sorted = [...floaters].sort((a, b) => Number(b.kind === first) - Number(a.kind === first));
  return sorted.map((floater, index) => ({ floater, delayMs: index * prefs.sequenceGapMs }));
}

/**
 * The lowest free lane for a new number next to numbers still rising at the
 * same spot: lane 0 is the anchor, each next lane one line higher, so numbers
 * that start close together stack instead of printing over each other.
 */
export function pickZaicodeFloaterLane(occupied: readonly number[], lanes = 5): number {
  for (let lane = 0; lane < lanes; lane += 1) if (!occupied.includes(lane)) return lane;
  return occupied.length % lanes;
}

/** Whether a chat edit's burst may play now (all the operator's conditions). */
export function admitZaicodeChatBurst(
  burst: { heal: number; damage: number; editedAt: number | null },
  prefs: Pick<ZaicodeChangeFloaterPrefs, "enabled" | "chatEnabled" | "chatMinLines" | "chatFreshSec" | "chatOnlyVisible" | "chatOnlyFocused">,
  env: { now: number; visible: boolean; focused: boolean },
): boolean {
  if (!prefs.enabled || !prefs.chatEnabled) return false;
  if (burst.heal + burst.damage <= 0 || burst.heal + burst.damage < prefs.chatMinLines) return false;
  if (burst.editedAt !== null && env.now - burst.editedAt > prefs.chatFreshSec * 1000) return false;
  if (prefs.chatOnlyVisible && !env.visible) return false;
  if (prefs.chatOnlyFocused && !env.focused) return false;
  return true;
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
