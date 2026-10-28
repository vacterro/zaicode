import { useState } from "react";
import { cn } from "@/components/lib/utils.js";
import {
  ZAICODE_DIAMOND_DEFAULT_OTHER,
  ZAICODE_DIAMOND_DEFAULT_SAIOPP,
  useZaicodeDiamondPrefs,
  zaicodeDiamondColor,
  type ZaicodeDiamondRule,
} from "@/zaicode/zaicodeDiamondColors.js";
import { ZaicodeRoleGlyph } from "@/zaicode/ZaicodeRoleGlyph.js";
import { ColorField, StudioSection, studioButton } from "./ZaicodeColorParts.js";

/**
 * Settings -> ZAICODE -> Colors -> Session diamonds (SRC-049): which colour
 * the ◆ before a session takes for the model its chat works with.
 */

const SAMPLE_MODELS = ["router/SAIFREN", "router/SAIOPP", "anthropic/claude-sonnet-4-6", "openai/gpt-5.5", "zai/GLM-5.3"];

function liveHex(variable: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

export function ZaicodeDiamondSettings() {
  const prefs = useZaicodeDiamondPrefs();
  const [match, setMatch] = useState("");
  const [ruleColor, setRuleColor] = useState("#a78bda");
  const addRule = () => {
    const text = match.trim();
    if (!text) return;
    prefs.update({ rules: [...prefs.rules.filter((rule) => rule.match.toLowerCase() !== text.toLowerCase()), { match: text, color: ruleColor }] });
    setMatch("");
  };
  const removeRule = (rule: ZaicodeDiamondRule) => prefs.update({ rules: prefs.rules.filter((entry) => entry !== rule) });
  return (
    <StudioSection
      title="Session diamonds"
      hint="The ◆ before a session shows the model its chat works with: SAIFREN yellow, SAIOPP orange, every other model its own colour."
      right={
        <button type="button" className={studioButton} onClick={prefs.reset} title="Back to the built-in colours">
          Reset
        </button>
      }
    >
      <div className="flex flex-col gap-1.5" data-zaicode-diamond-settings>
        <label className="flex items-center gap-1.5 text-foreground">
          <input type="checkbox" checked={prefs.byModel} onChange={(event) => prefs.update({ byModel: event.target.checked })} />
          Colour diamonds by the chat's model (off: gold MAIN, grey side sessions)
        </label>
        <div className={cn("grid grid-cols-[120px_auto_auto] items-center gap-x-2 gap-y-1", !prefs.byModel && "opacity-50")}>
          <span className="text-foreground">SAIFREN</span>
          <ColorField value={prefs.saifren || liveHex("--zaicode-highlight", "#f0c040")} title="SAIFREN diamond" onChange={(hex) => prefs.update({ saifren: hex })} />
          <button type="button" className={cn(studioButton, !prefs.saifren && "invisible")} title="Back to the theme highlight" onClick={() => prefs.update({ saifren: "" })}>
            ✕
          </button>
          <span className="text-foreground">SAIOPP</span>
          <ColorField value={prefs.saiopp || ZAICODE_DIAMOND_DEFAULT_SAIOPP} title="SAIOPP diamond" onChange={(hex) => prefs.update({ saiopp: hex })} />
          <button type="button" className={cn(studioButton, !prefs.saiopp && "invisible")} title="Back to the default orange" onClick={() => prefs.update({ saiopp: "" })}>
            ✕
          </button>
          <span className="text-foreground">Other models</span>
          <span className="flex items-center gap-1">
            <select
              className="border border-border bg-background px-1 text-foreground"
              value={prefs.others}
              onChange={(event) => prefs.update({ others: event.target.value === "single" ? "single" : "auto" })}
              aria-label="Other models"
            >
              <option value="auto">one colour per model</option>
              <option value="single">all the same colour</option>
            </select>
            {prefs.others === "single" ? (
              <ColorField value={prefs.othersColor || ZAICODE_DIAMOND_DEFAULT_OTHER} title="Other models" onChange={(hex) => prefs.update({ othersColor: hex })} />
            ) : null}
          </span>
          <span />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-foreground-subtle">Own rules (checked first): a part of the model id and its colour</span>
          {prefs.rules.map((rule) => (
            <div key={rule.match} className="flex items-center gap-1.5">
              <ZaicodeRoleGlyph role="MAIN" color={rule.color} />
              <span className="min-w-[120px] font-mono text-foreground">{rule.match}</span>
              <ColorField value={rule.color} title={rule.match} onChange={(hex) => prefs.update({ rules: prefs.rules.map((entry) => (entry === rule ? { ...entry, color: hex } : entry)) })} />
              <button type="button" className={studioButton} title="Remove this rule" onClick={() => removeRule(rule)}>
                ✕
              </button>
            </div>
          ))}
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              className="w-[140px] border border-border bg-background px-1 font-mono text-foreground"
              placeholder="claude"
              aria-label="Part of the model id"
              value={match}
              onChange={(event) => setMatch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addRule();
              }}
            />
            <ColorField value={ruleColor} title="Rule colour" onChange={setRuleColor} />
            <button type="button" className={studioButton} disabled={!match.trim()} onClick={addRule}>
              Add
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-1.5" aria-label="Preview">
          {SAMPLE_MODELS.map((model) => (
            <span key={model} className="flex items-center gap-1 text-foreground-subtle">
              <ZaicodeRoleGlyph role="MAIN" {...(zaicodeDiamondColor(model, prefs) ? { color: zaicodeDiamondColor(model, prefs)! } : {})} />
              {model.slice(model.indexOf("/") + 1)}
            </span>
          ))}
        </div>
      </div>
    </StudioSection>
  );
}
