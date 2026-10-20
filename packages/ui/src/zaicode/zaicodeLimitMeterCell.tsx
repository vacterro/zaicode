import type { ReactNode } from "react";
import type { ZaicodeEngineAccount, ZaicodeLimitSnapshot } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { readZaicodeEngine, zaicodeRemainingColor } from "./zaicodeEngines.js";
import {
  zaicodeMeterFillPercent,
  zaicodeTintedLevelColor,
  type ZaicodeLimitMeterStyle,
  type ZaicodeMeterFill,
} from "./zaicodeMeterPrefs.js";
import { zaicodeStackedLimitPair, zaicodeVendorColor } from "./ZaicodeLimitViews.js";
import { useZaicodeFresh, useZaicodeNotifySettings } from "./zaicodeNotifications.js";
import { useZaicodePreparedMeters } from "./ZaicodeSchedulerBits.js";
import { withZaicodeHighlight } from "./zaicodeHighlights.js";
import { zaicodeGlowHandlers, zaicodeGlowStyle } from "./zaicodeGlow.js";

/**
 * T-278: one engine's reading in the meter row, extracted from
 * ZaicodeLimitMeter so the meter module keeps to the 400-line budget. Display
 * only -- every input arrives as a prop, no shared state lives here.
 */

export interface CellLook {
  fill: ZaicodeMeterFill;
  vendorTint: boolean;
  showLabels: boolean;
}

export function MeterCell({
  account,
  snapshot,
  style,
  now,
  look,
}: {
  account: ZaicodeEngineAccount;
  snapshot: ZaicodeLimitSnapshot | undefined;
  style: ZaicodeLimitMeterStyle;
  now: number;
  look: CellLook;
}) {
  const reading = readZaicodeEngine(account, snapshot, now);
  const fresh = useZaicodeFresh(`engine:${account.id}`);
  // SRC-038: a schedule waits for this engine's reset -> the cell shows "prompt ready".
  const prepared = useZaicodePreparedMeters()(account.id);
  const glow = useZaicodeNotifySettings().glow;
  const offline = reading.tone === "offline";
  const vendor = zaicodeVendorColor(account.vendor);
  const color = (remaining: number | null) =>
    zaicodeTintedLevelColor(zaicodeRemainingColor(remaining), vendor, look.vendorTint);
  const label =
    style === "stacked" || look.showLabels ? (
      <span className="text-[9px] leading-none" style={{ color: offline ? undefined : vendor }}>
        {account.short}
      </span>
    ) : null;
  let body: ReactNode;
  if (style === "dots") {
    body = (
      <span
        className={cn("inline-block size-2.5 border border-black/70", offline && "border-dashed")}
        style={{ background: offline ? "transparent" : color(reading.remaining) }}
      />
    );
  } else if (style === "bars") {
    body = (
      <span className="relative inline-block h-4 w-1.5 border border-black/70 bg-black/35">
        <span
          className="absolute inset-x-0 bottom-0"
          style={{
            height: `${zaicodeMeterFillPercent(reading.remaining, look.fill)}%`,
            background: color(reading.remaining),
            opacity: reading.stale ? 0.55 : 1,
          }}
        />
      </span>
    );
  } else {
    body = zaicodeStackedLimitPair(snapshot, now).map((value, index) => (
      <span key={index} className="relative block h-[3px] w-5 bg-black/45">
        <span
          className="absolute inset-y-0 left-0"
          style={{
            width: `${zaicodeMeterFillPercent(value, look.fill)}%`,
            background: color(value),
            opacity: reading.stale ? 0.55 : 1,
          }}
        />
      </span>
    ));
  }
  return (
    <span
      {...withZaicodeHighlight(
        {
          className: "flex flex-col items-center gap-px",
          style: fresh ? zaicodeGlowStyle(fresh, now, glow) : undefined,
          ...(prepared.hint ? { title: prepared.hint } : {}),
        },
        fresh ? null : prepared.lights,
      )}
      data-zaicode-meter-cell={account.short}
      data-zaicode-fresh={fresh ? "true" : undefined}
      data-zaicode-prepared={prepared.hint ? "true" : undefined}
      {...zaicodeGlowHandlers([`engine:${account.id}`], Boolean(fresh))}
    >
      {label}
      {body}
    </span>
  );
}
