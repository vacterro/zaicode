import { cn } from "@/components/lib/utils.js";
import { readZaicodeEngine, useZaicodeEngines, visibleZaicodeAccounts, zaicodeRemainingColor } from "./zaicodeEngines.js";
import {
  ZAICODE_METER_TINT_MAX,
  isZaicodeEngineShown,
  setZaicodeLimitMeterStyle,
  useZaicodeLimitMeterStyle,
  useZaicodeMeterPrefs,
  zaicodeAvailabilityTint,
} from "./zaicodeMeterPrefs.js";
import { ZaicodePrefCheck, ZaicodePrefHeading, ZaicodePrefSegment, ZaicodePrefStepper } from "./ZaicodePrefControls.js";
import { zaicodeVendorColor } from "./ZaicodeLimitViews.js";

/**
 * FastPrompter's "Gauges & accounts" for ZAICODE: what the AI limit meters
 * show and how. The same panel sits in Settings -> Engines & limits and on a
 * right-click of the title bar meter, so a change is one click from where it
 * is seen.
 */
export function ZaicodeMeterSettingsPanel() {
  const prefs = useZaicodeMeterPrefs();
  const style = useZaicodeLimitMeterStyle();
  const engines = useZaicodeEngines();
  const now = Date.now();
  const accounts = visibleZaicodeAccounts(engines);
  const shownOnMeter = accounts.filter((account) =>
    isZaicodeEngineShown(account, engines.limits[account.id], prefs, "meter", now),
  ).length;

  return (
    <div className="flex flex-col gap-1.5 text-ui-xs" data-zaicode-meter-settings>
      <ZaicodePrefSegment
        label="Title bar meter"
        value={style}
        options={[
          { value: "stacked", label: "Stacked", hint: "Name over two thin bars: 5h, then the long window" },
          { value: "bars", label: "Bars", hint: "One thin vertical bar per engine" },
          { value: "dots", label: "Dots", hint: "One coloured square per engine" },
        ]}
        onChange={setZaicodeLimitMeterStyle}
      />
      <ZaicodePrefSegment
        label="Bars show"
        value={prefs.fill}
        options={[
          { value: "remaining", label: "Quota left", hint: "Full bar = quota available; it drains as you spend" },
          { value: "used", label: "Quota used", hint: "Empty bar = nothing spent; it grows as you spend" },
        ]}
        onChange={(fill) => prefs.update({ fill })}
      />
      <ZaicodePrefHeading>WHICH ENGINES SHOW</ZaicodePrefHeading>
      <ZaicodePrefCheck
        checked={prefs.hideZeroUsage}
        onChange={(hideZeroUsage) => prefs.update({ hideZeroUsage })}
        label="Hide engines with 0% used"
        hint="An engine appears once any of its windows was actually used. Engines without a reading stay."
      />
      <ZaicodePrefCheck
        checked={prefs.onlyUsable5h}
        onChange={(onlyUsable5h) => prefs.update({ onlyUsable5h })}
        label="Only engines that can work now (5h window has quota)"
        hint="A spent 5h window refuses work even with weekly quota left. Antigravity: one pool with quota is enough."
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-5 text-foreground-subtle">
        <span>These two rules apply to:</span>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={prefs.filterMeter} onChange={(event) => prefs.update({ filterMeter: event.target.checked })} />
          title bar meter
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={prefs.filterTiles} onChange={(event) => prefs.update({ filterTiles: event.target.checked })} />
          sidebar engine tiles
        </label>
      </div>
      {accounts.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground-subtle">
            On the meter ({shownOnMeter}/{accounts.length} shown) — click to hide / show one engine there only
          </span>
          <div className="flex flex-wrap gap-px">
            {accounts.map((account) => {
              const hidden = prefs.meterHidden.includes(account.id);
              const filteredOut =
                !hidden && !isZaicodeEngineShown(account, engines.limits[account.id], prefs, "meter", now);
              return (
                <button
                  key={account.id}
                  type="button"
                  aria-pressed={!hidden}
                  title={
                    hidden
                      ? `${account.label}: hidden from the meter. Click to show.`
                      : filteredOut
                        ? `${account.label}: shown, but the rules above hide it right now.`
                        : `${account.label}: on the meter. Click to hide it there.`
                  }
                  className={cn(
                    "min-w-[30px] border px-1 font-semibold",
                    hidden ? "border-dashed border-border text-foreground-subtlest line-through" : "border-border hover:bg-hover",
                    filteredOut && "opacity-50",
                  )}
                  style={hidden ? undefined : { color: zaicodeVendorColor(account.vendor) }}
                  onClick={() => prefs.toggleMeterHidden(account.id)}
                >
                  {account.short}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      <ZaicodePrefHeading>LOOK</ZaicodePrefHeading>
      <ZaicodePrefCheck
        checked={prefs.vendorTint}
        onChange={(vendorTint) => prefs.update({ vendorTint })}
        label="Vendor tint on the bars"
        hint="Nudges each bar toward its vendor colour (Claude terracotta, Codex blue, Antigravity violet)."
      />
      <ZaicodePrefCheck
        checked={prefs.showLabels}
        onChange={(showLabels) => prefs.update({ showLabels })}
        label="Engine names over Bars / Dots"
        hint="Stacked always shows them."
      />
      <ZaicodePrefStepper
        label="Availability tint of the sidebar tiles"
        value={prefs.availabilityTint}
        min={0}
        max={ZAICODE_METER_TINT_MAX}
        step={3}
        format={(value) => (value === 0 ? "off" : `${value}%`)}
        onChange={(availabilityTint) => prefs.update({ availabilityTint })}
      />
      <div className="flex items-center gap-1 pl-1 text-foreground-subtlest">
        <span>Preview:</span>
        {[
          { label: "80%", remaining: 80 },
          { label: "35%", remaining: 35 },
          { label: "10%", remaining: 10 },
          { label: "0%", remaining: 0 },
        ].map((sample) => (
          <span
            key={sample.label}
            className="border border-border px-1 text-foreground"
            style={{ background: zaicodeAvailabilityTint(zaicodeRemainingColor(sample.remaining), prefs.availabilityTint) }}
          >
            {sample.label}
          </span>
        ))}
      </div>
      {accounts.length > 0 && prefs.filterTiles && (prefs.hideZeroUsage || prefs.onlyUsable5h) ? (
        <span className="text-foreground-subtlest">
          Hidden tiles can still be started from a project&apos;s ⋯ menu and Settings → Engines.
          {accounts.some((account) => readZaicodeEngine(account, engines.limits[account.id], now).tone === "offline")
            ? " Engines that need sign-in keep their tile."
            : ""}
        </span>
      ) : null}
    </div>
  );
}
