import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { normalizeZaicodeHex, zaicodeContrastRatio } from "@/zaicode/zaicodeColorMath.js";
import type { ZaicodePaletteTokens } from "@/zaicode/zaicodePalettes.js";

/** Small building blocks of the Color Studio page. */

export const studioButton = "border border-border px-1.5 leading-5 text-foreground-subtle hover:bg-hover hover:text-foreground disabled:opacity-50";

export function StudioSection({ title, hint, right, children }: { title: string; hint?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="border border-border bg-card p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-ui-lg text-foreground">{title}</h2>
          {hint ? <p className="text-foreground-subtle">{hint}</p> : null}
        </div>
        {right ? <div className="flex flex-wrap items-center gap-1">{right}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Swatch + native picker + hex field; commits only valid colours, Enter or blur for typed ones. */
export function ColorField({ value, onChange, title }: { value: string; onChange: (hex: string) => void; title?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const hex = normalizeZaicodeHex(draft);
    if (hex && hex !== value) onChange(hex);
    else setDraft(value);
  };
  const safe = normalizeZaicodeHex(value) ?? "#000000";
  return (
    <span className="flex items-center gap-1" title={title}>
      <input
        type="color"
        aria-label={title ?? "Pick a colour"}
        className="h-5 w-7 cursor-pointer border border-border bg-transparent p-0"
        value={safe.toLowerCase()}
        onChange={(event) => onChange(event.target.value)}
      />
      <input
        type="text"
        spellCheck={false}
        aria-label={`${title ?? "Colour"} hex`}
        className="w-[72px] border border-border bg-background px-1 font-mono text-foreground"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setDraft(value);
        }}
      />
    </span>
  );
}

const CONTRAST_PAIRS: readonly { fg: keyof ZaicodePaletteTokens; bg: keyof ZaicodePaletteTokens; label: string }[] = [
  { fg: "textPrimary", bg: "background", label: "Text on window" },
  { fg: "textPrimary", bg: "surface", label: "Text on cards" },
  { fg: "textSecondary", bg: "background", label: "Secondary text" },
  { fg: "textMuted", bg: "background", label: "Muted text" },
  { fg: "borderHighlight", bg: "background", label: "Highlight" },
  { fg: "dangerText", bg: "surface", label: "Error text" },
];

/** Readability check: 4.5 is comfortable body text, 3 is the floor for large text and hints. */
export function ContrastReport({ tokens }: { tokens: ZaicodePaletteTokens }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1" data-zaicode-contrast-report>
      {CONTRAST_PAIRS.map((pair) => {
        const ratio = zaicodeContrastRatio(tokens[pair.fg], tokens[pair.bg]);
        const verdict = ratio >= 4.5 ? "ok" : ratio >= 3 ? "weak" : "poor";
        return (
          <span
            key={pair.label}
            className={cn(
              "border px-1 tabular-nums",
              verdict === "ok" ? "border-border text-foreground-subtle" : verdict === "weak" ? "border-[var(--color-warning)] text-foreground" : "border-destructive text-destructive",
            )}
            title={`${pair.label}: contrast ${ratio.toFixed(1)}:1 (4.5 comfortable, 3 minimum)`}
          >
            {verdict === "ok" ? "✓" : verdict === "weak" ? "!" : "✗"} {pair.label} {ratio.toFixed(1)}
          </span>
        );
      })}
    </div>
  );
}

/** A small piece of ZAICODE drawn with the live app colours: every change shows here and everywhere. */
export function StudioPreview() {
  return (
    <div className="grid gap-2 border border-border bg-background p-2 sm:grid-cols-2" data-zaicode-color-preview>
      <div className="flex flex-col gap-1 border border-border bg-card p-2">
        <span className="text-foreground">Card title · text</span>
        <span className="text-foreground-subtle">Secondary text</span>
        <span className="text-foreground-subtlest">Muted hint · 12:34</span>
        <span className="bg-hover px-1 text-foreground">Hovered row</span>
        <span className="bg-selected px-1 text-foreground">Selected row</span>
        <span className="border border-[var(--zaicode-highlight,var(--color-border-hover))] px-1 text-foreground">Highlighted choice</span>
      </div>
      <div className="flex flex-col gap-1 p-1">
        <span className="flex gap-1">
          <span className="border border-border bg-secondary px-1.5 text-foreground">Button</span>
          <span className="bg-primary px-1.5 text-primary-foreground">Primary</span>
        </span>
        <span className="border border-input-border bg-input px-1 text-foreground-subtle">Input field…</span>
        <span className="flex flex-wrap gap-1">
          <span className="border border-[var(--color-success)] px-1 text-[var(--color-success)]">DONE</span>
          <span className="border border-[var(--color-warning)] px-1 text-[var(--color-warning)]">PENDING</span>
          <span className="border border-destructive px-1 text-destructive">BLOCKED</span>
        </span>
        <span className="text-[var(--color-tooltip-tag-foreground)] underline">A link</span>
        <span className="bg-popover px-1 text-popover-foreground">Menu / popover</span>
      </div>
    </div>
  );
}
