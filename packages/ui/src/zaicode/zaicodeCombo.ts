/**
 * Shift-combining (SRC-043): one rule for every ZAICODE choice that can hold
 * several values at once -- a plain click picks one value, Shift (or Ctrl)
 * + click adds it to the combination or takes it out again. A "neutral"
 * value (Steady, Still, All) means "none of the others": picking it clears
 * the combination, and taking out the last combined value falls back to it.
 * Without a neutral value the last one cannot be taken out.
 */

export interface ZaicodeComboOptions<T extends string> {
  /** The value that means "nothing combined" (Steady, Still, All). */
  neutral?: T;
  /** Most values one combination may hold; the oldest drops out beyond it. */
  max?: number;
}

/** The combination after a click on `value`; `additive` = Shift or Ctrl held. */
export function nextZaicodeCombo<T extends string>(
  current: readonly T[],
  value: T,
  additive: boolean,
  options: ZaicodeComboOptions<T> = {},
): T[] {
  const { neutral, max } = options;
  if (!additive || value === neutral) return [value];
  const base = current.filter((entry) => entry !== neutral);
  if (base.includes(value)) {
    const rest = base.filter((entry) => entry !== value);
    if (rest.length > 0) return rest;
    return neutral === undefined ? [...base] : [neutral];
  }
  const next = [...base, value];
  return max !== undefined && next.length > max ? next.slice(next.length - max) : next;
}

/** True when the click that produced `event` asks to combine instead of replace. */
export function isZaicodeComboClick(event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): boolean {
  return event.shiftKey || event.ctrlKey || event.metaKey;
}
