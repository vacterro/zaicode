/**
 * Which subscription window just reset (FastPrompter's confirmed-reset rule).
 * A window counts as refilled when its remaining quota CLIMBS by more than a
 * point and lands near full (>= 90%): usage can only lower it, so a climb is
 * the one real reset signal. A partial climb (20% -> 60%) is a correction,
 * not a reset. The announcement latches until the window drops out of the
 * near-full band again, so jitter around 95-100% never repeats it, and the
 * very first reading of a window only records what is already true.
 */

export const ZAICODE_CONFIRMED_REFILL_PERCENT = 90;

export interface ZaicodeRefillWindow {
  key: string;
  label: string;
  remainingPercent: number | null;
}

export interface ZaicodeRefillMemory {
  remaining: number;
  latched: boolean;
}

export interface ZaicodeWindowRefill {
  key: string;
  label: string;
  from: number;
  to: number;
}

export function detectZaicodeWindowRefills(
  accountId: string,
  windows: readonly ZaicodeRefillWindow[],
  memory: Map<string, ZaicodeRefillMemory>,
): ZaicodeWindowRefill[] {
  const refills: ZaicodeWindowRefill[] = [];
  for (const window of windows) {
    if (window.remainingPercent === null || !Number.isFinite(window.remainingPercent)) continue;
    const id = `${accountId}|${window.key}`;
    const to = Math.max(0, Math.min(100, window.remainingPercent));
    const prior = memory.get(id);
    if (!prior) {
      memory.set(id, { remaining: to, latched: to >= ZAICODE_CONFIRMED_REFILL_PERCENT });
      continue;
    }
    let latched = prior.latched && to >= ZAICODE_CONFIRMED_REFILL_PERCENT;
    if (!latched && to - prior.remaining > 1 && to >= ZAICODE_CONFIRMED_REFILL_PERCENT) {
      refills.push({ key: window.key, label: window.label, from: prior.remaining, to });
      latched = true;
    }
    memory.set(id, { remaining: to, latched });
  }
  return refills;
}
