export const ZAICODE_PRESENTATIONS = [
  { id: "classic", label: "Classic", hint: "Existing vintage bevels" },
  { id: "simple-boxes", label: "Simple Boxes", hint: "Clear one-pixel boxes, no decorative depth" },
  { id: "flat", label: "Flat", hint: "Flat controls and restrained separators" },
  { id: "minimal", label: "Minimal", hint: "Quiet controls, borders on interaction" },
] as const;
export type ZaicodePresentation = typeof ZAICODE_PRESENTATIONS[number]["id"];
export function normalizeZaicodePresentation(value: string | null, legacyBevels = true): ZaicodePresentation {
  return ZAICODE_PRESENTATIONS.find((preset) => preset.id === value)?.id ?? (legacyBevels ? "classic" : "simple-boxes");
}
/** Presentation only: semantic palette variables and existing disabled/hover rules survive. */
export const ZAICODE_PRESENTATION_CSS = `
html[data-zaicode-style]:not([data-zaicode-style="classic"]) :is(button,[role="button"],input,textarea,[data-slot$="content"],[data-slot="select-trigger"]) {
  box-shadow: none !important;
  border-radius: 0 !important;
}
html[data-zaicode-style="simple-boxes"] :is(button,[role="button"],input,textarea,[data-slot$="content"],[data-slot="select-trigger"]) {
  border: 1px solid var(--color-border);
}
html[data-zaicode-style="flat"] :is(button,[role="button"]) { border-color: var(--color-border); }
html[data-zaicode-style="minimal"] :is(button,[role="button"]):not(:hover):not(:focus-visible):not([aria-pressed="true"]):not([aria-selected="true"]) { border-color: transparent; }
html[data-zaicode-style]:not([data-zaicode-style="classic"]) :is(button,[role="button"],input,textarea):focus-visible {
  outline: 1px solid var(--color-input-border-focused, var(--color-brand)) !important;
  outline-offset: 2px;
}
html[data-zaicode-style]:not([data-zaicode-style="classic"]) :is(button,[role="button"]):hover:not(:disabled) { border-color: var(--color-border-hover); }
`;
