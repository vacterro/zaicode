import { useZaicodeLights, zaicodeHighlightAttrs, type ZaicodeHighlightTarget } from "./zaicodeHighlights.js";
import { resolveZaicodeModelHighlight, useZaicodeModelAppearancePrefs } from "./zaicodeModelAppearance.js";

export function useZaicodeModelHighlight(target: ZaicodeHighlightTarget, active: boolean, stateColor?: string | null, model?: string | null) {
  const global = useZaicodeLights((state) => state.highlights[target]);
  const prefs = useZaicodeModelAppearancePrefs();
  return active ? zaicodeHighlightAttrs(target, resolveZaicodeModelHighlight(prefs, model, target, global), stateColor) : null;
}
