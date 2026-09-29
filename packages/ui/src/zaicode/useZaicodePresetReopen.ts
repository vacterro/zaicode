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

export function useZaicodePresetReopen(): void {
  useEffect(() => {
    const marker = takeOnce();
    if (!marker) return;
    // The workspace restores its tabs while it starts; Settings opened a moment later is the one that stays.
    const timer = window.setTimeout(() => {
      pending = null;
      openZaicodeSettings(marker.section);
      const undo = useZaicodePresets.getState().undos[marker.section];
      toast(`${marker.note}.`, {
        durationMs: 12_000,
        ...(undo ? { actionLabel: "Undo", onAction: () => void undoLastApply(zaicodePresetEnv, marker.section) } : {}),
      });
    }, 800);
    return () => window.clearTimeout(timer);
  }, []);
}
