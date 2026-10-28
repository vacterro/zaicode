import { useEffect } from "react";
import { toast } from "@/components/ui/toast.js";
import { openZaicodeSettings } from "./zaicodeActions.js";
import { undoLastApply } from "./zaicodePresetApply.js";
import { zaicodePresetEnv } from "./zaicodePresetEnv.js";
import { takePresetReopen, type PresetReopen } from "./zaicodePresetReopen.js";
import { useZaicodePresets } from "./zaicodePresetStore.js";

/**
 * After a preset reloaded the window (a page that only reads its settings at start), comes back to the
 * Settings page it was applied on and says what was done, with Undo when there is one to offer (T-125).
 *
 * The mark is taken once per page load, outside the effect: a development double-mount must neither lose it
 * nor show the message twice.
 *
 * The workspace opens its tabs while it starts, each one taking the focus. Settings is opened once the tab
 * count has been still for a moment (or after a longer wait when there are no tabs at all), so it is the last
 * to take the focus and the one that stays.
 */

let pending: PresetReopen | null | undefined;

function takeOnce(): PresetReopen | null {
  if (pending === undefined) {
    try {
      pending = takePresetReopen(sessionStorage);
    } catch {
      pending = null;
    }
  }
  return pending;
}

const SETTLE_MS = 1200;
const NO_TABS_MS = 4000;

export function useZaicodePresetReopen(tabCount: number): void {
  useEffect(() => {
    const marker = takeOnce();
    if (!marker) return;
    const timer = window.setTimeout(() => {
      pending = null;
      openZaicodeSettings(marker.section);
      const undo = useZaicodePresets.getState().undos[marker.section];
      toast(`${marker.note}.`, {
        durationMs: 12_000,
        ...(undo ? { actionLabel: "Undo", onAction: () => void undoLastApply(zaicodePresetEnv, marker.section) } : {}),
      });
    }, tabCount > 0 ? SETTLE_MS : NO_TABS_MS);
    return () => window.clearTimeout(timer);
  }, [tabCount]);
}
