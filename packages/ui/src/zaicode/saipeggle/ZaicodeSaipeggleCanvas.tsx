import { useEffect, useRef, useState } from "react";
import { readSaipegglePalette, saipeggleColors, type SpgColors } from "./saipeggleColors.js";
import { drawSaipeggle } from "./saipeggleDraw.js";
import {
  createSaipeggleGame,
  saipeggleAimAt,
  saipeggleGuide,
  saipeggleSetAim,
  saipeggleShoot,
  saipeggleUpdate,
  type SpgGame,
} from "./saipeggleGame.js";
import type { SpgLevelSpec } from "./saipeggleLevels.js";
import { SPG_CANNON, SPG_H, SPG_W, type SaipeggleSettings } from "./saipeggleModel.js";
import { playSaipeggleCues, playSaipeggleFeverMusic, stopSaipeggleMusic } from "./saipeggleSound.js";

/**
 * The SAIPEGGLE play field: a 320 x 240 canvas shown at a whole number of
 * device pixels per game pixel (crisp on any Windows scaling), the frame
 * loop, and the controls: the mouse aims and fires, the wheel and the arrow
 * keys fine-aim, Space / Enter fire and continue, P pauses, R retries.
 */

const FINE = (0.25 * Math.PI) / 180;
const TURN = (70 * Math.PI) / 180;

export interface SaipeggleCanvasProps {
  spec: SpgLevelSpec;
  settings: SaipeggleSettings;
  best: number | null;
  onWin: (game: SpgGame) => void;
  onNext: () => void;
  /** Esc while paused: back to the menu. */
  onMenu: () => void;
}

function useScale(host: React.RefObject<HTMLDivElement | null>, fixed: number): { scale: number; dpr: number } {
  const [state, setState] = useState({ scale: 1, dpr: 1 });
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const measure = () => {
      const dpr = window.devicePixelRatio || 1;
      const fit = Math.max(1, Math.floor(Math.min((node.clientWidth * dpr) / SPG_W, (node.clientHeight * dpr) / SPG_H)));
      setState({ scale: fixed > 0 ? Math.min(fit, Math.round(fixed * dpr)) : fit, dpr });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [host, fixed]);
  return state;
}

function useColors(mode: SaipeggleSettings["colors"]): React.MutableRefObject<SpgColors> {
  const colors = useRef<SpgColors>(saipeggleColors(readSaipegglePalette(), mode));
  useEffect(() => {
    const refresh = () => (colors.current = saipeggleColors(readSaipegglePalette(), mode));
    refresh();
    // A palette switch rewrites the root's CSS variables: follow it live.
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
    return () => observer.disconnect();
  }, [mode]);
  return colors;
}

export function ZaicodeSaipeggleCanvas({ spec, settings, best, onWin, onNext, onMenu }: SaipeggleCanvasProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const { scale, dpr } = useScale(host, settings.scale);
  const colors = useColors(settings.colors);
  const game = useRef<SpgGame | null>(null);
  const handlers = useRef({ onWin, onNext, onMenu, best });
  handlers.current = { onWin, onNext, onMenu, best };

  useEffect(() => {
    game.current = createSaipeggleGame(spec, settings, attempt);
    setPaused(false);
    stopSaipeggleMusic();
    // A new board or new rules start a new game; settings changes mid-level do too (they change the physics).
  }, [spec, settings, attempt]);

  useEffect(() => () => stopSaipeggleMusic(), []);
  useEffect(() => canvas.current?.focus({ preventScroll: true }), []);

  useEffect(() => {
    const keys = new Set<string>();
    const act = () => {
      const g = game.current;
      if (!g || pausedRef.current) return;
      if (g.phase === "won") handlers.current.onNext();
      else if (g.phase === "lost") setAttempt((value) => value + 1);
      else saipeggleShoot(g);
    };
    const down = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const code = event.code;
      if (["Space", "Enter", "ArrowLeft", "ArrowRight", "KeyP", "KeyR", "Escape", "KeyN"].includes(code)) event.preventDefault();
      if (code === "Space" || code === "Enter") act();
      else if (code === "KeyP") setPaused((value) => !value);
      else if (code === "KeyR") setAttempt((value) => value + 1);
      else if (code === "KeyN" && game.current?.phase === "won") handlers.current.onNext();
      else if (code === "Escape") {
        if (pausedRef.current) handlers.current.onMenu();
        else setPaused(true);
      } else keys.add(code);
    };
    const up = (event: KeyboardEvent) => keys.delete(event.code);
    const blur = () => setPaused(true);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);

    let frame = 0;
    let last = performance.now();
    let recorded: SpgGame | null = null;
    let guideKey = "";
    let guide: { x: number; y: number }[] | null = null;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const g = game.current;
      const ctx = canvas.current?.getContext("2d");
      if (g && ctx) {
        if (!pausedRef.current) {
          const turn = (keys.has("ShiftLeft") || keys.has("ShiftRight") ? TURN / 6 : TURN) * dt;
          // A positive aim points to the right of the screen.
          if (keys.has("ArrowLeft") || keys.has("KeyA")) saipeggleSetAim(g, g.aim - turn);
          if (keys.has("ArrowRight") || keys.has("KeyD")) saipeggleSetAim(g, g.aim + turn);
          saipeggleUpdate(g, dt);
        }
        const key = `${g.phase}|${g.aim}|${g.stats.shots}|${g.guideShots}|${Math.round(g.bucketX / 8)}`;
        if (key !== guideKey) {
          guideKey = key;
          guide = saipeggleGuide(g);
        }
        drawSaipeggle(ctx, g, colors.current, { guide, paused: pausedRef.current, time: now / 1000, best: handlers.current.best });
        if (g.cues.length > 0) {
          if (g.settings.feverMusic && g.cues.some((cue) => cue.id === "saipeggle.fever")) playSaipeggleFeverMusic();
          playSaipeggleCues(g.cues);
          g.cues.length = 0;
        }
        if (g.phase === "won" && recorded !== g) {
          recorded = g;
          handlers.current.onWin(g);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [colors]);

  const toGame = (event: React.PointerEvent | React.WheelEvent) => {
    const rect = canvas.current!.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * SPG_W, y: ((event.clientY - rect.top) / rect.height) * SPG_H };
  };
  const cssSize = { width: (SPG_W * scale) / dpr, height: (SPG_H * scale) / dpr };

  return (
    <div ref={host} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden" data-zaicode-saipeggle-field>
      <canvas
        ref={canvas}
        width={SPG_W}
        height={SPG_H}
        tabIndex={0}
        style={{ ...cssSize, imageRendering: "pixelated", cursor: "crosshair", outline: "none" }}
        aria-label="SAIPEGGLE: aim with the mouse, click or Space to fire, P to pause, R to retry, Esc for the menu"
        onPointerMove={(event) => {
          const g = game.current;
          if (!g || pausedRef.current || (g.phase !== "aim" && g.phase !== "intro")) return;
          const p = toGame(event);
          saipeggleAimAt(g, p.x, p.y, SPG_CANNON.x, SPG_CANNON.y);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const g = game.current;
          if (!g) return;
          if (pausedRef.current) {
            setPaused(false);
            return;
          }
          if (g.phase === "won") onNext();
          else if (g.phase === "lost") setAttempt((value) => value + 1);
          else saipeggleShoot(g);
        }}
        onWheel={(event) => {
          const g = game.current;
          if (g && g.phase === "aim") saipeggleSetAim(g, g.aim + Math.sign(event.deltaY) * FINE);
        }}
      />
    </div>
  );
}
