import { useState } from "react";
import { ZaicodeChangeFloaterSettings } from "@/settings/ZaicodeChangeFloaterSettings.js";
import { ZaicodeModelAppearanceSettings } from "@/zaicode/ZaicodeModelAppearanceSettings.js";
import { useZaicodeSessionBriefs } from "@/zaicode/zaicodeContinue.js";
import { useMemo } from "react";
import { useZaicodePoolGroups } from "@/zaicode/ZaicodePoolPicker.js";
import { parseZaicodeModelIdentity, resolveZaicodeModelHighlight, setZaicodeGlobalAppearance, setZaicodeModelAppearance, useZaicodeModelAppearancePrefs, zaicodeModelIdentityKey } from "@/zaicode/zaicodeModelAppearance.js";
import { ZaicodeChatFloaterSettings } from "@/settings/ZaicodeChatFloaterSettings.js";
import { cn } from "@/components/lib/utils.js";
import { Switch } from "@/components/ui/switch.js";
import { ZaicodePrefCheck, ZaicodePrefCombo, ZaicodePrefSegment } from "@/zaicode/ZaicodePrefControls.js";
import { ZaicodeLightsPresetsBlock } from "./ZaicodeLightsPresets.js";
import { ZaicodeHighlightMixTuning } from "./ZaicodeLightsTuning.js";
import { ZaicodeLightsSlider as Slider } from "./ZaicodeCurveEditor.js";
import {
  ZAICODE_HIGHLIGHT_COLORS,
  ZAICODE_HIGHLIGHT_EFFECTS,
  ZAICODE_HIGHLIGHT_SHAPES,
  ZAICODE_HIGHLIGHT_TARGETS,
  useZaicodeLights,
  withZaicodeHighlight,
  zaicodeHighlightAttrs,
  type ZaicodeHighlightRule,
} from "@/zaicode/zaicodeHighlights.js";
import { Block, ResetButton, WorkingIconBlock } from "./ZaicodeWorkingIconSettings.js";

/**
 * Settings -> ZAICODE -> Highlights & motion (SRC-038): the Working icon and
 * every highlight, each with a live preview. Full control, nothing hidden.
 * Pictures, motions, effects and shapes mix with Shift+Click (SRC-043).
 */

function HighlightRow({ target, model }: { target: (typeof ZAICODE_HIGHLIGHT_TARGETS)[number]; model: string | null }) {
  const global = useZaicodeLights((state) => state.highlights[target.id]);
  const prefs = useZaicodeModelAppearancePrefs();
  const rule = resolveZaicodeModelHighlight(prefs, model, target.id, global);
  const setHighlight = useZaicodeLights((state) => state.setHighlight);
  const resetHighlight = useZaicodeLights((state) => state.resetHighlight);
  const identity = parseZaicodeModelIdentity(model);
  const entry = identity ? prefs.models[zaicodeModelIdentityKey(identity)] : undefined;
  const clearGlobal = () => {
    const highlight = { ...prefs.global.highlight };
    delete highlight[target.id];
    setZaicodeGlobalAppearance({ highlight });
  };
  const set = (patch: Partial<ZaicodeHighlightRule>) => {
    if (identity) setZaicodeModelAppearance(identity, { mode: "separate", highlight: { ...entry?.highlight, [target.id]: { ...entry?.highlight?.[target.id], ...patch } } });
    else { setHighlight(target.id, { ...rule, ...patch }); clearGlobal(); }
  };
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
            {...withZaicodeHighlight(
              {
                className: "border border-border bg-background px-2 py-0.5 text-ui-base text-foreground",
              },
              preview,
            )}
            title="Preview"
          >
            PHASE BUILD T-49
          </span>
          <ResetButton onClick={() => {
            if (identity) {
              const highlight = { ...entry?.highlight };
              delete highlight[target.id];
              setZaicodeModelAppearance(identity, { highlight });
            } else { resetHighlight(target.id); clearGlobal(); }
          }} />
        </div>
      </div>
      <div className={cn("flex flex-col gap-2", !rule.enabled && "opacity-50")}>
        <ZaicodePrefCombo
          label="Effect"
          values={rule.effects}
          neutral="steady"
          onChange={(effects) => set({ effects })}
          options={ZAICODE_HIGHLIGHT_EFFECTS.map((effect) => ({
            value: effect.id,
            label: effect.label,
            hint: effect.hint,
          }))}
        />
        <ZaicodePrefCombo
          label="Shape"
          values={rule.shapes}
          onChange={(shapes) => set({ shapes })}
          options={ZAICODE_HIGHLIGHT_SHAPES.map((shape) => ({
            value: shape.id,
            label: shape.label,
            hint: shape.hint,
          }))}
        />
        <div className="flex flex-wrap items-end gap-3">
          <ZaicodePrefSegment
            label="Colour"
            value={rule.color}
            onChange={(color) => set({ color })}
            options={ZAICODE_HIGHLIGHT_COLORS.map((color) => ({
              value: color.id,
              label: color.label,
              hint: color.hint,
            }))}
          />
          {rule.color === "custom" ? <input type="color" value={rule.custom} onChange={(event) => set({ custom: event.target.value })} /> : null}
        </div>
        <div className="grid max-w-[560px] gap-1.5">
          <Slider label="Strength" value={rule.strength} min={10} max={100} step={5} format={(value) => `${value}%`} onChange={(strength) => set({ strength })} />
          {rule.effects.some((effect) => effect !== "steady") || rule.color === "rainbow" ? (
            <Slider label="Speed" value={rule.seconds} min={0.1} max={10} step={0.1} format={(value) => `${value.toFixed(1)} s`} onChange={(seconds) => set({ seconds })} />
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
  const [model, setModel] = useState<string | null>(null);
  const { groups } = useZaicodePoolGroups();
  // The models that actually did work, not the ones a picker is highlighting:
  // that is the same distinction the appearance resolver makes, taken from
  // the same source, so the settings list and the runtime cannot disagree.
  const sessions = useZaicodeSessionBriefs((state) => state.sessions);
  const seenModels = useMemo(
    () => [...new Set([...groups.flatMap((group) => group.options.map((option) => `${option.providerId}/${option.modelId}`)), ...sessions.map((session) => session.model).filter((model): model is string => Boolean(model))])],
    [sessions, groups],
  );
  return (
    <div className="flex flex-col gap-4" data-zaicode-lights-settings>
      <WorkingIconBlock model={model} tabs={<ZaicodeModelAppearanceSettings seenModels={seenModels} model={model} onModel={setModel} />} />
      <ZaicodeLightsPresetsBlock />
      <Block
        title={`Highlights · ${parseZaicodeModelIdentity(model)?.modelId ?? "Default"}`}
        hint="How things that need your eye light up: a working session, one that waits for you, the open one, busy projects, the title bar, a limit meter with a prompt ready. Effect, shape, colour, strength and speed for each; Shift+click mixes several effects or shapes into one."
      >
        <div className="flex flex-col gap-2">
          {ZAICODE_HIGHLIGHT_TARGETS.map((target) => (
            <HighlightRow key={target.id} target={target} model={model} />
          ))}
        </div>
      </Block>
      <ZaicodeChangeFloaterSettings />
      <ZaicodeChatFloaterSettings />
    </div>
  );
}
