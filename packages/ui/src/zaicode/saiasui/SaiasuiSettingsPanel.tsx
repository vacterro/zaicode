import { useMemo } from "react";
import { Switch } from "@/components/ui/switch.js";
import {
  SAIASUI_LIMITS,
  type SaiasuiConfig,
  type SaiasuiNumericKey,
  type SaiasuiPreset,
} from "./saiasuiConfig.js";

/**
 * The SAIASUI tuning panel: one declarative spec of collapsible groups drives
 * every control, so the shipped-defaults model, the in-game settings and the
 * Settings -> ZAICODE panel all read and write the same store. Common controls
 * lead; deterministic/debug controls live in Advanced, collapsed by default.
 *
 * ponytail: labels are inline English (ceiling: not localized). Upgrade path
 * when SAIASUI needs full i18n: move these strings into i18n/locales/saiasui.ts
 * keyed by field name and read them through intl here.
 */

type Field =
  | { key: SaiasuiNumericKey; label: string; unit?: string; kind: "num" }
  | { key: keyof SaiasuiConfig; label: string; kind: "bool" }
  | { key: keyof SaiasuiConfig; label: string; kind: "select"; options: { value: string; label: string }[] };

interface Group {
  id: string;
  title: string;
  advanced?: boolean;
  fields: Field[];
}

const GROUPS: Group[] = [
  {
    id: "gameplay",
    title: "Gameplay",
    fields: [
      { key: "enabled", label: "Enable SAIASUI Easter egg", kind: "bool" },
      {
        key: "pacing",
        label: "Pacing mode",
        kind: "select",
        options: [
          { value: "linear", label: "Linear — gradual" },
          { value: "step", label: "Step — every 2 min" },
        ],
      },
      { key: "initialInterval", label: "Initial target interval", unit: "s", kind: "num" },
      { key: "minInterval", label: "Minimum interval (max speed)", unit: "s", kind: "num" },
      { key: "accelRate", label: "Acceleration rate", kind: "num" },
      { key: "stepAmount", label: "Step pacing amount", kind: "num" },
      { key: "targetLifetime", label: "Target lifetime factor", unit: "×", kind: "num" },
      { key: "runDuration", label: "Run duration (0 = endless)", unit: "s", kind: "num" },
      { key: "hpActivateHits", label: "HP activation hit count", kind: "num" },
      { key: "startHp", label: "Starting HP", kind: "num" },
      { key: "maxHp", label: "Maximum HP", kind: "num" },
      { key: "hpDrain", label: "HP drain rate", unit: "/s", kind: "num" },
      { key: "missDamage", label: "Miss damage", unit: "HP", kind: "num" },
      { key: "targetMissDamage", label: "Target miss costs HP", kind: "bool" },
      { key: "blankMiss", label: "Blank-background click counts as miss", kind: "bool" },
      { key: "blankDamage", label: "Blank-click HP damage", unit: "HP", kind: "num" },
      { key: "comboResetOnMiss", label: "Miss resets combo", kind: "bool" },
      { key: "gameOverHp", label: "Game-over HP threshold", kind: "num" },
    ],
  },
  {
    id: "targets",
    title: "Targets",
    fields: [
      { key: "targetSize", label: "Main target size", unit: "px", kind: "num" },
      { key: "sizeVariation", label: "Target size variation", kind: "num" },
      { key: "ringSize", label: "Approach-ring size", unit: "px", kind: "num" },
      { key: "ringDuration", label: "Approach-ring reach", unit: "px", kind: "num" },
      { key: "movementEnabled", label: "Target movement enabled", kind: "bool" },
      { key: "movementSpeed", label: "Target movement speed", kind: "num" },
      { key: "movementAmount", label: "Target movement range", kind: "num" },
      { key: "tinyEnabled", label: "Tiny HP target enabled", kind: "bool" },
      { key: "tinyFrequency", label: "Tiny HP target frequency", kind: "num" },
      { key: "tinySize", label: "Tiny HP target size", unit: "px", kind: "num" },
      { key: "tinyHeal", label: "Tiny HP heal amount", unit: "HP", kind: "num" },
    ],
  },
  {
    id: "visuals",
    title: "Visuals",
    fields: [
      {
        key: "bodyStyle",
        label: "Target body style",
        kind: "select",
        options: [
          { value: "filled", label: "Filled" },
          { value: "hollow", label: "Hollow" },
        ],
      },
      {
        key: "colorMode",
        label: "Target color mode",
        kind: "select",
        options: [
          { value: "highlight", label: "Highlight accent" },
          { value: "mono", label: "Monochrome" },
        ],
      },
      { key: "targetOutline", label: "Target outline", kind: "bool" },
      { key: "ringVisible", label: "Approach ring visible", kind: "bool" },
      { key: "ringThickness", label: "Approach ring thickness", unit: "px", kind: "num" },
      { key: "targetOpacity", label: "Target opacity", kind: "num" },
      { key: "animIntensity", label: "Animation intensity", kind: "num" },
      { key: "hitFeedback", label: "Hit feedback", kind: "bool" },
      { key: "missFeedback", label: "Miss feedback", kind: "bool" },
      { key: "hudVisible", label: "HUD visible", kind: "bool" },
      { key: "showHp", label: "HP display", kind: "bool" },
      { key: "showScore", label: "Score display", kind: "bool" },
      { key: "showCombo", label: "Combo display", kind: "bool" },
      { key: "showGrade", label: "Grade display", kind: "bool" },
    ],
  },
  {
    id: "events",
    title: "Events",
    fields: [
      { key: "slowEnabled", label: "Slow event enabled", kind: "bool" },
      { key: "slowDuration", label: "Slow duration", unit: "s", kind: "num" },
      { key: "slowStrength", label: "Slow strength", kind: "num" },
      { key: "godEnabled", label: "God-mode event enabled", kind: "bool" },
      { key: "godDuration", label: "God duration", unit: "s", kind: "num" },
      { key: "fullEnabled", label: "Full-HP event enabled", kind: "bool" },
      { key: "movingEventEnabled", label: "Moving-target event enabled", kind: "bool" },
      { key: "eventIntervalMin", label: "Min hits between events", kind: "num" },
      { key: "eventIntervalMax", label: "Max hits between events", kind: "num" },
    ],
  },
  {
    id: "audio",
    title: "Audio",
    fields: [
      { key: "audioEnabled", label: "Master audio enable", kind: "bool" },
      { key: "volume", label: "Master volume", unit: "%", kind: "num" },
      { key: "hitSound", label: "Hit sound", kind: "bool" },
      { key: "missSound", label: "Miss sound", kind: "bool" },
      { key: "eventSound", label: "Event sounds", kind: "bool" },
      { key: "gameOverSound", label: "Game-over sound", kind: "bool" },
    ],
  },
];

export const SAIASUI_SETTING_GROUPS = GROUPS;

const PRESETS: { value: SaiasuiPreset; label: string }[] = [
  { value: "relaxed", label: "Relaxed" },
  { value: "default", label: "Default" },
  { value: "fast", label: "Fast" },
  { value: "brutal", label: "Brutal" },
  { value: "custom", label: "Custom" },
];

export function SaiasuiSettingsPanel({
  config,
  onChange,
  onPreset,
  onReset,
  open,
  onToggle,
}: {
  config: SaiasuiConfig;
  onChange: (patch: Partial<SaiasuiConfig>) => void;
  onPreset: (preset: SaiasuiPreset) => void;
  onReset: () => void;
  /** Which groups are expanded. Undefined = component uses its own defaults. */
  open?: Record<string, boolean>;
  onToggle?: (id: string, next: boolean) => void;
}) {
  const isOpen = useMemo(
    () => (id: string, advanced?: boolean) => open?.[id] ?? !advanced,
    [open],
  );
  return (
    <div className="flex flex-col gap-2 text-ui-sm" data-saiasui-panel>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-foreground-subtle">Preset</span>
        <select
          className="border border-border bg-input px-2 py-1 text-ui-base"
          value={config.preset}
          onChange={(event) => onPreset(event.target.value as SaiasuiPreset)}
        >
          {PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {preset.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ml-auto border border-border px-2 py-1"
          onClick={onReset}
        >
          Reset all to defaults
        </button>
      </div>
      {GROUPS.map((group) => (
        <fieldset key={group.id} className="border border-border bg-card">
          <button
            type="button"
            aria-expanded={isOpen(group.id, group.advanced)}
            className="flex w-full items-center justify-between px-3 py-2 text-ui-base"
            onClick={() => onToggle?.(group.id, !isOpen(group.id, group.advanced))}
          >
            <span>{group.title}</span>
            <span aria-hidden>{isOpen(group.id, group.advanced) ? "▾" : "▸"}</span>
          </button>
          {isOpen(group.id, group.advanced) ? (
            <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
              {group.fields.map((field) => (
                <FieldRow key={field.key} field={field} config={config} onChange={onChange} onReset={onReset} />
              ))}
            </div>
          ) : null}
        </fieldset>
      ))}
    </div>
  );
}

function FieldRow({
  field,
  config,
  onChange,
}: {
  field: Field;
  config: SaiasuiConfig;
  onChange: (patch: Partial<SaiasuiConfig>) => void;
  onReset: () => void;
}) {
  if (field.kind === "bool") {
    return (
      <label className="flex items-center justify-between gap-3">
        <span>{field.label}</span>
        <Switch
          checked={config[field.key] as boolean}
          onCheckedChange={(value) => onChange({ [field.key]: value } as Partial<SaiasuiConfig>)}
        />
      </label>
    );
  }
  if (field.kind === "select") {
    return (
      <label className="flex items-center justify-between gap-3">
        <span>{field.label}</span>
        <select
          className="border border-border bg-input px-2 py-1 text-ui-base"
          value={config[field.key] as string}
          onChange={(event) => onChange({ [field.key]: event.target.value } as Partial<SaiasuiConfig>)}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  const [min, max, step] = SAIASUI_LIMITS[field.key];
  const value = config[field.key] as number;
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center justify-between">
        <span>{field.label}</span>
        <span className="tabular-nums text-foreground-subtle">
          {value}
          {field.unit ? ` ${field.unit}` : ""}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={field.label}
        onChange={(event) => onChange({ [field.key]: Number(event.target.value) } as Partial<SaiasuiConfig>)}
      />
    </label>
  );
}
