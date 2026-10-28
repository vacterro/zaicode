/**
 * SAIPEGGLE's seeded randomness: the same seed always builds the same level
 * and makes the same choices (which peg turns purple, which power a random
 * level gets), so a level can be shared as a seed or a code.
 */

/** xmur3: a string -> a 32-bit seed. */
export function saipeggleSeedHash(text: string): number {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export interface SaipeggleRng {
  /** [0, 1) */
  next(): number;
  /** [min, max) */
  range(min: number, max: number): number;
  /** An integer in [min, max]. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
  /** A shuffled copy. */
  shuffle<T>(items: readonly T[]): T[];
}

/** mulberry32 over a string or numeric seed. */
export function saipeggleRng(seed: string | number): SaipeggleRng {
  let a = typeof seed === "number" ? seed >>> 0 : saipeggleSeedHash(seed);
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: SaipeggleRng = {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => Math.floor(min + (max - min + 1) * next()),
    pick: (items) => items[Math.floor(next() * items.length)]!,
    chance: (p) => next() < p,
    shuffle: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
  return rng;
}

const SEED_WORDS = ["AMBER", "BRASS", "COMET", "DELTA", "EMBER", "FROST", "GHOST", "HALO", "IVORY", "JADE", "KOI", "LOTUS", "MOSS", "NOVA", "ONYX", "PIXEL", "QUARTZ", "RUNE", "SAGE", "TIDE", "UMBRA", "VOLT", "WISP", "XENON", "YUZU", "ZEN"];

/** A fresh, readable seed such as "NOVA-4821". */
export function saipeggleNewSeed(random: () => number = Math.random): string {
  const word = SEED_WORDS[Math.floor(random() * SEED_WORDS.length)]!;
  return `${word}-${String(Math.floor(random() * 10000)).padStart(4, "0")}`;
}
