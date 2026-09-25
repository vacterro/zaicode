import type { ZaicodeSoundEntry, ZaicodeSoundKind } from "./zaicodeSoundCatalog.js";
import { nextZaicodeCombo } from "./zaicodeCombo.js";

/**
 * Sound picker filters (SRC-038): several kinds at once instead of hopping
 * between tabs. A plain click picks one tab; Shift / Ctrl + click adds or
 * removes a tab; pressing on a tab and dragging across others selects them
 * all. "All" clears the choice.
 */

export type ZaicodeSoundTab = ZaicodeSoundKind | "all" | "favorites";

/** The tabs after a click on `tab`; `additive` = Shift or Ctrl held. */
export function nextZaicodeSoundTabs(
  current: readonly ZaicodeSoundTab[],
  tab: ZaicodeSoundTab,
  additive: boolean,
): ZaicodeSoundTab[] {
  return nextZaicodeCombo(current, tab, additive, { neutral: "all" });
}

/** Adds `tab` to a drag selection that started on `anchor` (never removes). */
export function dragZaicodeSoundTabs(current: readonly ZaicodeSoundTab[], tab: ZaicodeSoundTab): ZaicodeSoundTab[] {
  if (tab === "all") return ["all"];
  const base = current.filter((entry) => entry !== "all");
  return base.includes(tab) ? [...base] : [...base, tab];
}

/** Whether a library entry passes the selected tabs. */
export function zaicodeSoundInTabs(
  entry: Pick<ZaicodeSoundEntry, "id" | "kind">,
  tabs: readonly ZaicodeSoundTab[],
  favorites: ReadonlySet<string>,
): boolean {
  if (tabs.length === 0 || tabs.includes("all")) return true;
  return tabs.includes(entry.kind) || (tabs.includes("favorites") && favorites.has(entry.id));
}
