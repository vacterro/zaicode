import { useRef, type ReactNode } from "react";
import { RotateCcw, Upload } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { ZaicodeWorkingIcon } from "@/zaicode/ZaicodeWorkingIcon.js";
import { ZaicodePrefCheck, ZaicodePrefCombo, ZaicodePrefSegment } from "@/zaicode/ZaicodePrefControls.js";
import { isZaicodeComboClick, nextZaicodeCombo } from "@/zaicode/zaicodeCombo.js";
import { ZaicodeLightsPresetsBlock } from "./ZaicodeLightsPresets.js";
import { ZaicodeHighlightMixTuning, ZaicodeLayerTuningPanel, ZaicodeMotionMixTuning } from "./ZaicodeLightsTuning.js";
import { ZaicodeEasingPicker, ZaicodeLightsSlider as Slider } from "./ZaicodeCurveEditor.js";
import {
  ZAICODE_HIGHLIGHT_COLORS,
  ZAICODE_HIGHLIGHT_EFFECTS,
  ZAICODE_HIGHLIGHT_SHAPES,
  ZAICODE_HIGHLIGHT_TARGETS,
  ZAICODE_IMAGE_COMBO,
  ZAICODE_WORKING_CUSTOM_IMAGE_MAX,
  ZAICODE_WORKING_IMAGES,
  ZAICODE_WORKING_MOTIONS,
  useZaicodeLights,
  withZaicodeHighlight,
  zaicodeHighlightAttrs,
  zaicodeWorkingMotionsReach,
  type ZaicodeHighlightRule,
  type ZaicodeHighlightTarget,
  type ZaicodeWorkingIconPrefs,
} from "@/zaicode/zaicodeHighlights.js";

/**
 * Settings -> ZAICODE -> Highlights & motion (SRC-038): the Working icon and
 * every highlight, each with a live preview. Full control, nothing hidden.
 * Pictures, motions, effects and shapes mix with Shift+Click (SRC-043).
 */

function Block({ title, hint, children, actions }: { title: string; hint: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border border-border bg-card p-4 text-ui-xs">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-ui-lg text-foreground">{title}</h2>
          <p className="mt-1 max-w-[620px] text-foreground-subtle">{hint}</p>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function ResetButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="flex shrink-0 items-center gap-1 border border-border px-1.5 py-0.5 text-foreground-subtle hover:bg-hover hover:text-foreground"
      onClick={onClick}
    >
      <RotateCcw className="size-3" />
      Default
    </button>
  );
}

function WorkingIconBlock() {
  const working = useZaicodeLights((state) => state.working);
  const setWorking = useZaicodeLights((state) => state.setWorking);
  const resetWorking = useZaicodeLights((state) => state.resetWorking);
  const fileInput = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<ZaicodeWorkingIconPrefs>) => setWorking(patch);
  const reaches = zaicodeWorkingMotionsReach(working.motions);
  return (
    <Block
      title="Working icon"
      hint="The mark that turns next to every session and project while an agent works, and in the chat while it thinks. Play with it: what it is, how it moves, how fast, which way. Shift+click stacks pictures and mixes motions."
      actions={<ResetButton onClick={resetWorking} />}
    >
      <div className="flex flex-wrap items-center gap-6 border border-border bg-background p-3" data-zaicode-working-preview>
        <span className="flex size-16 items-center justify-center">
          <ZaicodeWorkingIcon className="size-12" />
        </span>
        <span className="flex items-center gap-2 text-ui-base text-foreground">
          <ZaicodeWorkingIcon />
          PHASE BUILD T-49
        </span>
        <span className="text-foreground-subtlest">Live preview: the same settings every working mark uses.</span>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-foreground-subtle">
          Picture
          <span className="text-foreground-subtlest">
            {working.images.length > 1 ? ` · ${working.images.length} stacked` : ""} · Shift+click stacks up to{" "}
            {ZAICODE_IMAGE_COMBO.max}
          </span>
        </span>
        <div className="flex flex-wrap gap-1" role="group">
          {ZAICODE_WORKING_IMAGES.map((image) => {
            const disabled = image.id === "custom" && !working.customImage;
            const on = working.images.includes(image.id);
            return (
              <button
                key={image.id}
                type="button"
                role="checkbox"
                aria-checked={on}
                title={disabled ? "Load your own picture first" : `${image.label}\nShift+click: stack on top / take off`}
                disabled={disabled}
                className={cn(
                  "flex items-center gap-1 border px-1.5 py-1",
                  on
                    ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
                    : "border-border text-foreground-subtle hover:bg-hover",
                  disabled && "opacity-40",
                )}
                onClick={(event) =>
                  set({ images: nextZaicodeCombo(working.images, image.id, isZaicodeComboClick(event), ZAICODE_IMAGE_COMBO) })
                }
              >
                <ZaicodeWorkingIcon prefs={{ ...working, images: [image.id], motions: ["none"] }} className="size-4" />
                {image.label}
              </button>
            );
          })}
          <button
            type="button"
            className="flex items-center gap-1 border border-border px-1.5 py-1 text-foreground-subtle hover:bg-hover"
            onClick={() => fileInput.current?.click()}
          >
            <Upload className="size-3" />
            Load own picture…
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/gif,image/webp,image/svg+xml,image/jpeg"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              if (file.size > ZAICODE_WORKING_CUSTOM_IMAGE_MAX) {
                toast(`Pictures up to ${ZAICODE_WORKING_CUSTOM_IMAGE_MAX / 1024} KB, please.`);
                return;
              }
              const reader = new FileReader();
              reader.onload = () => {
                if (typeof reader.result === "string") set({ customImage: reader.result, images: ["custom"] });
              };
              reader.readAsDataURL(file);
            }}
          />
        </div>
      </div>
      <ZaicodePrefCombo
        label="Motion"
        values={working.motions}
        neutral="none"
        onChange={(motions) => set({ motions })}
        options={ZAICODE_WORKING_MOTIONS.map((motion) => ({ value: motion.id, label: motion.label, hint: motion.hint }))}
      />
      <div className="grid max-w-[560px] gap-1.5">
        <Slider
          label="Speed"
          value={working.seconds}
          min={0.2}
          max={20}
          step={0.1}
          format={(value) => `${value.toFixed(1)} s`}
          onChange={(seconds) => set({ seconds })}
        />
        {reaches ? (
          <Slider label="Reach" value={working.amplitude} min={5} max={100} format={(value) => `${value}%`} onChange={(amplitude) => set({ amplitude })} />
        ) : null}
        <Slider label="Size" value={working.size} min={60} max={200} step={5} format={(value) => `${value}%`} onChange={(size) => set({ size })} />
        <Slider label="Opacity" value={working.opacity} min={20} max={100} step={5} format={(value) => `${value}%`} onChange={(opacity) => set({ opacity })} />
      </div>
      <div className="flex flex-wrap gap-4">
        <ZaicodePrefSegment
          label="Direction"
          value={working.direction}
          onChange={(direction) => set({ direction })}
          options={[
            { value: "cw", label: "↻ Clockwise" },
            { value: "ccw", label: "↺ Counter-clockwise" },
            { value: "alternate", label: "⇄ Back and forth" },
          ]}
        />
        <ZaicodeEasingPicker
          label="Movement"
          value={working.easing}
          curve={working.curve}
          onChange={(easing) => set({ easing: easing ?? "linear" })}
          onCurve={(curve) => set({ curve })}
        />
        {working.easing === "steps" ? (
          <label className="flex flex-col gap-0.5">
            <span className="text-foreground-subtle">Ticks per turn</span>
            <input
              type="number"
              min={2}
              max={24}
              value={working.steps}
              className="w-16 border border-border bg-background px-1 text-foreground"
              onChange={(event) => set({ steps: Number(event.target.value) })}
            />
          </label>
        ) : null}
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <ZaicodePrefSegment
          label="Colour (drawn icons)"
          value={working.color}
          onChange={(color) => set({ color })}
          options={[
            { value: "text", label: "Text" },
            { value: "accent", label: "Theme" },
            { value: "custom", label: "Own" },
          ]}
        />
        {working.color === "custom" ? (
          <input type="color" value={working.custom} onChange={(event) => set({ custom: event.target.value })} />
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <ZaicodePrefCheck checked={working.glow} onChange={(glow) => set({ glow })} label="Glow around it" />
        <ZaicodePrefCheck
          checked={working.keepMoving}
          onChange={(keepMoving) => set({ keepMoving })}
          label="Keep moving in the calm interface"
          hint="Ignores “No animations” and the Windows reduced-motion setting for this icon only, so you always see that work is running"
        />
      </div>
      {working.motions.filter((motion) => motion !== "none").length > 1 ? (
        <ZaicodeMotionMixTuning
          working={working}
          onTuning={(motion, tuning) => {
            const next = { ...working.tuning };
            if (tuning) next[motion] = tuning;
            else delete next[motion];
            set({ tuning: next });
          }}
        />
      ) : null}
      <ZaicodeLayerTuningPanel
        working={working}
        onLayer={(image, layer) => {
          const next = { ...working.layers };
          if (layer) next[image] = layer;
          else delete next[image];
          set({ layers: next });
        }}
      />
    </Block>
  );
}

function HighlightRow({ target }: { target: (typeof ZAICODE_HIGHLIGHT_TARGETS)[number] }) {
  const rule = useZaicodeLights((state) => state.highlights[target.id]);
  const setHighlight = useZaicodeLights((state) => state.setHighlight);
  const resetHighlight = useZaicodeLights((state) => state.resetHighlight);
  const set = (patch: Partial<ZaicodeHighlightRule>) => setHighlight(target.id as ZaicodeHighlightTarget, patch);
  const preview = zaicodeHighlightAttrs(target.id, { ...rule, enabled: true });
  // A mix opens its fine controls by itself: that is where the parts get their own settings.
  const mixed = rule.effects.filter((effect) => effect !== "steady").length > 1 || rule.shapes.length > 1;
  return (
    <div className="flex flex-col gap-2 border border-border p-3" data-zaicode-highlight-row={target.id}>
      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-foreground">
          <Switch checked={rule.enabled} onCheckedChange={(enabled) => set({ enabled })} />
          <span>
            {target.label}
            <span className="block text-foreground-subtlest">{target.hint}</span>
          </span>
        </label>
        <div className="flex items-center gap-2">
          <span
            {...withZaicodeHighlight({ className: "border border-border bg-background px-2 py-0.5 text-ui-base text-foreground" }, preview)}
            title="Preview"
          >
            PHASE BUILD T-49
          </span>
          <ResetButton onClick={() => resetHighlight(target.id)} />
        </div>
      </div>
      <div className={cn("flex flex-col gap-2", !rule.enabled && "opacity-50")}>
        <ZaicodePrefCombo
          label="Effect"
          values={rule.effects}
          neutral="steady"
          onChange={(effects) => set({ effects })}
          options={ZAICODE_HIGHLIGHT_EFFECTS.map((effect) => ({ value: effect.id, label: effect.label, hint: effect.hint }))}
        />
        <ZaicodePrefCombo
          label="Shape"
          values={rule.shapes}
          onChange={(shapes) => set({ shapes })}
          options={ZAICODE_HIGHLIGHT_SHAPES.map((shape) => ({ value: shape.id, label: shape.label, hint: shape.hint }))}
        />
        <div className="flex flex-wrap items-end gap-3">
          <ZaicodePrefSegment
            label="Colour"
            value={rule.color}
            onChange={(color) => set({ color })}
            options={ZAICODE_HIGHLIGHT_COLORS.map((color) => ({ value: color.id, label: color.label, hint: color.hint }))}
          />
          {rule.color === "custom" ? (
            <input type="color" value={rule.custom} onChange={(event) => set({ custom: event.target.value })} />
          ) : null}
        </div>
        <div className="grid max-w-[560px] gap-1.5">
          <Slider label="Strength" value={rule.strength} min={10} max={100} step={5} format={(value) => `${value}%`} onChange={(strength) => set({ strength })} />
          {rule.effects.some((effect) => effect !== "steady") || rule.color === "rainbow" ? (
            <Slider
              label="Speed"
              value={rule.seconds}
              min={0.1}
              max={10}
              step={0.1}
              format={(value) => `${value.toFixed(1)} s`}
              onChange={(seconds) => set({ seconds })}
            />
          ) : null}
        </div>
        <ZaicodePrefCheck
          checked={rule.keepMoving}
          onChange={(keepMoving) => set({ keepMoving })}
          label="Keep moving in the calm interface"
          hint="This highlight still pulses while “No animations” is on"
        />
        <details open={mixed} className="text-foreground-subtle">
          <summary className="cursor-pointer select-none">Fine controls: every effect and shape on its own</summary>
          <div className="mt-2">
            <ZaicodeHighlightMixTuning
              rule={rule}
              onEffect={(effect, tuning) => {
                const next = { ...rule.tuning };
                if (tuning) next[effect] = tuning;
                else delete next[effect];
                set({ tuning: next });
              }}
              onShape={(shape, tuning) => {
                const next = { ...rule.shapeTuning };
                if (tuning) next[shape] = tuning;
                else delete next[shape];
                set({ shapeTuning: next });
              }}
            />
          </div>
        </details>
      </div>
    </div>
  );
}

export function ZaicodeLightsSettings() {
  return (
    <div className="flex flex-col gap-4" data-zaicode-lights-settings>
      <ZaicodeLightsPresetsBlock />
      <WorkingIconBlock />
      <Block
        title="Highlights"
        hint="How things that need your eye light up: a working session, one that waits for you, the open one, busy projects, the title bar, a limit meter with a prompt ready. Effect, shape, colour, strength and speed for each; Shift+click mixes several effects or shapes into one."
      >
        <div className="flex flex-col gap-2">
          {ZAICODE_HIGHLIGHT_TARGETS.map((target) => (
            <HighlightRow key={target.id} target={target} />
          ))}
        </div>
      </Block>
    </div>
  );
}
