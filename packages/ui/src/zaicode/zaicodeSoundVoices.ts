/**
 * The orchestra's ear (SRC-060): which Sounds-table voice a click or a changed
 * form field plays. Pure and asset-free, so it is testable without a DOM; the
 * listeners live in zaicodeSoundEvents.ts (installZaicodeDeclarativeSounds).
 */

/** The part of an Element the click classifier reads (a fake in tests). */
export interface ZaicodeSoundTarget {
  closest(selector: string): ZaicodeSoundTarget | null;
  getAttribute(name: string): string | null;
}

const MENU_ITEM = "[role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [role='option']";
export const ZAICODE_CLICKABLE = "button, [role='button'], summary";

/**
 * SRC-060: which orchestra voice a plain click on `target` plays, or null.
 * `expandedBefore` is the control's aria-expanded before the click (the click
 * itself flips it). Form fields (tick boxes, radios, selects, sliders) answer
 * on "change" instead, and a control with data-zaicode-sound plays its own.
 */
export function zaicodeClickSoundFor(target: ZaicodeSoundTarget, expandedBefore: string | null): string | null {
  if (target.closest("[data-zaicode-sound], [aria-disabled='true'], :disabled")) return null;
  if (target.closest("[role='switch']")) return "ui.toggle";
  if (target.closest("[role='tab']")) return "ui.tab";
  if (target.closest(MENU_ITEM)) return "ui.menuItem";
  if (target.closest("input, select, textarea, [contenteditable='true']")) return null;
  const control = target.closest(ZAICODE_CLICKABLE);
  if (control) {
    const popup = control.getAttribute("aria-haspopup");
    if (expandedBefore === "true") return "ui.collapse";
    if (popup && popup !== "false") return "ui.menuOpen";
    if (expandedBefore === "false") return "ui.expand";
    return "ui.button";
  }
  if (target.closest("a[href]")) return "ui.link";
  return null;
}

/** The voice of a changed form field: tick boxes tick on/off, sliders blip, choices click. */
export function zaicodeChangeSoundFor(
  target: ZaicodeSoundTarget,
  field: { type?: string; checked?: boolean },
): string | null {
  if (target.closest("[data-zaicode-sound], [aria-disabled='true'], :disabled")) return null;
  if (target.closest("[role='switch']")) return "ui.toggle";
  if (field.type === "checkbox") return field.checked ? "ui.checkOn" : "ui.checkOff";
  if (field.type === "range") return "ui.slider";
  if (field.type === "radio" || target.closest("select")) return "ui.select";
  return null;
}

/**
 * Groups whose sounds answer the operator's own hand (SRC-062): with
 * "Interface sounds one at a time" a new one fades the one still ringing, so
 * fast clicking through projects never piles sounds up. Agent, engine and
 * mail sounds are news, not echoes of a click: they always mix.
 */
export const ZAICODE_SOUND_CHOKE_GROUPS: ReadonlySet<string> = new Set([
  "Interface",
  "Orchestra",
  "Sidebar",
  "Sessions",
  "Window",
  "Composer",
]);

export function isZaicodeChokeGroup(group: string): boolean {
  return ZAICODE_SOUND_CHOKE_GROUPS.has(group);
}
