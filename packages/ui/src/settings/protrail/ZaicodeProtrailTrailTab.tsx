import { RotateCcw } from "lucide-react";
import {
  PROTRAIL_COLOR_MODES,
  PROTRAIL_COLOR_MODE_LABELS,
  PROTRAIL_FADE_CURVES,
  PROTRAIL_LIMITS as L,
  PROTRAIL_SPARKLE_MODES,
  PROTRAIL_TRAIL_STYLES,
  PROTRAIL_TRAIL_STYLE_LABELS,
} from "@/zaicode/protrail/protrailModel.js";
import { useZaicodeProtrail } from "@/zaicode/protrail/zaicodeProtrailStore.js";
import { ProtrailCheck, ProtrailColor, ProtrailGrid, ProtrailGroup, ProtrailSlider, fmt } from "./ZaicodeProtrailControls.js";

/** ProTrail's Trail tab: style, colours, shape, fade and the sparkle layer. */

const STYLE_HINTS: Record<(typeof PROTRAIL_TRAIL_STYLES)[number], string> = {
  classic: "The approved baseline stroke",
  softGlow: "A wide soft outer pass under the core",
  comet: "A bright enlarged head with a thin fading tail",
  neon: "Intense glow: a wider, stronger outer pass",
  dotted: "Evenly spaced dots along the path",
  pulse: "A travelling width / brightness wave",
  ribbon: "Smooth alternating broad / narrow twist lobes",
  spark: "Dots that flicker",
};
const SPARKLE_LABELS: Record<(typeof PROTRAIL_SPARKLE_MODES)[number], [string, string]> = {
  off: ["Off", "No sparkle layer"],
  stardust: ["Stardust", "Soft tiny dust hugging the path"],
  twinkle: ["Twinkle", "Sparse star-like flashes that pulse"],
  glitter: ["Glitter", "Dense tiny sharp shimmer"],
  firefly: ["Firefly", "Sparse drifting luminous points"],
  shards: ["Shards", "Detached rotating triangular fragments"],
};

export function ZaicodeProtrailTrailTab() {
  const { config, setTrail, resetTrail } = useZaicodeProtrail();
  const t = config.trail;
  const off = !t.enabled;
  const glowing = t.style === "softGlow" || t.style === "neon";
  const dotted = t.style === "dotted" || t.style === "spark";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <ProtrailCheck label="Show the cursor trail" checked={t.enabled} onChange={(enabled) => setTrail({ enabled })} />
        <button type="button" className="flex items-center gap-1 border border-border px-1.5 py-0.5 text-foreground-subtle hover:bg-hover" onClick={resetTrail}>
          <RotateCcw className="size-3" /> Restore Trail defaults
        </button>
      </div>
      <ProtrailGroup title="Style">
        <ProtrailGrid
          value={t.style}
          disabled={off}
          options={PROTRAIL_TRAIL_STYLES.map((value) => ({ value, label: PROTRAIL_TRAIL_STYLE_LABELS[value], hint: STYLE_HINTS[value] }))}
          onChange={(style) => setTrail({ style })}
        />
        {glowing ? <ProtrailSlider label="Glow strength" value={t.glowStrength} min={0} max={1} step={0.05} format={fmt.pct} disabled={off} onChange={(glowStrength) => setTrail({ glowStrength })} /> : null}
        {dotted ? <ProtrailSlider label="Dot spacing" value={t.segmentSpacingPx} min={L.segmentSpacingPx[0]} max={L.segmentSpacingPx[1]} step={1} format={fmt.px} disabled={off} onChange={(segmentSpacingPx) => setTrail({ segmentSpacingPx })} /> : null}
      </ProtrailGroup>
      <ProtrailGroup title="Colour">
        <ProtrailGrid
          value={t.colorMode}
          disabled={off}
          options={PROTRAIL_COLOR_MODES.map((value) => ({ value, label: PROTRAIL_COLOR_MODE_LABELS[value] }))}
          onChange={(colorMode) => setTrail({ colorMode })}
        />
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <ProtrailColor label="Start / head" value={t.start} disabled={off} onChange={(start) => setTrail({ start })} />
          <ProtrailColor label="Fade / tail" value={t.fade} disabled={off || t.colorMode === "full"} onChange={(fade) => setTrail({ fade })} />
        </div>
      </ProtrailGroup>
      <ProtrailGroup title="Shape">
        <ProtrailSlider label="Head thickness" value={t.headThicknessPx} min={L.thicknessPx[0]} max={L.thicknessPx[1]} step={0.5} format={fmt.px} disabled={off} onChange={(headThicknessPx) => setTrail({ headThicknessPx })} />
        <ProtrailSlider label="Tail thickness" value={t.tailThicknessPx} min={L.thicknessPx[0]} max={L.thicknessPx[1]} step={0.5} format={fmt.px} disabled={off} onChange={(tailThicknessPx) => setTrail({ tailThicknessPx })} />
        <ProtrailSlider label="Taper (head → tail)" value={t.taperStrength} min={0} max={1} step={0.05} format={fmt.pct} disabled={off} onChange={(taperStrength) => setTrail({ taperStrength })} />
        <ProtrailSlider label="Smoothing" value={t.smoothing} min={0} max={1} step={0.05} format={fmt.pct} disabled={off} onChange={(smoothing) => setTrail({ smoothing })} />
      </ProtrailGroup>
      <ProtrailGroup title="Fade">
        <ProtrailSlider label="Lifetime" value={t.lifetimeMs} min={L.lifetimeMs[0]} max={L.lifetimeMs[1]} step={10} format={fmt.ms} disabled={off} onChange={(lifetimeMs) => setTrail({ lifetimeMs })} />
        <ProtrailSlider label="Opacity" value={t.baseOpacity} min={L.trailOpacity[0]} max={1} step={0.05} format={fmt.pct} disabled={off} onChange={(baseOpacity) => setTrail({ baseOpacity })} />
        <ProtrailSlider label="Fade starts at" value={t.fadeStart} min={0} max={0.95} step={0.05} format={fmt.pct} disabled={off} onChange={(fadeStart) => setTrail({ fadeStart })} />
        <ProtrailGrid
          label="Fade curve"
          value={t.fadeCurve}
          columns={3}
          disabled={off}
          options={PROTRAIL_FADE_CURVES.map((value) => ({ value, label: value === "easeOut" ? "Ease out" : value === "smooth" ? "Smooth" : "Linear" }))}
          onChange={(fadeCurve) => setTrail({ fadeCurve })}
        />
      </ProtrailGroup>
      <ProtrailGroup title="Sparkles">
        <ProtrailGrid
          value={t.sparkleMode}
          columns={6}
          disabled={off}
          options={PROTRAIL_SPARKLE_MODES.map((value) => ({ value, label: SPARKLE_LABELS[value][0], hint: SPARKLE_LABELS[value][1] }))}
          onChange={(sparkleMode) => setTrail({ sparkleMode })}
        />
        {t.sparkleMode !== "off" ? (
          <>
            <ProtrailSlider label="Amount" value={t.sparkleAmount} min={0} max={1} step={0.05} format={fmt.pct} disabled={off} onChange={(sparkleAmount) => setTrail({ sparkleAmount })} />
            <ProtrailSlider label="Size" value={t.sparkleSizePx} min={L.sparkleSizePx[0]} max={L.sparkleSizePx[1]} step={0.5} format={fmt.px} disabled={off} onChange={(sparkleSizePx) => setTrail({ sparkleSizePx })} />
            <ProtrailSlider label="Spread" value={t.sparkleSpreadPx} min={0} max={L.sparkleSpreadPx[1]} step={1} format={fmt.px} disabled={off} onChange={(sparkleSpreadPx) => setTrail({ sparkleSpreadPx })} />
          </>
        ) : null}
      </ProtrailGroup>
    </div>
  );
}
