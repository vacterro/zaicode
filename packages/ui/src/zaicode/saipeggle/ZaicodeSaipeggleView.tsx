import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, X } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { ZaicodeSaipeggleCanvas } from "./ZaicodeSaipeggleCanvas.js";
import { ZaicodeSaipeggleHelp, ZaicodeSaipeggleLevels } from "./ZaicodeSaipegglePanels.js";
import { ZaicodeSaipeggleSettings } from "./ZaicodeSaipeggleSettings.js";
import { saipeggleCampaign, saipeggleRandomSpec, type SpgLevelSpec } from "./saipeggleLevels.js";
import { saipeggleNewSeed } from "./saipeggleRandom.js";
import { useSaipeggle } from "./saipeggleStore.js";

/**
 * SAIPEGGLE (SRC-062) takes over the whole ZAICODE window until you leave it
 * (Exit, or Esc from the menu). Opened from Settings (the SAIPEGGLE button
 * above Support Developer, its gear opens the game's settings), from Help,
 * or by typing PEGGLE anywhere outside a text field.
 */

const OPEN_EVENT = "zaicode-saipeggle-open";
export type SaipeggleScreen = "play" | "levels" | "settings" | "help";
const CAMPAIGN = saipeggleCampaign();

export function openZaicodeSaipeggle(screen: SaipeggleScreen = "play"): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: screen }));
}

type Selection = { index: number } | { spec: SpgLevelSpec };

function ZaicodeSaipeggleView({ initial, onExit }: { initial: SaipeggleScreen; onExit: () => void }) {
  const root = useRef<HTMLDivElement | null>(null);
  const [screen, setScreen] = useState<SaipeggleScreen>(initial);
  const settings = useSaipeggle((state) => state.settings);
  const progress = useSaipeggle((state) => state.progress);
  const recordWin = useSaipeggle((state) => state.recordWin);
  const setCurrent = useSaipeggle((state) => state.setCurrent);
  const [selection, setSelection] = useState<Selection>(() => ({ index: Math.min(progress.current, progress.unlocked - 1) }));
  const spec = useMemo(() => ("index" in selection ? CAMPAIGN[selection.index]! : selection.spec), [selection]);
  const adventureIndex = "index" in selection ? selection.index : null;

  useEffect(() => setScreen(initial), [initial]);
  // The game takes the keyboard: a text field under it must not receive A / D or letters.
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !root.current?.contains(active)) active.blur();
    // The play field focuses itself first (child effects run first); keep that.
    if (!root.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true });
  }, []);

  const play = useCallback(
    (choice: Selection) => {
      if ("index" in choice) setCurrent(choice.index);
      setSelection(choice);
      setScreen("play");
    },
    [setCurrent],
  );

  const next = useCallback(() => {
    if (adventureIndex !== null) {
      if (adventureIndex + 1 < CAMPAIGN.length) play({ index: adventureIndex + 1 });
      else setScreen("levels");
    } else if (spec.id.startsWith("R:")) {
      play({ spec: saipeggleRandomSpec(saipeggleNewSeed()) });
    } else {
      setScreen("levels");
    }
  }, [adventureIndex, spec, play]);

  // Esc outside the play field leaves the game (inside it, Esc pauses first).
  useEffect(() => {
    if (screen === "play") return;
    const key = (event: KeyboardEvent) => {
      if (event.code === "Escape") {
        event.preventDefault();
        onExit();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [screen, onExit]);

  const tabs: readonly [SaipeggleScreen, string][] = [
    ["play", "Play"],
    ["levels", "Levels"],
    ["settings", "Settings"],
    ["help", "How to play"],
  ];

  return (
    <div
      ref={root}
      tabIndex={-1}
      className="fixed inset-0 z-[10000] flex flex-col bg-background text-foreground outline-none"
      role="dialog"
      aria-modal="true"
      aria-label="SAIPEGGLE"
      data-zaicode-saipeggle
      data-zaicode-help="saipeggle"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-2 text-ui-xs [app-region:drag]">
        <span className="text-ui-sm text-[var(--zaicode-highlight,var(--color-warning))]">SAIPEGGLE</span>
        <nav className="flex gap-px [app-region:no-drag]" role="tablist">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={screen === id}
              className={cn("border px-2 py-0.5", screen === id ? "border-[var(--zaicode-highlight,var(--color-warning))] bg-selected text-foreground" : "border-border text-foreground-subtle hover:bg-hover")}
              onClick={() => setScreen(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <span className="min-w-0 truncate text-foreground-subtle">
          {spec.stage ? `${spec.id} · ` : ""}
          {spec.name}
        </span>
        <span className="ml-auto flex gap-1 [app-region:no-drag]">
          <button type="button" className="border border-border p-1 hover:bg-hover" title="Fullscreen" aria-label="Fullscreen" onClick={() => void root.current?.requestFullscreen?.().catch(() => undefined)}>
            <Maximize2 className="size-3.5" />
          </button>
          <button type="button" className="flex items-center gap-1 border border-border px-1.5 py-0.5 hover:bg-hover" title="Back to ZAICODE (Esc from the menu)" onClick={onExit} data-zaicode-saipeggle-exit>
            <X className="size-3.5" /> Exit
          </button>
        </span>
      </div>
      {screen === "play" ? (
        <ZaicodeSaipeggleCanvas
          spec={spec}
          settings={settings}
          best={progress.best[spec.id] ?? null}
          onWin={(game) => recordWin(spec.id, game.score, adventureIndex)}
          onNext={next}
          onMenu={() => setScreen("levels")}
        />
      ) : screen === "levels" ? (
        <ZaicodeSaipeggleLevels current={spec} onPlay={play} />
      ) : screen === "settings" ? (
        <ZaicodeSaipeggleSettings />
      ) : (
        <ZaicodeSaipeggleHelp />
      )}
      <div className="flex shrink-0 flex-wrap justify-center gap-3 border-t border-border px-2 py-0.5 text-ui-xs text-foreground-subtlest">
        <span>MOUSE AIM · CLICK / SPACE FIRE</span>
        <span>← → FINE AIM</span>
        <span>P PAUSE</span>
        <span>R RETRY</span>
        <span>ESC MENU / EXIT</span>
      </div>
    </div>
  );
}

export function ZaicodeSaipeggleHost() {
  const [open, setOpen] = useState<SaipeggleScreen | null>(null);
  useEffect(() => {
    const show = (event: Event) => setOpen(((event as CustomEvent<SaipeggleScreen>).detail ?? "play") as SaipeggleScreen);
    let typed = "";
    const secret = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.ctrlKey || event.altKey || event.metaKey || event.key.length !== 1) return;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      typed = `${typed}${event.key.toLowerCase()}`.slice(-6);
      if (typed === "peggle") setOpen("play");
    };
    window.addEventListener(OPEN_EVENT, show);
    window.addEventListener("keydown", secret);
    return () => {
      window.removeEventListener(OPEN_EVENT, show);
      window.removeEventListener("keydown", secret);
    };
  }, []);
  const close = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    setOpen(null);
  }, []);
  if (!open) return null;
  return createPortal(<ZaicodeSaipeggleView initial={open} onExit={close} />, document.body);
}
