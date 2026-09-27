import type { ReactNode } from "react";
import { ZaicodePrefCheck, ZaicodePrefSegment, ZaicodePrefStepper } from "@/zaicode/ZaicodePrefControls.js";
import {
  ZAICODE_HEADING_RULES,
  ZAICODE_LINE_STYLES,
  ZAICODE_LINK_UNDERLINES,
  ZAICODE_LIST_BULLETS,
  ZAICODE_LIST_NUMBERS,
  ZAICODE_TEXT_ALIGNS,
  ZAICODE_TEXT_CASES,
  ZAICODE_TEXT_DECORATIONS,
  ZAICODE_TEXT_FONTS,
  type ZaicodeSessionTextPrefs,
  type ZaicodeTextStyle,
} from "@/zaicode/zaicodeSessionTextModel.js";

/**
 * The controls of Settings -> Session text (SRC-062): one generic editor for
 * the knobs every element has (font, size, weight, italic, underline and its
 * look, colour, highlighter, letter case, spacing, space above / below) and
 * the extras of each element. "As the app" everywhere means "not changed".
 */

const AS_APP = "as app";

export function ZaicodeTextColor({
  label,
  value,
  onChange,
  fallback = "#c0b080",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  fallback?: string;
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
          title="Back to the theme"
          onClick={() => onChange("")}
        >
          theme
        </button>
      </span>
    </label>
  );
}

function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-foreground-subtle">{label}</span>
      <select
        className="max-w-[60%] border border-border bg-background px-1 py-0.5 text-foreground"
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const DECORATION_LABELS: Record<(typeof ZAICODE_TEXT_DECORATIONS)[number], string> = {
  inherit: "As the app",
  none: "No line",
  solid: "Line",
  dotted: "Dotted",
  dashed: "Dashed",
  double: "Double",
  wavy: "Wavy",
};
const CASE_LABELS: Record<(typeof ZAICODE_TEXT_CASES)[number], string> = {
  inherit: "As the app",
  none: "As written",
  uppercase: "UPPERCASE",
  lowercase: "lowercase",
  capitalize: "Every Word",
  "small-caps": "Small Caps",
};

/** Size, spacing and margins keep 0 / -1 as "as app"; a first step lands on a sensible value. */
function optional(value: number, sentinel: number, first: number, next: number): number {
  return value === sentinel && next !== sentinel ? first : next;
}

export function ZaicodeTextStyleEditor<T extends ZaicodeTextStyle>({
  style,
  onChange,
  firstSize = 14,
  children,
}: {
  style: T;
  onChange: (patch: Partial<T>) => void;
  firstSize?: number;
  children?: ReactNode;
}) {
  const underlined = style.decoration !== "inherit" && style.decoration !== "none";
  return (
    <div className="flex flex-col gap-1.5" data-zaicode-text-style-editor>
      <Select
        label="Font"
        value={style.font}
        options={ZAICODE_TEXT_FONTS.map((font) => ({ value: font.id, label: font.label }))}
        onChange={(font) => onChange({ font } as Partial<T>)}
      />
      {style.font === "custom" ? (
        <label className="flex items-center justify-between gap-2">
          <span className="text-foreground-subtle">Installed font name</span>
          <input
            className="w-40 border border-border bg-background px-1 py-0.5 text-foreground"
            maxLength={60}
            value={style.customFont}
            placeholder="e.g. Palatino Linotype"
            onChange={(event) => onChange({ customFont: event.target.value } as Partial<T>)}
          />
        </label>
      ) : null}
      <ZaicodePrefStepper
        label="Size"
        value={style.sizePx}
        min={0}
        max={72}
        format={(px) => (px === 0 ? AS_APP : `${px}px`)}
        onChange={(px) => onChange({ sizePx: px > 0 && px < 8 ? (style.sizePx === 0 ? firstSize : 0) : optional(style.sizePx, 0, firstSize, px) } as Partial<T>)}
      />
      <Select
        label="Weight"
        value={String(style.weight)}
        options={[
          { value: "0", label: "As the app" },
          ...[300, 400, 500, 600, 700, 800, 900].map((weight) => ({
            value: String(weight),
            label: `${weight}${weight === 400 ? " normal" : weight === 700 ? " bold" : ""}`,
          })),
        ]}
        onChange={(weight) => onChange({ weight: Number(weight) } as Partial<T>)}
      />
      <ZaicodePrefSegment
        label="Italic"
        value={style.italic}
        options={[
          { value: "inherit", label: "As app" },
          { value: "on", label: "Italic" },
          { value: "off", label: "Upright" },
        ]}
        onChange={(italic) => onChange({ italic } as Partial<T>)}
      />
      <Select
        label="Underline"
        value={style.decoration}
        options={ZAICODE_TEXT_DECORATIONS.map((value) => ({ value, label: DECORATION_LABELS[value] }))}
        onChange={(decoration) => onChange({ decoration } as Partial<T>)}
      />
      {underlined ? (
        <>
          <ZaicodeTextColor label="Line colour" value={style.decorationColor} onChange={(decorationColor) => onChange({ decorationColor } as Partial<T>)} />
          <ZaicodePrefStepper
            label="Line thickness"
            value={style.decorationThickness}
            min={0}
            max={6}
            format={(px) => (px === 0 ? "auto" : `${px}px`)}
            onChange={(decorationThickness) => onChange({ decorationThickness } as Partial<T>)}
          />
          <ZaicodePrefStepper
            label="Line below the text by"
            value={style.underlineOffset}
            min={0}
            max={12}
            format={(px) => (px === 0 ? "auto" : `${px}px`)}
            onChange={(underlineOffset) => onChange({ underlineOffset } as Partial<T>)}
          />
        </>
      ) : null}
      <ZaicodeTextColor label="Colour" value={style.color} onChange={(color) => onChange({ color } as Partial<T>)} />
      <ZaicodeTextColor label="Highlighter" value={style.background} fallback="#4a3a10" onChange={(background) => onChange({ background } as Partial<T>)} />
      <Select
        label="Letters"
        value={style.textCase}
        options={ZAICODE_TEXT_CASES.map((value) => ({ value, label: CASE_LABELS[value] }))}
        onChange={(textCase) => onChange({ textCase } as Partial<T>)}
      />
      <ZaicodePrefStepper
        label="Letter spacing"
        value={style.letterSpacing}
        min={-10}
        max={40}
        format={(value) => (value === 0 ? AS_APP : `${value > 0 ? "+" : ""}${value / 100}em`)}
        onChange={(letterSpacing) => onChange({ letterSpacing } as Partial<T>)}
      />
      <ZaicodePrefStepper
        label="Space above"
        value={style.marginTop}
        min={-1}
        max={96}
        step={1}
        format={(px) => (px < 0 ? AS_APP : `${px}px`)}
        onChange={(px) => onChange({ marginTop: optional(style.marginTop, -1, 8, px) } as Partial<T>)}
      />
      <ZaicodePrefStepper
        label="Space below"
        value={style.marginBottom}
        min={-1}
        max={96}
        format={(px) => (px < 0 ? AS_APP : `${px}px`)}
        onChange={(px) => onChange({ marginBottom: optional(style.marginBottom, -1, 8, px) } as Partial<T>)}
      />
      {children}
    </div>
  );
}

/** Extras only some elements have. */
export function ZaicodeSessionTextExtras({
  element,
  prefs,
  patch,
}: {
  element: string;
  prefs: ZaicodeSessionTextPrefs;
  patch: (next: ZaicodeSessionTextPrefs) => void;
}) {
  const heading = element.startsWith("h") && element.length === 2 ? (element as keyof ZaicodeSessionTextPrefs["headings"]) : null;
  if (element === "body") {
    const body = prefs.body;
    const set = (next: Partial<typeof body>) => patch({ ...prefs, body: { ...body, ...next } });
    return (
      <div className="flex flex-col gap-1.5">
        <ZaicodePrefStepper label="Line spacing" value={Math.round(body.lineHeight * 20)} min={0} max={60} format={(v) => (v === 0 ? AS_APP : `${(v / 20).toFixed(2)}`)} onChange={(v) => set({ lineHeight: v === 0 ? 0 : Math.max(1, v / 20) })} />
        <ZaicodePrefSegment label="Alignment" value={body.align} options={ZAICODE_TEXT_ALIGNS.map((value) => ({ value, label: value === "inherit" ? "As app" : value[0]!.toUpperCase() + value.slice(1) }))} onChange={(align) => set({ align })} />
        <ZaicodePrefStepper label="Line length" value={body.maxWidthCh} min={0} max={200} step={10} format={(ch) => (ch === 0 ? "full width" : `${ch} letters`)} onChange={(ch) => set({ maxWidthCh: ch > 0 && ch < 40 ? 40 : ch })} />
        <ZaicodePrefStepper label="First-line indent" value={body.indentPx} min={0} max={96} step={4} format={(px) => (px === 0 ? "none" : `${px}px`)} onChange={(indentPx) => set({ indentPx })} />
        <ZaicodePrefCheck checked={body.hyphens} onChange={(hyphens) => set({ hyphens })} label="Hyphenate long words" />
        <ZaicodeTextColor label="Selected text" value={body.selection} fallback="#5a4324" onChange={(selection) => set({ selection })} />
      </div>
    );
  }
  if (heading) {
    const style = prefs.headings[heading];
    const set = (next: Partial<typeof style>) => patch({ ...prefs, headings: { ...prefs.headings, [heading]: { ...style, ...next } } });
    return (
      <div className="flex flex-col gap-1.5">
        <Select
          label="Line / frame"
          value={style.rule}
          options={ZAICODE_HEADING_RULES.map((value) => ({ value, label: { none: "None", under: "Line under", over: "Line over", both: "Lines over and under", box: "Frame", bar: "Bar on the left", band: "Shaded band" }[value] }))}
          onChange={(rule) => set({ rule })}
        />
        {style.rule !== "none" ? <ZaicodeTextColor label="Line colour" value={style.ruleColor} onChange={(ruleColor) => set({ ruleColor })} /> : null}
        <ZaicodePrefCheck checked={prefs.numberHeadings} onChange={(numberHeadings) => patch({ ...prefs, numberHeadings })} label="Number headings 1. / 1.1 / 1.1.1 (like Word)" />
      </div>
    );
  }
  if (element === "link") {
    const link = prefs.link;
    const set = (next: Partial<typeof link>) => patch({ ...prefs, link: { ...link, ...next } });
    return (
      <div className="flex flex-col gap-1.5">
        <ZaicodePrefSegment label="Underlined" value={link.underline} options={ZAICODE_LINK_UNDERLINES.map((value) => ({ value, label: value === "inherit" ? "As app" : value[0]!.toUpperCase() + value.slice(1) }))} onChange={(underline) => set({ underline })} />
        <ZaicodeTextColor label="Colour under the pointer" value={link.hoverColor} onChange={(hoverColor) => set({ hoverColor })} />
      </div>
    );
  }
  if (element === "inlineCode") {
    const code = prefs.inlineCode;
    const set = (next: Partial<typeof code>) => patch({ ...prefs, inlineCode: { ...code, ...next } });
    return (
      <div className="flex flex-col gap-1.5">
        <ZaicodeTextColor label="Frame" value={code.border} onChange={(border) => set({ border })} />
        <ZaicodePrefStepper label="Padding" value={code.paddingPx} min={-1} max={12} format={(px) => (px < 0 ? AS_APP : `${px}px`)} onChange={(paddingPx) => set({ paddingPx })} />
      </div>
    );
  }
  if (element === "quote") {
    const quote = prefs.quote;
    const set = (next: Partial<typeof quote>) => patch({ ...prefs, quote: { ...quote, ...next } });
    return (
      <div className="flex flex-col gap-1.5">
        <ZaicodeTextColor label="Bar colour" value={quote.barColor} onChange={(barColor) => set({ barColor })} />
        <ZaicodePrefStepper label="Bar width" value={quote.barWidthPx} min={-1} max={12} format={(px) => (px < 0 ? AS_APP : px === 0 ? "no bar" : `${px}px`)} onChange={(barWidthPx) => set({ barWidthPx })} />
        <ZaicodePrefStepper label="Indent" value={quote.indentPx} min={-1} max={64} step={2} format={(px) => (px < 0 ? AS_APP : `${px}px`)} onChange={(px) => set({ indentPx: optional(quote.indentPx, -1, 12, px) })} />
      </div>
    );
  }
  if (element === "list") {
    const list = prefs.list;
    const set = (next: Partial<typeof list>) => patch({ ...prefs, list: { ...list, ...next } });
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-col gap-1">
          <span className="text-foreground-subtle">Bullet</span>
          <div className="flex flex-wrap gap-0.5">
            {ZAICODE_LIST_BULLETS.map((bullet) => (
              <button
                key={bullet}
                type="button"
                aria-pressed={list.bullet === bullet}
                className={`min-w-6 border px-1 ${list.bullet === bullet ? "border-[var(--zaicode-highlight,var(--color-warning))] text-foreground" : "border-border text-foreground-subtle hover:bg-hover"}`}
                onClick={() => set({ bullet })}
              >
                {bullet === "default" ? "as app" : bullet}
              </button>
            ))}
          </div>
        </div>
        <Select label="Numbers" value={list.numbers} options={ZAICODE_LIST_NUMBERS.map((value) => ({ value, label: { default: "As the app", decimal: "1. 2. 3.", "decimal-leading-zero": "01. 02. 03.", "lower-alpha": "a. b. c.", "upper-alpha": "A. B. C.", "lower-roman": "i. ii. iii.", "upper-roman": "I. II. III." }[value] }))} onChange={(numbers) => set({ numbers })} />
        <ZaicodeTextColor label="Bullet / number colour" value={list.markerColor} onChange={(markerColor) => set({ markerColor })} />
        <ZaicodePrefStepper label="Indent" value={list.indentPx} min={-1} max={64} step={2} format={(px) => (px < 0 ? AS_APP : `${px}px`)} onChange={(px) => set({ indentPx: optional(list.indentPx, -1, 20, px) })} />
        <ZaicodePrefStepper label="Gap between items" value={list.gapPx} min={-1} max={32} format={(px) => (px < 0 ? AS_APP : `${px}px`)} onChange={(gapPx) => set({ gapPx })} />
      </div>
    );
  }
  if (element === "table") {
    const table = prefs.table;
    const set = (next: Partial<typeof table>) => patch({ ...prefs, table: { ...table, ...next } });
    return (
      <div className="flex flex-col gap-1.5">
        <ZaicodeTextColor label="Grid lines" value={table.borderColor} onChange={(borderColor) => set({ borderColor })} />
        <ZaicodeTextColor label="Header shading" value={table.headerBackground} fallback="#2b2111" onChange={(headerBackground) => set({ headerBackground })} />
        <ZaicodePrefCheck checked={table.zebra} onChange={(zebra) => set({ zebra })} label="Zebra rows" />
        <ZaicodePrefStepper label="Cell padding" value={table.cellPaddingPx} min={-1} max={24} format={(px) => (px < 0 ? AS_APP : `${px}px`)} onChange={(cellPaddingPx) => set({ cellPaddingPx })} />
      </div>
    );
  }
  return null;
}

export function ZaicodeRuleEditor({ prefs, patch }: { prefs: ZaicodeSessionTextPrefs; patch: (next: ZaicodeSessionTextPrefs) => void }) {
  const hr = prefs.rule;
  const set = (next: Partial<typeof hr>) => patch({ ...prefs, rule: { ...hr, ...next } });
  return (
    <div className="flex flex-col gap-1.5">
      <ZaicodePrefSegment label="Line" value={hr.style} options={ZAICODE_LINE_STYLES.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))} onChange={(style) => set({ style })} />
      <ZaicodeTextColor label="Colour" value={hr.color} onChange={(color) => set({ color })} />
      <ZaicodePrefStepper label="Thickness" value={hr.thicknessPx} min={0} max={8} format={(px) => (px === 0 ? AS_APP : `${px}px`)} onChange={(thicknessPx) => set({ thicknessPx })} />
      <ZaicodePrefStepper label="Space around" value={hr.marginPx} min={-1} max={96} step={2} format={(px) => (px < 0 ? AS_APP : `${px}px`)} onChange={(px) => set({ marginPx: optional(hr.marginPx, -1, 16, px) })} />
    </div>
  );
}
