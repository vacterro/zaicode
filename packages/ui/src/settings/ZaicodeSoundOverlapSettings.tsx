import { Switch } from "@/components/ui/switch.js";
import { ZaicodePrefSegment } from "@/zaicode/ZaicodePrefControls.js";
import { setZaicodeSoundSettings, useZaicodeSoundSettings } from "@/zaicode/zaicodeSoundEvents.js";
import {
  ZAICODE_SOUND_LIMIT_MAX,
  ZAICODE_SOUND_LIMIT_MIN,
  type ZaicodeSoundOverlap,
} from "@/zaicode/zaicodeSoundPolicy.js";

const OVERLAPS: readonly { value: ZaicodeSoundOverlap; label: string; hint: string }[] = [
  { value: "mix", label: "Mix", hint: "Sounds play over each other, up to the limit; above it the oldest one fades." },
  { value: "queue", label: "Queue", hint: "One after another. Each repeated input waits, up to the limit." },
  { value: "cut", label: "Cut", hint: "A new sound fades the ones still ringing: never two at once." },
];

const EXPLAIN: Record<ZaicodeSoundOverlap, (limit: number) => string> = {
  mix: (limit) => `Sounds play over each other, at most ${limit} at once; above that the oldest one fades out.`,
  queue: (limit) =>
    `Sounds play one after another. Each repeated input waits; at most ${limit} wait, and further inputs are skipped.`,
  cut: () => "A new sound fades out whatever is still ringing, so there is never more than one: no cacophony.",
};

/**
 * How ZAICODE's sounds meet (operator request): mix up to N at once, queue
 * with up to N waiting, or cut. Rendered as rows of the Sounds grid
 * (label | control | value).
 */
export function ZaicodeSoundOverlapSettings() {
  const settings = useZaicodeSoundSettings();
  const { overlap, overlapLimit } = settings;
  return (
    <>
      <span className="text-foreground-subtle">When sounds meet</span>
      <div data-zaicode-sound-overlap={overlap}>
        <ZaicodePrefSegment
          label=""
          value={overlap}
          options={OVERLAPS}
          onChange={(next) => setZaicodeSoundSettings({ overlap: next, ...(next === "mix" ? { interfaceOneAtATime: false } : {}) })}
        />
      </div>
      <span />
      {overlap === "cut" ? null : (
        <>
          <span className="text-foreground-subtle">{overlap === "mix" ? "At most at once" : "At most waiting"}</span>
          <input
            type="range"
            min={ZAICODE_SOUND_LIMIT_MIN}
            max={ZAICODE_SOUND_LIMIT_MAX}
            value={overlapLimit}
            aria-label={overlap === "mix" ? "Sounds at once" : "Sounds waiting"}
            onChange={(event) => setZaicodeSoundSettings({ overlapLimit: Number(event.target.value) })}
          />
          <span className="w-10 text-right tabular-nums text-foreground">{overlapLimit}</span>
        </>
      )}
      {overlap === "mix" ? (
        <>
          <span
            className="text-foreground-subtle"
            title="Buttons, menus, the sidebar, sessions and window sounds cut each other: a new one fades the one still ringing, so fast clicking through projects never piles sounds up. Agent, engine and mail sounds always mix."
          >
            Interface sounds one at a time
          </span>
          <Switch
            checked={settings.interfaceOneAtATime}
            onCheckedChange={(interfaceOneAtATime) => setZaicodeSoundSettings({ interfaceOneAtATime })}
          />
          <span />
        </>
      ) : null}
      <span className="col-span-3 text-foreground-subtlest">
        {EXPLAIN[overlap](overlapLimit)} Previews, SAIPEGGLE, Problip and Ambience keep their own rules.
      </span>
    </>
  );
}
