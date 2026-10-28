/**
 * Hard bevels, the Wintage FastPrompter look (SRC-048, optional, default on):
 * every button, tab, field, menu, pop-up and list row gets the 2 px Win95
 * edge -- light top-left, dark bottom-right when raised; the other way round
 * when pressed, selected or sunken (fields, the open row).
 *
 * The edge is an inset box-shadow, not a border: it takes no room, so
 * switching it on or off never moves anything (saipen UI "the layout never
 * moves"). Colours come from the palette's own bevel tokens (Golden Default
 * bevelLight / borderDark), mixed toward the face for the inner pixel.
 *
 * Specificity: pixel mode clears every shadow with `html.zaicode-crisp *`
 * (0,1,1) !important; every rule here is at least (0,1,2) !important.
 * The list-row rules additionally carry [data-zaicode-style], so the explicit
 * rows toggle outranks the presentation preset shadow kill (same source order
 * would otherwise win the tie for role=button rows under non-classic styles).
 */

const HI = "var(--zaicode-bevel-light, var(--color-border-hover, #75663d))";
const LO = "var(--zaicode-bevel-dark, #100e08)";
const HI2 = `color-mix(in srgb, ${HI} 55%, transparent)`;
const LO2 = `color-mix(in srgb, ${LO} 60%, transparent)`;

/** Dark lines first: they win the top-right and bottom-left corner pixels, as on Windows 95. */
export const ZAICODE_BEVEL_RAISED = `inset -1px -1px 0 0 ${LO}, inset 1px 1px 0 0 ${HI}, inset -2px -2px 0 0 ${LO2}, inset 2px 2px 0 0 ${HI2}`;
export const ZAICODE_BEVEL_SUNKEN = `inset 1px 1px 0 0 ${LO}, inset -1px -1px 0 0 ${HI}, inset 2px 2px 0 0 ${LO2}, inset -2px -2px 0 0 ${HI2}`;

/** Raised controls. */
const RAISED = [
  "button",
  '[role="button"]:not([data-testid^="workspace-item-"])',
  '[data-slot="tabs-trigger"]',
  '[data-slot="select-trigger"]',
  '[data-slot="dropdown-menu-trigger"]',
  '[data-slot="switch-thumb"]',
  'input[type="button"]',
  'input[type="submit"]',
].map((selector) => `html.zaicode-bevels ${selector}`);

/** Pressed, on, selected: the same control sunk in. */
const PRESSED = [
  "button:active",
  '[role="button"]:active:not([data-testid^="workspace-item-"])',
  'button[aria-pressed="true"]',
  'button[aria-checked="true"]',
  'button[aria-selected="true"]',
  'button[data-state="on"]',
  'button[data-state="open"]',
  '[data-slot="tabs-trigger"][data-state="active"]',
].map((selector) => `html.zaicode-bevels ${selector}`);

/** Fields and wells: always sunken. */
const SUNKEN = [
  'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="button"]):not([type="submit"]):not([type="file"])',
  "textarea",
  '[data-slot="input-group"]',
  '[data-slot="switch"]',
  '[data-slot="checkbox"]',
  '[data-slot="progress"]',
  '[data-slot="tabs-list"]',
  '[data-v4-composer-dock-content="true"] [contenteditable="true"]',
].map((selector) => `html.zaicode-bevels ${selector}`);

/** Windows that float over the app: raised frames. */
const FLOATING = [
  '[data-slot="popover-content"]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="dropdown-menu-sub-content"]',
  '[data-slot="context-menu-content"]',
  '[data-slot="context-menu-sub-content"]',
  '[data-slot="select-content"]',
  '[data-slot="hover-card-content"]',
  '[data-slot="dialog-content"]',
  '[data-slot="alert-dialog-content"]',
  '[data-slot="sheet-content"]',
  '[data-slot="tooltip-content"]',
  '[role="tooltip"]',
].map((selector) => `html.zaicode-bevels ${selector}`);

/**
 * Sidebar rows (sub-option "list rows"): raised like FastPrompter's list; the
 * open one sunken. The generic raised/pressed rules above exclude the same row
 * prefix, so this sub-toggle owns the rows in every presentation: OFF is flat
 * (under Classic the generic role=button bevel used to keep them raised, which
 * is why the toggle looked dead) and ON outranks the presentation shadow kill.
 */
const ROWS = [
  '[data-testid^="workspace-item-"]',
  'li[data-testid^="task-item-"]',
].map((selector) => `html.zaicode-bevels.zaicode-bevel-rows[data-zaicode-style] ${selector}`);
const ROWS_OPEN = [
  'li[data-testid^="task-item-"].bg-selected',
].map((selector) => `html.zaicode-bevels.zaicode-bevel-rows[data-zaicode-style] ${selector}`);

export const ZAICODE_BEVEL_CSS = `
/* 项目选择必须独立于会话标题的亮色和 raised bevel，整行保持可见的内框。 */
html.zaicode-fonts [data-zaicode-project-selected] {
  outline: 2px solid var(--zaicode-highlight, var(--color-foreground)) !important;
  outline-offset: -2px !important;
}
${RAISED.join(",\n")},
${FLOATING.join(",\n")},
${ROWS.join(",\n")} {
  box-shadow: ${ZAICODE_BEVEL_RAISED} !important;
}
${SUNKEN.join(",\n")},
${PRESSED.join(",\n")},
${ROWS_OPEN.join(",\n")} {
  box-shadow: ${ZAICODE_BEVEL_SUNKEN} !important;
}
html.zaicode-bevels.zaicode-bevel-rows[data-zaicode-style] [data-testid^="workspace-item-"][data-zaicode-project-selected] {
  box-shadow: ${ZAICODE_BEVEL_SUNKEN} !important;
}
/* The one sanctioned movement: a pressed button's label shifts 1 px (saipen UI). */
html.zaicode-bevels button:active:not(:disabled) > * {
  translate: 1px 1px;
}
/* Keyboard focus: the bevel above replaces the upstream focus ring (also a box-shadow), so
   focus is the Windows 95 dotted rectangle inside the edge -- an outline, it takes no room. */
${RAISED.map((selector) => `${selector}:focus-visible`).join(",\n")} {
  outline: 1px dotted var(--zaicode-highlight, currentColor) !important;
  outline-offset: -4px !important;
}
/* A disabled control keeps its edge, only quieter. */
html.zaicode-bevels button:disabled {
  box-shadow: inset -1px -1px 0 0 ${LO2}, inset 1px 1px 0 0 ${HI2} !important;
}
/* Highlight shapes that draw with box-shadow (underline, side bar) keep their own. */
html.zaicode-bevels [data-zh][data-zh-shape~="underline"],
html.zaicode-bevels [data-zh][data-zh-shape~="bar"] {
  box-shadow: var(--zh-underline, 0 0 transparent), var(--zh-bar, 0 0 transparent) !important;
}
`;
