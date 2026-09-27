import { useState } from "react";
import { Check, Copy, Dice5, Lock, Play } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  SPG_LEVELS_PER_STAGE,
  SPG_STAGES,
  saipeggleCampaign,
  saipeggleLayout,
  saipeggleLevelCode,
  saipeggleParseLevelCode,
  saipeggleRandomSpec,
  type SpgLevelSpec,
} from "./saipeggleLevels.js";
import { SPG_POWER_INFO, SPG_POWERS } from "./saipeggleModel.js";
import { saipeggleNewSeed } from "./saipeggleRandom.js";
import { useSaipeggle } from "./saipeggleStore.js";

/** SAIPEGGLE's Levels and How-to-play screens. */

const CAMPAIGN = saipeggleCampaign();
const fmt = (value: number) => value.toLocaleString("en-US");

export function ZaicodeSaipeggleLevels({
  current,
  onPlay,
}: {
  current: SpgLevelSpec;
  onPlay: (choice: { index: number } | { spec: SpgLevelSpec }) => void;
}) {
  const progress = useSaipeggle((state) => state.progress);
  const settings = useSaipeggle((state) => state.settings);
  const setSettings = useSaipeggle((state) => state.setSettings);
  const [seed, setSeed] = useState(settings.seed || saipeggleNewSeed());
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const copyCode = () => {
    const text = saipeggleLevelCode(current, current.places ?? saipeggleLayout(current, settings.density));
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 text-ui-xs" data-zaicode-saipeggle-levels>
      <section className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-ui-sm text-foreground">Adventure</h3>
          <span className="text-foreground-subtle">
            {Object.keys(progress.cleared).filter((id) => /^\d+-\d+$/.test(id)).length} / {CAMPAIGN.length} cleared · total {fmt(progress.totalScore)}
          </span>
        </div>
        <div className="grid gap-1" style={{ gridTemplateColumns: "minmax(120px, 180px) repeat(5, minmax(0, 1fr))" }}>
          {SPG_STAGES.map((stage) => (
            <div key={stage.index} className="contents">
              <div className="flex flex-col justify-center border border-border/60 px-1.5 py-0.5">
                <span className="text-foreground">
                  {stage.index}. {stage.name}
                </span>
                <span className="text-foreground-subtle">
                  {SPG_POWER_INFO[stage.power].master} · {SPG_POWER_INFO[stage.power].name}
                </span>
              </div>
              {Array.from({ length: SPG_LEVELS_PER_STAGE }, (_, i) => {
                const index = (stage.index - 1) * SPG_LEVELS_PER_STAGE + i;
                const spec = CAMPAIGN[index]!;
                const locked = index >= progress.unlocked;
                const cleared = progress.cleared[spec.id] === true;
                return (
                  <button
                    key={spec.id}
                    type="button"
                    disabled={locked}
                    title={locked ? "Clear the level before it to open this one" : `${spec.name}${progress.best[spec.id] ? ` · best ${fmt(progress.best[spec.id]!)}` : ""}`}
                    className={cn(
                      "flex min-w-0 flex-col items-start border px-1.5 py-0.5 text-left",
                      spec.id === current.id ? "border-[var(--zaicode-highlight,var(--color-warning))] bg-selected" : "border-border hover:bg-hover",
                      locked && "opacity-40",
                    )}
                    onClick={() => onPlay({ index })}
                  >
                    <span className="flex w-full items-center gap-1 text-foreground">
                      {spec.id}
                      {locked ? <Lock className="size-3" /> : cleared ? <Check className="size-3 text-[var(--color-success)]" /> : null}
                    </span>
                    <span className="w-full truncate text-foreground-subtle">{spec.name}</span>
                    <span className="tabular-nums text-foreground-subtlest">{progress.best[spec.id] ? fmt(progress.best[spec.id]!) : "—"}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-1 border border-border/60 p-2">
        <h3 className="text-ui-sm text-foreground">Quick play: a random board from a seed</h3>
        <p className="text-foreground-subtle">The same seed always builds the same board, so you can share it. Orange pegs are dealt again on every try, as in the adventure.</p>
        <div className="flex flex-wrap items-center gap-1">
          <input
            className="w-40 border border-border bg-background px-1.5 py-0.5 text-foreground"
            value={seed}
            maxLength={32}
            aria-label="Seed"
            onChange={(event) => setSeed(event.target.value.toUpperCase())}
          />
          <button type="button" className="flex items-center gap-1 border border-border px-1.5 py-0.5 hover:bg-hover" onClick={() => setSeed(saipeggleNewSeed())}>
            <Dice5 className="size-3" /> New seed
          </button>
          <button
            type="button"
            className="flex items-center gap-1 border border-[var(--zaicode-highlight,var(--color-warning))] px-1.5 py-0.5 text-foreground hover:bg-hover"
            onClick={() => {
              const clean = seed.trim() || saipeggleNewSeed();
              setSettings({ seed: clean });
              onPlay({ spec: saipeggleRandomSpec(clean) });
            }}
          >
            <Play className="size-3" /> Play this seed
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-1 border border-border/60 p-2">
        <h3 className="text-ui-sm text-foreground">Share a board</h3>
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" className="flex items-center gap-1 border border-border px-1.5 py-0.5 hover:bg-hover" onClick={copyCode}>
            <Copy className="size-3" /> {copied ? "Copied" : `Copy the code of ${current.name}`}
          </button>
        </div>
        <textarea
          className="h-14 w-full resize-none border border-border bg-background px-1.5 py-0.5 font-mono text-foreground"
          placeholder="Paste a SPG1.… code here"
          value={code}
          aria-label="Level code"
          onChange={(event) => {
            setCode(event.target.value);
            setCodeError(null);
          }}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="flex items-center gap-1 border border-border px-1.5 py-0.5 hover:bg-hover disabled:opacity-40"
            disabled={!code.trim()}
            onClick={() => {
              const spec = saipeggleParseLevelCode(code);
              if (spec) onPlay({ spec });
              else setCodeError("Not a SAIPEGGLE level code.");
            }}
          >
            <Play className="size-3" /> Play the pasted board
          </button>
          {codeError ? <span className="text-[var(--color-destructive)]">{codeError}</span> : null}
        </div>
      </section>
    </div>
  );
}

export function ZaicodeSaipeggleHelp() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3 text-ui-xs text-foreground-subtle" data-zaicode-saipeggle-help>
      <h3 className="text-ui-sm text-foreground">How to play</h3>
      <p>Aim the cannon with the mouse and click (or press Space) to fire. Hit every orange peg before your balls run out.</p>
      <ul className="list-disc pl-4">
        <li>Blue 10 · orange 100 · purple 500 · green 10 and the master's power. Every lit peg disappears when the ball is gone.</li>
        <li>The more orange pegs are hit, the higher the multiplier: x2, x3, x5, x10 (right panel).</li>
        <li>The moving bucket gives a free ball. So does one shot worth 25,000, 75,000 and 125,000.</li>
        <li>A long flight between two hits onto an orange peg is a Long Shot: +25,000.</li>
        <li>The last orange peg starts Extreme Fever: slow motion, then buckets worth 10,000 / 50,000 / 100,000. Every ball left adds 10,000.</li>
        <li>The purple peg moves every turn. A ball resting on pegs clears them after a moment.</li>
      </ul>
      <h3 className="text-ui-sm text-foreground">Masters and powers</h3>
      <ul className="list-disc pl-4">
        {SPG_POWERS.map((power) => (
          <li key={power}>
            <span className="text-foreground">{SPG_POWER_INFO[power].master}</span> — {SPG_POWER_INFO[power].name}: {SPG_POWER_INFO[power].text}
          </li>
        ))}
      </ul>
      <h3 className="text-ui-sm text-foreground">Keys</h3>
      <p>Mouse or ← → (Shift: slow) aim · wheel: fine aim · Space / Enter / click: fire, continue · P: pause · R: retry · N: next level · Esc: pause, then the menu.</p>
    </div>
  );
}
