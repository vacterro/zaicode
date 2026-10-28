import { RotateCcw } from "lucide-react";
import {
  PROTRAIL_CLICK_STYLES,
  PROTRAIL_CLICK_STYLE_LABELS,
  PROTRAIL_EASINGS,
  PROTRAIL_LIMITS as L,
  isProtrailElemental,
} from "@/zaicode/protrail/protrailModel.js";
import { useZaicodeProtrail } from "@/zaicode/protrail/zaicodeProtrailStore.js";
import { ProtrailCheck, ProtrailColor, ProtrailGrid, ProtrailGroup, ProtrailSlider, fmt } from "./ZaicodeProtrailControls.js";

/** ProTrail's Click tab: the click itself, press-and-hold, and the motion wake. */

const STYLE_HINTS: Record<(typeof PROTRAIL_CLICK_STYLES)[number], string> = {
  ring: "A bubble ring with a subtle fill",
  doubleRing: "A main ring and an inner ring",
  ripple: "A thin pure ring, no fill",
  burst: "A ring and particles flying out",
  sparkBurst: "A scattered particle burst",
  softFlash: "A soft filled flash disc",
  dotRing: "A central dot and a ring",
  air: "A fast wide ring and swirling motes",
  fire: "Embers rising with wobble, cooling as they age",
  water: "Up to three staggered ripple rings and droplets",
  earth: "A low dust ring and debris falling under gravity",
};

export function ZaicodeProtrailClickTab() {
  const { config, setClick, resetClick } = useZaicodeProtrail();
  const c = config.click;
  const off = !c.enabled;
  const noHold = off || !c.holdEnabled;
  const noWake = noHold || !c.holdWakeEnabled;
  const particles = c.style === "burst" || c.style === "sparkBurst" || isProtrailElemental(c.style);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <ProtrailCheck label="Show click effects" checked={c.enabled} onChange={(enabled) => setClick({ enabled })} />
        <button type="button" className="flex items-center gap-1 border border-border px-1.5 py-0.5 text-foreground-subtle hover:bg-hover" onClick={resetClick}>
          <RotateCcw className="size-3" /> Restore Click defaults
        </button>
      </div>
      <ProtrailGroup title="Style">
        <ProtrailGrid
          value={c.style}
          disabled={off}
          options={PROTRAIL_CLICK_STYLES.map((value) => ({ value, label: PROTRAIL_CLICK_STYLE_LABELS[value], hint: STYLE_HINTS[value] }))}
          onChange={(style) => setClick({ style })}
        />
        {particles ? <ProtrailSlider label="Particles" value={c.particleAmount} min={0} max={L.particleAmount[1]} step={1} disabled={off} onChange={(particleAmount) => setClick({ particleAmount })} /> : null}
        {isProtrailElemental(c.style) ? <ProtrailSlider label="Element colour strength" value={c.elementTint} min={0} max={1} step={0.05} format={fmt.pct} disabled={off} onChange={(elementTint) => setClick({ elementTint })} /> : null}
      </ProtrailGroup>
      <ProtrailGroup title="Colour and buttons">
        <ProtrailColor label="Colour" value={c.color} disabled={off} onChange={(color) => setClick({ color })} />
        <div className="flex flex-wrap gap-3">
          <ProtrailCheck label="Left" checked={c.triggerLeft} disabled={off} onChange={(triggerLeft) => setClick({ triggerLeft })} />
          <ProtrailCheck label="Right" checked={c.triggerRight} disabled={off} onChange={(triggerRight) => setClick({ triggerRight })} />
          <ProtrailCheck label="Middle" checked={c.triggerMiddle} disabled={off} onChange={(triggerMiddle) => setClick({ triggerMiddle })} />
        </div>
      </ProtrailGroup>
      <ProtrailGroup title="Size and timing">
        <ProtrailSlider label="Start radius" value={c.startRadiusPx} min={0} max={L.startRadiusPx[1]} step={1} format={fmt.px} disabled={off} onChange={(startRadiusPx) => setClick({ startRadiusPx })} />
        <ProtrailSlider label="End radius" value={c.endRadiusPx} min={1} max={200} step={1} format={fmt.px} disabled={off} onChange={(endRadiusPx) => setClick({ endRadiusPx })} />
        <ProtrailSlider label="Duration" value={c.durationMs} min={L.durationMs[0]} max={L.durationMs[1]} step={10} format={fmt.ms} disabled={off} onChange={(durationMs) => setClick({ durationMs })} />
        <ProtrailSlider label="Opacity" value={c.baseOpacity} min={L.clickOpacity[0]} max={1} step={0.05} format={fmt.pct} disabled={off} onChange={(baseOpacity) => setClick({ baseOpacity })} />
        <ProtrailSlider label="Outline" value={c.outlineThicknessPx} min={L.outlinePx[0]} max={L.outlinePx[1]} step={0.5} format={fmt.px} disabled={off} onChange={(outlineThicknessPx) => setClick({ outlineThicknessPx })} />
        <ProtrailSlider label="Fill" value={c.fillOpacity} min={0} max={1} step={0.05} format={fmt.pct} disabled={off} onChange={(fillOpacity) => setClick({ fillOpacity })} />
        <ProtrailGrid
          label="Expansion"
          value={c.easing}
          columns={3}
          disabled={off}
          options={PROTRAIL_EASINGS.map((value) => ({ value, label: value === "easeOut" ? "Ease out" : value === "smooth" ? "Smooth" : "Linear" }))}
          onChange={(easing) => setClick({ easing })}
        />
      </ProtrailGroup>
      <ProtrailGroup title="Press and hold">
        <ProtrailCheck
          label="Hold effect (a charging aura while the button is down, a bigger payoff on release)"
          checked={c.holdEnabled}
          disabled={off}
          onChange={(holdEnabled) => setClick({ holdEnabled })}
        />
        <ProtrailSlider label="Aura intensity" value={c.holdIntensity} min={0.25} max={2} step={0.05} format={fmt.x} disabled={noHold} onChange={(holdIntensity) => setClick({ holdIntensity })} />
        <ProtrailSlider label="Release strength" value={c.holdReleaseStrength} min={0.5} max={2} step={0.05} format={fmt.x} disabled={noHold} onChange={(holdReleaseStrength) => setClick({ holdReleaseStrength })} />
        <ProtrailCheck label="Motion wake (dragging while holding sheds the style's geometry behind you)" checked={c.holdWakeEnabled} disabled={noHold} onChange={(holdWakeEnabled) => setClick({ holdWakeEnabled })} />
        <ProtrailSlider label="Wake density" value={c.holdWakeDensity} min={0.25} max={2} step={0.05} format={fmt.x} disabled={noWake} onChange={(holdWakeDensity) => setClick({ holdWakeDensity })} />
        <ProtrailSlider label="Wake lifetime" value={c.holdWakeLifetimeMs} min={L.holdWakeLifetimeMs[0]} max={L.holdWakeLifetimeMs[1]} step={10} format={fmt.ms} disabled={noWake} onChange={(holdWakeLifetimeMs) => setClick({ holdWakeLifetimeMs })} />
      </ProtrailGroup>
      <ProtrailGroup title="Motion wake — advanced">
        <ProtrailSlider label="Strength" value={c.wakeStrength} min={0.25} max={2} step={0.05} format={fmt.x} disabled={noWake} onChange={(wakeStrength) => setClick({ wakeStrength })} />
        <ProtrailSlider label="Size" value={c.wakeSize} min={0.5} max={2} step={0.05} format={fmt.x} disabled={noWake} onChange={(wakeSize) => setClick({ wakeSize })} />
        <ProtrailSlider label="Spread" value={c.wakeSpread} min={0} max={2} step={0.05} format={fmt.x} disabled={noWake} onChange={(wakeSpread) => setClick({ wakeSpread })} />
        <ProtrailSlider label="Speed response" value={c.speedResponse} min={0} max={2} step={0.05} format={fmt.x} disabled={noWake} onChange={(speedResponse) => setClick({ speedResponse })} />
        <ProtrailSlider label="Minimum motion speed" value={c.minMotionSpeedPxS} min={0} max={1000} step={10} format={fmt.speed} disabled={noWake} onChange={(minMotionSpeedPxS) => setClick({ minMotionSpeedPxS })} />
        <div className="flex flex-wrap gap-3">
          <ProtrailCheck label="Turn accent" hint="One accent when the drag turns sharply (over ~80°)" checked={c.turnAccent} disabled={noWake} onChange={(turnAccent) => setClick({ turnAccent })} />
          <ProtrailCheck label="Stop accent" hint="One accent when a drag comes to a stop" checked={c.stopAccent} disabled={noWake} onChange={(stopAccent) => setClick({ stopAccent })} />
        </div>
      </ProtrailGroup>
    </div>
  );
}
