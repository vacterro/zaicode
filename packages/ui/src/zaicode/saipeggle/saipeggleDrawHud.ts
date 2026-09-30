import type { SpgColors } from "./saipeggleColors.js";
import { saipeggleText, saipeggleTextWidth } from "./saipeggleFont.js";
import type { SpgGame } from "./saipeggleGame.js";
import { SPG_BOARD, SPG_H, SPG_POWER_INFO, SPG_W, saipeggleMultiplier, saipeggleMultiplierMarks } from "./saipeggleModel.js";
import { pxBead, pxPanel } from "./saipegglePixels.js";
import type { SpgView } from "./saipeggleDraw.js";

/** SAIPEGGLE's side panels, top line, banners and full-screen messages. */

const fmt = (value: number) => value.toLocaleString("en-US");

function leftPanel(ctx: CanvasRenderingContext2D, game: SpgGame, c: SpgColors): void {
  pxPanel(ctx, 0, 0, SPG_BOARD.left, SPG_H, c.panel, c.frameLight, c.frame);
  saipeggleText(ctx, "BALLS", 24, 6, c.dim, { align: "center" });
  saipeggleText(ctx, String(game.ballsLeft), 24, 16, c.text, { align: "center", scale: 2 });
  // The tube: one bead per ball left, the next one on top.
  const top = 36;
  const bottom = 196;
  ctx.fillStyle = c.bg;
  ctx.fillRect(17, top, 14, bottom - top);
  ctx.fillStyle = c.frame;
  ctx.fillRect(16, top, 1, bottom - top);
  ctx.fillRect(31, top, 1, bottom - top);
  const shown = Math.min(game.ballsLeft, Math.floor((bottom - top - 4) / 8));
  for (let i = 0; i < shown; i += 1) pxBead(ctx, 24, bottom - 6 - i * 8, 3, c.ball, c.ballShade, c.text);
  const info = SPG_POWER_INFO[game.power];
  saipeggleText(ctx, "POWER", 24, 202, c.dim, { align: "center" });
  saipeggleText(ctx, info.short, 24, 212, c.peg.green.lit, { align: "center" });
  const charge =
    game.power === "guide"
      ? game.guideShots
      : game.power === "pyramid"
        ? game.pyramidTurns
        : game.power === "zen"
          ? game.zenShots
          : game.guideShots || game.pyramidTurns || game.zenShots;
  if (charge > 0) saipeggleText(ctx, `x${charge}`, 24, 222, c.highlight, { align: "center" });
}

function rightPanel(ctx: CanvasRenderingContext2D, game: SpgGame, c: SpgColors): void {
  const x = SPG_BOARD.right;
  const w = SPG_W - x;
  pxPanel(ctx, x, 0, w, SPG_H, c.panel, c.frameLight, c.frame);
  const multiplier = saipeggleMultiplier(game.orangeHit, game.orangeTotal);
  saipeggleText(ctx, "FEVER", x + w / 2, 6, c.dim, { align: "center" });
  saipeggleText(ctx, `x${multiplier}`, x + w / 2, 16, multiplier >= 5 ? c.peg.orange.lit : c.text, { align: "center", scale: 2 });
  const top = 36;
  const bottom = 214;
  const barX = x + 9;
  ctx.fillStyle = c.bg;
  ctx.fillRect(barX, top, 10, bottom - top);
  const total = Math.max(1, game.orangeTotal);
  const cell = (bottom - top) / total;
  for (let i = 0; i < game.orangeHit && i < total; i += 1) {
    const y0 = Math.round(bottom - (i + 1) * cell);
    const y1 = Math.round(bottom - i * cell);
    ctx.fillStyle = i % 2 === 0 ? c.peg.orange.base : c.peg.orange.lit;
    ctx.fillRect(barX + 1, y0 + 1, 8, Math.max(1, y1 - y0 - 1));
  }
  for (const mark of saipeggleMultiplierMarks(total)) {
    const y = Math.round(bottom - mark.at * cell);
    ctx.fillStyle = c.frameLight;
    ctx.fillRect(barX - 2, y, 14, 1);
    saipeggleText(ctx, `x${mark.multiplier}`, barX + 13, y - 3, game.orangeHit >= mark.at ? c.highlight : c.dim);
  }
  saipeggleText(ctx, `${Math.max(0, game.orangeTotal - game.orangeHit)}`, x + w / 2, 220, c.peg.orange.lit, { align: "center" });
  saipeggleText(ctx, "LEFT", x + w / 2, 229, c.dim, { align: "center" });
}

function topLine(ctx: CanvasRenderingContext2D, game: SpgGame, c: SpgColors): void {
  ctx.fillStyle = c.bg;
  ctx.fillRect(SPG_BOARD.left, 0, SPG_BOARD.right - SPG_BOARD.left, SPG_BOARD.top);
  saipeggleText(ctx, fmt(game.score), SPG_BOARD.left + 4, 4, c.text);
  const title = `${game.spec.stage ? `${game.spec.id} ` : ""}${game.spec.name}`.toUpperCase();
  const room = Math.floor((SPG_BOARD.right - SPG_BOARD.left - 90) / 6);
  saipeggleText(ctx, title.length > room ? `${title.slice(0, room - 1)}.` : title, SPG_BOARD.right - 4, 4, c.dim, { align: "right" });
}

function box(ctx: CanvasRenderingContext2D, c: SpgColors, w: number, h: number): { x: number; y: number } {
  const x = Math.round((SPG_BOARD.left + SPG_BOARD.right - w) / 2);
  const y = Math.round((SPG_H - h) / 2);
  pxPanel(ctx, x, y, w, h, c.panel, c.frameLight, c.frame);
  return { x, y };
}

function lines(ctx: CanvasRenderingContext2D, c: SpgColors, rows: readonly [string, string, number?][], x: number, y: number): void {
  let top = y;
  for (const [text, color, scale] of rows) {
    saipeggleText(ctx, text, x, top, color, { align: "center", scale: scale ?? 1, shadow: c.bg });
    top += (scale ?? 1) * 7 + 5;
  }
}

export function drawSaipeggleHud(ctx: CanvasRenderingContext2D, game: SpgGame, c: SpgColors): void {
  leftPanel(ctx, game, c);
  rightPanel(ctx, game, c);
  topLine(ctx, game, c);
}

export function drawSaipeggleOverlay(ctx: CanvasRenderingContext2D, game: SpgGame, c: SpgColors, view: SpgView): void {
  const mid = (SPG_BOARD.left + SPG_BOARD.right) / 2;
  if (game.banner && game.phase !== "won" && game.phase !== "lost" && game.phase !== "intro") {
    const blink = game.banner.age > 1.5 && Math.floor(game.banner.age * 16) % 2 === 0;
    if (!blink) {
      // Its own band, so a banner never mixes with the pegs and the floating points under it.
      const scale = saipeggleTextWidth(game.banner.text, 2) <= SPG_BOARD.right - SPG_BOARD.left - 16 ? 2 : 1;
      const height = scale * 7 + 10;
      pxPanel(ctx, SPG_BOARD.left + 4, 60, SPG_BOARD.right - SPG_BOARD.left - 8, height, c.panel, c.frameLight, c.frame);
      saipeggleText(ctx, game.banner.text, mid, 65, game.fever ? c.peg.orange.lit : c.highlight, { align: "center", scale, shadow: c.bg });
    }
  }
  const blinkOn = Math.floor(view.time * 2) % 2 === 0;
  if (game.phase === "intro") {
    const info = SPG_POWER_INFO[game.power];
    const b = box(ctx, c, 200, 104);
    lines(ctx, c, [
      [game.spec.stage ? `LEVEL ${game.spec.id}` : "QUICK PLAY", c.dim],
      [game.spec.name.toUpperCase().slice(0, 16), c.highlight, 2],
      [`MASTER ${info.master.toUpperCase()}`, c.text],
      [`POWER: ${info.name.toUpperCase()}`, c.peg.green.lit],
      [`${game.orangeTotal} ORANGE · ${game.ballsLeft} BALLS`, c.peg.orange.lit],
      [blinkOn ? "CLICK OR SPACE" : "", c.text],
    ], mid, b.y + 8);
  } else if (game.phase === "won" && game.phaseTime > 0.4) {
    const b = box(ctx, c, 200, 118);
    lines(ctx, c, [
      ["LEVEL CLEAR!", c.highlight, 2],
      [`FEVER     +${fmt(game.feverBonus)}`, c.peg.orange.lit],
      [`BALLS     +${fmt(game.ballBonus)}`, c.peg.blue.lit],
      [`SCORE ${fmt(game.score)}`, c.text, 2],
      [view.best !== null && game.score >= view.best ? "NEW BEST!" : view.best !== null ? `BEST ${fmt(view.best)}` : "", c.peg.green.lit],
      [blinkOn ? "CLICK: NEXT   R: REPLAY" : "", c.text],
    ], mid, b.y + 8);
  } else if (game.phase === "lost" && game.phaseTime > 0.4) {
    const b = box(ctx, c, 196, 84);
    const left = game.orangeTotal - game.orangeHit;
    lines(ctx, c, [
      ["OUT OF BALLS", c.peg.orange.lit, 2],
      [`${left} ORANGE PEG${left === 1 ? "" : "S"} LEFT`, c.text],
      [`SCORE ${fmt(game.score)}`, c.dim],
      [blinkOn ? "CLICK OR R: TRY AGAIN" : "", c.text],
    ], mid, b.y + 10);
  }
  if (view.paused) {
    const b = box(ctx, c, 160, 50);
    lines(ctx, c, [
      ["PAUSED", c.highlight, 2],
      ["P: RESUME  ESC: MENU", c.text],
    ], mid, b.y + 10);
  }
}
