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

/** The toolbar buttons when the whole choice is small, or null to keep the dropdown. */
export function zaicodeToolbarModelButtons(
  groups: readonly ModelSelectGroup[],
): ZaicodeModelButton[] | null {
  if (!isZaicodeProductMode()) return null;
  if (groups.some(hasConnectionChoice)) return null;
  const buttons = groups.flatMap((group) =>
    group.items.map((item) => ({
      value: item.value,
      label: item.name,
      title: `${group.label} · ${item.name}`,
    })),
  );
  if (buttons.length === 0 || buttons.length > ZAICODE_MODEL_BUTTONS_MAX) return null;
  return buttons;
}
