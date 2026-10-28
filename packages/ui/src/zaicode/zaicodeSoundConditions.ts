/**
 * T-134: per-sound conditions. Every row of the Sounds table can say when it
 * plays, on top of the master switches (mute, quiet hours, "also while the
 * window is focused"):
 *
 * - when:         always (the global focus rule applies) | only while ZAICODE is
 *                 in the background | only while it is in front
 * - throughQuiet: this sound also plays in quiet hours (an alarm-grade cue:
 *                 "Human needed" should wake you, a button click should not)
 * - cooldownSec:  at most once per N seconds (a chatty progress cue that
 *                 would otherwise ring on every update)
 *
 * Pure: no audio, no DOM, no storage. The engine (zaicodeSoundEvents.ts)
 * passes the live facts in; the Sounds table edits the three fields.
 */

export const ZAICODE_SOUND_WHENS = ["always", "background", "foreground"] as const;
export type ZaicodeSoundWhen = (typeof ZAICODE_SOUND_WHENS)[number];

export const ZAICODE_SOUND_COOLDOWN_MAX = 3600;

/** The condition fields of one Sounds-table row (absent = the default). */
export interface ZaicodeSoundConditionFields {
  when?: ZaicodeSoundWhen;
  throughQuiet?: boolean;
  cooldownSec?: number;
}

export interface ZaicodeSoundConditionContext {
  /** The ZAICODE window has the keyboard focus. */
  focused: boolean;
  /** Quiet hours are on right now. */
  quietNow: boolean;
  /** The master "also play while the window is focused" switch. */
  whenFocusedGlobal: boolean;
  now: number;
  /** When this event last played, ms (0 = never). */
  lastPlayedAt: number;
}

export type ZaicodeSoundConditionVerdict =
  | { play: true }
  | { play: false; reason: "quiet" | "background-only" | "foreground-only" | "focused" | "cooldown" };

export function normalizeZaicodeSoundWhen(value: unknown): ZaicodeSoundWhen {
  return ZAICODE_SOUND_WHENS.includes(value as ZaicodeSoundWhen) ? (value as ZaicodeSoundWhen) : "always";
}

export function normalizeZaicodeSoundCooldown(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(ZAICODE_SOUND_COOLDOWN_MAX, Math.round(value));
}

/** The stored fields of a row, cleaned: defaults are left out so an untouched row stays small. */
export function normalizeZaicodeSoundConditions(raw: unknown): ZaicodeSoundConditionFields {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: ZaicodeSoundConditionFields = {};
  const when = normalizeZaicodeSoundWhen(value.when);
  if (when !== "always") out.when = when;
  if (value.throughQuiet === true) out.throughQuiet = true;
  const cooldown = normalizeZaicodeSoundCooldown(value.cooldownSec);
  if (cooldown > 0) out.cooldownSec = cooldown;
  return out;
}

/** Whether a row's own conditions let it play now. Mute and the row's on/off switch are the caller's. */
export function zaicodeSoundConditionsAllow(
  row: ZaicodeSoundConditionFields,
  context: ZaicodeSoundConditionContext,
): ZaicodeSoundConditionVerdict {
  if (context.quietNow && row.throughQuiet !== true) return { play: false, reason: "quiet" };
  const when = normalizeZaicodeSoundWhen(row.when);
  if (when === "background" && context.focused) return { play: false, reason: "background-only" };
  if (when === "foreground" && !context.focused) return { play: false, reason: "foreground-only" };
  // A row that asked for "in front" plays in front even when the master switch keeps the others quiet there.
  if (when === "always" && context.focused && !context.whenFocusedGlobal) return { play: false, reason: "focused" };
  const cooldown = normalizeZaicodeSoundCooldown(row.cooldownSec);
  if (cooldown > 0 && context.lastPlayedAt > 0 && context.now - context.lastPlayedAt < cooldown * 1000) {
    return { play: false, reason: "cooldown" };
  }
  return { play: true };
}

/** Short tag for the Sounds table ("" = no condition of its own). */
export function describeZaicodeSoundConditions(row: ZaicodeSoundConditionFields): string {
  const parts: string[] = [];
  const when = normalizeZaicodeSoundWhen(row.when);
  if (when === "background") parts.push("bg");
  if (when === "foreground") parts.push("fg");
  if (row.throughQuiet === true) parts.push("!q");
  const cooldown = normalizeZaicodeSoundCooldown(row.cooldownSec);
  if (cooldown > 0) parts.push(cooldown >= 60 && cooldown % 60 === 0 ? `${cooldown / 60}m` : `${cooldown}s`);
  return parts.join(" ");
}
