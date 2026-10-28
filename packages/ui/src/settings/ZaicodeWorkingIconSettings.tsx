import { useRef, type ReactNode } from "react";
import { RotateCcw, Upload } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { ZaicodeWorkingIcon } from "@/zaicode/ZaicodeWorkingIcon.js";
import { ZaicodePrefCheck, ZaicodePrefCombo, ZaicodePrefSegment } from "@/zaicode/ZaicodePrefControls.js";
import { isZaicodeComboClick, nextZaicodeCombo } from "@/zaicode/zaicodeCombo.js";
import { parseZaicodeModelIdentity, resolveZaicodeModelWorking, setZaicodeGlobalAppearance, setZaicodeModelAppearance, useZaicodeModelAppearancePrefs } from "@/zaicode/zaicodeModelAppearance.js";
import { ZAICODE_IMAGE_COMBO, ZAICODE_WORKING_CUSTOM_IMAGE_MAX, ZAICODE_WORKING_IMAGES, ZAICODE_WORKING_MOTIONS, useZaicodeLights, zaicodeWorkingMotionsReach, type ZaicodeWorkingIconPrefs } from "@/zaicode/zaicodeHighlights.js";
import { readZaicodeWorkingMedia, ZAICODE_WORKING_MEDIA_ACCEPT, ZAICODE_WORKING_MEDIA_MAX_DIMENSION } from "@/zaicode/zaicodeWorkingMedia.js";
import { ZaicodeLayerTuningPanel, ZaicodeMotionMixTuning } from "./ZaicodeLightsTuning.js";
import { ZaicodeEasingPicker, ZaicodeLightsSlider as Slider } from "./ZaicodeCurveEditor.js";

export function Block({ title, hint, children, actions }: { title: string; hint: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border border-border bg-card p-3 text-ui-xs">
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

export function ResetButton({ onClick }: { onClick: () => void }) {
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

export function WorkingIconBlock({ model = null, tabs }: { model?: string | null; tabs?: ReactNode }) {
  const global = useZaicodeLights((state) => state.working);
  const prefs = useZaicodeModelAppearancePrefs();
  const working = resolveZaicodeModelWorking(prefs, model, global);
  const setWorking = useZaicodeLights((state) => state.setWorking);
  const resetWorking = useZaicodeLights((state) => state.resetWorking);
  const fileInput = useRef<HTMLInputElement>(null);
  const identity = parseZaicodeModelIdentity(model);
  const set = (patch: Partial<ZaicodeWorkingIconPrefs>) => {
    if (identity) setZaicodeModelAppearance(identity, { mode: "separate", working: { ...working, ...patch }, workerIcon: "" });
    else { setWorking({ ...working, ...patch }); setZaicodeGlobalAppearance({ workerIcon: "" }); }
  };
  const reaches = zaicodeWorkingMotionsReach(working.motions);
  return (
    <Block
      title="Working icon"
      hint="Choose Default or a model below, then edit its picture, motion and colour. Shift+click mixes pictures and motions."
      actions={<ResetButton onClick={() => {
        if (identity) {
          setZaicodeModelAppearance(identity, { working: undefined, workerIcon: "" });
        } else { resetWorking(); setZaicodeGlobalAppearance({ workerIcon: "" }); }
      }} />}
    >
      {tabs}
      <div role="tabpanel" id="zaicode-model-appearance-editor" aria-label={model ?? "Default appearance"} className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 border border-border bg-background p-3" data-zaicode-working-preview>
        <span className="flex size-10 items-center justify-center">
          <ZaicodeWorkingIcon prefs={working} className="size-8" />
        </span>
        <span className="flex items-center gap-2 text-ui-base text-foreground">
          <ZaicodeWorkingIcon prefs={working} />
          PHASE BUILD T-49
        </span>
        <span className="text-foreground-subtlest">Live preview: the same settings every working mark uses.</span>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-foreground-subtle">
          Picture
          <span className="text-foreground-subtlest">
            {working.images.length > 1 ? ` · ${working.images.length} stacked` : ""} · Shift+click stacks up to {ZAICODE_IMAGE_COMBO.max}
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
                  on ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground" : "border-border text-foreground-subtle hover:bg-hover",
                  disabled && "opacity-40",
                )}
                onClick={(event) =>
                  set({
                    images: nextZaicodeCombo(working.images, image.id, isZaicodeComboClick(event), ZAICODE_IMAGE_COMBO),
                  })
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
            accept={ZAICODE_WORKING_MEDIA_ACCEPT}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              void readZaicodeWorkingMedia(file)
                .then((customImage) => set({ customImage, images: ["custom"] }))
                .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error)));
            }}
          />
          <span className="text-ui-xs text-foreground-subtlest">
            Images or browser video · up to {ZAICODE_WORKING_CUSTOM_IMAGE_MAX / 1024 / 1024} MiB · {ZAICODE_WORKING_MEDIA_MAX_DIMENSION}×{ZAICODE_WORKING_MEDIA_MAX_DIMENSION}
          </span>
        </div>
      </div>
      <ZaicodePrefCombo
        label="Motion"
        values={working.motions}
        neutral="none"
        onChange={(motions) => set({ motions })}
        options={ZAICODE_WORKING_MOTIONS.map((motion) => ({
          value: motion.id,
          label: motion.label,
          hint: motion.hint,
        }))}
      />
      <div className="grid max-w-[560px] gap-1.5">
        <Slider label="Speed" value={working.seconds} min={0.2} max={20} step={0.1} format={(value) => `${value.toFixed(1)} s`} onChange={(seconds) => set({ seconds })} />
        {reaches ? <Slider label="Reach" value={working.amplitude} min={5} max={100} format={(value) => `${value}%`} onChange={(amplitude) => set({ amplitude })} /> : null}
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
        {working.color === "custom" ? <input type="color" value={working.custom} onChange={(event) => set({ custom: event.target.value })} /> : null}
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
      </div>
    </Block>
  );
}
