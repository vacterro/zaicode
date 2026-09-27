import type { ReactNode } from "react";
import {
  PROTRAIL_PALETTE,
  protrailHexToRgb,
  protrailRgbToHex,
  type ProtrailRgb,
} from "@/zaicode/protrail/protrailModel.js";

/**
 * The controls of Settings -> ProTrail, shaped like ProTrail's own window:
 * visible selector grids instead of drop-downs, sliders with their value,
 * the 14-swatch palette plus a custom colour.
 */

export function ProtrailSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className={`grid grid-cols-[minmax(0,1fr)_minmax(90px,160px)_56px] items-center gap-2 ${disabled ? "opacity-50" : ""}`}>
      <span className="text-foreground-subtle">{label}</span>
      <input
        type="range"
        className="w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="text-right tabular-nums text-foreground">{format ? format(value) : String(value)}</span>
    </label>
  );
}

export function ProtrailGrid<T extends string>({
  label,
  value,
  options,
  onChange,
  columns = 4,
  disabled,
}: {
  label?: string;
  value: T;
  options: readonly { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
  columns?: number;
  disabled?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-1 ${disabled ? "opacity-50" : ""}`}>
      {label ? <span className="text-foreground-subtle">{label}</span> : null}
      <div className="grid gap-px" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }} role="radiogroup">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            title={option.hint}
            disabled={disabled}
            className={`truncate border px-1 py-0.5 ${option.value === value ? "border-[var(--zaicode-highlight,var(--color-warning))] bg-selected text-foreground" : "border-border text-foreground-subtle hover:bg-hover hover:text-foreground"}`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ProtrailColor({ label, value, onChange, disabled }: { label: string; value: ProtrailRgb; onChange: (value: ProtrailRgb) => void; disabled?: boolean }) {
  const hex = protrailRgbToHex(value);
  return (
    <div className={`flex flex-col gap-1 ${disabled ? "opacity-50" : ""}`}>
      <span className="flex items-center justify-between gap-2 text-foreground-subtle">
        {label}
        <input
          type="color"
          className="h-5 w-10 cursor-pointer border border-border bg-card p-0"
          value={hex}
          title="Custom colour"
          disabled={disabled}
          onChange={(event) => {
            const rgb = protrailHexToRgb(event.target.value);
            if (rgb) onChange(rgb);
          }}
        />
      </span>
      <div className="flex flex-wrap gap-px">
        {PROTRAIL_PALETTE.map((swatch) => {
          const active = swatch.r === value.r && swatch.g === value.g && swatch.b === value.b;
          return (
            <button
              key={swatch.name}
              type="button"
              title={swatch.name}
              aria-label={swatch.name}
              aria-pressed={active}
              disabled={disabled}
              className={`size-5 border ${active ? "border-foreground" : "border-border"}`}
              style={{ background: protrailRgbToHex(swatch) }}
              onClick={() => onChange({ r: swatch.r, g: swatch.g, b: swatch.b })}
            />
          );
        })}
      </div>
    </div>
  );
}

export function ProtrailCheck({ label, checked, onChange, hint, disabled }: { label: ReactNode; checked: boolean; onChange: (checked: boolean) => void; hint?: string; disabled?: boolean }) {
  return (
    <label className={`flex items-center gap-2 ${disabled ? "opacity-50" : ""}`} title={hint}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="text-foreground">{label}</span>
    </label>
  );
}

export function ProtrailGroup({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border border-border/60 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui-sm text-foreground">{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

export const fmt = {
  px: (v: number) => `${v.toFixed(v < 10 ? 1 : 0)} px`,
  ms: (v: number) => `${Math.round(v)} ms`,
  pct: (v: number) => `${Math.round(v * 100)}%`,
  x: (v: number) => `${v.toFixed(2)}×`,
  speed: (v: number) => (v === 0 ? "off" : `${Math.round(v)} px/s`),
};
