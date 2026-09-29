import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { advanceRun, createRun, targetPoint, type AimTarget } from "../src/zaicode/saiasui/saiasuiEngine.js";
import { SAIASUI_DEFAULTS, SAIASUI_LIMITS, type SaiasuiConfig } from "../src/zaicode/saiasui/saiasuiConfig.js";

// SRC-081: "the balls look cropped" (a ball drawn as four slivers, a ring cut to
// four corner arcs) and "SAIASUI without bugs at all".

const source = (path: string) => readFileSync(join(import.meta.dirname, "../src", path), "utf8");
const cfg = (patch: Partial<SaiasuiConfig> = {}): SaiasuiConfig => ({ ...SAIASUI_DEFAULTS, ...patch });

test("a ball is drawn round: no border on a button (ZAICODE zeroes every border-radius), no fixed ring box", () => {
  const target = source("zaicode/saiasui/SaiasuiTarget.tsx");
  // The global rule `html.zaicode-fonts * { border-radius: 0 !important }` squares any
  // bordered element; a circular clip-path over a square border leaves four slivers.
  assert.doesNotMatch(target, /borderWidth|borderStyle|borderColor/, "the ball is not a bordered button");
  // The ring's box was a fixed 144 px SVG that clips every ring wider than 72 px.
  assert.doesNotMatch(target, /width:\s*144|height:\s*144|viewBox="0 0 144 144"/, "no fixed 144 px ring box");
  assert.match(target, /overflow:\s*"visible"/, "the ring svg never clips");
  assert.match(target, /data-zaicode-pixel-filter/, "thin strokes opt out of the pixel threshold filter");
});

test("the ball's square holds the widest ring at every setting the panel allows", async () => {
  const { saiasuiTargetShape } = await import("../src/zaicode/saiasui/saiasuiTargetShape.js");
  const limit = (key: keyof typeof SAIASUI_LIMITS) => SAIASUI_LIMITS[key] as readonly [number, number, number];
  for (const targetSize of [limit("targetSize")[0], SAIASUI_DEFAULTS.targetSize, limit("targetSize")[1]]) {
    for (const ringDuration of [0, SAIASUI_DEFAULTS.ringDuration, limit("ringDuration")[1]]) {
      for (const animIntensity of [0, 1, 3]) {
        const config = cfg({ targetSize, ringDuration, animIntensity, ringSize: limit("ringSize")[1], ringThickness: limit("ringThickness")[1] });
        const target = { id: 3, kind: "normal", born: 0, expires: 2 } as Pick<AimTarget, "id" | "kind" | "born" | "expires">;
        for (const now of [0, 0.5, 1, 2]) {
          const shape = saiasuiTargetShape(target, now, config);
          assert.ok(
            shape.extent >= shape.ringReach + config.ringThickness / 2,
            `ring ${shape.ringReach.toFixed(1)} + stroke does not fit a ${shape.extent} px half box (size ${targetSize}, duration ${ringDuration}, intensity ${animIntensity}, t ${now})`,
          );
          assert.ok(shape.extent >= shape.radius, "the ball itself always fits");
        }
      }
    }
  }
});

test("a moving ball orbits inside the playfield at the largest movement amount", () => {
  const config = cfg({ movementEnabled: true, movementAmount: SAIASUI_LIMITS.movementAmount[1], movementSpeed: 5 });
  const run = createRun("orbit", config);
  for (const [x, y] of [[0.06, 0.06], [0.94, 0.94], [0.06, 0.94], [0.5, 0.5]] as const) {
    const target: AimTarget = { id: 1, x, y, born: 0, expires: 10, kind: "moving", phase: 0 };
    for (let now = 0; now < 4; now += 0.05) {
      const p = targetPoint(target, now, run, false);
      assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1, `(${p.x.toFixed(3)}, ${p.y.toFixed(3)}) left the field`);
    }
  }
});

test("the +HP ball never spawns on top of the ball it comes with", () => {
  let checked = 0;
  for (let seed = 0; seed < 60; seed += 1) {
    const run = createRun(`apart-${seed}`, cfg({ tinyEnabled: true, tinyFrequency: 1, eventIntervalMin: 1, eventIntervalMax: 1 }));
    run.hits = run.nextEvent;
    for (let i = 0; i < 100 && !run.target && !run.over; i += 1) advanceRun(run, 0.1);
    if (run.target && run.bonus) {
      checked += 1;
      const distance = Math.hypot(run.target.x - run.bonus.x, run.target.y - run.bonus.y);
      assert.ok(distance >= 0.14, `seed ${seed}: the balls are ${distance.toFixed(3)} apart`);
    }
  }
  assert.ok(checked >= 20, `${checked} event pairs were spawned to check`);
});
