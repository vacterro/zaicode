import { isZaicodeProductMode } from "@zcode/shared";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";

/**
 * T-136 / SRC-102: "buttons instead of the combobox; the combobox only when there are many
 * models -- otherwise buttons are enough." A provider with two models (SAIRoute: SAIFREN,
 * SAIOPP) sat behind a hover submenu, and the composer showed a dropdown for a handful of
 * choices.
 *
 * - Composer toolbar: up to ZAICODE_MODEL_BUTTONS_MAX models in all -> one button per model,
 *   plus a small menu button (Manage models, keyboard Ctrl+M); more -> the dropdown as before.
 * - Inside the dropdown: a provider with up to ZAICODE_MODEL_CHIP_GROUP_MAX models shows them as
 *   buttons under its name instead of a submenu; a bigger provider keeps its submenu.
 * A provider with a choice of connections keeps the menu (the choice lives there).
 */

export const ZAICODE_MODEL_BUTTONS_MAX = 6;
export const ZAICODE_MODEL_CHIP_GROUP_MAX = 4;

export interface ZaicodeModelButton {
  value: string;
  label: string;
  title: string;
  owner?: string;
}

function hasConnectionChoice(group: ModelSelectGroup): boolean {
  return (group.connectionOptions?.length ?? 0) > 1;
}

/** A provider small enough to show its models as buttons inside the dropdown. */
export function zaicodeGroupAsButtons(group: ModelSelectGroup): boolean {
  return (
    isZaicodeProductMode() &&
    group.items.length > 0 &&
    group.items.length <= ZAICODE_MODEL_CHIP_GROUP_MAX &&
    !hasConnectionChoice(group)
  );
}

/** Filters eligible buttons according to user visibility preferences while preserving selected model. */
export function zaicodeFilterVisibleModelButtons(
  buttons: readonly ZaicodeModelButton[],
  prefs?: { hiddenButtons: string[] | null } | null,
  selectedValue?: string,
): ZaicodeModelButton[] {
  if (!prefs?.hiddenButtons || prefs.hiddenButtons.length === 0) {
    return [...buttons];
  }
  const hidden = new Set(prefs.hiddenButtons);
  return buttons.filter((button) => {
    // Preserve selected model visibility
    if (selectedValue && button.value === selectedValue) {
      return true;
    }
    return !hidden.has(button.value);
  });
}

/** The toolbar buttons when the whole choice is small, or null to keep the dropdown. */
export function zaicodeToolbarModelButtons(
  groups: readonly ModelSelectGroup[],
  prefs?: { hiddenButtons: string[] | null } | null,
  selectedValue?: string,
): ZaicodeModelButton[] | null {
  if (!isZaicodeProductMode()) return null;
  if (groups.some(hasConnectionChoice)) return null;
  const buttons = groups.flatMap((group) =>
    group.items.map((item) => ({
      value: item.value,
      label: item.name,
      title: `${group.label} · ${item.name}`,
      owner: group.label,
    })),
  );
  if (buttons.length === 0 || buttons.length > ZAICODE_MODEL_BUTTONS_MAX) return null;
  // REQ-006: two accounts serving the same model name must not render two
  // identical buttons. Only the colliding labels gain their owner; unique
  // names stay short.
  const seen = new Map<string, number>();
  for (const button of buttons) seen.set(button.label, (seen.get(button.label) ?? 0) + 1);
  const eligible = buttons.map(({ owner, ...button }) => ({
    ...button,
    owner,
    label: (seen.get(button.label) ?? 0) > 1 ? `${button.label} (${owner})` : button.label,
  }));
  if (!prefs) return eligible;
  const visible = zaicodeFilterVisibleModelButtons(eligible, prefs, selectedValue);
  return visible.length > 0 ? visible : null;
}
