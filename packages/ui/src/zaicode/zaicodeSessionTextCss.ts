import {
  ZAICODE_HEADING_LEVELS,
  ZAICODE_TEXT_FONTS,
  zaicodeSafeFontName,
  type ZaicodeSessionTextPrefs,
  type ZaicodeTextStyle,
} from "./zaicodeSessionTextModel.js";

/**
 * Session-text settings -> one stylesheet (SRC-062). Pure: the same settings
 * always give the same CSS, and only what the operator changed is written,
 * so an untouched element keeps the app's look.
 *
 * Every rule sits under `html.zaicode-session-text .zaicode-md` (the markdown
 * root of an agent's answer) and is !important: pixel mode sets the interface
 * font on every element with !important (specificity 0,1,1) and Tailwind's
 * utility classes sit on the elements themselves; these selectors are
 * 0,2,2 and up, so the operator's choice wins over both.
 */

export const ZAICODE_SESSION_TEXT_ROOT = "html.zaicode-session-text .zaicode-md";

function fontFamily(style: Pick<ZaicodeTextStyle, "font" | "customFont">): string | null {
  if (style.font === "inherit") return null;
  if (style.font === "custom") {
    const name = zaicodeSafeFontName(style.customFont);
    return name ? `"${name}", var(--zaicode-ui-font-family, sans-serif)` : null;
  }
  return ZAICODE_TEXT_FONTS.find((font) => font.id === style.font)?.family || null;
}

/** The declarations of one style; empty when nothing is set. */
export function zaicodeTextStyleDeclarations(style: ZaicodeTextStyle): string[] {
  const out: string[] = [];
  const family = fontFamily(style);
  if (family) out.push(`font-family:${family}`);
  if (style.sizePx > 0) out.push(`font-size:${style.sizePx}px`);
  if (style.weight > 0) out.push(`font-weight:${style.weight}`);
  if (style.italic !== "inherit") out.push(`font-style:${style.italic === "on" ? "italic" : "normal"}`);
  if (style.decoration === "none") out.push("text-decoration-line:none");
  else if (style.decoration !== "inherit") {
    out.push("text-decoration-line:underline", `text-decoration-style:${style.decoration}`);
  }
  if (style.decoration !== "inherit" && style.decoration !== "none") {
    if (style.decorationColor) out.push(`text-decoration-color:${style.decorationColor}`);
    if (style.decorationThickness > 0) out.push(`text-decoration-thickness:${style.decorationThickness}px`);
    if (style.underlineOffset > 0) out.push(`text-underline-offset:${style.underlineOffset}px`);
  }
  if (style.color) out.push(`color:${style.color}`);
  if (style.background) out.push(`background-color:${style.background}`, "box-decoration-break:clone");
  if (style.textCase === "small-caps") out.push("font-variant-caps:small-caps");
  else if (style.textCase !== "inherit") out.push(`text-transform:${style.textCase}`);
  if (style.letterSpacing !== 0) out.push(`letter-spacing:${style.letterSpacing / 100}em`);
  if (style.marginTop >= 0) out.push(`margin-top:${style.marginTop}px`);
  if (style.marginBottom >= 0) out.push(`margin-bottom:${style.marginBottom}px`);
  return out;
}

function rule(selector: string, declarations: readonly string[]): string {
  if (declarations.length === 0) return "";
  return `${selector}{${declarations.map((line) => `${line} !important`).join(";")}}`;
}

function under(selectors: readonly string[]): string {
  return selectors.map((selector) => `${ZAICODE_SESSION_TEXT_ROOT} ${selector}`.trim()).join(",");
}

const RULE_COLOR = (color: string) => color || "var(--color-border, currentColor)";

function headingRule(kind: string, color: string): string[] {
  const line = `1px solid ${RULE_COLOR(color)}`;
  switch (kind) {
    case "under":
      return [`border-bottom:${line}`, "padding-bottom:0.2em"];
    case "over":
      return [`border-top:${line}`, "padding-top:0.2em"];
    case "both":
      return [`border-top:${line}`, `border-bottom:${line}`, "padding:0.15em 0"];
    case "box":
      return [`border:${line}`, "padding:0.15em 0.4em"];
    case "bar":
      return [`border-left:4px solid ${RULE_COLOR(color)}`, "padding-left:0.4em"];
    case "band":
      return [`background-color:${color || "var(--color-surface, transparent)"}`, "padding:0.1em 0.4em"];
    default:
      return [];
  }
}

export function zaicodeSessionTextCss(prefs: ZaicodeSessionTextPrefs): string {
  if (!prefs.enabled) return "";
  const css: string[] = [];
  const body = prefs.body;
  const bodyRoot = zaicodeTextStyleDeclarations({ ...body, marginTop: -1, marginBottom: -1 });
  if (body.lineHeight > 0) bodyRoot.push(`line-height:${body.lineHeight}`);
  if (body.align !== "inherit") bodyRoot.push(`text-align:${body.align}`);
  if (body.maxWidthCh > 0) bodyRoot.push(`max-width:${body.maxWidthCh}ch`);
  if (body.hyphens) bodyRoot.push("hyphens:auto");
  css.push(rule(ZAICODE_SESSION_TEXT_ROOT, bodyRoot));
  const paragraph: string[] = [];
  if (body.indentPx > 0) paragraph.push(`text-indent:${body.indentPx}px`);
  if (body.marginTop >= 0) paragraph.push(`margin-top:${body.marginTop}px`);
  if (body.marginBottom >= 0) paragraph.push(`margin-bottom:${body.marginBottom}px`);
  css.push(rule(under(["p"]), paragraph));
  if (body.selection) css.push(rule(under(["::selection", "*::selection"]), [`background-color:${body.selection}`]));

  for (const level of ZAICODE_HEADING_LEVELS) {
    const heading = prefs.headings[level];
    css.push(rule(under([level]), [...zaicodeTextStyleDeclarations(heading), ...headingRule(heading.rule, heading.ruleColor)]));
  }
  if (prefs.numberHeadings) {
    css.push(`${ZAICODE_SESSION_TEXT_ROOT}{counter-reset:zmd-h1 zmd-h2 zmd-h3}`);
    css.push(`${under(["h1"])}{counter-increment:zmd-h1;counter-reset:zmd-h2 zmd-h3}`);
    css.push(`${under(["h2"])}{counter-increment:zmd-h2;counter-reset:zmd-h3}`);
    css.push(`${under(["h3"])}{counter-increment:zmd-h3}`);
    css.push(`${under(["h1::before"])}{content:counter(zmd-h1) ". "}`);
    css.push(`${under(["h2::before"])}{content:counter(zmd-h1) "." counter(zmd-h2) " "}`);
    css.push(`${under(["h3::before"])}{content:counter(zmd-h1) "." counter(zmd-h2) "." counter(zmd-h3) " "}`);
  }

  css.push(rule(under(["strong", "b"]), zaicodeTextStyleDeclarations(prefs.strong)));
  css.push(rule(under(["em", "i"]), zaicodeTextStyleDeclarations(prefs.em)));
  css.push(rule(under(["del", "s"]), zaicodeTextStyleDeclarations(prefs.del)));

  const link = prefs.link;
  const links = ["a", ".zaicode-md-link"];
  const linkDeclarations = zaicodeTextStyleDeclarations({ ...link, decoration: "inherit" });
  if (link.underline === "always") linkDeclarations.push("text-decoration-line:underline");
  if (link.underline === "hover" || link.underline === "never") linkDeclarations.push("text-decoration-line:none");
  if (link.underline !== "never" && link.decoration !== "inherit" && link.decoration !== "none") {
    linkDeclarations.push(`text-decoration-style:${link.decoration}`);
    if (link.decorationColor) linkDeclarations.push(`text-decoration-color:${link.decorationColor}`);
  }
  css.push(rule(under(links), linkDeclarations));
  const hover: string[] = [];
  if (link.underline === "hover") hover.push("text-decoration-line:underline");
  if (link.hoverColor) hover.push(`color:${link.hoverColor}`);
  css.push(rule(under(links.map((selector) => `${selector}:hover`)), hover));

  const code = prefs.inlineCode;
  const codeDeclarations = zaicodeTextStyleDeclarations(code);
  if (code.border) codeDeclarations.push(`border:1px solid ${code.border}`);
  if (code.paddingPx >= 0) codeDeclarations.push(`padding:0 ${code.paddingPx}px`);
  css.push(rule(under(["code.zaicode-inline-code", ":not(pre) > code"]), codeDeclarations));

  const quote = prefs.quote;
  const quoteDeclarations = zaicodeTextStyleDeclarations(quote);
  if (quote.barWidthPx >= 0) {
    quoteDeclarations.push(`border-left:${quote.barWidthPx}px solid ${quote.barColor || "var(--color-border, currentColor)"}`);
  } else if (quote.barColor) quoteDeclarations.push(`border-left-color:${quote.barColor}`);
  if (quote.indentPx >= 0) quoteDeclarations.push(`padding-left:${quote.indentPx}px`);
  css.push(rule(under(["blockquote"]), quoteDeclarations));

  const list = prefs.list;
  css.push(rule(under(["ul", "ol"]), [
    ...zaicodeTextStyleDeclarations(list),
    ...(list.indentPx >= 0 ? [`padding-left:${list.indentPx}px`] : []),
  ]));
  if (list.bullet !== "default") css.push(rule(under(["ul"]), [`list-style-type:"${list.bullet} "`]));
  if (list.numbers !== "default") css.push(rule(under(["ol"]), [`list-style-type:${list.numbers}`]));
  if (list.gapPx >= 0) css.push(rule(under(["li + li"]), [`margin-top:${list.gapPx}px`]));
  if (list.markerColor) css.push(rule(under(["li::marker"]), [`color:${list.markerColor}`]));

  const table = prefs.table;
  css.push(rule(under(["table"]), zaicodeTextStyleDeclarations(table)));
  const cells: string[] = [];
  if (table.borderColor) cells.push(`border:1px solid ${table.borderColor}`);
  if (table.cellPaddingPx >= 0) cells.push(`padding:${table.cellPaddingPx}px ${table.cellPaddingPx * 1.5}px`);
  css.push(rule(under(["th", "td"]), cells));
  if (table.headerBackground) css.push(rule(under(["th"]), [`background-color:${table.headerBackground}`]));
  if (table.zebra) {
    css.push(rule(under(["tbody tr:nth-child(even) td"]), ["background-color:color-mix(in srgb, currentColor 7%, transparent)"]));
  }

  const hr = prefs.rule;
  const hrDeclarations: string[] = [];
  if (hr.thicknessPx > 0 || hr.color || hr.style !== "solid") {
    hrDeclarations.push("border:0", `border-top:${Math.max(1, hr.thicknessPx)}px ${hr.style} ${hr.color || "var(--color-border, currentColor)"}`);
  }
  if (hr.marginPx >= 0) hrDeclarations.push(`margin:${hr.marginPx}px 0`);
  css.push(rule(under(["hr"]), hrDeclarations));

  return css.filter(Boolean).join("\n");
}
