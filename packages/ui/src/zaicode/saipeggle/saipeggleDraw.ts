import type { SpgColors } from "./saipeggleColors.js";
import { saipeggleText } from "./saipeggleFont.js";
import type { SpgGame } from "./saipeggleGame.js";
import {
  SPG_BALL_R,
  SPG_BOARD,
  SPG_BRICK_HALF,
  SPG_BRICK_R,
  SPG_BUCKET_Y,
  SPG_CANNON,
  SPG_FEVER_BUCKETS,
  SPG_H,
  SPG_PEG_R,
  SPG_W,
  type SpgPeg,
} from "./saipeggleModel.js";
import { saipeggleFeverPosts, saipeggleMuzzle } from "./saipegglePhysics.js";
import { pxBead, pxCapsule, pxDisc, pxFrame, pxLine } from "./saipegglePixels.js";
import { bucketOf, type SpgTone } from "./saipeggleRules.js";
import { drawSaipeggleHud, drawSaipeggleOverlay } from "./saipeggleDrawHud.js";

/**
 * Draws one SAIPEGGLE frame onto a 320 x 240 canvas: the board, the pegs,
 * the cannon and its guide, the balls, the bucket (or the fever buckets),
 * particles and floating points, then the side panels and the overlays.
 */

export interface SpgView {
  guide: { x: number; y: number }[] | null;
  paused: boolean;
  time: number;
  best: number | null;
}

export function toneColor(colors: SpgColors, tone: SpgTone, lit = false): string {
  if (tone === "text") return colors.text;
  if (tone === "gold") return colors.highlight;
  return lit ? colors.peg[tone].lit : colors.peg[tone].base;
}

// Peg sprites: drawn pixel by pixel once per look, then blitted.
const sprites = new Map<string, HTMLCanvasElement>();
const SPRITE = 20;

function pegSprite(peg: SpgPeg, colors: SpgColors, flash: boolean): { canvas: HTMLCanvasElement; ox: number; oy: number } {
  const tones = colors.peg[peg.kind];
  const fx = peg.x - Math.floor(peg.x);
  const fy = peg.y - Math.floor(peg.y);
  const body = peg.lit ? (flash ? tones.glint : tones.lit) : tones.base;
  const key = `${peg.shape}|${peg.shape === "brick" ? peg.angle.toFixed(3) : ""}|${fx}|${fy}|${body}|${tones.shade}|${tones.glint}`;
  let canvas = sprites.get(key);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.width = SPRITE;
    canvas.height = SPRITE;
    const ctx = canvas.getContext("2d")!;
    const c = SPRITE / 2 + fx;
    const r = SPRITE / 2 + fy;
    if (peg.shape === "round") pxBead(ctx, c, r, SPG_PEG_R, body, tones.shade, tones.glint);
    else pxCapsule(ctx, c, r, peg.angle, SPG_BRICK_HALF, SPG_BRICK_R, body, tones.shade, tones.glint);
    if (sprites.size > 4000) sprites.clear();
    sprites.set(key, canvas);
  }
  return { canvas, ox: Math.floor(peg.x) - SPRITE / 2, oy: Math.floor(peg.y) - SPRITE / 2 };
}

function drawPegs(ctx: CanvasRenderingContext2D, game: SpgGame, colors: SpgColors, time: number): void {
  for (const peg of game.pegs) {
    if (peg.gone) continue;
    const flash = peg.lit && Math.floor(time * 8 + peg.id) % 4 === 0;
    const sprite = pegSprite(peg, colors, flash);
    ctx.drawImage(sprite.canvas, sprite.ox, sprite.oy);
  }
}

function drawBucket(ctx: CanvasRenderingContext2D, game: SpgGame, colors: SpgColors): void {
  const bucket = bucketOf(game);
  if (bucket) {
    const left = Math.round(bucket.x - bucket.half);
    const width = Math.round(bucket.half * 2);
    ctx.fillStyle = colors.bucketShade;
    ctx.fillRect(left + 2, SPG_BUCKET_Y + 3, width - 3, SPG_H - SPG_BUCKET_Y - 3);
    ctx.fillStyle = colors.bucket;
    ctx.fillRect(left + 1, SPG_BUCKET_Y + 2, width - 1, 2);
    ctx.fillRect(left + 3, SPG_BUCKET_Y + 6, width - 5, 1);
    pxDisc(ctx, bucket.x - bucket.half, SPG_BUCKET_Y + 3, 2, colors.bucket);
    pxDisc(ctx, bucket.x + bucket.half, SPG_BUCKET_Y + 3, 2, colors.bucket);
    return;
  }
  const posts = saipeggleFeverPosts();
  SPG_FEVER_BUCKETS.forEach((value, index) => {
    const left = Math.round(posts[index]!);
    const right = Math.round(posts[index + 1]!);
    const tone = value >= 100_000 ? colors.peg.orange.base : value >= 50_000 ? colors.peg.purple.base : colors.peg.blue.base;
    ctx.fillStyle = tone;
    ctx.fillRect(left + 2, SPG_H - 5, right - left - 3, 5);
    saipeggleText(ctx, value >= 100_000 ? "100K" : `${value / 1000}K`, (left + right) / 2, SPG_H - 15, colors.text, { align: "center", shadow: colors.bg });
  });
  for (const x of posts) pxLine(ctx, x, SPG_H - 10, x, SPG_H, 3, colors.bucket);
}

function drawCannon(ctx: CanvasRenderingContext2D, game: SpgGame, colors: SpgColors): void {
  const tip = saipeggleMuzzle(game.aim);
  pxLine(ctx, SPG_CANNON.x, SPG_CANNON.y, tip.x, tip.y, 5, colors.frame);
  pxLine(ctx, SPG_CANNON.x, SPG_CANNON.y, tip.x, tip.y, 3, colors.frameLight);
  pxDisc(ctx, SPG_CANNON.x, SPG_CANNON.y - 2, 7, colors.panel);
  pxDisc(ctx, SPG_CANNON.x, SPG_CANNON.y - 2, 5, colors.frame);
  pxDisc(ctx, SPG_CANNON.x, SPG_CANNON.y - 2, 3, colors.highlight);
  if (game.phase === "aim" && game.ballsLeft > 0) pxBead(ctx, tip.x, tip.y, SPG_BALL_R, colors.ball, colors.ballShade, colors.text);
}

function drawGuide(ctx: CanvasRenderingContext2D, points: readonly { x: number; y: number }[], colors: SpgColors, time: number): void {
  ctx.fillStyle = colors.guide;
  const offset = Math.floor(time * 12) % 2;
  points.forEach((p, index) => {
    if ((index + offset) % 2 === 0 && p.y > SPG_BOARD.top) ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
  });
}

function drawBalls(ctx: CanvasRenderingContext2D, game: SpgGame, colors: SpgColors, time: number): void {
  for (const ball of game.balls) {
    if (!ball.alive) continue;
    if (ball.fire > 0) {
      ctx.fillStyle = colors.fire;
      for (let i = 1; i <= 4; i += 1) ctx.fillRect(Math.round(ball.x - ball.vx * 0.012 * i), Math.round(ball.y - ball.vy * 0.012 * i), 2, 2);
    }
    const body = ball.fire > 0 ? colors.fire : ball.spooky && Math.floor(time * 6) % 2 === 0 ? colors.peg.purple.lit : colors.ball;
    pxBead(ctx, ball.x, ball.y, SPG_BALL_R, body, colors.ballShade, colors.text);
  }
}

function drawEffects(ctx: CanvasRenderingContext2D, game: SpgGame, colors: SpgColors): void {
  for (const p of game.particles) {
    ctx.fillStyle = toneColor(colors, p.tone, true);
    ctx.fillRect(Math.round(p.x), Math.round(p.y), p.age < p.life * 0.5 ? 2 : 1, p.age < p.life * 0.5 ? 2 : 1);
  }
  for (const item of game.popups) {
    // Pixel style has no alpha fade: the last quarter of a popup blinks instead.
    if (item.age > item.life * 0.75 && Math.floor(item.age * 20) % 2 === 0) continue;
    saipeggleText(ctx, item.text, item.x, item.y, toneColor(colors, item.tone, true), { align: "center", scale: item.big ? 2 : 1, shadow: colors.bg });
  }
}

export function drawSaipeggle(ctx: CanvasRenderingContext2D, game: SpgGame, colors: SpgColors, view: SpgView): void {
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, SPG_W, SPG_H);
  if (game.shake > 0 && game.settings.shake) {
    const t = Math.floor(view.time * 60);
    ctx.setTransform(1, 0, 0, 1, (t % 3) - 1, ((t >> 1) % 3) - 1);
  }
  ctx.fillStyle = colors.board;
  ctx.fillRect(SPG_BOARD.left, SPG_BOARD.top, SPG_BOARD.right - SPG_BOARD.left, SPG_H - SPG_BOARD.top);
  if (game.fever && game.slow > 0 && Math.floor(view.time * 10) % 2 === 0) {
    pxFrame(ctx, SPG_BOARD.left, SPG_BOARD.top, SPG_BOARD.right - SPG_BOARD.left, SPG_H - SPG_BOARD.top, colors.peg.orange.lit);
  }
  drawPegs(ctx, game, colors, view.time);
  drawBucket(ctx, game, colors);
  if (view.guide && !view.paused) drawGuide(ctx, view.guide, colors, view.time);
  drawCannon(ctx, game, colors);
  drawBalls(ctx, game, colors, view.time);
  drawEffects(ctx, game, colors);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawSaipeggleHud(ctx, game, colors);
  drawSaipeggleOverlay(ctx, game, colors, view);
}
