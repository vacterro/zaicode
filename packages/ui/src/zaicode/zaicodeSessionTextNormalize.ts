import {
  ZAICODE_HEADING_LEVELS,
  ZAICODE_HEADING_RULES,
  ZAICODE_LINE_STYLES,
  ZAICODE_LINK_UNDERLINES,
  ZAICODE_LIST_BULLETS,
  ZAICODE_LIST_NUMBERS,
  ZAICODE_TEXT_ALIGNS,
  ZAICODE_USER_TEXT_MODES,
  normalizeZaicodeTextStyle,
  zaicodeSessionTextDefaults,
  zaicodeTextColor,
  type ZaicodeHeadingStyle,
  type ZaicodeSessionTextPrefs,
} from "./zaicodeSessionTextModel.js";

/**
 * Stored / imported session-text settings -> a complete, safe value. Anything
 * unknown or out of range falls back to the default ("inherit"), never to a
 * guess; colours must be #rrggbb and font names cannot carry CSS syntax.
 */

type Raw = Record<string, unknown>;

function record(value: unknown): Raw {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {};
}

function num(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value * 100) / 100)) : fallback;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function color(value: unknown, fallback: string): string {
  return value === undefined ? fallback : zaicodeTextColor(value);
}

export function normalizeZaicodeSessionText(raw: unknown): ZaicodeSessionTextPrefs {
  const d = zaicodeSessionTextDefaults();
  const r = record(raw);
  const body = record(r.body);
  const headings = record(r.headings);
  const link = record(r.link);
  const code = record(r.inlineCode);
  const quote = record(r.quote);
  const list = record(r.list);
  const table = record(r.table);
  const rule = record(r.rule);
  return {
    enabled: flag(r.enabled, d.enabled),
    body: {
      ...normalizeZaicodeTextStyle(body, d.body),
      lineHeight: body.lineHeight === 0 ? 0 : num(body.lineHeight, 1, 3, d.body.lineHeight),
      align: oneOf(body.align, ZAICODE_TEXT_ALIGNS, d.body.align),
      maxWidthCh: body.maxWidthCh === 0 ? 0 : num(body.maxWidthCh, 40, 200, d.body.maxWidthCh),
      indentPx: num(body.indentPx, 0, 96, d.body.indentPx),
      hyphens: flag(body.hyphens, d.body.hyphens),
      selection: color(body.selection, d.body.selection),
    },
    headings: Object.fromEntries(
      ZAICODE_HEADING_LEVELS.map((level) => {
        const h = record(headings[level]);
        const style: ZaicodeHeadingStyle = {
          ...normalizeZaicodeTextStyle(h, d.headings[level]),
          rule: oneOf(h.rule, ZAICODE_HEADING_RULES, d.headings[level].rule),
          ruleColor: color(h.ruleColor, d.headings[level].ruleColor),
        };
        return [level, style];
      }),
    ) as ZaicodeSessionTextPrefs["headings"],
    numberHeadings: flag(r.numberHeadings, d.numberHeadings),
    strong: normalizeZaicodeTextStyle(r.strong, d.strong),
    em: normalizeZaicodeTextStyle(r.em, d.em),
    del: normalizeZaicodeTextStyle(r.del, d.del),
    link: {
      ...normalizeZaicodeTextStyle(link, d.link),
      underline: oneOf(link.underline, ZAICODE_LINK_UNDERLINES, d.link.underline),
      hoverColor: color(link.hoverColor, d.link.hoverColor),
    },
    inlineCode: {
      ...normalizeZaicodeTextStyle(code, d.inlineCode),
      border: color(code.border, d.inlineCode.border),
      paddingPx: num(code.paddingPx, -1, 12, d.inlineCode.paddingPx),
    },
    quote: {
      ...normalizeZaicodeTextStyle(quote, d.quote),
      barColor: color(quote.barColor, d.quote.barColor),
      barWidthPx: num(quote.barWidthPx, -1, 12, d.quote.barWidthPx),
      indentPx: num(quote.indentPx, -1, 64, d.quote.indentPx),
    },
    list: {
      ...normalizeZaicodeTextStyle(list, d.list),
      bullet: oneOf(list.bullet, ZAICODE_LIST_BULLETS, d.list.bullet),
      numbers: oneOf(list.numbers, ZAICODE_LIST_NUMBERS, d.list.numbers),
      markerColor: color(list.markerColor, d.list.markerColor),
      indentPx: num(list.indentPx, -1, 64, d.list.indentPx),
      gapPx: num(list.gapPx, -1, 32, d.list.gapPx),
    },
    table: {
      ...normalizeZaicodeTextStyle(table, d.table),
      borderColor: color(table.borderColor, d.table.borderColor),
      headerBackground: color(table.headerBackground, d.table.headerBackground),
      zebra: flag(table.zebra, d.table.zebra),
      cellPaddingPx: num(table.cellPaddingPx, -1, 24, d.table.cellPaddingPx),
    },
    rule: {
      style: oneOf(rule.style, ZAICODE_LINE_STYLES, d.rule.style),
      color: color(rule.color, d.rule.color),
      thicknessPx: num(rule.thicknessPx, 0, 8, d.rule.thicknessPx),
      marginPx: num(rule.marginPx, -1, 96, d.rule.marginPx),
    },
    userMessage: (() => {
      const source = record(r.userMessage);
      const user = record(source.style);
      return {
        mode: oneOf(source.mode, ZAICODE_USER_TEXT_MODES, d.userMessage.mode),
        style: {
          ...normalizeZaicodeTextStyle(user, d.userMessage.style),
          lineHeight: user.lineHeight === 0 ? 0 : num(user.lineHeight, 1, 3, d.userMessage.style.lineHeight),
          align: oneOf(user.align, ZAICODE_TEXT_ALIGNS, d.userMessage.style.align),
          borderColor: color(user.borderColor, d.userMessage.style.borderColor),
          borderWidthPx: num(user.borderWidthPx, -1, 12, d.userMessage.style.borderWidthPx),
          borderRadiusPx: num(user.borderRadiusPx, -1, 48, d.userMessage.style.borderRadiusPx),
          paddingPx: num(user.paddingPx, -1, 48, d.userMessage.style.paddingPx),
        },
      };
    })(),
  };
}
