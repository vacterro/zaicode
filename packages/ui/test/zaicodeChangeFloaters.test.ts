import assert from "node:assert/strict";
import test from "node:test";
import {
  ZAICODE_FLOATER_DEFAULTS,
  normalizeZaicodeFloaterPrefs,
  zaicodeChangeDelta,
  zaicodeFloatersFor,
} from "../src/zaicode/zaicodeChangeFloaters.js";

// SRC-060: "Changes как в RPG плюсики минусики типо как урон выдаёт или хилится"
// -- added lines float up as a green +N (heal), removed ones as a red -N
// (damage), toggleable and richly configurable under Highlights.

test("only a rise of the counter makes numbers; the first reading and a drop stay silent", () => {
  assert.deepEqual(zaicodeChangeDelta(null, { added: 133, removed: 7 }), { heal: 0, damage: 0 });
  assert.deepEqual(zaicodeChangeDelta({ added: 133, removed: 7 }, { added: 150, removed: 9 }), { heal: 17, damage: 2 });
  // A commit or another session resets the counter: no negative heal, no numbers.
  assert.deepEqual(zaicodeChangeDelta({ added: 150, removed: 9 }, { added: 0, removed: 0 }), { heal: 0, damage: 0 });
});

test("heal is +N, damage is -N, a big burst is a critical hit", () => {
  const prefs = { ...ZAICODE_FLOATER_DEFAULTS, critAt: 100 };
  assert.deepEqual(zaicodeFloatersFor({ heal: 12, damage: 7 }, prefs), [
    { kind: "heal", amount: 12, crit: false, text: "+12" },
    { kind: "damage", amount: 7, crit: false, text: "-7" },
  ]);
  assert.deepEqual(zaicodeFloatersFor({ heal: 250, damage: 0 }, prefs), [
    { kind: "heal", amount: 250, crit: true, text: "+250!" },
  ]);
  assert.deepEqual(zaicodeFloatersFor({ heal: 250, damage: 0 }, { ...prefs, critAt: 0 })[0]!.crit, false);
  assert.equal(zaicodeFloatersFor({ heal: 5, damage: 1 }, { ...prefs, suffix: "hp" })[1]!.text, "-1 HP");
});

test("every part can be switched off", () => {
  const delta = { heal: 5, damage: 3 };
  assert.deepEqual(zaicodeFloatersFor(delta, { ...ZAICODE_FLOATER_DEFAULTS, enabled: false }), []);
  assert.deepEqual(
    zaicodeFloatersFor(delta, { ...ZAICODE_FLOATER_DEFAULTS, showHeal: false }).map((floater) => floater.kind),
    ["damage"],
  );
  assert.deepEqual(
    zaicodeFloatersFor(delta, { ...ZAICODE_FLOATER_DEFAULTS, showDamage: false }).map((floater) => floater.kind),
    ["heal"],
  );
});

test("stored settings normalize: ranges clamp, bad colours and styles fall back", () => {
  assert.deepEqual(normalizeZaicodeFloaterPrefs(null), ZAICODE_FLOATER_DEFAULTS);
  const prefs = normalizeZaicodeFloaterPrefs({
    style: "explode",
    distancePx: 999,
    durationMs: 10,
    maxFloaters: 0,
    healColor: "green",
    damageColor: "#FF0000",
    suffix: "xp",
  });
  assert.equal(prefs.style, "rise");
  assert.equal(prefs.distancePx, 80);
  assert.equal(prefs.durationMs, 400);
  assert.equal(prefs.maxFloaters, 1);
  assert.equal(prefs.healColor, "");
  assert.equal(prefs.damageColor, "#ff0000");
  assert.equal(prefs.suffix, "none");
});
