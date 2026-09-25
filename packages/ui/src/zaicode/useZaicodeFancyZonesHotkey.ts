import { useEffect, useState } from "react";
import { isZaicodeProductMode } from "@zcode/shared";
import { cycleFastFancyZone, readZaicodeFancyZonesSettings } from "./zaicodeFancyZones.js";
import { matchZaicodeHotkey } from "./zaicodeHotkeys.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";

/** Last pointer position inside the window: the picker opens under it, like FastPrompter's. */
let lastPointer = { x: -1, y: -1 };

export function readZaicodeLastPointer(): { x: number; y: number } {
  return lastPointer;
}

export function useZaicodeFancyZonesHotkey() {
  const [isOverlayOpen, setIsOverlayOpen] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !isZaicodeProductMode()) return;

    const onPointerMove = (event: PointerEvent) => {
      lastPointer = { x: event.clientX, y: event.clientY };
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Q by default (Settings -> Hotkeys), by physical key: works on every keyboard layout.
      if (!matchZaicodeHotkey("window.zones", e)) return;
      const settings = readZaicodeFancyZonesSettings();
      if (!settings.enabled) return;

      e.preventDefault();
      e.stopPropagation();

      if (settings.fastMode) {
        setIsOverlayOpen(false);
        void cycleFastFancyZone(1);
      } else {
        setIsOverlayOpen((prev) => {
          if (!prev) playZaicodeSound("window.picker");
          return !prev;
        });
      }
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  return {
    isOverlayOpen,
    setIsOverlayOpen,
    closeOverlay: () => setIsOverlayOpen(false),
  };
}
