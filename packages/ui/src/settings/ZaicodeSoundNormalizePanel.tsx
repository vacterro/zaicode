import { useState } from "react";
import { Play, RotateCcw, Wand2 } from "lucide-react";
import { toast } from "@/components/ui/toast.js";
import { ZaicodePrefSegment, ZaicodePrefStepper } from "@/zaicode/ZaicodePrefControls.js";
import {
  readZaicodeSoundSettings,
  setZaicodeSoundSettings,
  zaicodeEffectiveGainDb,
  zaicodeSoundEventDef,
} from "@/zaicode/zaicodeSoundSettingsModel.js";
import { resolveSoundUrl } from "@/zaicode/zaicodeSoundEvents.js";
import {
  ZAICODE_NORMALIZE_ATTENUATION_CAP_DEFAULT,
  ZAICODE_NORMALIZE_ATTENUATION_CAP_MAX,
  ZAICODE_NORMALIZE_ATTENUATION_CAP_MIN,
  ZAICODE_NORMALIZE_PROFILES,
  ZAICODE_NORMALIZE_PROFILE_IDS,
  normalizeZaicodeAttenuationCap,
  planZaicodeNormalization,
  type ZaicodeNormalizePlan,
  type ZaicodeNormalizeProfileId,
} from "@/zaicode/zaicodeSoundAnalysis.js";
import {
  applyZaicodeNormalization,
  collectZaicodeNormalizeTargets,
  readZaicodeAnalysisCache,
  runZaicodeNormalizePass,
  undoZaicodeNormalization,
  writeZaicodeAnalysisCache,
} from "@/zaicode/zaicodeSoundNormalize.js";

/**
 * Settings -> Sounds -> "Normalize configured sounds" (Wave 3, part A).
 *
 * One button, and it never lies: the table it shows IS the plan that Apply
 * writes, computed from measurements the operator can see. Nothing is applied
 * until they press Apply, and Undo takes the compensation away again without
 * touching a single sound they chose.
 *
 * The pass yields between files and reports a file it could not read, because
 * a 200-row table with one broken file is a normal afternoon, not a failure.
 */

const PROFILE_OPTIONS = ZAICODE_NORMALIZE_PROFILE_IDS.map((id) => ({
  value: id,
  label: ZAICODE_NORMALIZE_PROFILES[id].label,
}));

const REASON_TEXT: Record<string, string> = {
  "capped-attenuation": "hit your attenuation cap",
  "capped-boost": "hit the boost ceiling",
  "peak-limited": "limited by the peak guard",
  unmeasured: "could not be measured",
  ok: "",
};

export function ZaicodeSoundNormalizePanel() {
  const [profile, setProfile] = useState<ZaicodeNormalizeProfileId>("standard");
  const [cap, setCap] = useState(ZAICODE_NORMALIZE_ATTENUATION_CAP_DEFAULT);
  const [plan, setPlan] = useState<ZaicodeNormalizePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const settings = readZaicodeSoundSettings();
  const normalizedCount = Object.values(settings.events).filter((row) => zaicodeEffectiveGainDb(row) !== row.gainDb).length;

  const run = async () => {
    setBusy(true);
    try {
      const cache = readZaicodeAnalysisCache();
      const targets = collectZaicodeNormalizeTargets(settings);
      if (targets.length === 0) {
        toast("No configured sound to measure yet: choose a sound for an enabled event first");
        return;
      }
      const context = new AudioContext();
      const result = await runZaicodeNormalizePass(targets, {
        cache,
        decode: async (sound) => {
          const url = await resolveSoundUrl(sound);
          if (!url) return null;
          const response = await fetch(url);
          if (!response.ok) return null;
          const buffer = await context.decodeAudioData(await response.arrayBuffer());
          return { samples: buffer.getChannelData(0), sampleRate: buffer.sampleRate };
        },
        fetchBytes: async (sound) => {
          const url = await resolveSoundUrl(sound);
          if (!url) return null;
          const response = await fetch(url);
          return response.ok ? await response.arrayBuffer() : null;
        },
        onProgress: (done, total) => {
          if (done === total) return;
          toast(`Measuring ${done}/${total}…`, { durationMs: 400, dedupeKey: "zaicode-normalize-progress" });
        },
      });
      writeZaicodeAnalysisCache(cache, Date.now());
      await context.close();
      const next = planZaicodeNormalization(result.inputs, { profile, attenuationCapDb: cap });
      setPlan(next);
      if (result.failed.length > 0) {
        toast(`Measured ${result.inputs.length}; ${result.failed.length} could not be read and were left alone`, { variant: "warning" });
      }
      if (next.rows.length === 0) toast("Nothing to normalize: no configured sound could be measured");
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (!plan) return;
    setZaicodeSoundSettings(applyZaicodeNormalization(plan, readZaicodeSoundSettings()));
    toast(`Normalized ${plan.changed} event(s). Undo puts it back.`);
    setPlan(null);
  };

  const undo = () => {
    setZaicodeSoundSettings(undoZaicodeNormalization(readZaicodeSoundSettings()));
    toast("Normalization undone; your sounds and your own gains are as they were");
  };

  return (
    <section className="flex flex-col gap-2 border border-border bg-card p-3 text-ui-xs" data-zaicode-sound-normalize data-zaicode-help="sounds">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 text-ui-sm text-foreground">
          <Wand2 className="size-3" />
          Loudness
        </span>
        <button
          type="button"
          className="flex items-center gap-1 border border-border px-1.5 py-px text-foreground hover:bg-hover disabled:opacity-40"
          data-zaicode-normalize-run
          disabled={busy}
          title="Measure every sound you have configured (pool members included) and work out what each one needs. Nothing is changed until you press Apply."
          onClick={() => void run()}
        >
          {busy ? "Measuring…" : "Normalize configured sounds"}
        </button>
        <button
          type="button"
          className="flex items-center gap-1 border border-border px-1.5 py-px text-foreground-subtle hover:bg-hover disabled:opacity-40"
          data-zaicode-normalize-undo
          disabled={normalizedCount === 0}
          title="Take the automatic compensation away again. Your sound choices and your own dB values are untouched."
          onClick={undo}
        >
          <RotateCcw className="size-3" />
          Undo normalization{normalizedCount > 0 ? ` (${normalizedCount})` : ""}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <ZaicodePrefSegment
          label="Strength"
          value={profile}
          options={PROFILE_OPTIONS}
          onChange={(value) => setProfile(value)}
        />
        <span className="text-foreground-subtlest">{ZAICODE_NORMALIZE_PROFILES[profile].hint}</span>
        <ZaicodePrefStepper
          label="Automatic cut, at most"
          value={cap}
          min={ZAICODE_NORMALIZE_ATTENUATION_CAP_MIN}
          max={ZAICODE_NORMALIZE_ATTENUATION_CAP_MAX}
          step={1}
          format={(db) => `${db} dB`}
          onChange={(value) => setCap(normalizeZaicodeAttenuationCap(value))}
        />
        <span className="max-w-[46ch] text-foreground-subtlest">
          How far DOWN this pass may pull one sound. Not a target: the set is measured against its own median and only moved by
          {` ${Math.round(ZAICODE_NORMALIZE_PROFILES[profile].strength * 100)}%`} of the distance to it.
        </span>
      </div>

      {plan ? (
        <div className="flex flex-col gap-1 border border-border/60 p-2" data-zaicode-normalize-plan>
          <div className="flex flex-wrap items-center gap-2 text-foreground-subtle">
            <span>
              Reference (median of {plan.rows.filter((row) => row.measured).length} measured):{" "}
              <b className="text-foreground">{plan.referenceDb === -Infinity ? "—" : `${plan.referenceDb.toFixed(1)} dB`}</b>
            </span>
            <span>
              Change: <b className="text-foreground">{plan.changed} event(s)</b>
            </span>
            <span>
              Ceiling on boosts: <b className="text-foreground">+{plan.profile.boostCapDb} dB</b>
            </span>
            <button
              type="button"
              className="ml-auto flex items-center gap-1 border border-border px-1.5 py-px text-foreground hover:bg-hover"
              data-zaicode-normalize-apply
              onClick={apply}
            >
              <Play className="size-3" />
              Apply
            </button>
          </div>
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-left">
              <thead className="text-foreground-subtlest">
                <tr>
                  <th className="py-0.5 pr-2 font-normal">Event</th>
                  <th className="py-0.5 pr-2 font-normal">Before</th>
                  <th className="py-0.5 pr-2 font-normal">Change</th>
                  <th className="py-0.5 pr-2 font-normal">After</th>
                  <th className="py-0.5 font-normal">Note</th>
                </tr>
              </thead>
              <tbody>
                {plan.rows.map((row) => (
                  <tr key={row.id} className="border-t border-border/40">
                    <td className="py-0.5 pr-2">{zaicodeSoundEventDef(row.id)?.label ?? row.id}</td>
                    <td className="py-0.5 pr-2 tabular-nums">{row.measured ? `${row.beforeDb.toFixed(1)} dB` : "—"}</td>
                    <td className="py-0.5 pr-2 tabular-nums">
                      {row.gainDb > 0 ? `+${row.gainDb}` : row.gainDb} dB
                    </td>
                    <td className="py-0.5 pr-2 tabular-nums">{row.measured ? `${row.afterDb.toFixed(1)} dB` : "—"}</td>
                    <td className="py-0.5 text-foreground-subtlest">{REASON_TEXT[row.reason]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-foreground-subtlest">
            Preview one: nothing is stored yet, so a sound you do not like costs nothing to try.
          </p>
        </div>
      ) : null}
    </section>
  );
}

