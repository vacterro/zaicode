import {
  SPG_AIM_LIMIT,
  SPG_BALL_R,
  SPG_BOARD,
  SPG_FREE_BALL_SCORES,
  SPG_LONG_SHOT,
  SPG_PEG_POINTS,
  SPG_POWERS,
  SPG_POWER_INFO,
  saipeggleMultiplier,
  type SaipeggleSettings,
  type SpgPeg,
  type SpgPegKind,
  type SpgPower,
} from "./saipeggleModel.js";
import { saipeggleNewBall, saipeggleTrace, type SpgBall, type SpgBucket, type SpgPhysics } from "./saipegglePhysics.js";
import type { SaipeggleRng } from "./saipeggleRandom.js";
import type { SpgLevelSpec } from "./saipeggleLevels.js";

/**
 * SAIPEGGLE's rules: what a hit is worth, the fever multiplier, style shots,
 * free balls, the purple peg and the masters' powers. The game loop
 * (saipeggleGame) calls these; they only change the game state and queue
 * sound cues, popups and banners for the view.
 */

export type SpgPhase = "intro" | "aim" | "flight" | "clearing" | "won" | "lost";
export type SpgTone = SpgPegKind | "text" | "gold";

export interface SpgPopup {
  x: number;
  y: number;
  text: string;
  tone: SpgTone;
  age: number;
  life: number;
  big: boolean;
}

export interface SpgParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  tone: SpgTone;
}

export interface SpgCue {
  id: string;
  rate?: number;
}

export interface SpgShot {
  score: number;
  hits: number;
  freeBalls: number;
  longShot: boolean;
  /** Pegs lit this shot, in hit order (they pop in this order). */
  order: number[];
}

export interface SpgGame {
  spec: SpgLevelSpec;
  settings: SaipeggleSettings;
  attempt: number;
  pegs: SpgPeg[];
  balls: SpgBall[];
  phase: SpgPhase;
  phaseTime: number;
  aim: number;
  ballsLeft: number;
  score: number;
  shot: SpgShot;
  orangeTotal: number;
  orangeHit: number;
  power: SpgPower;
  guideShots: number;
  zenShots: number;
  pyramidTurns: number;
  bucketX: number;
  bucketDir: 1 | -1;
  purpleId: number | null;
  fever: boolean;
  feverBonus: number;
  ballBonus: number;
  slow: number;
  shake: number;
  banner: { text: string; age: number } | null;
  popups: SpgPopup[];
  particles: SpgParticle[];
  cues: SpgCue[];
  clearQueue: number[];
  clearTimer: number;
  accumulator: number;
  rng: SaipeggleRng;
  stats: { shots: number; catches: number; style: string[] };
}

export function newShot(): SpgShot {
  return { score: 0, hits: 0, freeBalls: 0, longShot: false, order: [] };
}

export function physicsOf(game: SpgGame): SpgPhysics {
  return { gravity: game.settings.gravity, bounce: game.settings.bounce };
}

/** The moving bucket, or null while the fever buckets are out. */
export function bucketOf(game: SpgGame): SpgBucket | null {
  if (game.fever && game.settings.fever) return null;
  return { x: game.bucketX, half: game.pyramidTurns > 0 ? 34 : 13 };
}

/** The scale the peg hits climb within one shot (semitones of a major scale). */
const SCALE = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24, 26, 28, 29, 31];
export function saipegglePitch(step: number): number {
  return 0.84 * 2 ** (SCALE[Math.min(SCALE.length - 1, Math.max(0, step))]! / 12);
}

export function popup(game: SpgGame, x: number, y: number, text: string, tone: SpgTone, big = false): void {
  game.popups.push({ x, y, text, tone, age: 0, life: big ? 1.6 : 0.9, big });
  if (game.popups.length > 40) game.popups.shift();
}

export function banner(game: SpgGame, text: string): void {
  game.banner = { text, age: 0 };
}

function award(game: SpgGame, points: number): void {
  game.score += points;
  game.shot.score += points;
  for (const [index, threshold] of SPG_FREE_BALL_SCORES.entries()) {
    if (game.shot.freeBalls <= index && game.shot.score >= threshold) {
      game.shot.freeBalls = index + 1;
      game.ballsLeft += 1;
      banner(game, "FREE BALL!");
      game.cues.push({ id: "saipeggle.freeBall" });
    }
  }
}

export function assignPurple(game: SpgGame): void {
  const old = game.purpleId === null ? null : game.pegs[game.purpleId];
  if (old && !old.lit && !old.gone) old.kind = "blue";
  game.purpleId = null;
  if (!game.settings.purple) return;
  const blues = game.pegs.filter((peg) => peg.kind === "blue" && !peg.lit && !peg.gone);
  if (blues.length === 0) return;
  const peg = game.rng.pick(blues);
  peg.kind = "purple";
  game.purpleId = peg.id;
}

/** A peg is hit for the first time: light it, score it, and run what its colour does. */
export function lightPeg(game: SpgGame, peg: SpgPeg, ball: SpgBall): void {
  if (peg.lit || peg.gone) return;
  peg.lit = true;
  game.shot.order.push(peg.id);
  if (peg.kind === "orange") game.orangeHit += 1;
  const multiplier = saipeggleMultiplier(game.orangeHit, game.orangeTotal);
  const points = SPG_PEG_POINTS[peg.kind] * multiplier;
  game.cues.push({ id: "saipeggle.peg", rate: saipegglePitch(game.shot.hits) });
  game.shot.hits += 1;
  popup(game, peg.x, peg.y - 6, String(points), peg.kind);
  award(game, points);

  if (peg.kind === "orange") {
    const flight = Math.hypot(peg.x - ball.lastHitX, peg.y - ball.lastHitY);
    // A long flight between two hits of the same shot (the launch itself does not count).
    if (!game.shot.longShot && game.shot.hits > 1 && flight >= 120) {
      game.shot.longShot = true;
      game.stats.style.push("LONG SHOT");
      banner(game, `LONG SHOT +${SPG_LONG_SHOT.toLocaleString("en-US")}`);
      game.cues.push({ id: "saipeggle.style" });
      award(game, SPG_LONG_SHOT);
    } else if (ball.offWall) {
      game.stats.style.push("BANK SHOT");
      popup(game, peg.x, peg.y - 14, "BANK +1000", "gold");
      award(game, 1000);
    }
    if (game.orangeHit >= game.orangeTotal && !game.fever) startFever(game, peg);
  }
  ball.lastHitX = peg.x;
  ball.lastHitY = peg.y;
  ball.offWall = false;
  ball.idle = 0;
  if (peg.kind === "green") activatePower(game, peg, ball);
}

function startFever(game: SpgGame, peg: SpgPeg): void {
  game.fever = true;
  game.slow = game.settings.slowMo ? 1.6 : 0;
  game.shake = game.settings.shake ? 0.5 : 0;
  banner(game, "EXTREME FEVER");
  popup(game, peg.x, peg.y - 14, "LAST ORANGE!", "orange");
  game.cues.push({ id: "saipeggle.fever" });
}

export function activatePower(game: SpgGame, peg: SpgPeg, ball: SpgBall): void {
  let power = game.power;
  if (power === "lucky") power = game.rng.pick(SPG_POWERS.filter((item) => item !== "lucky"));
  const name = SPG_POWER_INFO[power].name.toUpperCase();
  banner(game, game.power === "lucky" ? `LUCKY SPIN: ${name}` : name);
  game.cues.push({ id: "saipeggle.power" });
  switch (power) {
    case "guide":
      game.guideShots += 3;
      break;
    case "zen":
      game.zenShots += 1;
      break;
    case "pyramid":
      game.pyramidTurns += 3;
      break;
    case "multiball": {
      const extraX = Math.max(SPG_BOARD.left + SPG_BALL_R, Math.min(SPG_BOARD.right - SPG_BALL_R, peg.x));
      const extraY = Math.max(SPG_BOARD.top + SPG_BALL_R, Math.min(SPG_BOARD.bottom - SPG_BALL_R, peg.y - 8));
      const extra = saipeggleNewBall(extraX, extraY, -ball.vx, -Math.abs(ball.vy) * 0.9 - 40);
      extra.lastHitX = peg.x;
      extra.lastHitY = peg.y;
      game.balls.push(extra);
      break;
    }
    case "blast":
      game.shake = game.settings.shake ? 0.35 : 0;
      for (const other of game.pegs) {
        if (other !== peg && !other.lit && !other.gone && Math.hypot(other.x - peg.x, other.y - peg.y) <= 42) lightPeg(game, other, ball);
      }
      break;
    case "spooky":
      for (const item of game.balls) item.spooky = true;
      break;
    case "fireball":
      for (const item of game.balls) item.fire = 3;
      break;
    default:
      break;
  }
}

/** What a traced path is worth to the Zen Ball: pegs by colour, the last oranges most, a bucket catch. */
function pathValue(game: SpgGame, hits: readonly SpgPeg[], caught: boolean): number {
  const left = game.orangeTotal - game.orangeHit;
  let value = caught ? 400 : 0;
  for (const peg of hits) {
    if (peg.lit) continue;
    value += peg.kind === "orange" ? 100 + (left <= 3 ? 400 : 0) : peg.kind === "purple" ? 500 : peg.kind === "green" ? 80 : 10;
  }
  return value;
}

/** The Zen Ball: the best aim within 3 degrees of the operator's, by the value of its whole path. */
export function zenAim(game: SpgGame): number {
  const physics = physicsOf(game);
  const bucket = bucketOf(game);
  let best = Math.max(-SPG_AIM_LIMIT, Math.min(SPG_AIM_LIMIT, game.aim));
  let bestValue = -1;
  for (let step = -12; step <= 12; step += 1) {
    const rawAim = game.aim + (step * 0.25 * Math.PI) / 180;
    const aim = Math.max(-SPG_AIM_LIMIT, Math.min(SPG_AIM_LIMIT, rawAim));
    const trace = saipeggleTrace(aim, game.pegs, bucket, physics, { seconds: 7, every: 1000 });
    const value = pathValue(game, trace.hits, trace.caught) - Math.abs(step) * 0.5;
    if (value > bestValue) {
      bestValue = value;
      best = aim;
    }
  }
  return best;
}
