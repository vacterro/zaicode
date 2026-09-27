import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { ZaicodePrefCheck, ZaicodePrefSegment, ZaicodePrefStepper } from "@/zaicode/ZaicodePrefControls.js";
import { ZaicodeChangeCounter } from "@/zaicode/ZaicodeChangeCounter.js";
import {
  ZAICODE_FLOATER_LIMITS,
  ZAICODE_FLOATER_ORDERS,
  ZAICODE_FLOATER_STYLES,
  useZaicodeChangeFloaters,
  type ZaicodeFloaterSuffix,
} from "@/zaicode/zaicodeChangeFloaters.js";

/**
 * Settings -> Highlights & motion -> Change numbers (SRC-060): the RPG-style
 * "+N" heal / "-N" damage numbers over the Changes counter. Every knob, and a
 * test counter to try them on.
 */

const SUFFIXES: readonly { value: ZaicodeFloaterSuffix; label: string; hint: string }[] = [
  { value: "none", label: "+12", hint: "Only the number" },
  { value: "hp", label: "+12 HP", hint: "Hit points, like a game" },
  { value: "lines", label: "+12 lines", hint: "Say what it counts" },
];

function ColorField({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string;
  value: string;
  fallback: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-foreground-subtle">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="color"
          className="h-5 w-8 cursor-pointer border border-border bg-card p-0"
          value={value || fallback}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="border border-border px-1 text-foreground-subtlest hover:bg-hover hover:text-foreground disabled:opacity-40"
          disabled={!value}
          title="Back to the theme colour"
          onClick={() => onChange("")}
        >
          theme
        </button>
      </span>
    </label>
  );
}

export function ZaicodeChangeFloaterSettings() {
  const prefs = useZaicodeChangeFloaters();
  const [test, setTest] = useState({ added: 120, removed: 30 });
  const off = !prefs.enabled;
  return (
    <section
      className="flex flex-col gap-2 border border-border bg-card p-4 text-ui-xs"
      data-zaicode-change-floater-settings
      data-zaicode-help="changes"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-ui-lg text-foreground">Change numbers</h2>
          <p className="mt-1 max-w-[620px] text-foreground-subtle">
            When an agent adds lines, a green +N floats up from the Changes counter like healing in
            a game; removed lines fly off as a red -N like damage. A big change is a critical hit.
            Numbers that start close together stack one above the other instead of printing over
            each other.
          </p>
        </div>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 border border-border px-1.5 py-0.5 text-foreground-subtle hover:bg-hover hover:text-foreground"
          onClick={() => prefs.reset()}
        >
          <RotateCcw className="size-3" />
          Default
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 border border-border/60 px-3 py-2">
        <span className="text-foreground-subtle">Try it:</span>
        <ZaicodeChangeCounter
          added={test.added}
          removed={test.removed}
          scopeKey="settings-preview"
          demo
          className="flex items-center gap-1.5 font-mono text-ui-base tabular-nums"
        >
          <span className="text-[var(--color-diff-added)]">+{test.added}</span>
          <span className="text-[var(--color-diff-removed)]">-{test.removed}</span>
        </ZaicodeChangeCounter>
        {(
          [
            ["Heal +12", { added: 12, removed: 0 }],
            ["Damage -7", { added: 0, removed: 7 }],
            ["Both", { added: 24, removed: 9 }],
            ["Critical", { added: Math.max(prefs.critAt, 1), removed: 0 }],
          ] as const
        ).map(([label, delta]) => (
          <button
            key={label}
            type="button"
            className="border border-border px-1.5 py-px text-foreground-subtle hover:bg-hover hover:text-foreground"
            onClick={() =>
              setTest((current) => ({ added: current.added + delta.added, removed: current.removed + delta.removed }))
            }
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid max-w-[720px] grid-cols-1 gap-x-6 gap-y-1.5 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <ZaicodePrefCheck
            checked={prefs.enabled}
            onChange={(enabled) => prefs.update({ enabled })}
            label="Show change numbers"
          />
          <ZaicodePrefCheck
            checked={prefs.showHeal}
            disabled={off}
            onChange={(showHeal) => prefs.update({ showHeal })}
            label="Added lines: green +N (heal)"
          />
          <ZaicodePrefCheck
            checked={prefs.showDamage}
            disabled={off}
            onChange={(showDamage) => prefs.update({ showDamage })}
            label="Removed lines: red -N (damage)"
          />
          <ZaicodePrefSegment
            label="Style"
            value={prefs.style}
            options={ZAICODE_FLOATER_STYLES.map((style) => ({ value: style.id, label: style.label, hint: style.hint }))}
            disabled={off}
            onChange={(style) => prefs.update({ style })}
          />
          <ZaicodePrefSegment
            label="Text"
            value={prefs.suffix}
            options={SUFFIXES}
            disabled={off}
            onChange={(suffix) => prefs.update({ suffix })}
          />
          <ZaicodePrefCheck
            checked={prefs.outline}
            disabled={off}
            onChange={(outline) => prefs.update({ outline })}
            label="Dark outline around the digits"
          />
          <ZaicodePrefCheck
            checked={prefs.flashCounter}
            disabled={off}
            onChange={(flashCounter) => prefs.update({ flashCounter })}
            label="The counter flashes when it changes"
          />
          <ZaicodePrefCheck
            checked={prefs.sound}
            disabled={off}
            onChange={(sound) => prefs.update({ sound })}
            label="Sound (Sounds -> Agent: Lines added / Lines removed)"
          />
          <ZaicodePrefCheck
            checked={prefs.ignoreReducedMotion}
            disabled={off}
            onChange={(ignoreReducedMotion) => prefs.update({ ignoreReducedMotion })}
            label="Keep moving when animations are off"
            hint="The calm interface (Layout & home) and the system's 'reduce motion' stop every animation. On: these numbers still fly. Off: they follow the rest and only fade in place."
          />
          <ZaicodePrefSegment
            label="Both at once"
            value={prefs.order}
            options={ZAICODE_FLOATER_ORDERS}
            disabled={off}
            onChange={(order) => prefs.update({ order })}
          />
          <ZaicodePrefStepper
            label="Gap between - and +"
            value={prefs.sequenceGapMs}
            min={ZAICODE_FLOATER_LIMITS.sequenceGapMs[0]}
            max={ZAICODE_FLOATER_LIMITS.sequenceGapMs[1]}
            step={50}
            format={(ms) => (ms === 0 ? "none" : `${(ms / 1000).toFixed(2)} s`)}
            disabled={off || prefs.order === "together"}
            onChange={(sequenceGapMs) => prefs.update({ sequenceGapMs })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <ZaicodePrefStepper
            label="Float distance"
            value={prefs.distancePx}
            min={ZAICODE_FLOATER_LIMITS.distancePx[0]}
            max={ZAICODE_FLOATER_LIMITS.distancePx[1]}
            step={4}
            suffix="px"
            disabled={off}
            onChange={(distancePx) => prefs.update({ distancePx })}
          />
          <ZaicodePrefStepper
            label="How long it stays"
            value={prefs.durationMs}
            min={ZAICODE_FLOATER_LIMITS.durationMs[0]}
            max={ZAICODE_FLOATER_LIMITS.durationMs[1]}
            step={200}
            format={(ms) => `${(ms / 1000).toFixed(1)} s`}
            disabled={off}
            onChange={(durationMs) => prefs.update({ durationMs })}
          />
          <ZaicodePrefStepper
            label="Size"
            value={prefs.scalePct}
            min={ZAICODE_FLOATER_LIMITS.scalePct[0]}
            max={ZAICODE_FLOATER_LIMITS.scalePct[1]}
            step={10}
            suffix="%"
            disabled={off}
            onChange={(scalePct) => prefs.update({ scalePct })}
          />
          <ZaicodePrefStepper
            label="Critical hit from (lines, 0 = never)"
            value={prefs.critAt}
            min={ZAICODE_FLOATER_LIMITS.critAt[0]}
            max={ZAICODE_FLOATER_LIMITS.critAt[1]}
            step={10}
            disabled={off}
            onChange={(critAt) => prefs.update({ critAt })}
          />
          <ZaicodePrefStepper
            label="Add up changes within"
            value={prefs.mergeMs}
            min={ZAICODE_FLOATER_LIMITS.mergeMs[0]}
            max={ZAICODE_FLOATER_LIMITS.mergeMs[1]}
            step={100}
            format={(ms) => (ms === 0 ? "off" : `${(ms / 1000).toFixed(1)} s`)}
            disabled={off}
            onChange={(mergeMs) => prefs.update({ mergeMs })}
          />
          <ZaicodePrefStepper
            label="Most numbers at once"
            value={prefs.maxFloaters}
            min={ZAICODE_FLOATER_LIMITS.maxFloaters[0]}
            max={ZAICODE_FLOATER_LIMITS.maxFloaters[1]}
            disabled={off}
            onChange={(maxFloaters) => prefs.update({ maxFloaters })}
          />
          <ColorField
            label="Heal colour"
            value={prefs.healColor}
            fallback="#4caf50"
            onChange={(healColor) => prefs.update({ healColor })}
          />
          <ColorField
            label="Damage colour"
            value={prefs.damageColor}
            fallback="#e05555"
            onChange={(damageColor) => prefs.update({ damageColor })}
          />
        </div>
      </div>
    </section>
  );
}
