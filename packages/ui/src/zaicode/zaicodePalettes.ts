/* oxlint-disable eslint(max-lines) -- palette data table imported from the Wintage theme packs. */
/**
 * ZAICODE Wintage palettes.
 *
 * Imported from the Wintage theme packs (`_WIN95THEME/Wintage/themes/*.json`).
 * One palette = the Wintage token set; `paletteCssVariables` maps it onto the
 * app's `--color-*` tokens, so every surface follows the palette without
 * touching component code. Edit a palette here and it hot-reloads in dev.
 *
 * Default is OLED Vintage: black surfaces, grey (#A0A0A0) text, never pure white.
 */
export interface ZaicodePaletteTokens {
  background: string;
  backgroundSoft: string;
  surface: string;
  surfaceRaised: string;
  surfaceAlt: string;
  borderDark: string;
  borderHighlight: string;
  bevelLight: string;
  borderMuted: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accentTeal: string;
  accentTealDeep: string;
  success: string;
  warning: string;
  danger: string;
  dangerText: string;
  selection: string;
  compareBack: string;
  link: string;
}

export interface ZaicodePalette {
  slug: string;
  label: string;
  tokens: ZaicodePaletteTokens;
}

export const ZAICODE_PALETTES: readonly ZaicodePalette[] = [
  {
    slug: "golden",
    label: "Dark Golden (Win95)",
    tokens: {
      background: "#342012",
      backgroundSoft: "#3A2616",
      surface: "#4A341B",
      surfaceRaised: "#5A4324",
      surfaceAlt: "#634B2B",
      borderDark: "#1C1208",
      borderHighlight: "#D3B57A",
      bevelLight: "#826941",
      borderMuted: "#665033",
      textPrimary: "#E2CA95",
      textSecondary: "#C5AB6E",
      textMuted: "#95804C",
      accentTeal: "#008080",
      accentTealDeep: "#006060",
      success: "#5B9630",
      warning: "#969630",
      danger: "#963030",
      dangerText: "#D37676",
      selection: "#5A4324",
      compareBack: "#24170C",
      link: "#D3B57A",
    },
  },
  {
    slug: "claudecode",
    label: "Claude Code",
    tokens: {
      background: "#29241D",
      backgroundSoft: "#2E2922",
      surface: "#3B362A",
      surfaceRaised: "#484436",
      surfaceAlt: "#514C3D",
      borderDark: "#15130F",
      borderHighlight: "#D1A27C",
      bevelLight: "#75644F",
      borderMuted: "#555144",
      textPrimary: "#E0B997",
      textSecondary: "#C39870",
      textMuted: "#93704E",
      accentTeal: "#008080",
      accentTealDeep: "#006060",
      success: "#5B9630",
      warning: "#969630",
      danger: "#963030",
      dangerText: "#D37575",
      selection: "#484436",
      compareBack: "#1C1914",
      link: "#D1A27C",
    },
  },
  {
    slug: "antigravity",
    label: "Antigravity",
    tokens: {
      background: "#1B1F2C",
      backgroundSoft: "#1F2431",
      surface: "#272B3E",
      surfaceRaised: "#31354D",
      surfaceAlt: "#393D55",
      borderDark: "#0D0F17",
      borderHighlight: "#7AD0D3",
      bevelLight: "#4B6678",
      borderMuted: "#404359",
      textPrimary: "#95DEE2",
      textSecondary: "#6EBFC5",
      textMuted: "#4C8F95",
      accentTeal: "#008080",
      accentTealDeep: "#006060",
      success: "#5B9630",
      warning: "#969630",
      danger: "#963030",
      dangerText: "#D06D6D",
      selection: "#31354D",
      compareBack: "#12151E",
      link: "#7AD0D3",
    },
  },
  {
    slug: "klite",
    label: "K-Lite (MPC-HC)",
    tokens: {
      background: "#212325",
      backgroundSoft: "#26282A",
      surface: "#303235",
      surfaceRaised: "#3C3F42",
      surfaceAlt: "#44474A",
      borderDark: "#111213",
      borderHighlight: "#A2A5AB",
      bevelLight: "#5E6165",
      borderMuted: "#494C50",
      textPrimary: "#B8BABF",
      textSecondary: "#95989E",
      textMuted: "#6D6F74",
      accentTeal: "#008080",
      accentTealDeep: "#006060",
      success: "#5B9630",
      warning: "#969630",
      danger: "#963030",
      dangerText: "#D27272",
      selection: "#3C3F42",
      compareBack: "#171819",
      link: "#A2A5AB",
    },
  },
  {
    slug: "freebuff",
    label: "FreeBuff",
    tokens: {
      background: "#1B232B",
      backgroundSoft: "#202830",
      surface: "#28303D",
      surfaceRaised: "#333B4B",
      surfaceAlt: "#3A4354",
      borderDark: "#0E1116",
      borderHighlight: "#89D37A",
      bevelLight: "#506B5F",
      borderMuted: "#414958",
      textPrimary: "#A0E295",
      textSecondary: "#7AC56E",
      textMuted: "#55954C",
      accentTeal: "#008080",
      accentTealDeep: "#006060",
      success: "#5B9630",
      warning: "#969630",
      danger: "#963030",
      dangerText: "#D27272",
      selection: "#333B4B",
      compareBack: "#13181D",
      link: "#89D37A",
    },
  },
  {
    slug: "codenomad",
    label: "CodeNomad",
    tokens: {
      background: "#1C242A",
      backgroundSoft: "#21282F",
      surface: "#29313C",
      surfaceRaised: "#343D4A",
      surfaceAlt: "#3C4552",
      borderDark: "#0E1216",
      borderHighlight: "#9D86D1",
      bevelLight: "#575776",
      borderMuted: "#424A57",
      textPrimary: "#B099DE",
      textSecondary: "#9C84C8",
      textMuted: "#675091",
      accentTeal: "#008080",
      accentTealDeep: "#006060",
      success: "#5B9630",
      warning: "#969630",
      danger: "#963030",
      dangerText: "#D27272",
      selection: "#343D4A",
      compareBack: "#13181D",
      link: "#9D86D1",
    },
  },
  {
    slug: "fpdefault",
    label: "Default",
    tokens: {
      background: "#1A1A1A",
      backgroundSoft: "#2C2C2C",
      surface: "#2B2B2B",
      surfaceRaised: "#343434",
      surfaceAlt: "#3A3A3A",
      borderDark: "#0A0A0A",
      borderHighlight: "#839BB0",
      bevelLight: "#4E555B",
      borderMuted: "#4D4D4D",
      textPrimary: "#C0C0C0",
      textSecondary: "#949494",
      textMuted: "#656565",
      accentTeal: "#008080",
      accentTealDeep: "#004C4C",
      success: "#4A7A20",
      warning: "#7A7A20",
      danger: "#7A2020",
      dangerText: "#DB7575",
      selection: "#343434",
      compareBack: "#141414",
      link: "#839BB0",
    },
  },
  {
    slug: "goldenvintage",
    label: "Golden Vintage",
    tokens: {
      background: "#0F0F0F",
      backgroundSoft: "#1A1A1A",
      surface: "#2B2B2B",
      surfaceRaised: "#333333",
      surfaceAlt: "#393939",
      borderDark: "#050505",
      borderHighlight: "#D6BE76",
      bevelLight: "#655E4A",
      borderMuted: "#4A4A4A",
      textPrimary: "#C4BA9F",
      textSecondary: "#8E8774",
      textMuted: "#605C50",
      accentTeal: "#008080",
      accentTealDeep: "#004C4C",
      success: "#4A7A20",
      warning: "#7A7A20",
      danger: "#7A2020",
      dangerText: "#D45C5C",
      selection: "#333333",
      compareBack: "#0B0B0B",
      link: "#D6BE76",
    },
  },
  {
    slug: "goldendefault",
    label: "Golden Default",
    tokens: {
      background: "#1A1810",
      backgroundSoft: "#232018",
      surface: "#332E22",
      surfaceRaised: "#3D372A",
      surfaceAlt: "#453D30",
      borderDark: "#100E08",
      borderHighlight: "#F0D060",
      bevelLight: "#75663D",
      borderMuted: "#5A5040",
      textPrimary: "#D4C89A",
      textSecondary: "#9C9371",
      textMuted: "#6E674E",
      accentTeal: "#008080",
      accentTealDeep: "#004C4C",
      success: "#4A7A20",
      warning: "#7A7A20",
      danger: "#7A2020",
      dangerText: "#D66464",
      selection: "#3D372A",
      compareBack: "#14120C",
      link: "#F0D060",
    },
  },
  {
    slug: "vintagedark",
    label: "Vintage Dark",
    tokens: {
      background: "#181818",
      backgroundSoft: "#1B1B1B",
      surface: "#2B2B2B",
      surfaceRaised: "#343434",
      surfaceAlt: "#3A3A3A",
      borderDark: "#0A0A0A",
      borderHighlight: "#738EA6",
      bevelLight: "#4A5258",
      borderMuted: "#4D4D4D",
      textPrimary: "#C0C0C0",
      textSecondary: "#8E8E8E",
      textMuted: "#646464",
      accentTeal: "#008080",
      accentTealDeep: "#004C4C",
      success: "#4A7A20",
      warning: "#7A7A20",
      danger: "#7A2020",
      dangerText: "#D45D5D",
      selection: "#343434",
      compareBack: "#121212",
      link: "#738EA6",
    },
  },
  {
    slug: "vintageclassic",
    label: "Vintage Classic",
    tokens: {
      background: "#C0C0C0",
      backgroundSoft: "#FFFFFF",
      surface: "#C0C0C0",
      surfaceRaised: "#D0D0D0",
      surfaceAlt: "#DCDCDC",
      borderDark: "#808080",
      borderHighlight: "#F6F6F6",
      bevelLight: "#F6F6F6",
      borderMuted: "#FFFFFF",
      textPrimary: "#000000",
      textSecondary: "#3A3A3A",
      textMuted: "#6A6A6A",
      accentTeal: "#008080",
      accentTealDeep: "#004C4C",
      success: "#4A7A20",
      warning: "#7A7A20",
      danger: "#7A2020",
      dangerText: "#7A2020",
      selection: "#D0D0D0",
      compareBack: "#D0D0D0",
      link: "#5E7A7A",
    },
  },
  {
    slug: "oled",
    label: "OLED Vintage",
    tokens: {
      background: "#000000",
      backgroundSoft: "#000000",
      surface: "#0A0A0A",
      surfaceRaised: "#141414",
      surfaceAlt: "#1C1C1C",
      borderDark: "#1A1A1A",
      borderHighlight: "#FFFFFF",
      bevelLight: "#5C5C5C",
      borderMuted: "#333333",
      textPrimary: "#A0A0A0",
      textSecondary: "#777777",
      textMuted: "#484848",
      accentTeal: "#008080",
      accentTealDeep: "#004C4C",
      success: "#4A7A20",
      warning: "#7A7A20",
      danger: "#7A2020",
      dangerText: "#CE4444",
      selection: "#141414",
      compareBack: "#000000",
      link: "#FFFFFF",
    },
  },
  {
    slug: "dracula",
    label: "Dracula",
    tokens: {
      background: "#21222C",
      backgroundSoft: "#282A36",
      surface: "#44475A",
      surfaceRaised: "#4C526D",
      surfaceAlt: "#525A7B",
      borderDark: "#191A21",
      borderHighlight: "#BD93F9",
      bevelLight: "#706A9E",
      borderMuted: "#6272A4",
      textPrimary: "#F8F8F2",
      textSecondary: "#B8B8B7",
      textMuted: "#828285",
      accentTeal: "#008080",
      accentTealDeep: "#004C4C",
      success: "#4A7A20",
      warning: "#7A7A20",
      danger: "#7A2020",
      dangerText: "#DA7373",
      selection: "#4C526D",
      compareBack: "#191A21",
      link: "#BD93F9",
    },
  },
  {
    slug: "nord",
    label: "Nord",
    tokens: {
      background: "#272C36",
      backgroundSoft: "#2E3440",
      surface: "#3B4252",
      surfaceRaised: "#3F4758",
      surfaceAlt: "#434B5D",
      borderDark: "#232831",
      borderHighlight: "#88C0D0",
      bevelLight: "#566C7D",
      borderMuted: "#4C566A",
      textPrimary: "#D8DEE9",
      textSecondary: "#A3A9B3",
      textMuted: "#777C87",
      accentTeal: "#008080",
      accentTealDeep: "#004C4C",
      success: "#4A7A20",
      warning: "#7A7A20",
      danger: "#7A2020",
      dangerText: "#DE8282",
      selection: "#3F4758",
      compareBack: "#1D2129",
      link: "#88C0D0",
    },
  },
  {
    slug: "solarized",
    label: "Solarized Dark",
    tokens: {
      background: "#002B36",
      backgroundSoft: "#073642",
      surface: "#073642",
      surfaceRaised: "#1B444F",
      surfaceAlt: "#2B4F59",
      borderDark: "#001F27",
      borderHighlight: "#51A2DB",
      bevelLight: "#36667D",
      borderMuted: "#586E75",
      textPrimary: "#93A1A1",
      textSecondary: "#8D9EA1",
      textMuted: "#426066",
      accentTeal: "#008080",
      accentTealDeep: "#004C4C",
      success: "#4A7A20",
      warning: "#7A7A20",
      danger: "#7A2020",
      dangerText: "#DD7D7D",
      selection: "#1B444F",
      compareBack: "#002029",
      link: "#51A2DB",
    },
  },
  {
    slug: "custom",
    label: "Custom",
    tokens: {
      background: "#1A1810",
      backgroundSoft: "#232018",
      surface: "#332E22",
      surfaceRaised: "#3D372A",
      surfaceAlt: "#453D30",
      borderDark: "#100E08",
      borderHighlight: "#F0D060",
      bevelLight: "#75663D",
      borderMuted: "#5A5040",
      textPrimary: "#D4C89A",
      textSecondary: "#9C9371",
      textMuted: "#6E674E",
      accentTeal: "#008080",
      accentTealDeep: "#004C4C",
      success: "#4A7A20",
      warning: "#7A7A20",
      danger: "#7A2020",
      dangerText: "#D66464",
      selection: "#3D372A",
      compareBack: "#14120C",
      link: "#F0D060",
    },
  },
];

export const ZAICODE_DEFAULT_PALETTE = "oled";
/** Palette value meaning "use the upstream ZCode colours". */
export const ZAICODE_PALETTE_NONE = "none";

export function findZaicodePalette(slug: string | null | undefined): ZaicodePalette | null {
  return ZAICODE_PALETTES.find((palette) => palette.slug === slug) ?? null;
}

function hexLuminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Same polarity rule as Wintage: background luminance below 0.18 is a dark palette. */
export function isDarkPalette(palette: ZaicodePalette): boolean {
  return hexLuminance(palette.tokens.background) < 0.18;
}

/** Wintage tokens -> app `--color-*` variables. */
export function paletteCssVariables(palette: ZaicodePalette): Record<string, string> {
  const t = palette.tokens;
  return {
    "--animated-gradient-text-strong": t.textPrimary,
    "--animated-gradient-text-soft": t.textMuted,
    "--color-background": t.background,
    "--color-background-win-alt": t.surface,
    "--color-background-alt": t.backgroundSoft,
    "--color-brand": t.textPrimary,
    "--color-sidebar": t.background,
    "--color-header": t.backgroundSoft,
    "--color-panel": t.backgroundSoft,
    "--color-card": t.surface,
    "--color-card-selected": t.surfaceAlt,
    "--color-card-border": t.borderMuted,
    "--color-popover": t.surface,
    "--color-popover-foreground": t.textPrimary,
    "--color-popover-header": t.backgroundSoft,
    "--color-popover-border": t.borderMuted,
    "--color-tooltip": t.surface,
    "--color-tooltip-foreground": t.textPrimary,
    "--color-tooltip-tag": t.surfaceRaised,
    "--color-tooltip-tag-foreground": t.link,
    "--color-toast": t.surface,
    "--zaicode-highlight": t.borderHighlight,
    "--zaicode-bevel-light": t.bevelLight,
    "--zaicode-bevel-dark": t.borderDark,
    "--color-input": t.compareBack,
    "--color-input-focused": t.compareBack,
    "--color-input-border": t.borderMuted,
    "--color-input-border-hover": t.bevelLight,
    "--color-input-border-focused": t.borderHighlight,
    "--color-menu": t.surface,
    "--color-menu-hover": t.surfaceRaised,
    "--color-tab": t.backgroundSoft,
    "--color-tab-active": t.background,
    "--color-tab-border": t.borderMuted,
    "--color-border": t.borderMuted,
    "--color-border-hover": t.bevelLight,
    "--color-hover": t.surfaceRaised,
    "--color-selected": t.surfaceAlt,
    "--color-surface": t.surface,
    "--color-surface-hover": t.surfaceRaised,
    "--color-foreground": t.textPrimary,
    "--color-foreground-subtle": t.textSecondary,
    "--color-foreground-subtlest": t.textMuted,
    "--color-foreground-inverse": t.background,
    "--color-primary": t.textPrimary,
    "--color-primary-foreground": t.background,
    "--color-secondary": t.surfaceRaised,
    "--color-accent": t.accentTealDeep,
    "--color-success": t.success,
    "--color-warning": t.warning,
    "--color-destructive": t.dangerText,
    "--color-terminal-bg": t.background,
    "--color-terminal-fg": t.textPrimary,
    "--color-terminal-cursor": t.textPrimary,
    "--color-terminal-cursor-accent": t.background,
  };
}

/**
 * Pixel mode: no antialiasing anywhere the renderer lets CSS decide it —
 * square corners, no shadows/blur, no smoothing hints, pixelated images,
 * crisp vector edges, Verdana (hinted bitmap-friendly) as the UI face.
 */
export const ZAICODE_CRISP_CSS = `
html.zaicode-fonts, html.zaicode-fonts body, html.zaicode-fonts * {
  font-family: var(--zaicode-ui-font-family) !important;
}
/* body carries no colour upstream, so a portaled surface (Timers, toasts, tours) that
   forgot its own text class drew browser-default black on the dark theme (SRC-043). */
html.zaicode-fonts body {
  color: var(--color-foreground);
}
html.zaicode-fonts pre, html.zaicode-fonts code, html.zaicode-fonts .font-mono, html.zaicode-fonts [data-diffs] {
  font-family: var(--font-mono) !important;
  font-variant-ligatures: var(--zaicode-code-ligatures);
  line-height: var(--zaicode-code-line-height);
}
html.zaicode-fonts .zaicode-inline-code {
  font-size: var(--zaicode-inline-code-size) !important;
}
/* ZAICODE: no rounded shapes anywhere, independent of pixel mode.
   Tailwind's important utilities (!rounded-lg) live in a cascade layer, and a
   layered !important beats this unlayered one, so the radius tokens they read
   are zeroed too (custom properties also reach shadow roots via inheritance). */
html.zaicode-fonts {
  --radius: 0px;
  --radius-xs: 0px;
  --radius-sm: 0px;
  --radius-md: 0px;
  --radius-lg: 0px;
  --radius-xl: 0px;
  --radius-2xl: 0px;
  --radius-3xl: 0px;
  --radius-4xl: 0px;
}
html.zaicode-fonts *, html.zaicode-fonts *::before, html.zaicode-fonts *::after {
  border-radius: 0 !important;
}
/* Chromium ignores ::-webkit-scrollbar once scrollbar-color is set, and its
   standard thumb is rounded; switch back to the styled (square, bevelled) one. */
html.zaicode-fonts * {
  scrollbar-color: auto !important;
  scrollbar-width: auto !important;
}
html.zaicode-fonts *::-webkit-scrollbar {
  width: 14px;
  height: 14px;
  background: var(--color-background-alt, var(--color-background));
}
html.zaicode-fonts *::-webkit-scrollbar-track {
  background: var(--color-background-alt, var(--color-background));
  border-left: 1px solid var(--zaicode-bevel-dark, var(--color-border));
}
html.zaicode-fonts *::-webkit-scrollbar-thumb {
  min-height: 24px;
  min-width: 24px;
  border-radius: 0 !important;
  background: var(--color-surface-hover, var(--color-border));
  background-clip: border-box;
  border: 1px solid;
  border-color: var(--zaicode-bevel-light, var(--color-border-hover))
    var(--zaicode-bevel-dark, var(--color-border))
    var(--zaicode-bevel-dark, var(--color-border))
    var(--zaicode-bevel-light, var(--color-border-hover));
}
html.zaicode-fonts *::-webkit-scrollbar-thumb:hover {
  background: var(--color-selected, var(--color-border-hover));
}
html.zaicode-fonts *::-webkit-scrollbar-corner,
html.zaicode-fonts *::-webkit-resizer {
  background: var(--color-background-alt, var(--color-background));
  border-radius: 0 !important;
}
html.zaicode-fonts input[type="radio"],
html.zaicode-fonts input[type="range"]::-webkit-slider-thumb {
  border-radius: 0 !important;
}
html.zaicode-crisp *, html.zaicode-crisp *::before, html.zaicode-crisp *::after {
  -webkit-font-smoothing: none !important;
  -moz-osx-font-smoothing: unset !important;
  font-smooth: never !important;
  font-synthesis: none !important;
  font-optical-sizing: none !important;
  letter-spacing: normal !important;
  text-rendering: optimizeSpeed !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  text-shadow: none !important;
  backdrop-filter: none !important;
  transition: none !important;
}
html.zaicode-palette [data-slot="tooltip-content"] {
  border-color: var(--zaicode-highlight) !important;
  color: var(--color-tooltip-foreground);
}
html.zaicode-crisp img, html.zaicode-crisp canvas, html.zaicode-crisp video {
  image-rendering: pixelated !important;
}
html.zaicode-crisp svg, html.zaicode-crisp svg * {
  shape-rendering: crispEdges !important;
}
html.zaicode-crisp svg:not([data-zaicode-pixel-filter]) {
  filter: url(#zaicode-pixel-threshold) !important;
}
/* Readable pixel icons: a 2px stroke drawn at 14px is ~1.2 device px, which the
   alpha threshold above breaks into dots; a heavier stroke survives it. */
html.zaicode-crisp svg.lucide {
  stroke-width: 2.6px;
}
/* Sidebar row actions (…, files, new session, START) were 14px glyphs: too small to read. */
html.zaicode-fonts [data-testid="sidebar"] svg.lucide.size-3\\.5,
html.zaicode-fonts [data-testid="sidebar"] svg.lucide.h-3\\.5 {
  width: 16px !important;
  height: 16px !important;
}
/* Calm interface (Settings -> Layout & home): nothing moves, nothing dims, nothing pops up on hover. */
html.zaicode-no-motion *, html.zaicode-no-motion *::before, html.zaicode-no-motion *::after {
  animation: none !important;
  transition: none !important;
  scroll-behavior: auto !important;
}
html.zaicode-no-dim *, html.zaicode-no-dim *::before, html.zaicode-no-dim *::after {
  backdrop-filter: none !important;
}
html.zaicode-no-dim [data-slot="dialog-overlay"],
html.zaicode-no-dim [data-slot="alert-dialog-overlay"],
html.zaicode-no-dim [data-slot="sheet-overlay"] {
  background: transparent !important;
}
html.zaicode-no-popups [data-slot="tooltip-content"],
html.zaicode-no-popups [data-slot="hover-card-content"],
html.zaicode-no-popups [data-zaicode-hover-popup] {
  display: none !important;
}
/* Compact sidebar: no bubbly spacing between project rows. */
html.zaicode-fonts [data-testid="sidebar"] [data-testid="workspace-list"] > li {
  margin-top: 0 !important;
}
`;
