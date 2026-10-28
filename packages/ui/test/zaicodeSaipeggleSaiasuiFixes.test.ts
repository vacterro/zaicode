import assert from "node:assert/strict";
import test from "node:test";
import {
  saipeggleDeal,
  saipeggleLevelCode,
  saipeggleParseLevelCode,
} from "../src/zaicode/saipeggle/saipeggleLevels.js";
import {
  SPG_AIM_LIMIT,
  SPG_BALL_R,
  SPG_BOARD,
  saipeggleDefaults,
} from "../src/zaicode/saipeggle/saipeggleModel.js";
import {
  saipeggleNewBall,
  saipeggleStep,
  type SpgStepEvent,
} from "../src/zaicode/saipeggle/saipegglePhysics.js";
import {
  createSaipeggleGame,
  saipeggleSetAim,
} from "../src/zaicode/saipeggle/saipeggleGame.js";
import { lightPeg, zenAim } from "../src/zaicode/saipeggle/saipeggleRules.js";
import { saiasuiChinese, saiasuiEnglish } from "../src/i18n/locales/saiasui.js";

test("saipeggle: ceiling collision emits wall event and sets ball.offWall", () => {
  const ball = saipeggleNewBall(160, SPG_BOARD.top + SPG_BALL_R - 1, 0, -50);
  const events: SpgStepEvent[] = [];
  saipeggleStep(ball, [], null, { gravity: 1, bounce: 0.8 }, 1 / 240, events);
  assert.equal(ball.offWall, true);
  assert.ok(events.some((e) => e.kind === "wall"));
  assert.ok(ball.vy > 0);
  assert.ok(ball.y >= SPG_BOARD.top + SPG_BALL_R);
});

test("saipeggle: zenAim stays strictly within [-SPG_AIM_LIMIT, SPG_AIM_LIMIT]", () => {
  const spec = {
    id: "test",
    name: "test",
    seed: "zen-test",
    template: "sparse" as const,
    stage: 1,
    power: "zen" as const,
    places: [{ x: 160, y: 100, shape: "round" as const, angle: 0 }],
  };
  const game = createSaipeggleGame(spec, saipeggleDefaults(), 0);
  saipeggleSetAim(game, SPG_AIM_LIMIT);
  const aimNearMax = zenAim(game);
  assert.ok(aimNearMax <= SPG_AIM_LIMIT + 1e-9);
  assert.ok(aimNearMax >= -SPG_AIM_LIMIT - 1e-9);

  saipeggleSetAim(game, -SPG_AIM_LIMIT);
  const aimNearMin = zenAim(game);
  assert.ok(aimNearMin <= SPG_AIM_LIMIT + 1e-9);
  assert.ok(aimNearMin >= -SPG_AIM_LIMIT - 1e-9);
});

test("saipeggle: multiball clamps extra ball within board bounds when triggered near ceiling", () => {
  const spec = {
    id: "test-multi",
    name: "test-multi",
    seed: "multi-test",
    template: "code" as const,
    stage: null,
    power: "multiball" as const,
    places: [{ x: 160, y: 50, shape: "round" as const, angle: 0 }],
  };
  const game = createSaipeggleGame(spec, saipeggleDefaults(), 0);
  game.power = "multiball";
  // Simulate a peg near the top ceiling (e.g. at y = 15)
  const topPeg = { id: 0, x: 160, y: 15, shape: "round" as const, angle: 0, kind: "green" as const, lit: false, gone: false };
  game.pegs = [topPeg];
  const ball = saipeggleNewBall(160, 25, 0, -20);
  lightPeg(game, topPeg, ball);
  assert.equal(game.balls.length, 1);
  const extra = game.balls[0]!;
  assert.ok(extra.y >= SPG_BOARD.top + SPG_BALL_R);
  assert.ok(extra.x >= SPG_BOARD.left + SPG_BALL_R);
  assert.ok(extra.x <= SPG_BOARD.right - SPG_BALL_R);
});

test("saipeggle: saipeggleDeal ensures at least 1 orange peg on small boards", () => {
  const spec = {
    id: "small",
    name: "small",
    seed: "small-seed",
    template: "sparse" as const,
    stage: 1,
    power: "guide" as const,
    places: [
      { x: 160, y: 100, shape: "round" as const, angle: 0 },
      { x: 170, y: 100, shape: "round" as const, angle: 0 },
    ],
  };
  const pegs = saipeggleDeal(spec.places, spec, { orange: 25, green: 2 }, 0);
  assert.equal(pegs.length, 2);
  const oranges = pegs.filter((p) => p.kind === "orange");
  assert.equal(oranges.length, 1);
});

test("saipeggle: level codes parse unpadded base64 correctly", () => {
  const spec = {
    id: "code-test",
    name: "Code Test",
    seed: "SEED42",
    template: "code" as const,
    stage: null,
    power: "pyramid" as const,
    places: [{ x: 160, y: 100, shape: "round" as const, angle: 0 }],
  };
  const code = saipeggleLevelCode(spec, spec.places);
  assert.ok(code.startsWith("SPG1."));
  const parsed = saipeggleParseLevelCode(code);
  assert.ok(parsed);
  assert.equal(parsed.name, "Code Test");
  assert.equal(parsed.power, "pyramid");
  assert.equal(parsed.places.length, 1);
});

test("saiasui: locale strings include retryHint", () => {
  assert.ok(saiasuiEnglish["saiasui.retryHint"].includes("Space"));
  assert.ok(saiasuiChinese["saiasui.retryHint"].includes("空格"));
});
