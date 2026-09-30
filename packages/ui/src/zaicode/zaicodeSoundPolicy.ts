/**
 * How ZAICODE's sounds meet (operator request): a sound that starts while
 * others still ring either mixes with them (at most N at once), waits for its
 * turn in a line (at most N waiting), or cuts them. The operator picks one in
 * Settings -> Sounds. Pure, so the rules are testable without audio; the
 * engine in zaicodeSoundEvents.ts applies the answer.
 */

export const ZAICODE_SOUND_OVERLAPS = ["mix", "queue", "cut"] as const;
export type ZaicodeSoundOverlap = (typeof ZAICODE_SOUND_OVERLAPS)[number];

/** N for "mix" (at once) and "queue" (waiting). */
export const ZAICODE_SOUND_LIMIT_MIN = 2;
export const ZAICODE_SOUND_LIMIT_MAX = 16;

export function normalizeZaicodeSoundOverlap(value: unknown): ZaicodeSoundOverlap {
  return ZAICODE_SOUND_OVERLAPS.includes(value as ZaicodeSoundOverlap) ? (value as ZaicodeSoundOverlap) : "mix";
}

export function normalizeZaicodeSoundLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return ZAICODE_SOUND_LIMIT_MAX;
  return Math.min(ZAICODE_SOUND_LIMIT_MAX, Math.max(ZAICODE_SOUND_LIMIT_MIN, Math.round(value)));
}

export interface ZaicodeSoundRules {
  overlap: ZaicodeSoundOverlap;
  limit: number;
  /** "mix" only: interface sounds (clicks, menus, sidebar, ...) cut each other. */
  interfaceOneAtATime: boolean;
}

/** A sound that is ringing now, or the one that asks to start. */
export interface ZaicodeSoundVoice {
  /** The event id, or the channel of a file sound: the same key is "the same sound". */
  key: string;
  interface: boolean;
}

export interface ZaicodeSoundRequest extends ZaicodeSoundVoice {
  /** The row's own "replace": this sound never rings twice at once. */
  replaceOwn: boolean;
}

export type ZaicodeSoundDecision =
  /** Start now; first fade out the ringing voices at these positions. */
  | { play: true; stop: number[] }
  /** Wait in line (queue) or be dropped (the line is full, or the same sound already waits). */
  | { play: false; wait: boolean };

/**
 * What a new sound does. `ringing` is oldest first; `waiting` holds the keys in
 * line, the next one first.
 */
export function decideZaicodeSound(
  rules: ZaicodeSoundRules,
  ringing: readonly ZaicodeSoundVoice[],
  waiting: readonly string[],
  request: ZaicodeSoundRequest,
): ZaicodeSoundDecision {
  const all = ringing.map((_, index) => index);
  if (rules.overlap === "cut") return { play: true, stop: all };
  if (rules.overlap === "queue") {
    if (ringing.length === 0 && waiting.length === 0) return { play: true, stop: [] };
    // Its own "replace": the same sound ringing alone restarts at once, still one at a time.
    if (request.replaceOwn && ringing.length > 0 && ringing.every((voice) => voice.key === request.key)) {
      return { play: true, stop: all };
    }
    // replace 行仅保留一次等待；overlap 行的真实重复输入各自排队。
    if (request.replaceOwn && waiting.includes(request.key)) return { play: false, wait: false };
    if (waiting.length >= rules.limit) return { play: false, wait: false };
    return { play: false, wait: true };
  }
  const stop = new Set<number>();
  ringing.forEach((voice, index) => {
    if (request.replaceOwn && voice.key === request.key) stop.add(index);
    if (rules.interfaceOneAtATime && request.interface && voice.interface) stop.add(index);
  });
  // At most `limit` at once, the new one included: the oldest leave first.
  let left = ringing.length - stop.size;
  for (const index of all) {
    if (left < rules.limit) break;
    if (stop.has(index)) continue;
    stop.add(index);
    left -= 1;
  }
  return { play: true, stop: [...stop].sort((a, b) => a - b) };
}
