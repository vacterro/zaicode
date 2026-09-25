import { useState, type ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover.js";
import { isZaicodeComboClick, nextZaicodeCombo } from "./zaicodeCombo.js";

/**
 * Small, dense controls shared by the ZAICODE right-click settings panels
 * (SLOTS, LIVE, SAIMAIL envelope, ...). One visual language: a title bar, then
 * rows of checkboxes, segmented choices and +/- steppers.
 */

/**
 * Wraps a control so that a RIGHT click opens its settings panel next to it,
 * while a left click keeps doing whatever the control does.
 */
export function ZaicodeRightClickSettings({
  title,
  hint,
  children,
  panel,
  side = "bottom",
  align = "start",
  className,
}: {
  title: string;
  hint?: string;
  /** The control itself (button, chip, ...). */
  children: ReactNode;
  /** The settings panel body. */
  panel: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          className={cn("inline-flex", className)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
          }}
        >
          {children}
        </div>
      </PopoverAnchor>
      <PopoverContent
        side={side}
        align={align}
        className="w-80 gap-2 border border-[var(--zaicode-highlight,var(--color-border))] p-2 text-ui-xs"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-baseline justify-between gap-2 border-b border-border pb-1">
          <strong className="text-ui-sm font-normal text-foreground">{title}</strong>
          <span className="text-foreground-subtlest">right-click opens this</span>
        </div>
        {hint ? <p className="text-foreground-subtle">{hint}</p> : null}
        <div className="flex max-h-[70vh] flex-col gap-1.5 overflow-y-auto">{panel}</div>
      </PopoverContent>
    </Popover>
  );
}

export function ZaicodePrefCheck({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn("flex items-start gap-1.5 text-foreground", disabled && "opacity-50")}
      title={hint}
    >
      <input
        type="checkbox"
        className="mt-0.5 shrink-0"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0">
        {label}
        {hint ? <span className="block text-foreground-subtlest">{hint}</span> : null}
      </span>
    </label>
  );
}

export function ZaicodePrefSegment<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: ReactNode;
  value: T;
  options: readonly { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className={cn("flex flex-col gap-0.5", disabled && "opacity-50")}>
      <span className="text-foreground-subtle">{label}</span>
      <div className="flex flex-wrap gap-px" role="radiogroup">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            disabled={disabled}
            title={option.hint}
            className={cn(
              "border px-1.5 py-px leading-4",
              value === option.value
                ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
                : "border-border text-foreground-subtle hover:bg-hover hover:text-foreground",
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A segmented choice that can also hold a mix (SRC-043): click picks one,
 * Shift / Ctrl + click adds the option to the mix or takes it out
 * (zaicodeCombo.ts). Every picked option is lit.
 */
export function ZaicodePrefCombo<T extends string>({
  label,
  values,
  options,
  onChange,
  neutral,
  max,
  disabled,
}: {
  label: ReactNode;
  values: readonly T[];
  options: readonly { value: T; label: string; hint?: string }[];
  onChange: (values: T[]) => void;
  /** The option that means "nothing mixed" (Steady, Still). */
  neutral?: T;
  max?: number;
  disabled?: boolean;
}) {
  const mixed = values.length > 1;
  return (
    <div className={cn("flex flex-col gap-0.5", disabled && "opacity-50")} data-zaicode-pref-combo>
      <span className="text-foreground-subtle">
        {label}
        <span className="text-foreground-subtlest">
          {mixed ? ` · mix of ${values.length}` : ""} · Shift+click mixes
        </span>
      </span>
      <div className="flex flex-wrap gap-px" role="group">
        {options.map((option) => {
          const on = values.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              role="checkbox"
              aria-checked={on}
              disabled={disabled}
              title={[option.hint, "Shift+click: add to the mix / take out"].filter(Boolean).join("\n")}
              className={cn(
                "border px-1.5 py-px leading-4",
                on
                  ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
                  : "border-border text-foreground-subtle hover:bg-hover hover:text-foreground",
              )}
              onClick={(event) =>
                onChange(
                  nextZaicodeCombo(values, option.value, isZaicodeComboClick(event), {
                    ...(neutral !== undefined ? { neutral } : {}),
                    ...(max !== undefined ? { max } : {}),
                  }),
                )
              }
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ZaicodePrefStepper({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  format,
  onChange,
  disabled,
}: {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  format?: (value: number) => string;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const stepClass =
    "flex h-5 w-5 items-center justify-center border border-border bg-card text-foreground hover:bg-hover disabled:opacity-40";
  const clampValue = (next: number) => Math.min(max, Math.max(min, Math.round(next / step) * step));
  return (
    <div className={cn("flex items-center justify-between gap-2", disabled && "opacity-50")}>
      <span className="text-foreground-subtle">{label}</span>
      <span className="flex items-center gap-1">
        <button
          type="button"
          className={stepClass}
          disabled={disabled || value <= min}
          onClick={() => onChange(clampValue(value - step))}
        >
          −
        </button>
        <span className="min-w-12 text-center tabular-nums text-foreground">
          {format ? format(value) : value}
          {suffix}
        </span>
        <button
          type="button"
          className={stepClass}
          disabled={disabled || value >= max}
          onClick={() => onChange(clampValue(value + step))}
        >
          +
        </button>
      </span>
    </div>
  );
}

export function ZaicodePrefHeading({ children }: { children: ReactNode }) {
  return (
    <div className="mt-1 border-t border-border pt-1 text-[10px] tracking-wide text-foreground-subtlest">
      {children}
    </div>
  );
}
