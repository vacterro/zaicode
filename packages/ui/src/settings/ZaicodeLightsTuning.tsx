import { useState, type ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { ZaicodePrefSegment } from "@/zaicode/ZaicodePrefControls.js";
import {
  ZAICODE_EFFECT_DEPTH,
  ZAICODE_HIGHLIGHT_EFFECTS,
  ZAICODE_HIGHLIGHT_SHAPES,
  ZAICODE_WORKING_IMAGES,
  ZAICODE_WORKING_MOTIONS,
  type ZaicodeHighlightEffect,
  type ZaicodeHighlightRule,
  type ZaicodeHighlightShape,
  type ZaicodeWorkingIconPrefs,
  type ZaicodeWorkingImage,
  type ZaicodeWorkingMotion,
} from "@/zaicode/zaicodeHighlights.js";
import {
  ZAICODE_BLENDS,
  ZAICODE_DEFAULT_CURVE,
  ZAICODE_LAYER_DEFAULTS,
  ZAICODE_MOTION_TUNING_NONE,
  isZaicodeTuningEmpty,
  type ZaicodeBlend,
  type ZaicodeEffectTuning,
  type ZaicodeLayerTuning,
  type ZaicodeMotionDirection,
  type ZaicodeMotionTuning,
} from "@/zaicode/zaicodeMotionTuning.js";
import { ZaicodeEasingPicker, ZaicodeLightsSlider } from "./ZaicodeCurveEditor.js";

/**
 * Settings -> Highlights & motion, the fine controls (SRC-048): own easing
 * curves, and separate settings for every part of a mix -- each combined
 * motion and effect its own speed, easing, reach / depth and phase, each
 * shape its own colour and strength, each stacked picture its own layer.
 */

// ---------------------------------------------------------------- mix tabs

function MixTabs<T extends string>({
  items,
  active,
  onPick,
  labelOf,
  tuned,
}: {
  items: readonly T[];
  active: T;
  onPick: (item: T) => void;
  labelOf: (item: T) => string;
  tuned: (item: T) => boolean;
}) {
  return (
    <div className="flex flex-wrap gap-px" role="tablist">
      {items.map((item) => (
        <button
          key={item}
          type="button"
          role="tab"
          aria-selected={item === active}
          className={cn(
            "border px-1.5 py-px",
            item === active
              ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
              : "border-border text-foreground-subtle hover:bg-hover",
          )}
          onClick={() => onPick(item)}
        >
          {labelOf(item)}
          {tuned(item) ? " •" : ""}
        </button>
      ))}
    </div>
  );
}

function Frame({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border border-border bg-background p-2" data-zaicode-mix-tuning>
      <div>
        <span className="text-foreground">{title}</span>
        <span className="block text-foreground-subtlest">{hint}</span>
      </div>
      {children}
    </div>
  );
}

const DIRECTION_OPTIONS = [
  { value: "common", label: "Common" },
  { value: "cw", label: "↻" },
  { value: "ccw", label: "↺" },
  { value: "alternate", label: "⇄" },
] as const;

const REACH_MOTIONS: readonly ZaicodeWorkingMotion[] = ["swing", "wobble", "pulse", "breathe", "bounce", "blink"];

const motionLabel = (motion: ZaicodeWorkingMotion) => ZAICODE_WORKING_MOTIONS.find((entry) => entry.id === motion)?.label ?? motion;

/** Working icon: own speed / easing / direction / reach / phase for every motion in the mix. */
export function ZaicodeMotionMixTuning({
  working,
  onTuning,
}: {
  working: ZaicodeWorkingIconPrefs;
  onTuning: (motion: ZaicodeWorkingMotion, tuning: ZaicodeMotionTuning | null) => void;
}) {
  const motions: ZaicodeWorkingMotion[] = working.motions.filter((motion) => motion !== "none");
  const [picked, setPicked] = useState<ZaicodeWorkingMotion | null>(null);
  if (motions.length === 0) return null;
  const active = picked && motions.includes(picked) ? picked : motions[0]!;
  const own = working.tuning[active] ?? ZAICODE_MOTION_TUNING_NONE;
  const set = (patch: Partial<ZaicodeMotionTuning>) => {
    const next = { ...own, ...patch };
    onTuning(active, isZaicodeTuningEmpty(next) ? null : next);
  };
  return (
    <Frame
      title="Separate settings per motion"
      hint="Each motion of the mix runs on its own clock: its own speed, easing, direction, reach and starting point. Unticked = follows the common setting above."
    >
      <MixTabs items={motions} active={active} onPick={setPicked} labelOf={motionLabel} tuned={(motion) => Boolean(working.tuning[motion])} />
      <div className="grid max-w-[600px] gap-1.5">
        <ZaicodeLightsSlider
          label="Speed"
          value={own.seconds ?? working.seconds}
          min={0.2}
          max={20}
          step={0.1}
          format={(value) => `${value.toFixed(1)} s`}
          onChange={(seconds) => set({ seconds })}
          own={{ on: own.seconds !== null, onToggle: (on) => set({ seconds: on ? working.seconds : null }) }}
        />
        {REACH_MOTIONS.includes(active) ? (
          <ZaicodeLightsSlider
            label="Reach"
            value={own.amplitude ?? working.amplitude}
            min={5}
            max={100}
            format={(value) => `${value}%`}
            onChange={(amplitude) => set({ amplitude })}
            own={{ on: own.amplitude !== null, onToggle: (on) => set({ amplitude: on ? working.amplitude : null }) }}
          />
        ) : null}
        <ZaicodeLightsSlider
          label="Start at"
          value={own.phase}
          min={0}
          max={100}
          format={(value) => `${value}%`}
          onChange={(phase) => set({ phase })}
        />
      </div>
      <ZaicodePrefSegment
        label="Direction"
        value={own.direction ?? "common"}
        onChange={(direction) => set({ direction: direction === "common" ? null : (direction as ZaicodeMotionDirection) })}
        options={DIRECTION_OPTIONS}
      />
      <ZaicodeEasingPicker
        label="Easing"
        common="Common"
        value={own.easing}
        curve={own.curve ?? working.curve}
        onChange={(easing) => set({ easing, curve: easing === "custom" ? (own.curve ?? working.curve) : own.curve })}
        onCurve={(curve) => set({ curve })}
      />
      <button
        type="button"
        className="self-start border border-border px-1.5 py-px text-foreground-subtle hover:bg-hover"
        onClick={() => onTuning(active, null)}
      >
        Follow the common settings again
      </button>
    </Frame>
  );
}

const imageLabel = (image: ZaicodeWorkingImage) => ZAICODE_WORKING_IMAGES.find((entry) => entry.id === image)?.label ?? image;

/** Stacked pictures as layers: opacity, size, blend, offset and an own extra motion each. */
export function ZaicodeLayerTuningPanel({
  working,
  onLayer,
}: {
  working: ZaicodeWorkingIconPrefs;
  onLayer: (image: ZaicodeWorkingImage, layer: ZaicodeLayerTuning | null) => void;
}) {
  const [picked, setPicked] = useState<ZaicodeWorkingImage | null>(null);
  if (working.images.length < 2) return null;
  const active = picked && working.images.includes(picked) ? picked : working.images[0]!;
  const layer = working.layers[active] ?? ZAICODE_LAYER_DEFAULTS;
  const set = (patch: Partial<ZaicodeLayerTuning>) => onLayer(active, { ...layer, ...patch });
  return (
    <Frame
      title="Layers"
      hint="The stacked pictures, bottom first. Each layer: its own opacity, size, blend with the layers under it, offset, and a motion of its own on top of the icon's."
    >
      <MixTabs items={working.images} active={active} onPick={setPicked} labelOf={imageLabel} tuned={(image) => Boolean(working.layers[image])} />
      <div className="grid max-w-[600px] gap-1.5">
        <ZaicodeLightsSlider label="Opacity" value={layer.opacity} min={10} max={100} step={5} format={(v) => `${v}%`} onChange={(opacity) => set({ opacity })} />
        <ZaicodeLightsSlider label="Size" value={layer.size} min={30} max={200} step={5} format={(v) => `${v}%`} onChange={(size) => set({ size })} />
        <ZaicodeLightsSlider label="Offset →" value={layer.x} min={-50} max={50} format={(v) => `${v}%`} onChange={(x) => set({ x })} />
        <ZaicodeLightsSlider label="Offset ↓" value={layer.y} min={-50} max={50} format={(v) => `${v}%`} onChange={(y) => set({ y })} />
      </div>
      <ZaicodePrefSegment
        label="Blend"
        value={layer.blend}
        onChange={(blend) => set({ blend: blend as ZaicodeBlend })}
        options={ZAICODE_BLENDS.map((blend) => ({ value: blend.id, label: blend.label }))}
      />
      <ZaicodePrefSegment
        label="Own motion"
        value={layer.motion}
        onChange={(motion) => set({ motion })}
        options={ZAICODE_WORKING_MOTIONS.map((motion) => ({ value: motion.id as string, label: motion.label, hint: motion.hint }))}
      />
      {layer.motion !== "none" ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid min-w-[360px] gap-1.5">
            <ZaicodeLightsSlider label="Its speed" value={layer.seconds} min={0.2} max={20} step={0.1} format={(v) => `${v.toFixed(1)} s`} onChange={(seconds) => set({ seconds })} />
          </div>
          <ZaicodePrefSegment
            label="Its direction"
            value={layer.direction}
            onChange={(direction) => set({ direction })}
            options={DIRECTION_OPTIONS.filter((option) => option.value !== "common") as { value: ZaicodeMotionDirection; label: string }[]}
          />
        </div>
      ) : null}
      <button type="button" className="self-start border border-border px-1.5 py-px text-foreground-subtle hover:bg-hover" onClick={() => onLayer(active, null)}>
        Plain layer again
      </button>
    </Frame>
  );
}

const effectLabel = (effect: ZaicodeHighlightEffect) => ZAICODE_HIGHLIGHT_EFFECTS.find((entry) => entry.id === effect)?.label ?? effect;
const shapeLabel = (shape: ZaicodeHighlightShape) => ZAICODE_HIGHLIGHT_SHAPES.find((entry) => entry.id === shape)?.label ?? shape;

const EFFECT_TUNING_NONE: ZaicodeEffectTuning = { seconds: null, easing: null, curve: null, depth: null, phase: 0 };

/** Highlight: own speed / easing / depth / phase for every effect in the mix, own colour / strength per shape. */
export function ZaicodeHighlightMixTuning({
  rule,
  onEffect,
  onShape,
}: {
  rule: ZaicodeHighlightRule;
  onEffect: (effect: ZaicodeHighlightEffect, tuning: ZaicodeEffectTuning | null) => void;
  onShape: (shape: ZaicodeHighlightShape, tuning: { color: string | null; strength: number | null } | null) => void;
}) {
  const effects: ZaicodeHighlightEffect[] = rule.effects.filter((effect) => effect !== "steady");
  const [pickedEffect, setPickedEffect] = useState<ZaicodeHighlightEffect | null>(null);
  const [pickedShape, setPickedShape] = useState<ZaicodeHighlightShape | null>(null);
  const activeEffect = pickedEffect && effects.includes(pickedEffect) ? pickedEffect : (effects[0] ?? null);
  const activeShape = pickedShape && rule.shapes.includes(pickedShape) ? pickedShape : rule.shapes[0]!;
  const ownEffect = activeEffect ? (rule.tuning[activeEffect] ?? EFFECT_TUNING_NONE) : EFFECT_TUNING_NONE;
  const setEffect = (patch: Partial<ZaicodeEffectTuning>) => {
    if (!activeEffect) return;
    const next = { ...ownEffect, ...patch };
    onEffect(activeEffect, isZaicodeTuningEmpty(next) ? null : next);
  };
  const ownShape = rule.shapeTuning[activeShape] ?? { color: null, strength: null };
  const setShape = (patch: Partial<{ color: string | null; strength: number | null }>) => {
    const next = { ...ownShape, ...patch };
    onShape(activeShape, next.color === null && next.strength === null ? null : next);
  };
  const naturalDepth = activeEffect ? ZAICODE_EFFECT_DEPTH[activeEffect] : 0;
  return (
    <Frame
      title="Separate settings per effect and shape"
      hint="In a mix every effect keeps its own speed, easing, depth and starting point, and every shape its own colour and strength. Unticked = the highlight's common setting."
    >
      {activeEffect ? (
        <>
          <MixTabs items={effects} active={activeEffect} onPick={setPickedEffect} labelOf={effectLabel} tuned={(effect) => Boolean(rule.tuning[effect])} />
          <div className="grid max-w-[600px] gap-1.5">
            <ZaicodeLightsSlider
              label="Speed"
              value={ownEffect.seconds ?? rule.seconds}
              min={0.1}
              max={10}
              step={0.1}
              format={(value) => `${value.toFixed(1)} s`}
              onChange={(seconds) => setEffect({ seconds })}
              own={{ on: ownEffect.seconds !== null, onToggle: (on) => setEffect({ seconds: on ? rule.seconds : null }) }}
            />
            <ZaicodeLightsSlider
              label="Depth"
              value={ownEffect.depth ?? naturalDepth}
              min={5}
              max={100}
              format={(value) => `${value}%`}
              onChange={(depth) => setEffect({ depth })}
              own={{ on: ownEffect.depth !== null, onToggle: (on) => setEffect({ depth: on ? naturalDepth : null }) }}
            />
            <ZaicodeLightsSlider label="Start at" value={ownEffect.phase} min={0} max={100} format={(value) => `${value}%`} onChange={(phase) => setEffect({ phase })} />
          </div>
          <ZaicodeEasingPicker
            label="Easing"
            common="Auto"
            value={ownEffect.easing}
            curve={ownEffect.curve ?? ZAICODE_DEFAULT_CURVE}
            onChange={(easing) => setEffect({ easing, curve: easing === "custom" ? (ownEffect.curve ?? [...ZAICODE_DEFAULT_CURVE]) : ownEffect.curve })}
            onCurve={(curve) => setEffect({ curve })}
          />
        </>
      ) : (
        <span className="text-foreground-subtlest">Steady has nothing to time: pick an effect above.</span>
      )}
      <MixTabs items={rule.shapes} active={activeShape} onPick={setPickedShape} labelOf={shapeLabel} tuned={(shape) => Boolean(rule.shapeTuning[shape])} />
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-foreground-subtle">
          <input
            type="checkbox"
            checked={ownShape.color !== null}
            onChange={(event) => setShape({ color: event.target.checked ? rule.custom : null })}
          />
          Own colour
        </label>
        {ownShape.color !== null ? (
          <input type="color" value={ownShape.color} onChange={(event) => setShape({ color: event.target.value })} />
        ) : null}
      </div>
      <div className="grid max-w-[600px] gap-1.5">
        <ZaicodeLightsSlider
          label="Strength"
          value={ownShape.strength ?? rule.strength}
          min={10}
          max={100}
          step={5}
          format={(value) => `${value}%`}
          onChange={(strength) => setShape({ strength })}
          own={{ on: ownShape.strength !== null, onToggle: (on) => setShape({ strength: on ? rule.strength : null }) }}
        />
      </div>
    </Frame>
  );
}

