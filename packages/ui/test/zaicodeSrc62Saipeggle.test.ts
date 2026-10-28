import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { contrast, parseRgb, readable, saipeggleColors } from "../src/zaicode/saipeggle/saipeggleColors.js";
import { saipeggleFontCovers } from "../src/zaicode/saipeggle/saipeggleFont.js";
import { createSaipeggleGame, saipeggleSetAim, saipeggleShoot, saipeggleUpdate } from "../src/zaicode/saipeggle/saipeggleGame.js";
import {
  SPG_STAGES,
  saipeggleCampaign,
  saipeggleDeal,
  saipeggleLayout,
  saipeggleLevelCode,
  saipeggleParseLevelCode,
  saipeggleRandomSpec,
} from "../src/zaicode/saipeggle/saipeggleLevels.js";
import {
  SPG_BALL_BONUS,
  SPG_PEG_AREA,
  normalizeSaipeggleSettings,
  saipeggleDefaults,
  saipeggleMultiplier,
  saipeggleMultiplierMarks,
  type SpgPeg,
} from "../src/zaicode/saipeggle/saipeggleModel.js";
import { saipeggleNewBall, saipeggleStep, saipeggleTrace, type SpgStepEvent } from "../src/zaicode/saipeggle/saipegglePhysics.js";
import { bucketOf, physicsOf, zenAim } from "../src/zaicode/saipeggle/saipeggleRules.js";
import { SPG_TEMPLATES } from "../src/zaicode/saipeggle/saipeggleTemplates.js";

// SRC-062: "SAIPEGGLE -- a full playable pixel game, no anti-aliasing: a cannon
// shoots balls at pegs, great physics, levels, score, sounds, a randomizer, a
// seed, level config", and then "you are building this game, right? (Peggle
// Deluxe on Steam) I want exactly that".

const settings = saipeggleDefaults();
const campaign = saipeggleCampaign();
const src = (path: string) => readFileSync(join(import.meta.dirname, "../src", path), "utf8");

test("the adventure: 11 stages x 5 levels, every board design used, every board sound", () => {
  assert.equal(SPG_STAGES.length, 11);
  assert.equal(campaign.length, 55);
  assert.equal(new Set(campaign.map((spec) => spec.id)).size, 55);
  assert.deepEqual(new Set(campaign.map((spec) => spec.template)), new Set(SPG_TEMPLATES.map((template) => template.id)));
  for (const spec of campaign) {
    const places = saipeggleLayout(spec, 1);
    assert.ok(places.length >= 50 && places.length <= 180, `${spec.id} has ${places.length} pegs`);
    for (const p of places) {
      assert.ok(p.x >= SPG_PEG_AREA.left - 5 && p.x <= SPG_PEG_AREA.right + 5 && p.y >= SPG_PEG_AREA.top - 5 && p.y <= SPG_PEG_AREA.bottom + 5, `${spec.id} peg outside`);
    }
    for (let i = 0; i < places.length; i += 1) {
      for (let j = i + 1; j < places.length; j += 1) {
        assert.ok(Math.hypot(places[i]!.x - places[j]!.x, places[i]!.y - places[j]!.y) >= 9.9, `${spec.id}: pegs ${i} and ${j} overlap`);
      }
    }
  }
});

test("a seed always builds the same board; the orange pegs are dealt again on every try", () => {
  const a = saipeggleRandomSpec("NOVA-4821");
  assert.deepEqual(saipeggleLayout(a, 1), saipeggleLayout(saipeggleRandomSpec("NOVA-4821"), 1));
  assert.notDeepEqual(saipeggleLayout(a, 1), saipeggleLayout(saipeggleRandomSpec("NOVA-4822"), 1));
  const places = saipeggleLayout(campaign[0]!, 1);
  const first = saipeggleDeal(places, campaign[0]!, settings, 0);
  assert.deepEqual(first, saipeggleDeal(places, campaign[0]!, settings, 0), "reproducible");
  assert.notDeepEqual(first.map((peg) => peg.kind), saipeggleDeal(places, campaign[0]!, settings, 1).map((peg) => peg.kind), "a retry deals anew");
  assert.equal(first.filter((peg) => peg.kind === "orange").length, 25);
  assert.equal(first.filter((peg) => peg.kind === "green").length, 2);
});

test("the multiplier climbs x2 / x3 / x5 / x10 with the orange pegs hit", () => {
  assert.deepEqual([0, 9, 10, 14, 15, 18, 19, 21, 22, 25].map((hit) => saipeggleMultiplier(hit, 25)), [1, 1, 2, 2, 3, 3, 5, 5, 10, 10]);
  assert.deepEqual(saipeggleMultiplierMarks(25).map((mark) => mark.at), [10, 15, 19, 22]);
});

function peg(x: number, y: number, shape: SpgPeg["shape"] = "round"): SpgPeg {
  return { id: 0, x, y, shape, angle: 0, kind: "blue", lit: false, gone: false };
}

test("physics: a ball bounces off a peg, loses energy, and never tunnels at top speed", () => {
  const target = peg(160, 120);
  const ball = saipeggleNewBall(160, 100, 0, 150);
  const events: SpgStepEvent[] = [];
  let hit = false;
  for (let i = 0; i < 120 && !hit; i += 1) {
    events.length = 0;
    saipeggleStep(ball, [target], null, { gravity: 1, bounce: 0.78 }, 1 / 240, events);
    hit = events.some((event) => event.kind === "peg");
  }
  assert.ok(hit, "the peg was touched");
  assert.ok(ball.vy < 0 && Math.abs(ball.vy) < 170, `bounced up, slower: ${ball.vy}`);
  // Straight at a brick at the speed cap: the contact is still seen.
  const brick = peg(160, 140, "brick");
  const fast = saipeggleNewBall(160, 60, 0, 380);
  let touched = false;
  for (let i = 0; i < 240 && !touched; i += 1) {
    events.length = 0;
    saipeggleStep(fast, [brick], null, { gravity: 1, bounce: 0.78 }, 1 / 240, events);
    touched = events.some((event) => event.kind === "peg");
  }
  assert.ok(touched && fast.y < 140, "no tunnelling through a brick");
});

test("physics: a ball resting on a peg slides off instead of sticking (friction only on impacts)", () => {
  const target = peg(160, 120);
  // Just off the top of the peg, at rest.
  const ball = saipeggleNewBall(160.6, 112.9, 0, 0);
  const events: SpgStepEvent[] = [];
  for (let i = 0; i < 240; i += 1) {
    events.length = 0;
    saipeggleStep(ball, [target], null, { gravity: 1, bounce: 0.78 }, 1 / 240, events);
  }
  assert.ok(ball.y > 128, `after one second the ball is below the peg, not glued to it: y=${ball.y.toFixed(1)}`);
});

test("a whole level: shots, pops, free balls and Extreme Fever to the end", () => {
  const game = createSaipeggleGame(campaign[0]!, settings, 0);
  saipeggleShoot(game);
  assert.equal(game.phase, "aim");
  const cues = new Set<string>();
  for (let frame = 0; frame < 60 * 60 * 15 && game.phase !== "won" && game.phase !== "lost"; frame += 1) {
    if (game.phase === "aim") {
      // A perfect-sight player: the aim whose whole path lights the most orange.
      let best = 0;
      let value = -1;
      for (let aim = -1.4; aim <= 1.4; aim += 0.04) {
        const trace = saipeggleTrace(aim, game.pegs, bucketOf(game), physicsOf(game), { seconds: 6, every: 1000 });
        const v = trace.hits.filter((p) => !p.lit && p.kind === "orange").length * 10 + trace.hits.length;
        if (v > value) [value, best] = [v, aim];
      }
      saipeggleSetAim(game, best);
      const balls = game.ballsLeft;
      assert.ok(saipeggleShoot(game));
      assert.equal(game.ballsLeft, balls - 1);
    }
    saipeggleUpdate(game, 1 / 60);
    for (const cue of game.cues) cues.add(cue.id);
    game.cues.length = 0;
    if (game.phase === "aim") assert.ok(game.pegs.every((p) => !p.lit || p.gone), "lit pegs pop before the next shot");
  }
  assert.equal(game.phase, "won");
  assert.equal(game.orangeHit, game.orangeTotal);
  assert.equal(game.ballBonus, game.ballsLeft * SPG_BALL_BONUS);
  for (const id of ["saipeggle.shoot", "saipeggle.peg", "saipeggle.clear", "saipeggle.fever", "saipeggle.win"]) assert.ok(cues.has(id), id);
  assert.ok(game.feverBonus > 0 || !settings.fever, "the fever buckets paid");
});

test("the Zen Ball stays within three degrees of the aim", () => {
  const game = createSaipeggleGame(campaign[7]!, settings, 0);
  saipeggleShoot(game);
  saipeggleSetAim(game, 0.3);
  assert.ok(Math.abs(zenAim(game) - 0.3) <= (3 * Math.PI) / 180 + 1e-9);
});

test("a board code round-trips, and anything else is refused", () => {
  const spec = campaign[12]!;
  const places = saipeggleLayout(spec, 1);
  const parsed = saipeggleParseLevelCode(saipeggleLevelCode(spec, places));
  assert.ok(parsed);
  assert.equal(parsed.name, spec.name);
  assert.equal(parsed.places!.length, places.length);
  parsed.places!.forEach((p, i) => {
    assert.equal(p.x, places[i]!.x);
    assert.equal(p.shape, places[i]!.shape);
  });
  for (const bad of ["", "hello", "SPG1.", "SPG1.!!!", `SPG1.${btoa("{}")}`]) assert.equal(saipeggleParseLevelCode(bad), null, bad);
});

test("settings are clamped; the font draws every letter the game writes; palette colours stay readable", () => {
  const s = normalizeSaipeggleSettings({ balls: 999, orange: -3, power: "rocket", colors: "neon", seed: " nova-1 " });
  assert.equal(s.balls, 30);
  assert.equal(s.orange, 5);
  assert.equal(s.power, "stage");
  assert.equal(s.colors, "palette");
  assert.equal(s.seed, "NOVA-1");
  for (const char of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 +-.,:!?'/%()x·") assert.ok(saipeggleFontCovers(char), char);
  const dark = parseRgb("#342012")!;
  assert.ok(contrast(readable(parseRgb("#006060")!, dark, 2.6), dark) >= 2.6);
  const colors = saipeggleColors(
    { background: dark, surface: parseRgb("#4A341B")!, border: [28, 18, 8], borderLight: [130, 105, 65], text: [226, 202, 149], textDim: [197, 171, 110], accent: [96, 160, 64], warning: [224, 160, 48], success: [96, 160, 64], danger: [224, 96, 64], highlight: [240, 208, 96] },
    "palette",
  );
  assert.notEqual(colors.peg.blue.base, colors.peg.green.base, "an accent equal to the green is moved to blue");
});

test("wired in: the button above Support Developer with its own settings gear, the host, the sounds, no Pebble Drop", () => {
  const page = src("SettingsPage.tsx");
  const game = page.indexOf('label="SAIPEGGLE"');
  assert.ok(game > 0 && game < page.indexOf('label="Support Developer"'), "SAIPEGGLE sits above Support Developer");
  assert.match(page, /openZaicodeSaipeggle\("settings"\)/);
  assert.match(src("zaicode/ZaicodeAppRuntime.tsx"), /<ZaicodeSaipeggleHost \/>/);
  const sounds = src("zaicode/zaicodeSoundSettingsModel.ts");
  const used = new Set([...`${src("zaicode/saipeggle/saipeggleRules.ts")}${src("zaicode/saipeggle/saipeggleGame.ts")}`.matchAll(/"(saipeggle\.[a-zA-Z]+)"/g)].map((m) => m[1]!));
  for (const id of used) assert.match(sounds, new RegExp(`id: "${id.replace(".", "\\.")}", group: "SAIPEGGLE"`), id);
  assert.doesNotMatch(src("zaicode/ZaicodeAppRuntime.tsx"), /Pebble/);
  // The game owns the keyboard: app hotkeys and F-keys stay quiet under it, and it takes focus.
  assert.match(src("zaicode/ZaicodeAppRuntime.tsx"), /if \(document\.querySelector\("\[data-zaicode-saipeggle\]"\)\) return;/);
  assert.match(src("zaicode/saipeggle/ZaicodeSaipeggleView.tsx"), /active\.blur\(\)/);
  assert.match(src("zaicode/saipeggle/ZaicodeSaipeggleCanvas.tsx"), /canvas\.current\?\.focus\(/);
});
