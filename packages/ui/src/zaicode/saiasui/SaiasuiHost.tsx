import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { logger } from "@/logger.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isBlankDraftClick, trackBlankClick, type BlankClick } from "./saiasuiGesture.js";
import { SaiasuiGame } from "./SaiasuiGame.js";
import { useSaiasui } from "./saiasuiStore.js";

/** A failure in optional entertainment must not unmount the workspace. */
class GameBoundary extends Component<
  { children: ReactNode; onExit: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    logger.warn("[saiasui] Game closed after render failure", error);
    this.props.onExit();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Mounted only by a focused editable New task pane. No global start route. */
export function SaiasuiHost() {
  const { intl } = useZCodeIntl();
  const anchor = useRef<HTMLSpanElement>(null);
  const clicks = useRef<BlankClick[]>([]);
  const [offer, setOffer] = useState<{ x: number; y: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const settings = useSaiasui((state) => state.settings);
  const exit = useCallback(() => {
    setPlaying(false);
    setOffer(null);
    clicks.current = [];
  }, []);
  useEffect(() => {
    if (!settings.enabled) {
      exit();
      return;
    }
    const pane = anchor.current?.closest<HTMLElement>("[data-session-id]");
    if (!pane) return;
    const pointer = (event: PointerEvent) => {
      if (playing) return;
      if (offer) {
        if (!(event.target instanceof Element) || !event.target.closest("[data-saiasui-offer]"))
          exit();
        return;
      }
      if (!isBlankDraftClick(event, pane)) {
        clicks.current = [];
        return;
      }
      clicks.current = trackBlankClick(clicks.current, {
        x: event.clientX,
        y: event.clientY,
        at: performance.now() / 1000,
      });
      if (clicks.current.length >= 5) {
        const rect = pane.getBoundingClientRect();
        setOffer({
          x: Math.max(rect.left + 60, Math.min(rect.right - 60, event.clientX + 90)),
          y: Math.max(rect.top + 60, Math.min(rect.bottom - 60, event.clientY - 90)),
        });
        clicks.current = [];
      }
    };
    const key = (event: KeyboardEvent) => {
      clicks.current = [];
      if (event.key === "Escape" && offer) {
        event.preventDefault();
        event.stopImmediatePropagation();
        exit();
      } else if (!playing && offer) exit();
    };
    const hidden = () => {
      if (document.hidden) exit();
    };
    document.addEventListener("pointerdown", pointer);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", exit);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", exit);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [settings.enabled, offer, playing, exit]);
  useEffect(() => {
    if (!offer) return;
    const timer = window.setTimeout(exit, 8000);
    const resize = () => exit();
    window.addEventListener("resize", resize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", resize);
    };
  }, [offer, exit]);
  return (
    <>
      <span ref={anchor} hidden />
      {settings.enabled && playing
        ? createPortal(
            <GameBoundary onExit={exit}>
              <SaiasuiGame settings={settings} onExit={exit} />
            </GameBoundary>,
            document.body,
          )
        : null}
      {settings.enabled && offer && !playing
        ? createPortal(
            <button
              type="button"
              data-saiasui-offer
              aria-label={intl.formatMessage({ id: "saiasui.offer" })}
              title={intl.formatMessage({ id: "saiasui.offer" })}
              className="fixed z-[9999] flex items-center justify-center border-2 border-[var(--zaicode-highlight,var(--color-warning))] bg-background text-ui-sm text-foreground [app-region:no-drag]"
              style={{
                left: offer.x - 36,
                top: offer.y - 36,
                width: 72,
                height: 72,
                clipPath: "circle(50%)",
              }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
                setOffer(null);
                setPlaying(true);
              }}
            >
              <style>{`[data-saiasui-offer] { border-radius: 50% !important; }`}</style>SAIASUI!
            </button>,
            document.body,
          )
        : null}
    </>
  );
}
