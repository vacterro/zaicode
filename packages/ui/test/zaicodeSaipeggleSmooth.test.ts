import assert from "node:assert/strict";
import test from "node:test";
import { saipeggleCampaign, saipeggleDeal, saipeggleLayout } from "../src/zaicode/saipeggle/saipeggleLevels.js";
import { SPG_BALL_R, SPG_BRICK_HALF, SPG_BRICK_R, saipeggleDefaults, type SpgPeg } from "../src/zaicode/saipeggle/saipeggleModel.js";
import { saipeggleNewBall, saipeggleStep, type SpgStepEvent } from "../src/zaicode/saipeggle/saipegglePhysics.js";

// SRC-081: "if the ball rolls in a straight line (level 2, along the slope) it can
// jump off an invisible curb although there is nothing there".

const campaign = saipeggleCampaign();

/** The first row of bricks of adventure level 1-2 ("Lightning"): a long, gentle slope. */
function slopeRow(): SpgPeg[] {
  const spec = campaign[1]!;
  const pegs = saipeggleDeal(saipeggleLayout(spec, 1), spec, saipeggleDefaults(), 0);
  return pegs.filter((peg) => peg.shape === "brick" && peg.y < 90);
}

test("a ball rolling along a straight row of bricks stays on it: no hop at any seam", () => {
  const row = slopeRow();
  assert.ok(row.length >= 12, `the slope has ${row.length} bricks`);
  const first = row[0]!;
  const angle = first.angle;
  const nx = Math.sin(angle);
  const ny = -Math.cos(angle);
  const tx = Math.cos(angle);
  const ty = Math.sin(angle);
  const reach = SPG_BALL_R + SPG_BRICK_R;
  const events: SpgStepEvent[] = [];
  for (const speed of [40, 100, 160, 220]) {
    const ball = saipeggleNewBall(first.x + 2 + nx * reach, first.y + ny * reach, tx * speed, ty * speed);
    let lift = 0;
    for (let step = 0; step < 240 * 3 && ball.alive; step += 1) {
      events.length = 0;
      saipeggleStep(ball, row, { x: 160, half: 1 }, { gravity: 1, bounce: 0.78 }, 1 / 240, events);
      if (ball.x > row.at(-1)!.x - 6) break;
      if (ball.x < first.x) continue;
      const height = (ball.x - first.x) * nx + (ball.y - first.y) * ny - reach;
      lift = Math.max(lift, height);
    }
    assert.ok(lift < 1.5, `at ${speed} px/s the ball rose ${lift.toFixed(2)} px above the slope`);
  }
});

test("bricks of one row lie on one line: no seam is a step (every adventure level)", () => {
  for (const spec of campaign) {
    const places = saipeggleLayout(spec, 1);
    const bricks = places.filter((place) => place.shape === "brick");
    for (let i = 0; i < bricks.length; i += 1) {
      for (let j = i + 1; j < bricks.length; j += 1) {
        const a = bricks[i]!;
        const b = bricks[j]!;
        if (Math.abs(a.angle - b.angle) > 1e-6) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const along = dx * Math.cos(a.angle) + dy * Math.sin(a.angle);
        const across = Math.abs(-dx * Math.sin(a.angle) + dy * Math.cos(a.angle));
        // Neighbours in a row: 14 px apart at most along it, their axes near one line.
        // Literals, not the model's constants: the oracle must not move with the brick length.
        if (Math.abs(along) > 14 || across > 2.5) continue;
        assert.ok(across < 0.1, `${spec.id}: two bricks of one row differ by ${across.toFixed(2)} px across the row (a step of that height throws a rolling ball)`);
      }
    }
  }
});

test("a row of bricks 12-13 px apart has touching cores: no groove between two bricks", () => {
  // The cores are as long as the centre spacing of the densest rows, so the surface
  // a ball rolls on is continuous. With cores of 10 there was a 3 px gap at every seam.
  assert.ok(SPG_BRICK_HALF * 2 >= 13, `brick core is ${SPG_BRICK_HALF * 2} px`);
});
