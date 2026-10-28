import {
  SPG_AIM_LIMIT,
  SPG_BALL_BONUS,
  SPG_BOARD,
  SPG_FEVER_BUCKETS,
  SPG_STEP,
  type SaipeggleSettings,
} from "./saipeggleModel.js";
import { saipeggleDeal, saipeggleLayout, type SpgLevelSpec } from "./saipeggleLevels.js";
import type { SpgPlace } from "./saipegglePatterns.js";
import { saipeggleMuzzle, saipeggleNewBall, saipeggleStep, saipeggleTrace, type SpgBall, type SpgStepEvent } from "./saipegglePhysics.js";
import { saipeggleRng } from "./saipeggleRandom.js";
import {
  assignPurple,
  banner,
  bucketOf,
  lightPeg,
  newShot,
  physicsOf,
  popup,
  saipegglePitch,
  zenAim,
  type SpgGame,
} from "./saipeggleRules.js";

/**
 * The SAIPEGGLE game loop: a level from its spec, aiming, shooting, the
 * physics substeps, the pop of lit pegs after each shot, and the end of the
 * level. Pure state; the view draws it and plays the queued cues.
 */

export type { SpgGame } from "./saipeggleRules.js";

const MAX_STEPS_PER_UPDATE = 48;
const CLEAR_EVERY = 0.045;
const BUCKET_SPEED = 46;

export function createSaipeggleGame(spec: SpgLevelSpec, settings: SaipeggleSettings, attempt = 0, places?: readonly SpgPlace[]): SpgGame {
  const layout = places ?? saipeggleLayout(spec, settings.density);
  const pegs = saipeggleDeal(layout, spec, settings, attempt);
  const game: SpgGame = {
    spec,
    settings,
    attempt,
    pegs,
    balls: [],
    phase: "intro",
    phaseTime: 0,
    aim: 0,
    ballsLeft: settings.balls,
    score: 0,
    shot: newShot(),
    orangeTotal: pegs.filter((peg) => peg.kind === "orange").length,
    orangeHit: 0,
    power: settings.power === "stage" ? spec.power : settings.power,
    guideShots: 0,
    zenShots: 0,
    pyramidTurns: 0,
    bucketX: (SPG_BOARD.left + SPG_BOARD.right) / 2,
    bucketDir: 1,
    purpleId: null,
    fever: false,
    feverBonus: 0,
    ballBonus: 0,
    slow: 0,
    shake: 0,
    banner: null,
    popups: [],
    particles: [],
    cues: [],
    clearQueue: [],
    clearTimer: 0,
    accumulator: 0,
    rng: saipeggleRng(`${spec.seed}/play/${attempt}`),
    stats: { shots: 0, catches: 0, style: [] },
  };
  assignPurple(game);
  return game;
}

function setPhase(game: SpgGame, phase: SpgGame["phase"]): void {
  game.phase = phase;
  game.phaseTime = 0;
}

export function saipeggleSetAim(game: SpgGame, aim: number): void {
  game.aim = Math.max(-SPG_AIM_LIMIT, Math.min(SPG_AIM_LIMIT, aim));
}

/** Aim at a point on the screen (the cannon turns toward it). */
export function saipeggleAimAt(game: SpgGame, x: number, y: number, cannonX: number, cannonY: number): void {
  const dx = x - cannonX;
  const dy = Math.max(1, y - cannonY);
  saipeggleSetAim(game, Math.atan2(dx, dy));
}

/** Click / Space: leaves the intro, or fires when the cannon is ready. */
export function saipeggleShoot(game: SpgGame): boolean {
  if (game.phase === "intro") {
    setPhase(game, "aim");
    return false;
  }
  if (game.phase !== "aim" || game.ballsLeft <= 0) return false;
  let aim = game.aim;
  if (game.zenShots > 0) {
    aim = zenAim(game);
    game.zenShots -= 1;
    if (Math.abs(aim - game.aim) > 1e-6) banner(game, "ZEN BALL");
  }
  const muzzle = saipeggleMuzzle(aim);
  game.balls = [saipeggleNewBall(muzzle.x, muzzle.y, muzzle.vx, muzzle.vy)];
  game.ballsLeft -= 1;
  if (game.guideShots > 0) game.guideShots -= 1;
  game.shot = newShot();
  game.stats.shots += 1;
  game.cues.push({ id: "saipeggle.shoot" });
  setPhase(game, "flight");
  return true;
}

function burst(game: SpgGame, x: number, y: number, tone: SpgGame["particles"][number]["tone"]): void {
  if (!game.settings.particles) return;
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * Math.PI * 2 + Math.random() * 0.8;
    const speed = 30 + Math.random() * 40;
    game.particles.push({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed - 30, age: 0, life: 0.45 + Math.random() * 0.3, tone });
  }
  if (game.particles.length > 240) game.particles.splice(0, game.particles.length - 240);
}

function popPeg(game: SpgGame, id: number, step: number): void {
  const peg = game.pegs[id];
  if (!peg || peg.gone) return;
  peg.gone = true;
  burst(game, peg.x, peg.y, peg.kind);
  game.cues.push({ id: "saipeggle.clear", rate: saipegglePitch(Math.min(step, 12)) });
}

function handle(game: SpgGame, ball: SpgBall, event: SpgStepEvent): void {
  switch (event.kind) {
    case "peg":
      lightPeg(game, event.peg, ball);
      break;
    case "wall":
      game.cues.push({ id: "saipeggle.wall" });
      break;
    case "caught":
      game.ballsLeft += 1;
      game.stats.catches += 1;
      popup(game, ball.x, ball.y - 10, "FREE BALL", "gold", true);
      game.cues.push({ id: "saipeggle.bucket" });
      break;
    case "fever": {
      const bonus = SPG_FEVER_BUCKETS[event.bucket] ?? 0;
      game.score += bonus;
      game.feverBonus += bonus;
      popup(game, ball.x, ball.y - 14, `+${bonus.toLocaleString("en-US")}`, "gold", true);
      game.cues.push({ id: "saipeggle.feverBucket" });
      break;
    }
    case "lost":
      if (!game.fever) game.cues.push({ id: "saipeggle.lost" });
      break;
    case "spooky":
      game.cues.push({ id: "saipeggle.power" });
      break;
    case "stuck": {
      // A ball resting on pegs: the lit pegs holding it go now, as in the genre.
      const near = game.pegs.filter((peg) => peg.lit && !peg.gone && Math.hypot(peg.x - ball.x, peg.y - ball.y) <= 22);
      near.forEach((peg, index) => popPeg(game, peg.id, index));
      if (near.length === 0) ball.vy += 60;
      break;
    }
  }
}

function finishShot(game: SpgGame): void {
  game.clearQueue = game.shot.order.filter((id) => !game.pegs[id]!.gone);
  game.clearTimer = 0;
  setPhase(game, "clearing");
}

function finishClearing(game: SpgGame): void {
  if (game.orangeTotal === 0 || game.orangeHit >= game.orangeTotal) {
    game.ballBonus = game.ballsLeft * SPG_BALL_BONUS;
    game.score += game.ballBonus;
    banner(game, "LEVEL CLEAR");
    game.cues.push({ id: "saipeggle.win" });
    setPhase(game, "won");
    return;
  }
  if (game.ballsLeft <= 0) {
    banner(game, "OUT OF BALLS");
    game.cues.push({ id: "saipeggle.fail" });
    setPhase(game, "lost");
    return;
  }
  if (game.pyramidTurns > 0) game.pyramidTurns -= 1;
  assignPurple(game);
  setPhase(game, "aim");
}

function animate(game: SpgGame, dt: number): void {
  for (const item of game.popups) {
    item.age += dt;
    item.y -= dt * (item.big ? 10 : 16);
  }
  game.popups = game.popups.filter((item) => item.age < item.life);
  for (const item of game.particles) {
    item.age += dt;
    item.vy += 160 * dt;
    item.x += item.vx * dt;
    item.y += item.vy * dt;
  }
  game.particles = game.particles.filter((item) => item.age < item.life);
  if (game.banner) {
    game.banner.age += dt;
    if (game.banner.age > 1.8) game.banner = null;
  }
  game.shake = Math.max(0, game.shake - dt);
  game.slow = Math.max(0, game.slow - dt);
}

function moveBucket(game: SpgGame, dt: number): void {
  const bucket = bucketOf(game);
  if (!bucket) return;
  const stage = game.spec.stage ?? 6;
  const speed = BUCKET_SPEED * game.settings.bucketSpeed * (1 + stage * 0.04);
  game.bucketX += game.bucketDir * speed * dt;
  const min = SPG_BOARD.left + bucket.half + 2;
  const max = SPG_BOARD.right - bucket.half - 2;
  if (game.bucketX <= min) {
    game.bucketX = min;
    game.bucketDir = 1;
  } else if (game.bucketX >= max) {
    game.bucketX = max;
    game.bucketDir = -1;
  }
}

/** Advances the game by `dtReal` seconds of real time. */
export function saipeggleUpdate(game: SpgGame, dtReal: number): void {
  const dt = Math.max(0, Math.min(0.05, dtReal));
  game.phaseTime += dt;
  animate(game, dt);
  const scale = game.slow > 0 ? 0.3 : 1;
  if (game.phase === "aim" || game.phase === "flight") moveBucket(game, dt * scale);

  if (game.phase === "flight") {
    game.accumulator += dt * scale;
    const physics = physicsOf(game);
    const events: SpgStepEvent[] = [];
    let steps = 0;
    while (game.accumulator >= SPG_STEP && steps < MAX_STEPS_PER_UPDATE) {
      game.accumulator -= SPG_STEP;
      steps += 1;
      const bucket = bucketOf(game);
      // A Multiball split adds a ball mid-step; it starts moving on the next substep.
      const moving = game.balls.slice();
      for (const ball of moving) {
        events.length = 0;
        saipeggleStep(ball, game.pegs, bucket, physics, SPG_STEP, events);
        for (const event of events) handle(game, ball, event);
      }
    }
    game.balls = game.balls.filter((ball) => ball.alive);
    if (game.balls.length === 0) {
      game.accumulator = 0;
      finishShot(game);
    }
  } else if (game.phase === "clearing") {
    game.clearTimer += dt;
    while (game.clearTimer >= CLEAR_EVERY && game.clearQueue.length > 0) {
      game.clearTimer -= CLEAR_EVERY;
      const step = game.shot.order.length - game.clearQueue.length;
      popPeg(game, game.clearQueue.shift()!, step);
    }
    if (game.clearQueue.length === 0 && game.clearTimer >= CLEAR_EVERY) finishClearing(game);
  }
}

/** The aim guide: the path up to the first peg, or the whole path while the Super Guide lasts. */
export function saipeggleGuide(game: SpgGame): { x: number; y: number }[] | null {
  if (game.phase !== "aim") return null;
  const bucket = bucketOf(game);
  if (game.guideShots > 0) return saipeggleTrace(game.aim, game.pegs, bucket, physicsOf(game), { seconds: 3.2, every: 3 }).points;
  if (!game.settings.aimGuide) return null;
  return saipeggleTrace(game.aim, game.pegs, bucket, physicsOf(game), { seconds: 1.1, stopAtPeg: true, every: 3 }).points;
}
