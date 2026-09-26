import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { ZaicodePrefSegment } from "@/zaicode/ZaicodePrefControls.js";
import {
  ZAICODE_CURVE_PRESETS,
  ZAICODE_EASINGS,
  normalizeZaicodeBezier,
  zaicodeEasingCss,
  type ZaicodeBezier,
  type ZaicodeMotionEasing,
} from "@/zaicode/zaicodeMotionTuning.js";

/**
 * Settings -> Highlights & motion (SRC-048): the own-easing controls -- a
 * slider that can follow the common value, the easing choice and a curve
 * editor with two draggable handles, presets, exact numbers and a live
 * preview of how it moves.
 */

export function ZaicodeLightsSlider({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  onChange,
  own,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
  /** Own-or-common toggle: off = the slider shows the common value and is locked. */
  own?: { on: boolean; onToggle: (on: boolean) => void };
}) {
  const locked = own ? !own.on : false;
  return (
    <label className="grid grid-cols-[16px_88px_1fr_64px] items-center gap-2">
      {own ? (
        <input
          type="checkbox"
          checked={own.on}
          title={own.on ? "Own value: untick to follow the common one" : "Follows the common value: tick for its own"}
          onChange={(event) => own.onToggle(event.target.checked)}
        />
      ) : (
        <span />
      )}
      <span className={cn("text-foreground-subtle", locked && "text-foreground-subtlest")}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={locked}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className={cn("text-right tabular-nums", locked ? "text-foreground-subtlest" : "text-foreground")}>{format(value)}</span>
    </label>
  );
}

// ---------------------------------------------------------------- curve editor

const PLOT_W = 112;
const PLOT_UNIT = 112;
/** Visible y range: a bit below 0 and above 1, so overshoot handles stay on screen. */
const Y_MIN = -0.35;
const Y_MAX = 1.35;
const PLOT_H = Math.round((Y_MAX - Y_MIN) * PLOT_UNIT);

const toX = (x: number) => x * PLOT_W;
const toY = (y: number) => (Y_MAX - y) * PLOT_UNIT;

/** Drag the two handles of a cubic-bezier curve; presets and exact numbers next to it. */
export function ZaicodeCurveEditor({ curve, onChange }: { curve: ZaicodeBezier; onChange: (curve: ZaicodeBezier) => void }) {
  const svg = useRef<SVGSVGElement | null>(null);
  const [dragging, setDragging] = useState<0 | 1 | null>(null);
  const [x1, y1, x2, y2] = curve;
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragging === null || !svg.current) return;
    const rect = svg.current.getBoundingClientRect();
    const x = (event.clientX - rect.left) / PLOT_W;
    const y = Y_MAX - (event.clientY - rect.top) / PLOT_UNIT;
    const next: ZaicodeBezier = dragging === 0 ? [x, y, x2, y2] : [x1, y1, x, y];
    onChange(normalizeZaicodeBezier(next));
  };
  const css = zaicodeEasingCss("custom", curve, 1);
  return (
    <div className="flex flex-wrap items-start gap-3" data-zaicode-curve-editor>
      <svg
        ref={svg}
        width={PLOT_W}
        height={PLOT_H}
        className="shrink-0 cursor-crosshair border border-border bg-background"
        onPointerMove={move}
        onPointerUp={() => setDragging(null)}
        onPointerLeave={() => setDragging(null)}
        role="img"
        aria-label={`Curve ${css}`}
      >
        <rect x={0} y={toY(1)} width={PLOT_W} height={toY(0) - toY(1)} fill="none" stroke="var(--color-border)" strokeDasharray="2 2" />
        <line x1={toX(0)} y1={toY(0)} x2={toX(x1)} y2={toY(y1)} stroke="var(--color-foreground-subtle)" />
        <line x1={toX(1)} y1={toY(1)} x2={toX(x2)} y2={toY(y2)} stroke="var(--color-foreground-subtle)" />
        <path
          d={`M ${toX(0)} ${toY(0)} C ${toX(x1)} ${toY(y1)}, ${toX(x2)} ${toY(y2)}, ${toX(1)} ${toY(1)}`}
          fill="none"
          stroke="var(--zaicode-highlight, #f0c040)"
          strokeWidth={2}
        />
        {([0, 1] as const).map((handle) => {
          const [hx, hy] = handle === 0 ? [x1, y1] : [x2, y2];
          return (
            <rect
              key={handle}
              x={toX(hx) - 4}
              y={toY(hy) - 4}
              width={8}
              height={8}
              fill={dragging === handle ? "var(--zaicode-highlight, #f0c040)" : "var(--color-foreground)"}
              className="cursor-grab"
              onPointerDown={(event) => {
                event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
                setDragging(handle);
              }}
            />
          );
        })}
      </svg>
      <div className="flex min-w-[180px] flex-col gap-1.5">
        <div className="grid grid-cols-4 gap-1">
          {(["x1", "y1", "x2", "y2"] as const).map((name, index) => (
            <label key={name} className="flex flex-col text-foreground-subtlest">
              {name}
              <input
                type="number"
                step={0.01}
                min={index % 2 === 0 ? 0 : -1}
                max={index % 2 === 0 ? 1 : 2}
                value={curve[index]}
                className="w-full border border-border bg-background px-1 text-foreground"
                onChange={(event) => {
                  const next = [...curve] as ZaicodeBezier;
                  next[index] = Number(event.target.value);
                  onChange(normalizeZaicodeBezier(next));
                }}
              />
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-px">
          {ZAICODE_CURVE_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="border border-border px-1.5 py-px text-foreground-subtle hover:bg-hover hover:text-foreground"
              onClick={() => onChange([...preset.curve])}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="relative h-3 w-full border border-border bg-background" title="How it moves">
          <span className="absolute top-0 size-2.5 bg-[var(--zaicode-highlight,#f0c040)]" style={{ animation: `zaicode-ease-demo 1.6s ${css} infinite alternate` }} />
        </div>
        <span className="font-mono text-foreground-subtlest">{css}</span>
      </div>
    </div>
  );
}

/** Easing choice (+ the curve editor for "Own curve"); `common` adds a "Common" / "Auto" first option. */
export function ZaicodeEasingPicker({
  label,
  value,
  curve,
  onChange,
  onCurve,
  common,
}: {
  label: ReactNode;
  value: ZaicodeMotionEasing | null;
  curve: ZaicodeBezier;
  onChange: (value: ZaicodeMotionEasing | null) => void;
  onCurve: (curve: ZaicodeBezier) => void;
  common?: string;
}) {
  const options = [
    ...(common ? [{ value: "common", label: common, hint: "Follows the common setting" }] : []),
    ...ZAICODE_EASINGS.map((easing) => ({ value: easing.id as string, label: easing.label, hint: easing.hint })),
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <ZaicodePrefSegment
        label={label}
        value={value ?? "common"}
        onChange={(next) => onChange(next === "common" ? null : (next as ZaicodeMotionEasing))}
        options={options}
      />
      {value === "custom" ? <ZaicodeCurveEditor curve={curve} onChange={onCurve} /> : null}
    </div>
  );
}

