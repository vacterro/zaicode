import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { ZaicodePrefCheck, ZaicodePrefSegment } from "../ZaicodePrefControls.js";
import { SAIPEGGLE_LIMITS as L, SPG_POWERS, SPG_POWER_INFO, type SaipeggleSettings } from "./saipeggleModel.js";
import { useSaipeggle } from "./saipeggleStore.js";

/** SAIPEGGLE -> Settings: the rules of a level, the look and the feel. Every change starts the level again. */

function Slider({
  label,
  value,
  range,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  range: readonly [number, number];
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid grid-cols-[minmax(0,1fr)_minmax(90px,180px)_64px] items-center gap-2">
      <span className="text-foreground-subtle">{label}</span>
      <input type="range" min={range[0]} max={range[1]} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <span className="text-right tabular-nums text-foreground">{format(value)}</span>
    </label>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border border-border/60 p-2">
      <h3 className="text-ui-sm text-foreground">{title}</h3>
      {children}
    </section>
  );
}

const pct = (value: number) => `${Math.round(value * 100)}%`;
const times = (value: number) => `${value.toFixed(2)}×`;

export function ZaicodeSaipeggleSettings() {
  const settings = useSaipeggle((state) => state.settings);
  const set = useSaipeggle((state) => state.setSettings);
  const reset = useSaipeggle((state) => state.resetSettings);
  const resetProgress = useSaipeggle((state) => state.resetProgress);
  const [confirmReset, setConfirmReset] = useState(false);
  const patch = <K extends keyof SaipeggleSettings>(key: K) => (value: SaipeggleSettings[K]) => set({ [key]: value } as Partial<SaipeggleSettings>);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3 text-ui-xs" data-zaicode-saipeggle-settings>
      <div className="flex items-center justify-between">
        <span className="text-foreground-subtle">Every change starts the current level again.</span>
        <button type="button" className="flex items-center gap-1 border border-border px-1.5 py-0.5 text-foreground-subtle hover:bg-hover" onClick={reset}>
          <RotateCcw className="size-3" /> Defaults
        </button>
      </div>
      <Group title="Master and power">
        <ZaicodePrefSegment
          label="Green pegs give"
          value={settings.power}
          options={[
            { value: "stage", label: "The stage's master", hint: "Each adventure stage has its own master, as in the genre" },
            ...SPG_POWERS.map((power) => ({ value: power, label: SPG_POWER_INFO[power].name, hint: SPG_POWER_INFO[power].text })),
          ]}
          onChange={patch("power")}
        />
        <ZaicodePrefCheck checked={settings.aimGuide} onChange={patch("aimGuide")} label="Aim guide (the path up to the first peg)" />
      </Group>
      <Group title="Level rules">
        <Slider label="Balls per level" value={settings.balls} range={L.balls} step={1} format={String} onChange={patch("balls")} />
        <Slider label="Orange pegs" value={settings.orange} range={L.orange} step={1} format={String} onChange={patch("orange")} />
        <Slider label="Green pegs" value={settings.green} range={L.green} step={1} format={String} onChange={patch("green")} />
        <ZaicodePrefCheck checked={settings.purple} onChange={patch("purple")} label="A purple peg (500) that moves every turn" />
        <Slider label="Peg density (random and adventure boards)" value={settings.density} range={L.density} step={0.05} format={pct} onChange={patch("density")} />
      </Group>
      <Group title="Physics">
        <Slider label="Gravity" value={settings.gravity} range={L.gravity} step={0.05} format={times} onChange={patch("gravity")} />
        <Slider label="Bounce" value={settings.bounce} range={L.bounce} step={0.01} format={pct} onChange={patch("bounce")} />
        <Slider label="Bucket speed" value={settings.bucketSpeed} range={L.bucketSpeed} step={0.05} format={times} onChange={patch("bucketSpeed")} />
      </Group>
      <Group title="Fever and effects">
        <ZaicodePrefCheck checked={settings.fever} onChange={patch("fever")} label="Extreme Fever buckets (10K / 50K / 100K) after the last orange peg" />
        <ZaicodePrefCheck checked={settings.slowMo} onChange={patch("slowMo")} label="Slow motion on the last orange peg" />
        <ZaicodePrefCheck checked={settings.feverMusic} onChange={patch("feverMusic")} label="Fever tune (Ode to Joy, 8-bit)" />
        <ZaicodePrefCheck checked={settings.particles} onChange={patch("particles")} label="Pixel sparks when pegs pop" />
        <ZaicodePrefCheck checked={settings.shake} onChange={patch("shake")} label="Screen shake (fever, Space Blast)" />
      </Group>
      <Group title="Look">
        <ZaicodePrefSegment
          label="Colours"
          value={settings.colors}
          options={[
            { value: "palette", label: "My ZAICODE palette", hint: "Board, panels and pegs from the palette in use" },
            { value: "classic", label: "Classic pegs", hint: "The palette's board with the genre's blue / orange / green / purple" },
          ]}
          onChange={patch("colors")}
        />
        <Slider label="Pixel size (0 = as big as fits)" value={settings.scale} range={L.scale} step={1} format={(value) => (value === 0 ? "auto" : `${value}×`)} onChange={patch("scale")} />
      </Group>
      <Group title="Progress">
        <p className="text-foreground-subtle">Sounds: Settings → Sounds → SAIPEGGLE (every cue has its own row).</p>
        <button
          type="button"
          className="self-start border border-border px-1.5 py-0.5 text-foreground-subtle hover:bg-hover"
          onClick={() => {
            if (!confirmReset) {
              setConfirmReset(true);
              setTimeout(() => setConfirmReset(false), 4000);
              return;
            }
            resetProgress();
            setConfirmReset(false);
          }}
        >
          {confirmReset ? "Click again: every level locks and every best score goes" : "Reset adventure progress…"}
        </button>
      </Group>
    </div>
  );
}
