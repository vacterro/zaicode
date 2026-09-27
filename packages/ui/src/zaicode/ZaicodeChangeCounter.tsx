import { useEffect, useRef, type ReactNode } from "react";
import { isZaicodeProductMode } from "@zcode/shared";
import {
  useZaicodeChangeFloaters,
  zaicodeChangeDelta,
  zaicodeFloatersFor,
  type ZaicodeChangeCounts,
} from "./zaicodeChangeFloaters.js";
import { flashZaicodeChange, launchZaicodeFloaters, zaicodeCounterLook } from "./zaicodeFloaterLayer.js";

/**
 * Wraps a "+added -removed" counter (the Changes chip and row) and makes the
 * numbers fly (SRC-060): green "+N" rises like healing, red "-N" like damage.
 * `scopeKey` is what the counts belong to (the workspace): a new scope starts
 * silent.
 *
 * The numbers themselves live in the shared floater layer on <body>
 * (zaicodeFloaterLayer), outside this component: nothing this component does
 * -- a re-render, a remount, the counter flash -- can restart or cut a number
 * in flight. The flash is retriggered on the same element, never by a key.
 */
export function ZaicodeChangeCounter({
  added,
  removed,
  scopeKey,
  children,
  className,
  demo = false,
}: ZaicodeChangeCounts & {
  scopeKey: string;
  children: ReactNode;
  className?: string;
  /** The settings' "Try it" counter: its sounds are the operator testing, played directly. */
  demo?: boolean;
}) {
  const prefs = useZaicodeChangeFloaters();
  const anchor = useRef<HTMLSpanElement | null>(null);
  const previous = useRef<{ key: string; counts: ZaicodeChangeCounts } | null>(null);
  const pending = useRef({ heal: 0, damage: 0 });
  const mergeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(
    () => () => {
      if (mergeTimer.current) clearTimeout(mergeTimer.current);
    },
    [],
  );

  useEffect(() => {
    const before = previous.current?.key === scopeKey ? previous.current.counts : null;
    previous.current = { key: scopeKey, counts: { added, removed } };
    if (!isZaicodeProductMode()) return;
    const delta = zaicodeChangeDelta(before, { added, removed });
    if (delta.heal === 0 && delta.damage === 0) return;
    pending.current = { heal: pending.current.heal + delta.heal, damage: pending.current.damage + delta.damage };
    if (mergeTimer.current) return;
    const flush = () => {
      mergeTimer.current = null;
      const burst = pending.current;
      pending.current = { heal: 0, damage: 0 };
      const current = prefsRef.current;
      const made = zaicodeFloatersFor(burst, current);
      if (made.length === 0) return;
      launchZaicodeFloaters(() => anchor.current?.getBoundingClientRect() ?? null, made, current, zaicodeCounterLook(current), {
        sound: current.sound,
        soundEcho: !demo,
        onStart: () => {
          if (current.flashCounter) flashZaicodeChange(anchor.current, current.ignoreReducedMotion);
        },
      });
    };
    if (prefsRef.current.mergeMs === 0) flush();
    else mergeTimer.current = setTimeout(flush, prefsRef.current.mergeMs);
  }, [added, removed, scopeKey, demo]);

  return (
    <span ref={anchor} className={className} data-zaicode-change-counter data-zaicode-help="changes">
      {children}
    </span>
  );
}
