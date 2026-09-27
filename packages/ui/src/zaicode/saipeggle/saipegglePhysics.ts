import {
  SPG_BALL_R,
  SPG_BOARD,
  SPG_BRICK_HALF,
  SPG_BRICK_R,
  SPG_BUCKET_Y,
  SPG_CANNON,
  SPG_FEVER_BUCKETS,
  SPG_GRAVITY,
  SPG_H,
  SPG_LAUNCH_SPEED,
  SPG_MAX_SPEED,
  SPG_PEG_R,
  type SpgPeg,
} from "./saipeggleModel.js";

/**
 * SAIPEGGLE's ball physics. Pure and deterministic: the same aim on the same
 * board always takes the same path (the Super Guide and the Zen Ball rely on
 * that). One call is one 1/240 s substep; a ball never moves more than
 * ~1.6 px per substep, so it cannot skip through a 4 px peg.
 */

export interface SpgBall {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds of Fireball left: pegs light up but do not bounce the ball. */
  fire: number;
  /** Spooky Ball: the first fall out of the bottom drops the ball in again from the top. */
  spooky: boolean;
  alive: boolean;
  /** Where the ball stood when it last moved noticeably, and for how long it has not. */
  anchorX: number;
  anchorY: number;
  still: number;
  /** Rattling: seconds without a new lit peg or a new lowest point (the game resets it on a hit). */
  idle: number;
  lowest: number;
  /** For the Long Shot: where the previous peg was hit. */
  lastHitX: number;
  lastHitY: number;
  /** A wall bounce happened since the last peg hit ("Off the wall"). */
  offWall: boolean;
}

export interface SpgPhysics {
  gravity: number;
  bounce: number;
}

export interface SpgBucket {
  x: number;
  half: number;
}

export type SpgStepEvent =
  | { kind: "peg"; peg: SpgPeg }
  | { kind: "wall" }
  | { kind: "caught" }
  | { kind: "fever"; bucket: number }
  | { kind: "lost" }
  | { kind: "spooky" }
  | { kind: "stuck" };

export const SPG_STUCK_SECONDS = 1.6;
export const SPG_RATTLE_SECONDS = 3;
const STUCK_RADIUS = 14;
const WALL_BOUNCE = 0.82;
const TANGENT_KEEP = 0.985;
/** Below this approach speed a contact is resting, not an impact. */
const IMPACT_SPEED = 25;

export function saipeggleMuzzle(aim: number): { x: number; y: number; vx: number; vy: number } {
  const sx = Math.sin(aim);
  const cy = Math.cos(aim);
  return {
    x: SPG_CANNON.x + sx * SPG_CANNON.barrel,
    y: SPG_CANNON.y + cy * SPG_CANNON.barrel,
    vx: sx * SPG_LAUNCH_SPEED,
    vy: cy * SPG_LAUNCH_SPEED,
  };
}

export function saipeggleNewBall(x: number, y: number, vx: number, vy: number): SpgBall {
  return { x, y, vx, vy, fire: 0, spooky: false, alive: true, anchorX: x, anchorY: y, still: 0, idle: 0, lowest: y, lastHitX: x, lastHitY: y, offWall: false };
}

/** The point of a peg's surface core nearest to (x, y), and that core's radius. */
export function saipeggleCore(peg: SpgPeg, x: number, y: number): { cx: number; cy: number; r: number } {
  if (peg.shape === "round") return { cx: peg.x, cy: peg.y, r: SPG_PEG_R };
  const ux = Math.cos(peg.angle);
  const uy = Math.sin(peg.angle);
  const t = Math.max(-SPG_BRICK_HALF, Math.min(SPG_BRICK_HALF, (x - peg.x) * ux + (y - peg.y) * uy));
  return { cx: peg.x + ux * t, cy: peg.y + uy * t, r: SPG_BRICK_R };
}

/** Bounces `ball` off a circle of radius `r` at (cx, cy); true when they touched. */
function bounceOff(ball: SpgBall, cx: number, cy: number, r: number, restitution: number, solid: boolean): boolean {
  const dx = ball.x - cx;
  const dy = ball.y - cy;
  const reach = SPG_BALL_R + r;
  const d2 = dx * dx + dy * dy;
  if (d2 >= reach * reach) return false;
  if (!solid) return true;
  const d = Math.sqrt(d2) || 1e-6;
  const nx = d2 > 1e-12 ? dx / d : 0;
  const ny = d2 > 1e-12 ? dy / d : -1;
  ball.x = cx + nx * reach;
  ball.y = cy + ny * reach;
  const vn = ball.vx * nx + ball.vy * ny;
  if (vn < -IMPACT_SPEED) {
    // A real impact: bounce, and lose a little of the sideways speed once.
    const tx = ball.vx - vn * nx;
    const ty = ball.vy - vn * ny;
    ball.vx = tx * TANGENT_KEEP - vn * restitution * nx;
    ball.vy = ty * TANGENT_KEEP - vn * restitution * ny;
  } else if (vn < 0) {
    // Resting contact (the ball lies on the peg): no bounce and no friction, it slides
    // off. Friction applied on every 1/240 s substep of a contact was glue
    // (0.985^240 ~ 0.03 per second): balls crawled over pegs for half a minute.
    ball.vx -= vn * nx;
    ball.vy -= vn * ny;
  }
  return true;
}

function clampSpeed(ball: SpgBall): void {
  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed > SPG_MAX_SPEED) {
    ball.vx *= SPG_MAX_SPEED / speed;
    ball.vy *= SPG_MAX_SPEED / speed;
  }
}

/** Where the fever buckets' dividers stand (x of each post). */
export function saipeggleFeverPosts(): number[] {
  const width = (SPG_BOARD.right - SPG_BOARD.left) / SPG_FEVER_BUCKETS.length;
  return Array.from({ length: SPG_FEVER_BUCKETS.length + 1 }, (_, i) => SPG_BOARD.left + i * width);
}

/**
 * One substep for one ball. `bucket` is the moving bucket (null while the
 * fever buckets are out). Pegs the ball touches are reported every time
 * (the game lights a peg on its first report).
 */
export function saipeggleStep(
  ball: SpgBall,
  pegs: readonly SpgPeg[],
  bucket: SpgBucket | null,
  physics: SpgPhysics,
  dt: number,
  events: SpgStepEvent[],
): void {
  if (!ball.alive) return;
  ball.vy += SPG_GRAVITY * physics.gravity * dt;
  clampSpeed(ball);
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  if (ball.fire > 0) ball.fire = Math.max(0, ball.fire - dt);

  if (ball.x - SPG_BALL_R < SPG_BOARD.left && ball.vx < 0) {
    ball.x = SPG_BOARD.left + SPG_BALL_R;
    ball.vx = -ball.vx * WALL_BOUNCE;
    ball.offWall = true;
    events.push({ kind: "wall" });
  } else if (ball.x + SPG_BALL_R > SPG_BOARD.right && ball.vx > 0) {
    ball.x = SPG_BOARD.right - SPG_BALL_R;
    ball.vx = -ball.vx * WALL_BOUNCE;
    ball.offWall = true;
    events.push({ kind: "wall" });
  }
  if (ball.y - SPG_BALL_R < SPG_BOARD.top && ball.vy < 0) {
    ball.y = SPG_BOARD.top + SPG_BALL_R;
    ball.vy = -ball.vy * WALL_BOUNCE;
  }

  for (const peg of pegs) {
    if (peg.gone) continue;
    // Cheap reject before the exact test.
    if (Math.abs(ball.x - peg.x) > 12 || Math.abs(ball.y - peg.y) > 12) continue;
    const core = saipeggleCore(peg, ball.x, ball.y);
    if (bounceOff(ball, core.cx, core.cy, core.r, physics.bounce, ball.fire <= 0)) events.push({ kind: "peg", peg });
  }

  if (bucket) {
    const postY = SPG_BUCKET_Y + 3;
    bounceOff(ball, bucket.x - bucket.half, postY, 2, 0.6, true);
    bounceOff(ball, bucket.x + bucket.half, postY, 2, 0.6, true);
    if (ball.vy > 0 && ball.y + SPG_BALL_R >= SPG_BUCKET_Y + 2 && Math.abs(ball.x - bucket.x) < bucket.half - 2) {
      ball.alive = false;
      events.push({ kind: "caught" });
      return;
    }
  } else {
    const posts = saipeggleFeverPosts();
    for (const x of posts) bounceOff(ball, x, SPG_H - 8, 2, 0.5, true);
    if (ball.y + SPG_BALL_R >= SPG_H - 4) {
      const width = (SPG_BOARD.right - SPG_BOARD.left) / SPG_FEVER_BUCKETS.length;
      const index = Math.max(0, Math.min(SPG_FEVER_BUCKETS.length - 1, Math.floor((ball.x - SPG_BOARD.left) / width)));
      ball.alive = false;
      events.push({ kind: "fever", bucket: index });
      return;
    }
  }

  if (ball.y - SPG_BALL_R > SPG_H) {
    if (ball.spooky) {
      ball.spooky = false;
      ball.y = SPG_BOARD.top + SPG_BALL_R + 1;
      ball.vy = Math.min(ball.vy, 60);
      events.push({ kind: "spooky" });
    } else {
      ball.alive = false;
      events.push({ kind: "lost" });
      return;
    }
  }

  if (ball.y > ball.lowest + 6) {
    ball.lowest = ball.y;
    ball.idle = 0;
  } else {
    ball.idle += dt;
  }
  // Stuck = not 14 px away from where it was 1.6 s ago. A smaller radius let a ball
  // crawling down a shallow brick at a few px/s count as moving for half a minute.
  if (Math.hypot(ball.x - ball.anchorX, ball.y - ball.anchorY) > STUCK_RADIUS) {
    ball.anchorX = ball.x;
    ball.anchorY = ball.y;
    ball.still = 0;
  } else {
    ball.still += dt;
  }
  if (ball.still >= SPG_STUCK_SECONDS || ball.idle >= SPG_RATTLE_SECONDS) {
    ball.still = 0;
    ball.idle = 0;
    events.push({ kind: "stuck" });
  }
}

export interface SpgTrace {
  points: { x: number; y: number }[];
  /** Pegs the path touches, in order (each once). */
  hits: SpgPeg[];
  caught: boolean;
}

/**
 * Follows a shot without changing the board: the aim guide (`stopAtPeg`), the
 * Super Guide (whole path) and the Zen Ball's search. Every `every`-th
 * substep adds a point.
 */
export function saipeggleTrace(
  aim: number,
  pegs: readonly SpgPeg[],
  bucket: SpgBucket | null,
  physics: SpgPhysics,
  options: { seconds: number; stopAtPeg?: boolean; every?: number },
): SpgTrace {
  const m = saipeggleMuzzle(aim);
  const ball = saipeggleNewBall(m.x, m.y, m.vx, m.vy);
  const hits: SpgPeg[] = [];
  const seen = new Set<number>();
  const points = [{ x: ball.x, y: ball.y }];
  const events: SpgStepEvent[] = [];
  const steps = Math.round(options.seconds * 240);
  const every = options.every ?? 2;
  let caught = false;
  for (let i = 0; i < steps && ball.alive; i += 1) {
    events.length = 0;
    saipeggleStep(ball, pegs, bucket, physics, 1 / 240, events);
    for (const event of events) {
      if (event.kind === "peg" && !seen.has(event.peg.id)) {
        seen.add(event.peg.id);
        hits.push(event.peg);
      } else if (event.kind === "caught") caught = true;
      else if (event.kind === "stuck") ball.alive = false;
    }
    if (i % every === 0) points.push({ x: ball.x, y: ball.y });
    if (options.stopAtPeg && hits.length > 0) break;
  }
  return { points, hits, caught };
}
