import assert from "node:assert/strict";
import test from "node:test";
import { ZaicodeProtrailClock, parseZaicodeProtrailInputLine } from "@zcode/shared";
import { ProtrailClickEngine, wakeSpacingPx } from "../src/zaicode/protrail/protrailClickEngine.js";
import { HOLD_ACTIVATION_MS, HOLD_CHARGE_MS } from "../src/zaicode/protrail/protrailClickMath.js";
import { protrailDefaults } from "../src/zaicode/protrail/protrailModel.js";
import { normalizeProtrailConfig } from "../src/zaicode/protrail/protrailNormalize.js";
import { buildTrailFrame } from "../src/zaicode/protrail/protrailTrailGeometry.js";
import { alphaFor, applyFadeCurve, widthAt } from "../src/zaicode/protrail/protrailTrailMath.js";

// SRC-062: "copy the ProTrail mechanism fully (vacterro/protrail) into ZAICODE,
// with its settings as a separate section ... it must work fully, not only
// inside the program but globally in Windows." These pin the port to
// ProTrail v0.1.9's numbers (release_defaults.json, trail_effect.cpp,
// click_bubble_effect.cpp) and the desktop-wide input contract.

test("the defaults are ProTrail's release defaults, drawn everywhere", () => {
  const d = protrailDefaults();
  assert.equal(d.enabled, true);
  assert.equal(d.everywhere, true, "the desktop-wide mode is the default");
  assert.deepEqual(d.trail.start, { r: 255, g: 255, b: 0 });
  assert.equal(d.trail.lifetimeMs, 350);
  assert.equal(d.trail.headThicknessPx, 3);
  assert.equal(d.trail.smoothing, 0.75);
  assert.equal(d.trail.sparkleMode, "off");
  assert.deepEqual(d.click.color, { r: 0, g: 200, b: 255 });
  assert.equal(d.click.style, "ring");
  assert.deepEqual([d.click.startRadiusPx, d.click.endRadiusPx, d.click.durationMs], [8, 26, 250]);
  assert.equal(d.click.holdEnabled, true);
});

test("a stored config is repaired like ProTrail's validators do it", () => {
  const repaired = normalizeProtrailConfig({
    everywhere: "yes",
    pixelSize: 9,
    trail: { lifetimeMs: Number.NaN, headThicknessPx: 99, sparkleMode: "confetti", style: "neon", start: { r: 300, g: -4, b: 7.6 } },
    click: { startRadiusPx: 60, endRadiusPx: 10, style: "lava", particleAmount: 1000 },
  });
  assert.equal(repaired.everywhere, true, "a non-boolean keeps the default");
  assert.equal(repaired.pixelSize, 4);
  assert.equal(repaired.trail.lifetimeMs, 350, "NaN repairs to the product default");
  assert.equal(repaired.trail.headThicknessPx, 40, "out of range clamps");
  assert.equal(repaired.trail.sparkleMode, "off", "a corrupted sparkle mode is Off, never on by accident");
  assert.equal(repaired.trail.style, "neon");
  assert.deepEqual(repaired.trail.start, { r: 255, g: 0, b: 8 });
  assert.equal(repaired.click.style, "ring");
  assert.equal(repaired.click.endRadiusPx, 60, "the end radius is never below the start radius");
  assert.equal(repaired.click.particleAmount, 24);
  assert.deepEqual(normalizeProtrailConfig(null), protrailDefaults());
  assert.equal(normalizeProtrailConfig({ everywhere: false }).everywhere, false);
});

test("fade, alpha and width follow trail_effect.cpp", () => {
  assert.equal(applyFadeCurve("linear", 0.25), 0.25);
  assert.equal(applyFadeCurve("smooth", 0.5), 0.5);
  assert.equal(applyFadeCurve("easeOut", 0.5), 0.875);
  const trail = protrailDefaults().trail;
  assert.equal(alphaFor(trail, 1), trail.baseOpacity, "the head is at full opacity");
  assert.equal(alphaFor(trail, 0), 0, "exactly 0 at the lifetime boundary");
  const tapered = { ...trail, headThicknessPx: 10, tailThicknessPx: 2, taperStrength: 1 };
  assert.equal(widthAt(tapered, 1), 10);
  assert.equal(widthAt(tapered, 0), 2);
  assert.equal(widthAt({ ...tapered, taperStrength: 0 }, 0), 10, "taper 0 keeps the head width");
});

test("hold: activation, charge and the charged release power", () => {
  const engine = new ProtrailClickEngine(protrailDefaults().click);
  engine.down(0, 10, 10, 0);
  assert.equal(engine.bubbles.length, 1, "the click itself");
  assert.equal(engine.holds.length, 1);
  engine.up(0, 10, 10, HOLD_ACTIVATION_MS - 1);
  assert.equal(engine.bubbles.length, 1, "a short click has no release payoff");

  engine.down(0, 10, 10, 1000);
  engine.up(0, 10, 10, 1000 + HOLD_ACTIVATION_MS + HOLD_CHARGE_MS);
  const release = engine.bubbles.at(-1)!;
  assert.equal(release.power, 1 + 1.2 * 1 * protrailDefaults().click.holdReleaseStrength);
});

test("trigger buttons and a lost button-up", () => {
  const engine = new ProtrailClickEngine({ ...protrailDefaults().click, triggerRight: false });
  engine.down(2, 0, 0, 0);
  assert.equal(engine.bubbles.length, 0, "right is not a trigger");
  engine.down(1, 0, 0, 0);
  assert.equal(engine.holds.length, 1);
  engine.reconcile(0, 0, 0, 500);
  assert.equal(engine.holds.length, 0, "no button down any more: the hold ends");
});

test("the motion wake spacing is 12 px x (1 / density)^0.75", () => {
  assert.equal(wakeSpacingPx(1), 12);
  assert.ok(Math.abs(wakeSpacingPx(2) - 12 * Math.pow(0.5, 0.75)) < 1e-9);
  assert.equal(wakeSpacingPx(Number.NaN), 12);
});

test("a trail is drawn from live samples and gone after its lifetime", () => {
  const trail = protrailDefaults().trail;
  const samples = [
    { x: 0, y: 0, ts: 1000 },
    { x: 40, y: 10, ts: 1016 },
    { x: 80, y: 30, ts: 1032 },
  ];
  const live = buildTrailFrame(samples, 1040, trail, { x: 80, y: 30 });
  assert.ok(live.segments.length > 0);
  assert.ok(live.segments.every((segment) => segment.alpha >= 0 && segment.alpha <= trail.baseOpacity));
  assert.equal(buildTrailFrame(samples, 1032 + trail.lifetimeMs + 500, trail, null).segments.length, 0);
  assert.equal(buildTrailFrame(samples, 1040, { ...trail, enabled: false }, null).segments.length, 0);
});

test("the Raw Input helper's lines parse strictly", () => {
  assert.deepEqual(parseZaicodeProtrailInputLine("m 1920 -40 1234.500"), { kind: 0, button: -1, x: 1920, y: -40, t: 1234.5 });
  assert.deepEqual(parseZaicodeProtrailInputLine("d 2 10 20 5.000"), { kind: 1, button: 2, x: 10, y: 20, t: 5 });
  assert.deepEqual(parseZaicodeProtrailInputLine("u 1 10 20 6.000"), { kind: 2, button: 1, x: 10, y: 20, t: 6 });
  for (const bad of ["ready", "error register 5", "d 3 1 2 3", "m 1 2", "m a b c", "d 0 1 2 3 4", ""]) {
    assert.equal(parseZaicodeProtrailInputLine(bad), null, bad);
  }
});

test("the overlay clock keeps the source's spacing and never lands in the future", () => {
  const clock = new ZaicodeProtrailClock();
  clock.observe(100, 5000); // delivered 4900 ms "late" in page time
  assert.equal(clock.map(90, 5000), 4990);
  assert.equal(clock.map(100, 5000), 5000);
  clock.observe(120, 5018); // a faster delivery tightens the offset
  assert.equal(clock.map(120, 5018), 5018);
  assert.ok(clock.map(119, 5018) < clock.map(120, 5018));
  assert.ok(clock.map(10_000, 5020) <= 5020, "never in the future");
  // The helper restarted: its clock begins again near 0.
  clock.observe(3, 9000);
  assert.equal(clock.map(3, 9000), 9000);
});
