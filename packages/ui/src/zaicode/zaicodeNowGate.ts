import { useEffect, useRef, useState } from "react";

/**
 * Change-gated 1-second tick (T-67, SRC-049): the timer still fires every
 * second, but `now` only advances when the display's own bucket changed — a
 * minute-granularity clock renders once a minute instead of 60 times.
 * React bails out on the identical value, so renders are what we cut, not
 * timer accuracy: any change lands on the next 1-second tick as before.
 */

export const ZAICODE_NOW_STEP_SECOND_MS = 1_000;
export const ZAICODE_NOW_STEP_MINUTE_MS = 60_000;
/** `formatZaicodeRemaining` starts showing seconds below this (59m59s). */
export const ZAICODE_SECOND_GRANULARITY_MS = 3_600_000;

/**
 * Pure: the step a display needs. `showSeconds` forces seconds; otherwise a
 * countdown under an hour does, because formatZaicodeRemaining shows seconds
 * from 59m59s down.
 */
export function zaicodeNowStepMs(input: { showSeconds: boolean; secondTargets: readonly number[] }, now: number): number {
  if (input.showSeconds) return ZAICODE_NOW_STEP_SECOND_MS;
  for (const target of input.secondTargets) {
    if (target - now < ZAICODE_SECOND_GRANULARITY_MS) return ZAICODE_NOW_STEP_SECOND_MS;
  }
  return ZAICODE_NOW_STEP_MINUTE_MS;
}

/** Pure: did the display bucket move between two reads? */
export function zaicodeNowBucketChanged(previousNow: number, nextNow: number, stepMs: number): boolean {
  return Math.trunc(nextNow / stepMs) !== Math.trunc(previousNow / stepMs);
}

/**
 * `now` that only changes when its display bucket changes. `getStepMs` runs on
 * every tick with the freshest clock reading; keep it cheap and read live state
 * through store getters, never stale closures.
 */
export function useZaicodeGatedNow(getStepMs: (now: number) => number): number {
  const [now, setNow] = useState(() => Date.now());
  const stepRef = useRef(getStepMs);
  stepRef.current = getStepMs;
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow((previous) => {
        const next = Date.now();
        const step = stepRef.current(next);
        return zaicodeNowBucketChanged(previous, next, step) ? next : previous;
      });
    }, ZAICODE_NOW_STEP_SECOND_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
