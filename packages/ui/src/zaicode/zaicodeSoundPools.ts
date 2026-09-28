/**
 * Per-event sound pools (Wave 3, part B).
 *
 * An event plays one sound or a pool of them. The pool is not "pick at
 * random": every entry carries a weight, and what the settings screen shows
 * is the EFFECTIVE probability -- the weight turned into a share of exactly
 * 100%. The two must never disagree, so the percentages are computed once, in
 * basis points, with a largest-remainder pass, and the pick walks those same
 * numbers. What you see is what plays.
 *
 * Missing files are visible and never chosen. A pool whose entries are all
 * unusable still resolves to something deterministic rather than silence at
 * random.
 */

export interface ZaicodePoolEntry {
  /** Sound id (`fastprompter:...`, `custom:...`, or `default`). */
  id: string;
  /** Relative weight. 0 is a legal, silent-but-present entry. */
  weight: number;
  /** Pinned: redistributing other weights must not move this share. */
  locked: boolean;
  /** The file could not be found or decoded: shown, never selected. */
  missing: boolean;
}

export interface ZaicodePoolShare {
  id: string;
  weight: number;
  /** Basis points, 0..10000. Sums to exactly 10000 across selectable entries. */
  bps: number;
  /** The same number as the settings screen shows it, in percent. */
  percent: number;
  locked: boolean;
  missing: boolean;
  selectable: boolean;
  /** Why an entry gets nothing, in words. */
  note: "ok" | "zero-weight" | "missing-file";
}

export interface ZaicodePoolPlan {
  shares: ZaicodePoolShare[];
  selectable: number;
  /** Always 10000 for a plan with at least one selectable entry. */
  totalBps: number;
}

const TOTAL_BPS = 10_000;

function weightOf(entry: ZaicodePoolEntry): number {
  return Number.isFinite(entry.weight) && entry.weight > 0 ? entry.weight : 0;
}

/**
 * Weights -> effective probabilities that sum to exactly 100%. Largest
 * remainder: floor everyone's exact share, then hand the leftover basis points
 * to the largest fractional parts, ties broken by id so the result is
 * deterministic rather than merely usually-right.
 */
export function normalizeZaicodePool(entries: readonly ZaicodePoolEntry[]): ZaicodePoolPlan {
  const selectable = entries.filter((entry) => !entry.missing && weightOf(entry) > 0);
  if (selectable.length === 0) {
    // Nothing can play. One usable fallback keeps the event from being mute
    // by accident, and it is the same one every time.
    const fallback = entries.find((entry) => !entry.missing) ?? null;
    const fallbackId = fallback?.id ?? null;
    return {
      shares: entries.map((entry) => {
        const on = fallbackId !== null && entry.id === fallbackId;
        return {
          id: entry.id,
          weight: weightOf(entry),
          bps: on ? TOTAL_BPS : 0,
          percent: on ? 100 : 0,
          locked: entry.locked,
          missing: entry.missing,
          selectable: on,
          note: entry.missing ? "missing-file" : on ? "ok" : "zero-weight",
        };
      }),
      selectable: fallbackId === null ? 0 : 1,
      totalBps: fallbackId === null ? 0 : TOTAL_BPS,
    };
  }
  if (selectable.length === 1) {
    return {
      shares: entries.map((entry) => {
        const on = entry.id === selectable[0]!.id;
        return {
          id: entry.id,
          weight: weightOf(entry),
          bps: on ? TOTAL_BPS : 0,
          percent: on ? 100 : 0,
          locked: entry.locked,
          missing: entry.missing,
          selectable: on,
          note: entry.missing ? "missing-file" : on ? "ok" : "zero-weight",
        };
      }),
      selectable: 1,
      totalBps: TOTAL_BPS,
    };
  }

  const total = selectable.reduce((sum, entry) => sum + weightOf(entry), 0);
  const exact = new Map(selectable.map((entry) => [entry.id, (weightOf(entry) / total) * TOTAL_BPS]));
  const floor = new Map([...exact].map(([id, value]) => [id, Math.floor(value)]));
  let left = TOTAL_BPS - [...floor.values()].reduce((sum, value) => sum + value, 0);
  const byRemainder = [...exact.entries()]
    .map(([id, value]) => ({ id, rest: value - Math.floor(value) }))
    .sort((left_, right_) => right_.rest - left_.rest || (left_.id < right_.id ? -1 : 1));
  for (const candidate of byRemainder) {
    if (left <= 0) break;
    floor.set(candidate.id, floor.get(candidate.id)! + 1);
    left -= 1;
  }

  return {
    shares: entries.map((entry) => {
      const bps = floor.get(entry.id) ?? 0;
      const on = !entry.missing && bps > 0;
      return {
        id: entry.id,
        weight: weightOf(entry),
        bps,
        percent: bps / 100,
        locked: entry.locked,
        missing: entry.missing,
        selectable: on,
        note: entry.missing ? "missing-file" : on ? "ok" : "zero-weight",
      };
    }),
    selectable: selectable.length,
    totalBps: TOTAL_BPS,
  };
}

/**
 * One entry's weight changed; the rest of the pool is redistributed around it.
 *
 * A LOCKED entry holds the percentage it had, not its weight, so the free
 * entries' weights are rescaled to a total that puts the locked share back
 * where it was. Without a lock the free weights are left alone and the change
 * is purely relative -- normalization already moves everyone proportionally.
 *
 * The result always re-normalizes to exactly 100%, and a locked entry's share
 * is unchanged by any other entry's edit.
 */
export function redistributeZaicodePool(
  entries: readonly ZaicodePoolEntry[],
  changedId: string,
  newWeight: number,
): ZaicodePoolEntry[] {
  if (!entries.some((entry) => entry.id === changedId)) return [...entries];
  const weight = Number.isFinite(newWeight) && newWeight > 0 ? newWeight : 0;
  const usable = (entry: ZaicodePoolEntry) => !entry.missing && weightOf(entry) > 0;

  const locked = entries.filter((entry) => entry.id !== changedId && entry.locked && usable(entry));
  const lockedWeight = locked.reduce((sum, entry) => sum + weightOf(entry), 0);
  const lockedBps = locked.length > 0 ? normalizeZaicodePool(entries).shares.reduce((sum, share) => sum + (locked.some((entry) => entry.id === share.id) ? share.bps : 0), 0) : 0;

  const free = entries.filter((entry) => entry.id !== changedId && !entry.locked && usable(entry));
  const freeOtherWeight = free.reduce((sum, entry) => sum + weightOf(entry), 0);
  const freeTotalWeight = weight + freeOtherWeight;

  // The weight budget the free entries may spend, so a locked share survives.
  // With no lock the budget is simply what the free entries already had.
  const budget = lockedBps > 0
    ? (lockedWeight * (TOTAL_BPS - lockedBps)) / lockedBps
    : freeTotalWeight;
  if (budget <= 0) return entries.map((entry) => (entry.id === changedId ? { ...entry, weight } : { ...entry, weight: 0 }));

  const scale = freeTotalWeight > 0 ? budget / freeTotalWeight : 0;
  return entries.map((entry) => {
    if (entry.id === changedId) return { ...entry, weight: Math.round(weight * scale * 1000) / 1000 };
    if (!free.some((candidate) => candidate.id === entry.id)) return entry;
    return { ...entry, weight: Math.round(weightOf(entry) * scale * 1000) / 1000 };
  });
}

/** Deterministic RNG: seeded xmur3 + mulberry32, injectable so tests can pin it. */
export interface ZaicodeRng {
  int: (maxExclusive: number) => number;
  next: () => number;
}

export function zaicodeRng(seed: string): ZaicodeRng {
  let state = 0;
  for (let index = 0; index < seed.length; index += 1) {
    state = (state + seed.charCodeAt(index)) | 0;
    state = (state << 13) | (state >>> 19);
  }
  let value = (state ^ 0x9e3779b9) >>> 0;
  const next = (): number => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (maxExclusive: number) => Math.floor(next() * maxExclusive) };
}

/**
 * The pick walks the same basis points the screen shows. A missing file is
 * never returned; if the draw lands on one (it cannot, but a plan from older
 * storage might), the draw repeats against the remaining ones.
 */
export function pickZaicodePoolSound(entries: readonly ZaicodePoolEntry[], rng: ZaicodeRng): string | null {
  const plan = normalizeZaicodePool(entries);
  if (plan.totalBps === 0) return null;
  const selectable = plan.shares.filter((share) => share.selectable);
  if (selectable.length === 0) return null;
  let draw = rng.int(TOTAL_BPS);
  for (const share of selectable) {
    draw -= share.bps;
    if (draw < 0) return share.id;
  }
  return selectable[selectable.length - 1]!.id;
}
