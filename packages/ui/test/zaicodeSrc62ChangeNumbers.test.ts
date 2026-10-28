import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  ZAICODE_FLOATER_DEFAULTS,
  admitZaicodeChatBurst,
  normalizeZaicodeFloaterPrefs,
  pickZaicodeFloaterLane,
  zaicodeFloaterSchedule,
  zaicodeFloatersFor,
} from "../src/zaicode/zaicodeChangeFloaters.js";

// SRC-062, three operator requests about the RPG change numbers:
// 1. "a toggle so the RPG counter ignores the reduced-motion setting, it does
//    not work with that on" -- the calm interface put animation:none
//    !important on everything, the system setting flattened them to a fade;
// 2. "in the preview the digits overlap" -- they started on the counter's own
//    digits, and two numbers at once printed over each other;
// 3. "in the chat too: the agent changes files, it lights up and plays; with
//    both, first minus then plus so they don't pile up; full control of the
//    timing and the conditions".

const layer = readFileSync(join(import.meta.dirname, "..", "src", "zaicode", "zaicodeFloaterLayer.ts"), "utf8");

test("keep moving: a number survives the calm interface and the system's reduced motion", () => {
  assert.equal(ZAICODE_FLOATER_DEFAULTS.ignoreReducedMotion, true, "on by default, the operator asked for it");
  // Beats `html.zaicode-no-motion *{animation:none!important}` by specificity, also !important.
  assert.match(layer, /html\.zaicode-no-motion \.zaicode-floater\[data-zf-keep="1"\]\{animation:var\(--zf-name,zf-rise\)[^}]*!important/);
  // The system setting flattens only the numbers that were not asked to keep moving.
  assert.match(layer, /prefers-reduced-motion: reduce\)\{\.zaicode-floater:not\(\[data-zf-keep="1"\]\)/);
  assert.ok(layer.includes('element.dataset.zfKeep = "1"'), "the flag reaches the node");
  assert.equal(normalizeZaicodeFloaterPrefs({ ignoreReducedMotion: false }).ignoreReducedMotion, false);
});

test("a number starts above its anchor, not on the counter's own digits", () => {
  assert.match(layer, /transform:translate\(-50%,-100%\)/);
  assert.match(layer, /@keyframes zf-rise\{0%\{opacity:0;transform:translate\(-50%,-100%\)/);
});

test("numbers launched close together take the next free lane up", () => {
  assert.equal(pickZaicodeFloaterLane([]), 0);
  assert.equal(pickZaicodeFloaterLane([0]), 1);
  assert.equal(pickZaicodeFloaterLane([0, 1, 3]), 2);
  // All lanes busy: it wraps instead of growing off the screen.
  assert.ok(pickZaicodeFloaterLane([0, 1, 2, 3, 4]) < 5);
});

test("with both, the red -N goes first and the green +N after the gap (the default)", () => {
  const both = zaicodeFloatersFor({ heal: 12, damage: 7 }, ZAICODE_FLOATER_DEFAULTS);
  assert.deepEqual(
    zaicodeFloaterSchedule(both, ZAICODE_FLOATER_DEFAULTS).map((step) => [step.floater.text, step.delayMs]),
    [
      ["-7", 0],
      ["+12", ZAICODE_FLOATER_DEFAULTS.sequenceGapMs],
    ],
  );
  assert.deepEqual(
    zaicodeFloaterSchedule(both, { order: "heal-first", sequenceGapMs: 300 }).map((step) => [step.floater.text, step.delayMs]),
    [
      ["+12", 0],
      ["-7", 300],
    ],
  );
  assert.deepEqual(
    zaicodeFloaterSchedule(both, { order: "together", sequenceGapMs: 300 }).map((step) => step.delayMs),
    [0, 0],
  );
  // One number alone never waits.
  assert.deepEqual(zaicodeFloaterSchedule([both[0]!], ZAICODE_FLOATER_DEFAULTS)[0]!.delayMs, 0);
});

test("chat numbers play only for a change that is happening now, under every condition set", () => {
  const prefs = ZAICODE_FLOATER_DEFAULTS;
  const now = 1_000_000;
  const env = { now, visible: true, focused: true };
  const burst = { heal: 3, damage: 1, editedAt: now - 1000 };
  assert.equal(admitZaicodeChatBurst(burst, prefs, env), true);
  assert.equal(admitZaicodeChatBurst(burst, { ...prefs, chatEnabled: false }, env), false, "switched off");
  assert.equal(admitZaicodeChatBurst(burst, { ...prefs, enabled: false }, env), false, "all numbers off");
  assert.equal(admitZaicodeChatBurst(burst, prefs, { ...env, visible: false }), false, "scrolled away");
  assert.equal(admitZaicodeChatBurst(burst, { ...prefs, chatOnlyVisible: false }, { ...env, visible: false }), true);
  assert.equal(admitZaicodeChatBurst(burst, { ...prefs, chatOnlyFocused: true }, { ...env, focused: false }), false);
  assert.equal(admitZaicodeChatBurst(burst, { ...prefs, chatMinLines: 5 }, env), false, "smaller than the minimum");
  assert.equal(
    admitZaicodeChatBurst({ ...burst, editedAt: now - (prefs.chatFreshSec + 1) * 1000 }, prefs, env),
    false,
    "waited longer than the freshness window",
  );
  assert.equal(admitZaicodeChatBurst({ heal: 0, damage: 0, editedAt: now }, { ...prefs, chatMinLines: 0 }, env), false);
});

test("chat settings normalize and clamp", () => {
  const prefs = normalizeZaicodeFloaterPrefs({
    order: "sideways",
    sequenceGapMs: 99_999,
    chatStyle: "explode",
    chatFreshSec: 1,
    chatQueueMax: 0,
    chatScalePct: 1000,
  });
  assert.equal(prefs.order, "damage-first");
  assert.equal(prefs.sequenceGapMs, 2000);
  assert.equal(prefs.chatStyle, "same");
  assert.equal(prefs.chatFreshSec, 5);
  assert.equal(prefs.chatQueueMax, 1);
  assert.equal(prefs.chatScalePct, 300);
  assert.equal(normalizeZaicodeFloaterPrefs({ chatStyle: "arcade" }).chatStyle, "arcade");
});

test("the Edit row wires its numbers to the edit's own id and liveness", () => {
  const edit = readFileSync(join(import.meta.dirname, "..", "src", "ToolCallBlocks", "renderers", "edit.tsx"), "utf8");
  assert.match(edit, /useZaicodeChatChangeFloater\(toolCall\.toolId, totalChangeStat, \{\s*running: isRunning,\s*startedAt: toolCall\.startedAt,/);
  const hook = readFileSync(join(import.meta.dirname, "..", "src", "zaicode", "useZaicodeChatChangeFloater.ts"), "utf8");
  // A row first seen stale only sets its baseline; a row the list remounts never plays twice.
  assert.ok(hook.includes("played.get(toolId) ?? (fresh ? { added: 0, removed: 0 } : null)"));
});
