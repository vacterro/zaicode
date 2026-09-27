import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, PictureInPicture2, RotateCcw, X } from "lucide-react";

const OPEN_EVENT = "zaicode-pebble-open";
const WIDTH = 320;
const HEIGHT = 200;
const LEVELS = 6;

type GameStatus = "title" | "running" | "paused" | "levelComplete" | "gameOver" | "won";
type DropKind = "pebble" | "hazard" | "heart";

interface Drop {
  x: number;
  y: number;
  speed: number;
  kind: DropKind;
}

interface World {
  playerX: number;
  score: number;
  lives: number;
  level: number;
  caught: number;
  spawnMs: number;
  drops: Drop[];
}

const newWorld = (): World => ({
  playerX: WIDTH / 2,
  score: 0,
  lives: 3,
  level: 1,
  caught: 0,
  spawnMs: 0,
  drops: [],
});

export function openZaicodePebbleGame(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

function targetFor(level: number): number {
  return 5 + level * 3;
}

function statusLabel(status: GameStatus): string {
  if (status === "title") return "READY";
  if (status === "levelComplete") return "LEVEL CLEAR";
  if (status === "gameOver") return "GAME OVER";
  if (status === "won") return "ALL LEVELS CLEAR";
  return status.toUpperCase();
}

function drawPixelText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size = 10,
  color = "#D4C89A",
  align: CanvasTextAlign = "left",
) {
  ctx.font = `bold ${size}px Verdana, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = "top";
  ctx.fillStyle = color;
  ctx.fillText(text, Math.round(x), Math.round(y));
}

function drawWorld(ctx: CanvasRenderingContext2D, world: World, status: GameStatus): void {
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#1A1810";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  for (let x = 8; x < WIDTH; x += 29) {
    const y = (x * 17 + world.level * 11) % 145;
    ctx.fillStyle = x % 3 === 0 ? "#3D372A" : "#332E22";
    ctx.fillRect(x, y, 2, 2);
  }
  ctx.fillStyle = "#100E08";
  ctx.fillRect(0, 22, WIDTH, 1);
  drawPixelText(ctx, `LEVEL ${world.level}/${LEVELS}`, 6, 6, 8, "#F0D060");
  drawPixelText(
    ctx,
    `SCORE ${String(world.score).padStart(6, "0")}`,
    WIDTH / 2,
    6,
    8,
    "#D4C89A",
    "center",
  );
  drawPixelText(ctx, `LIVES ${"■".repeat(world.lives)}`, WIDTH - 6, 6, 8, "#D66464", "right");
  ctx.fillStyle = "#332E22";
  ctx.fillRect(6, 25, WIDTH - 12, 4);
  ctx.fillStyle = "#7A7A20";
  ctx.fillRect(
    6,
    25,
    Math.floor((WIDTH - 12) * Math.min(1, world.caught / targetFor(world.level))),
    4,
  );

  for (const drop of world.drops) {
    const x = Math.round(drop.x);
    const y = Math.round(drop.y);
    if (drop.kind === "hazard") {
      ctx.fillStyle = "#7A2020";
      ctx.fillRect(x - 4, y - 4, 9, 9);
      ctx.fillStyle = "#D66464";
      ctx.fillRect(x - 2, y - 2, 4, 4);
    } else if (drop.kind === "heart") {
      ctx.fillStyle = "#D66464";
      ctx.fillRect(x - 4, y - 3, 3, 3);
      ctx.fillRect(x + 1, y - 3, 3, 3);
      ctx.fillRect(x - 3, y, 6, 3);
      ctx.fillRect(x - 1, y + 3, 2, 2);
    } else {
      ctx.fillStyle = "#F0D060";
      ctx.fillRect(x - 4, y - 3, 8, 6);
      ctx.fillStyle = "#F0D060";
      ctx.fillRect(x - 2, y - 2, 3, 2);
      ctx.fillStyle = "#75663D";
      ctx.fillRect(x + 1, y + 1, 3, 2);
    }
  }
  const px = Math.round(world.playerX);
  ctx.fillStyle = "#D4C89A";
  ctx.fillRect(px - 15, 184, 30, 5);
  ctx.fillStyle = "#F0D060";
  ctx.fillRect(px - 10, 181, 20, 3);
  ctx.fillStyle = "#5A5040";
  ctx.fillRect(px - 12, 189, 5, 3);
  ctx.fillRect(px + 7, 189, 5, 3);

  if (status === "running") return;
  ctx.fillStyle = "#14120C";
  ctx.fillRect(34, 52, WIDTH - 68, 94);
  ctx.strokeStyle = "#F0D060";
  ctx.strokeRect(34.5, 52.5, WIDTH - 69, 93);
  drawPixelText(ctx, "PEBBLE DROP", WIDTH / 2, 63, 18, "#F0D060", "center");
  drawPixelText(
    ctx,
    statusLabel(status),
    WIDTH / 2,
    89,
    10,
    status === "gameOver" ? "#D66464" : "#D4C89A",
    "center",
  );
  const instruction =
    status === "title"
      ? "← → / A D MOVE · CATCH GOLD · DODGE RED"
      : status === "levelComplete"
        ? `NEXT: LEVEL ${Math.min(LEVELS, world.level + 1)}`
        : status === "won"
          ? "YOU MASTERED EVERY LEVEL"
          : status === "gameOver"
            ? "PRESS R TO TRY AGAIN"
            : "PRESS P TO RESUME";
  drawPixelText(ctx, instruction, WIDTH / 2, 112, 7, "#D4C89A", "center");
  if (status === "title" || status === "levelComplete")
    drawPixelText(ctx, "PRESS SPACE", WIDTH / 2, 129, 8, "#F0D060", "center");
}

function updateWorld(
  world: World,
  keys: ReadonlySet<string>,
  elapsedMs: number,
): GameStatus | null {
  const seconds = Math.min(0.04, elapsedMs / 1000);
  const direction =
    Number(keys.has("ArrowRight") || keys.has("KeyD")) -
    Number(keys.has("ArrowLeft") || keys.has("KeyA"));
  world.playerX = Math.max(
    17,
    Math.min(WIDTH - 17, world.playerX + direction * (115 + world.level * 8) * seconds),
  );
  world.spawnMs += elapsedMs;
  const interval = Math.max(270, 850 - world.level * 88);
  while (world.spawnMs >= interval) {
    world.spawnMs -= interval;
    const roll = Math.random();
    const kind: DropKind =
      roll < Math.min(0.48, 0.2 + world.level * 0.045)
        ? "hazard"
        : roll > 0.985
          ? "heart"
          : "pebble";
    world.drops.push({
      x: 10 + Math.random() * (WIDTH - 20),
      y: 34,
      speed: 40 + world.level * 11 + Math.random() * 22,
      kind,
    });
  }
  const next: Drop[] = [];
  for (const drop of world.drops) {
    drop.y += drop.speed * seconds;
    if (drop.y < 180) {
      next.push(drop);
      continue;
    }
    const hit = Math.abs(drop.x - world.playerX) <= 19 && drop.y <= 194;
    if (hit && drop.kind === "pebble") {
      world.score += 100 * world.level;
      world.caught += 1;
    } else if (hit && drop.kind === "hazard") {
      world.lives -= 1;
    } else if (hit && drop.kind === "heart") {
      world.lives = Math.min(5, world.lives + 1);
      world.score += 250;
    }
  }
  world.drops = next;
  if (world.lives <= 0) return "gameOver";
  if (world.caught >= targetFor(world.level))
    return world.level >= LEVELS ? "won" : "levelComplete";
  return null;
}

function GameSurface({ onClose, onDetach }: { onClose: () => void; onDetach: () => void }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const shell = useRef<HTMLDivElement | null>(null);
  const world = useRef<World>(newWorld());
  const keys = useRef(new Set<string>());
  const [status, setStatus] = useState<GameStatus>("title");
  const statusRef = useRef(status);
  statusRef.current = status;

  const startAgain = useCallback(() => {
    world.current = newWorld();
    setStatus("running");
  }, []);

  const advance = useCallback(() => {
    if (statusRef.current === "title") {
      setStatus("running");
      return;
    }
    if (statusRef.current === "levelComplete") {
      world.current.level += 1;
      world.current.caught = 0;
      world.current.drops = [];
      world.current.spawnMs = 0;
      setStatus("running");
    }
  }, []);

  useEffect(() => {
    const owner = canvas.current?.ownerDocument.defaultView ?? window;
    const down = (event: KeyboardEvent) => {
      if (
        ["ArrowLeft", "ArrowRight", "Space", "KeyA", "KeyD", "KeyP", "KeyR", "Escape"].includes(
          event.code,
        )
      )
        event.preventDefault();
      if (event.code === "Escape") onClose();
      else if (event.code === "KeyR") startAgain();
      else if (event.code === "Space") advance();
      else if (
        event.code === "KeyP" &&
        (statusRef.current === "running" || statusRef.current === "paused")
      ) {
        setStatus(statusRef.current === "running" ? "paused" : "running");
      }
      keys.current.add(event.code);
    };
    const up = (event: KeyboardEvent) => keys.current.delete(event.code);
    owner.addEventListener("keydown", down);
    owner.addEventListener("keyup", up);
    return () => {
      owner.removeEventListener("keydown", down);
      owner.removeEventListener("keyup", up);
      keys.current.clear();
    };
  }, [advance, onClose, startAgain]);

  useEffect(() => {
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const ctx = canvas.current?.getContext("2d");
      if (statusRef.current === "running") {
        const terminal = updateWorld(world.current, keys.current, now - previous);
        if (terminal) setStatus(terminal);
      }
      previous = now;
      if (ctx) drawWorld(ctx, world.current, statusRef.current);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      ref={shell}
      className="flex h-full min-h-[360px] w-full flex-col bg-[#1A1810] font-[Verdana] text-[#D4C89A]"
      data-zaicode-pebble-game
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[#75663D] bg-[#232018] px-2 [app-region:drag]">
        <span className="font-bold text-[#F0D060]">PEBBLE DROP</span>
        <span className="text-[10px] text-[#9C9371]">ZAICODE BONUS · 6 LEVELS</span>
        <span className="ml-auto flex gap-1 [app-region:no-drag]">
          <button
            type="button"
            className="border border-[#75663D] p-1 hover:bg-[#453D30]"
            title="Restart"
            onClick={startAgain}
          >
            <RotateCcw className="size-3.5" />
          </button>
          <button
            type="button"
            className="border border-[#75663D] p-1 hover:bg-[#453D30]"
            title="Fullscreen"
            onClick={() => void shell.current?.requestFullscreen()}
          >
            <Maximize2 className="size-3.5" />
          </button>
          <button
            type="button"
            className="border border-[#75663D] p-1 hover:bg-[#453D30]"
            title="Detach into its own window"
            onClick={onDetach}
          >
            <PictureInPicture2 className="size-3.5" />
          </button>
          <button
            type="button"
            className="border border-[#75663D] p-1 hover:bg-[#7A2020]"
            title="Close"
            onClick={onClose}
          >
            <X className="size-3.5" />
          </button>
        </span>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
        <canvas
          ref={canvas}
          width={WIDTH}
          height={HEIGHT}
          tabIndex={0}
          className="aspect-[8/5] max-h-full w-full max-w-[960px] border-2 border-[#F0D060] bg-[#1A1810] [image-rendering:pixelated] focus:outline focus:outline-2 focus:outline-[#F0D060]"
          aria-label="Pebble Drop game. Move with left/right or A/D, Space starts levels, P pauses, R restarts."
        />
      </div>
      <div className="flex shrink-0 flex-wrap justify-center gap-3 border-t border-[#5A5040] px-2 py-1 text-[10px] text-[#9C9371]">
        <span>← → / A D MOVE</span>
        <span>SPACE START/NEXT</span>
        <span>P PAUSE</span>
        <span>R RESTART</span>
        <span>ESC CLOSE</span>
      </div>
    </div>
  );
}

export function ZaicodePebbleGameHost() {
  const [open, setOpen] = useState(false);
  const [detached, setDetached] = useState<Window | null>(null);
  useEffect(() => {
    const show = () => setOpen(true);
    let typed = "";
    const secret = (event: KeyboardEvent) => {
      if (
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      )
        return;
      if (event.key.length !== 1) return;
      typed = `${typed}${event.key.toLowerCase()}`.slice(-6);
      if (typed === "pebble") show();
    };
    window.addEventListener(OPEN_EVENT, show);
    window.addEventListener("keydown", secret);
    return () => {
      window.removeEventListener(OPEN_EVENT, show);
      window.removeEventListener("keydown", secret);
    };
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    detached?.close();
    setDetached(null);
  }, [detached]);
  const detach = useCallback(() => {
    if (detached && !detached.closed) {
      detached.focus();
      return;
    }
    const child = window.open("", "zaicode-pebble", "popup,width=960,height=720");
    if (!child) return;
    child.document.title = "PEBBLE DROP · ZAICODE";
    child.document.documentElement.style.cssText = "height:100%;background:#1A1810";
    child.document.body.style.cssText = "height:100%;margin:0;overflow:hidden;background:#1A1810";
    for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
      child.document.head.append(node.cloneNode(true));
    }
    child.addEventListener("beforeunload", () => setDetached(null), { once: true });
    setDetached(child);
  }, [detached]);
  useEffect(() => () => detached?.close(), [detached]);
  if (!open) return null;
  const game = <GameSurface onClose={close} onDetach={detach} />;
  if (detached && !detached.closed) return createPortal(game, detached.document.body);
  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex bg-[#1A1810] p-3"
      role="dialog"
      aria-modal="true"
      aria-label="Pebble Drop game"
    >
      {game}
    </div>,
    document.body,
  );
}
