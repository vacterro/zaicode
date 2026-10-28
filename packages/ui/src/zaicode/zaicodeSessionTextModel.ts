/**
 * Session text (SRC-062): "full control over the main text in sessions, like
 * in Word -- the font, what happens when the agent underlines something, the
 * headers, everything rich and nicely configurable, with presets".
 *
 * The model: one style per markdown element of an agent's answer (the body,
 * H1-H6, bold, italic, strikethrough, links, inline code, quotes, lists,
 * tables, the horizontal rule), each with the Word-like knobs that make sense
 * for it. Every value has an "inherit" state, so an untouched element keeps
 * the ZAICODE look; the CSS generator (zaicodeSessionTextCss) only writes what
 * the operator changed.
 */

export const ZAICODE_TEXT_FONTS = [
  { id: "inherit", label: "As the app", family: "" },
  { id: "ui", label: "Interface font", family: "var(--zaicode-ui-font-family, Verdana, sans-serif)" },
  { id: "verdana", label: "Verdana m1 (bitmap)", family: '"Verdana_m1", Verdana, Tahoma, sans-serif' },
  { id: "tahoma", label: "Tahoma", family: "Tahoma, Verdana, sans-serif" },
  { id: "segoe", label: "Segoe UI", family: '"Segoe UI", Tahoma, sans-serif' },
  { id: "arial", label: "Arial", family: "Arial, Helvetica, sans-serif" },
  { id: "calibri", label: "Calibri (Word)", family: "Calibri, Carlito, \"Segoe UI\", sans-serif" },
  { id: "cambria", label: "Cambria (Word)", family: "Cambria, Caladea, Georgia, serif" },
  { id: "georgia", label: "Georgia", family: "Georgia, \"Times New Roman\", serif" },
  { id: "times", label: "Times New Roman", family: "\"Times New Roman\", Times, serif" },
  { id: "garamond", label: "Garamond", family: "Garamond, \"EB Garamond\", Georgia, serif" },
  { id: "courier", label: "Courier New (typewriter)", family: "\"Courier New\", Courier, monospace" },
  { id: "consolas", label: "Consolas", family: "Consolas, monospace" },
  { id: "terminus", label: "Terminus (bitmap)", family: '"Terminus (TTF) for Windows", "ZAICODE Terminus", monospace' },
  { id: "mono", label: "Code font", family: "var(--font-mono, monospace)" },
  { id: "custom", label: "Installed font (type its name)", family: "" },
] as const;
export type ZaicodeTextFont = (typeof ZAICODE_TEXT_FONTS)[number]["id"];

export const ZAICODE_TEXT_DECORATIONS = ["inherit", "none", "solid", "dotted", "dashed", "double", "wavy"] as const;
export type ZaicodeTextDecoration = (typeof ZAICODE_TEXT_DECORATIONS)[number];

export const ZAICODE_TEXT_CASES = ["inherit", "none", "uppercase", "lowercase", "capitalize", "small-caps"] as const;
export type ZaicodeTextCase = (typeof ZAICODE_TEXT_CASES)[number];

export const ZAICODE_TEXT_TRISTATE = ["inherit", "on", "off"] as const;
export type ZaicodeTextTristate = (typeof ZAICODE_TEXT_TRISTATE)[number];

/** The knobs every element has. 0 / "" / "inherit" = leave it as the app draws it. */
export interface ZaicodeTextStyle {
  font: ZaicodeTextFont;
  customFont: string;
  /** px; 0 = inherit. */
  sizePx: number;
  /** 100..900; 0 = inherit. */
  weight: number;
  italic: ZaicodeTextTristate;
  decoration: ZaicodeTextDecoration;
  /** "" = the text colour. */
  decorationColor: string;
  /** px; 0 = auto. */
  decorationThickness: number;
  /** px; 0 = auto. */
  underlineOffset: number;
  /** "" = the theme. */
  color: string;
  /** Highlighter behind the text; "" = none. */
  background: string;
  textCase: ZaicodeTextCase;
  /** Hundredths of an em; 0 = inherit. */
  letterSpacing: number;
  /** px; -1 = inherit. */
  marginTop: number;
  marginBottom: number;
}

export const ZAICODE_TEXT_STYLE_DEFAULT: ZaicodeTextStyle = {
  font: "inherit",
  customFont: "",
  sizePx: 0,
  weight: 0,
  italic: "inherit",
  decoration: "inherit",
  decorationColor: "",
  decorationThickness: 0,
  underlineOffset: 0,
  color: "",
  background: "",
  textCase: "inherit",
  letterSpacing: 0,
  marginTop: -1,
  marginBottom: -1,
};

export const ZAICODE_HEADING_RULES = ["none", "under", "over", "both", "box", "bar", "band"] as const;
export type ZaicodeHeadingRule = (typeof ZAICODE_HEADING_RULES)[number];
export const ZAICODE_LIST_BULLETS = ["default", "•", "◦", "▪", "■", "–", "—", "▸", "►", "→", "✓", "◆", "★"] as const;
export type ZaicodeListBullet = (typeof ZAICODE_LIST_BULLETS)[number];
export const ZAICODE_LIST_NUMBERS = ["default", "decimal", "decimal-leading-zero", "lower-alpha", "upper-alpha", "lower-roman", "upper-roman"] as const;
export type ZaicodeListNumber = (typeof ZAICODE_LIST_NUMBERS)[number];
export const ZAICODE_LINK_UNDERLINES = ["inherit", "always", "hover", "never"] as const;
export type ZaicodeLinkUnderline = (typeof ZAICODE_LINK_UNDERLINES)[number];
export const ZAICODE_TEXT_ALIGNS = ["inherit", "left", "justify", "center"] as const;
export type ZaicodeTextAlign = (typeof ZAICODE_TEXT_ALIGNS)[number];
export const ZAICODE_LINE_STYLES = ["solid", "dashed", "dotted", "double"] as const;
export type ZaicodeLineStyle = (typeof ZAICODE_LINE_STYLES)[number];

export const ZAICODE_HEADING_LEVELS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;
export type ZaicodeHeadingLevel = (typeof ZAICODE_HEADING_LEVELS)[number];

export interface ZaicodeHeadingStyle extends ZaicodeTextStyle {
  rule: ZaicodeHeadingRule;
  ruleColor: string;
}

export interface ZaicodeSessionTextPrefs {
  enabled: boolean;
  body: ZaicodeTextStyle & {
    /** 0 = inherit, else 1.0..3.0 */
    lineHeight: number;
    align: ZaicodeTextAlign;
    /** Characters; 0 = full width. */
    maxWidthCh: number;
    /** First-line indent of paragraphs, px. */
    indentPx: number;
    hyphens: boolean;
    /** Colour of selected text's background; "" = system. */
    selection: string;
  };
  headings: Record<ZaicodeHeadingLevel, ZaicodeHeadingStyle>;
  /** Word-like "1.", "1.1", "1.1.1" before H1-H3. */
  numberHeadings: boolean;
  strong: ZaicodeTextStyle;
  em: ZaicodeTextStyle;
  del: ZaicodeTextStyle;
  link: ZaicodeTextStyle & { underline: ZaicodeLinkUnderline; hoverColor: string };
  inlineCode: ZaicodeTextStyle & { border: string; paddingPx: number };
  quote: ZaicodeTextStyle & { barColor: string; barWidthPx: number; indentPx: number };
  list: ZaicodeTextStyle & { bullet: ZaicodeListBullet; numbers: ZaicodeListNumber; markerColor: string; indentPx: number; gapPx: number };
  table: ZaicodeTextStyle & { borderColor: string; headerBackground: string; zebra: boolean; cellPaddingPx: number };
  rule: { style: ZaicodeLineStyle; color: string; thicknessPx: number; marginPx: number };
  /**
   * What YOU write (SRC-062, Wave 2). "default" = the user's own text follows
   * the shared session-text theme; "separate" = the overrides below belong to
   * the user alone and persist on their own. Same style schema as an agent
   * element, so there is no second model and no second renderer: the bubble
   * already carries `data-v4-user-input-bubble`, and that is the whole target.
   */
  userMessage: { mode: ZaicodeUserTextMode; style: ZaicodeUserTextStyle };
}

export const ZAICODE_USER_TEXT_MODES = ["default", "separate"] as const;
export type ZaicodeUserTextMode = (typeof ZAICODE_USER_TEXT_MODES)[number];

export interface ZaicodeUserTextStyle extends ZaicodeTextStyle {
  /** 0 = inherit. */
  lineHeight: number;
  align: ZaicodeTextAlign;
  borderColor: string;
  /** -1 = as the app. */
  borderWidthPx: number;
  /** -1 = as the app. */
  borderRadiusPx: number;
  /** -1 = as the app. */
  paddingPx: number;
}

export type ZaicodeSessionTextElement =
  | "body"
  | ZaicodeHeadingLevel
  | "strong"
  | "em"
  | "del"
  | "link"
  | "inlineCode"
  | "quote"
  | "list"
  | "table"
  | "rule";

export const ZAICODE_SESSION_TEXT_ELEMENTS: readonly { id: ZaicodeSessionTextElement; label: string; hint: string }[] = [
  { id: "body", label: "Text", hint: "Every paragraph of an answer: font, size, line spacing, width, alignment" },
  { id: "h1", label: "Heading 1", hint: "# Title" },
  { id: "h2", label: "Heading 2", hint: "## Section" },
  { id: "h3", label: "Heading 3", hint: "### Subsection" },
  { id: "h4", label: "Heading 4", hint: "#### " },
  { id: "h5", label: "Heading 5", hint: "##### " },
  { id: "h6", label: "Heading 6", hint: "###### " },
  { id: "strong", label: "Bold", hint: "**what the agent stresses**" },
  { id: "em", label: "Italic", hint: "*emphasis*" },
  { id: "del", label: "Strikethrough", hint: "~~crossed out~~" },
  { id: "link", label: "Links", hint: "Web and file links: colour, when they are underlined" },
  { id: "inlineCode", label: "Inline code", hint: "`names` in the text" },
  { id: "quote", label: "Quotes", hint: "> quoted text: the bar, its colour, indent" },
  { id: "list", label: "Lists", hint: "Bullets, numbers, indent, gaps" },
  { id: "table", label: "Tables", hint: "Borders, header shading, zebra rows" },
  { id: "rule", label: "Divider", hint: "--- the horizontal line" },
];

function headingDefaults(): Record<ZaicodeHeadingLevel, ZaicodeHeadingStyle> {
  return Object.fromEntries(
    ZAICODE_HEADING_LEVELS.map((level) => [level, { ...ZAICODE_TEXT_STYLE_DEFAULT, rule: "none", ruleColor: "" }]),
  ) as Record<ZaicodeHeadingLevel, ZaicodeHeadingStyle>;
}

export function zaicodeSessionTextDefaults(): ZaicodeSessionTextPrefs {
  const s = ZAICODE_TEXT_STYLE_DEFAULT;
  return {
    enabled: true,
    body: { ...s, lineHeight: 0, align: "inherit", maxWidthCh: 0, indentPx: 0, hyphens: false, selection: "" },
    headings: headingDefaults(),
    numberHeadings: false,
    strong: { ...s },
    em: { ...s },
    del: { ...s },
    link: { ...s, underline: "inherit", hoverColor: "" },
    inlineCode: { ...s, border: "", paddingPx: -1 },
    quote: { ...s, barColor: "", barWidthPx: -1, indentPx: -1 },
    list: { ...s, bullet: "default", numbers: "default", markerColor: "", indentPx: -1, gapPx: -1 },
    table: { ...s, borderColor: "", headerBackground: "", zebra: false, cellPaddingPx: -1 },
    rule: { style: "solid", color: "", thicknessPx: 0, marginPx: -1 },
    userMessage: {
      mode: "default",
      style: { ...s, lineHeight: 0, align: "inherit", borderColor: "", borderWidthPx: -1, borderRadiusPx: -1, paddingPx: -1 },
    },
  };
}

const HEX = /^#[0-9a-f]{6}$/i;

function num(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value * 100) / 100)) : fallback;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

export function zaicodeTextColor(value: unknown): string {
  return typeof value === "string" && HEX.test(value) ? value.toLowerCase() : "";
}

/** Installed font names only: no quotes, semicolons or control characters reach the stylesheet. */
export function zaicodeSafeFontName(value: unknown): string {
  if (typeof value !== "string") return "";
  return [...value]
    .filter((char) => (char.codePointAt(0) ?? 0) >= 32 && !"\"'\\;{}<>".includes(char))
    .join("")
    .slice(0, 60)
    .trim();
}

export function normalizeZaicodeTextStyle(raw: unknown, base: ZaicodeTextStyle = ZAICODE_TEXT_STYLE_DEFAULT): ZaicodeTextStyle {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    font: oneOf(r.font, ZAICODE_TEXT_FONTS.map((font) => font.id), base.font),
    customFont: typeof r.customFont === "string" ? zaicodeSafeFontName(r.customFont) : base.customFont,
    sizePx: r.sizePx === 0 ? 0 : num(r.sizePx, 8, 72, base.sizePx),
    weight: r.weight === 0 ? 0 : Math.round(num(r.weight, 100, 900, base.weight) / 100) * 100,
    italic: oneOf(r.italic, ZAICODE_TEXT_TRISTATE, base.italic),
    decoration: oneOf(r.decoration, ZAICODE_TEXT_DECORATIONS, base.decoration),
    decorationColor: r.decorationColor === undefined ? base.decorationColor : zaicodeTextColor(r.decorationColor),
    decorationThickness: num(r.decorationThickness, 0, 6, base.decorationThickness),
    underlineOffset: num(r.underlineOffset, 0, 12, base.underlineOffset),
    color: r.color === undefined ? base.color : zaicodeTextColor(r.color),
    background: r.background === undefined ? base.background : zaicodeTextColor(r.background),
    textCase: oneOf(r.textCase, ZAICODE_TEXT_CASES, base.textCase),
    letterSpacing: num(r.letterSpacing, -10, 40, base.letterSpacing),
    marginTop: num(r.marginTop, -1, 96, base.marginTop),
    marginBottom: num(r.marginBottom, -1, 96, base.marginBottom),
  };
}
