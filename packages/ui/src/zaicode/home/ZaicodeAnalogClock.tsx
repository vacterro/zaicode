import { useEffect, useState } from "react";
import { formatZaicodeTimeOfDay, zaicodeTimeZoneName } from "@zcode/shared";
import { useZaicodeUiPrefs } from "../zaicodeUiPrefs.js";
import type { ZaicodeHomeClockPrefs } from "./zaicodeHomePrefs.js";

/**
 * SAIHOME's large classic analog clock (T-56). SVG, so it stays sharp at any
 * size and while the window is resized. It owns its own clock state: the
 * second hand re-renders this component only, never the dashboard. Smooth
 * sweep needs motion allowed (calm interface off and no OS reduced-motion);
 * otherwise the hand ticks once a second, and the time is always exact.
 */

const SIZES: Record<ZaicodeHomeClockPrefs["size"], number> = { small: 150, medium: 210, large: 290 };

/** Hand angles in degrees (0 = 12 o'clock), seconds optionally continuous. */
export function zaicodeClockAngles(date: Date, smoothSeconds: boolean): { hour: number; minute: number; second: number } {
  const seconds = date.getSeconds() + (smoothSeconds ? date.getMilliseconds() / 1000 : 0);
  const minutes = date.getMinutes() + seconds / 60;
  const hours = (date.getHours() % 12) + minutes / 60;
  return { hour: hours * 30, minute: minutes * 6, second: seconds * 6 };
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function useClockNow(smooth: boolean, everyMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (smooth) {
      let frame = 0;
      const loop = () => {
        setNow(new Date());
        frame = window.requestAnimationFrame(loop);
      };
      frame = window.requestAnimationFrame(loop);
      return () => window.cancelAnimationFrame(frame);
    }
    // Align to the next whole step so the hand moves exactly on the second (or minute).
    let timer = 0;
    const tick = () => {
      const current = new Date();
      setNow(current);
      timer = window.setTimeout(tick, everyMs - (current.getTime() % everyMs) + 5);
    };
    timer = window.setTimeout(tick, everyMs - (Date.now() % everyMs) + 5);
    return () => window.clearTimeout(timer);
  }, [smooth, everyMs]);
  return now;
}

function hand(angle: number, length: number, tail: number) {
  const radians = ((angle - 90) * Math.PI) / 180;
  return {
    x1: 100 - Math.cos(radians) * tail,
    y1: 100 - Math.sin(radians) * tail,
    x2: 100 + Math.cos(radians) * length,
    y2: 100 + Math.sin(radians) * length,
  };
}

function zoneTime(date: Date, timeZone: string, hour12: boolean): string | null {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12 }).format(date);
  } catch {
    return null;
  }
}

export function ZaicodeAnalogClock({ prefs }: { prefs: ZaicodeHomeClockPrefs }) {
  const calm = useZaicodeUiPrefs((state) => state.noMotion);
  const smooth = prefs.secondHand && prefs.smooth && !calm && !prefersReducedMotion();
  const everyMs = prefs.secondHand || prefs.digital !== "off" ? 1000 : 15_000;
  const now = useClockNow(smooth, everyMs);
  const angles = zaicodeClockAngles(now, smooth);
  const size = SIZES[prefs.size];
  const zone = zaicodeTimeZoneName(now);
  const hour12 = prefs.digital === "12";
  const digital = prefs.digital === "off" ? null : formatZaicodeTimeOfDay(now, { seconds: prefs.secondHand, hour12 });
  const dateText = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const second = prefs.secondZone ? zoneTime(now, prefs.secondZone, hour12) : null;
  const spoken = `${formatZaicodeTimeOfDay(now, { hour12 })}, ${dateText}${zone ? `, ${zone}` : ""}`;
  return (
    <div className="flex flex-col items-center gap-1" data-zaicode-clock>
      <svg
        role="img"
        aria-label={`Clock: ${spoken}`}
        viewBox="0 0 200 200"
        className="aspect-square h-auto max-w-full"
        style={{ width: `min(${size}px, 100%)` }}
      >
        <title>{spoken}</title>
        <circle cx="100" cy="100" r="96" fill="var(--color-card)" stroke="var(--color-border-hover, var(--color-border))" strokeWidth="3" />
        <circle cx="100" cy="100" r="90" fill="none" stroke="var(--color-border)" strokeWidth="1" />
        {Array.from({ length: 60 }, (_, index) => {
          const major = index % 5 === 0;
          const radians = (index * 6 - 90) * (Math.PI / 180);
          const outer = 88;
          const inner = major ? 76 : 83;
          return (
            <line
              key={index}
              x1={100 + Math.cos(radians) * inner}
              y1={100 + Math.sin(radians) * inner}
              x2={100 + Math.cos(radians) * outer}
              y2={100 + Math.sin(radians) * outer}
              stroke={major ? "var(--color-foreground)" : "var(--color-foreground-subtlest)"}
              strokeWidth={major ? 3 : 1}
            />
          );
        })}
        {prefs.numerals
          ? Array.from({ length: 12 }, (_, index) => {
              const value = index + 1;
              const radians = (value * 30 - 90) * (Math.PI / 180);
              return (
                <text
                  key={value}
                  x={100 + Math.cos(radians) * 64}
                  y={100 + Math.sin(radians) * 64}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize="13"
                  fill="var(--color-foreground-subtle)"
                  style={{ fontFamily: "inherit" }}
                >
                  {value}
                </text>
              );
            })
          : null}
        <line {...hand(angles.hour, 48, 10)} stroke="var(--color-foreground)" strokeWidth="6" strokeLinecap="square" />
        <line {...hand(angles.minute, 74, 12)} stroke="var(--color-foreground)" strokeWidth="4" strokeLinecap="square" />
        {prefs.secondHand ? (
          <line {...hand(angles.second, 80, 18)} stroke="var(--zaicode-highlight, var(--color-warning))" strokeWidth="1.5" />
        ) : null}
        <circle cx="100" cy="100" r="4.5" fill="var(--zaicode-highlight, var(--color-warning))" />
      </svg>
      {digital ? (
        <time
          dateTime={now.toISOString()}
          className="text-ui-base tabular-nums text-foreground"
          data-zaicode-clock-digital
        >
          {digital}
        </time>
      ) : null}
      {prefs.date || prefs.timeZone ? (
        <span className="text-center text-ui-xs text-foreground-subtle">
          {prefs.date ? dateText : ""}
          {prefs.date && prefs.timeZone && zone ? " · " : ""}
          {prefs.timeZone ? zone : ""}
        </span>
      ) : null}
      {second ? (
        <span className="text-ui-xs text-foreground-subtlest" title={prefs.secondZone}>
          {prefs.secondZone.split("/").pop()?.replace(/_/g, " ")} {second}
        </span>
      ) : null}
    </div>
  );
}
