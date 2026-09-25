import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import {
  FANCYZONE_MAX_PRESETS,
  applyFancyZone,
  deleteFancyPreset,
  fancyZoneLayouts,
  saveCurrentWindowAsFancyPreset,
  useZaicodeFancyZones,
  writeZaicodeFancyZonesSettings,
} from "./zaicodeFancyZones.js";
import { readZaicodeLastPointer } from "./useZaicodeFancyZonesHotkey.js";
import { zaicodeDigitOf, zaicodeKeyIs } from "./zaicodeKeys.js";
import { matchZaicodeHotkey } from "./zaicodeHotkeys.js";

interface ZaicodeFancyZoneOverlayProps {
  open: boolean;
  onClose: () => void;
}

const WIDTH = 250;
const HEIGHT = 168;

/**
 * FastPrompter's Ctrl+Q picker: a small screen map that pops up under the
 * pointer (no dimming, no dialog). Hover highlights, click or 1-9 / 0 snaps,
 * Tab / arrows switch Quarters / Columns / Presets, S saves the window as a
 * preset, Delete removes the hovered preset, Esc / Q / clicking away closes.
 */
export function ZaicodeFancyZoneOverlay({ open, onClose }: ZaicodeFancyZoneOverlayProps) {
  const settings = useZaicodeFancyZones();
  const layouts = fancyZoneLayouts(settings);
  const [pageId, setPageId] = useState(settings.layoutId);
  const [hotIndex, setHotIndex] = useState(-1);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const panelRef = useRef<HTMLDivElement>(null);
  const page = layouts.find((layout) => layout.id === pageId) ?? layouts[0]!;
  const isPresets = page.id === "Presets";

  useLayoutEffect(() => {
    if (!open) return;
    setPageId(layouts.some((layout) => layout.id === settings.layoutId) ? settings.layoutId : layouts[0]!.id);
    setHotIndex(-1);
    const pointer = readZaicodeLastPointer();
    const x = pointer.x >= 0 ? pointer.x : window.innerWidth / 2;
    const y = pointer.y >= 0 ? pointer.y : window.innerHeight / 3;
    setPosition({
      left: Math.round(Math.min(Math.max(4, x - WIDTH / 2), window.innerWidth - WIDTH - 4)),
      top: Math.round(Math.min(Math.max(4, y + 12), window.innerHeight - HEIGHT - 4)),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- position and page are taken once per opening
  }, [open]);

  const choose = useCallback(
    async (index: number) => {
      const zone = page.zones[index];
      if (!zone) return;
      writeZaicodeFancyZonesSettings({ layoutId: page.id, fastIndex: index });
      onClose();
      await applyFancyZone(zone);
    },
    [page, onClose],
  );

  const cycle = useCallback(
    (step: number) => {
      const index = layouts.findIndex((layout) => layout.id === page.id);
      const next = layouts[(index + step + layouts.length) % layouts.length]!;
      setPageId(next.id);
      setHotIndex(-1);
      writeZaicodeFancyZonesSettings({ layoutId: next.id });
    },
    [layouts, page.id],
  );

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (matchZaicodeHotkey("window.zones", e)) return; // the hotkey hook toggles it
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" || zaicodeKeyIs(e, "q")) {
        onClose();
        return;
      }
      const digit = zaicodeDigitOf(e);
      if (digit !== null) {
        void choose(digit === 0 ? 9 : digit - 1);
        return;
      }
      if (e.key === "Tab") {
        cycle(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        cycle(1);
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        cycle(-1);
        return;
      }
      if (e.key === "Enter") {
        void choose(hotIndex >= 0 ? hotIndex : 0);
        return;
      }
      if (zaicodeKeyIs(e, "s")) {
        void saveCurrentWindowAsFancyPreset().then((index) => {
          if (index === null) return;
          setPageId("Presets");
          setHotIndex(index);
          writeZaicodeFancyZonesSettings({ layoutId: "Presets" });
        });
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && isPresets && hotIndex >= 0) {
        deleteFancyPreset(hotIndex);
        setHotIndex(-1);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) onClose();
    };
    const onBlur = () => onClose();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, choose, cycle, hotIndex, isPresets, onClose]);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      className="fixed z-[210] select-none border border-[var(--zaicode-highlight,var(--color-border-hover))] bg-card font-mono text-ui-xs shadow-2xl"
      style={{ left: position.left, top: position.top, width: WIDTH, height: HEIGHT }}
      data-zaicode-fancyzones-picker={page.id}
    >
      <div className="flex h-5 items-center gap-px border-b border-border px-1">
        {layouts.map((layout) => (
          <button
            key={layout.id}
            type="button"
            className={cn(
              "px-1.5 leading-4",
              layout.id === page.id ? "bg-selected text-foreground" : "text-foreground-subtle hover:text-foreground",
            )}
            onClick={() => {
              setPageId(layout.id);
              setHotIndex(-1);
              writeZaicodeFancyZonesSettings({ layoutId: layout.id });
            }}
          >
            {layout.name}
          </button>
        ))}
        <span className="ml-auto pr-1 text-foreground-subtlest">
          {isPresets ? `S=save  Del=remove` : "Tab"}
        </span>
      </div>
      <div className="relative m-1.5" style={{ height: HEIGHT - 20 - 12 - 14 }}>
        <div className="absolute inset-0 border border-border/70 bg-background/80" />
        {page.zones.map((zone, index) => {
          const hot = index === hotIndex;
          return (
            <div
              key={index}
              className="absolute p-px"
              style={{
                left: `${zone.fx * 100}%`,
                top: `${zone.fy * 100}%`,
                width: `${zone.fw * 100}%`,
                height: `${zone.fh * 100}%`,
              }}
              onMouseEnter={() => setHotIndex(index)}
              onMouseLeave={() => setHotIndex((current) => (current === index ? -1 : current))}
              onClick={() => void choose(index)}
            >
              <div
                className={cn(
                  "flex h-full w-full cursor-pointer items-center justify-center border font-bold",
                  hot
                    ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
                    : "border-border bg-card/70 text-foreground-subtle",
                )}
              >
                {index === 9 ? 0 : index + 1}
                {zone.state === "maximized" ? <span className="ml-0.5 text-[9px]">▣</span> : null}
              </div>
            </div>
          );
        })}
        {isPresets && page.zones.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center px-3 text-center text-foreground-subtle">
            No presets yet. Press S to save this window's place (up to {FANCYZONE_MAX_PRESETS}).
          </div>
        ) : null}
      </div>
      <div className="px-1.5 text-center text-[10px] text-foreground-subtlest">
        1-{Math.min(page.zones.length, 9) || 9}
        {page.zones.length >= 10 ? ", 0" : ""} snap · Enter hovered · Esc/Q close
      </div>
    </div>
  );
}
