import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  decideZaicodeSound,
  normalizeZaicodeSoundLimit,
  normalizeZaicodeSoundOverlap,
  type ZaicodeSoundRules,
  type ZaicodeSoundVoice,
} from "../src/zaicode/zaicodeSoundPolicy.js";

// Operator request: in Settings -> Sounds the operator decides how sounds meet:
// mix (at most N at once, N up to 16), queue (one after another) or cut (a new
// one replaces the rest, no cacophony).

const voice = (key: string, isInterface = false): ZaicodeSoundVoice => ({ key, interface: isInterface });
const ask = (key: string, extra: { interface?: boolean; replaceOwn?: boolean } = {}) => ({
  key,
  interface: extra.interface ?? false,
  replaceOwn: extra.replaceOwn ?? false,
});
const rules = (overlap: ZaicodeSoundRules["overlap"], limit = 16, interfaceOneAtATime = false): ZaicodeSoundRules => ({
  overlap,
  limit,
  interfaceOneAtATime,
});

test("mix: sounds layer up to the limit, then the oldest ones fade", () => {
  assert.deepEqual(decideZaicodeSound(rules("mix", 4), [voice("a"), voice("b")], [], ask("c")), { play: true, stop: [] });
  // Four ring, the limit is four: the new one takes the oldest one's place.
  const four = [voice("a"), voice("b"), voice("c"), voice("d")];
  assert.deepEqual(decideZaicodeSound(rules("mix", 4), four, [], ask("e")), { play: true, stop: [0] });
  // The limit was lowered while more rang: enough of the oldest go at once.
  assert.deepEqual(decideZaicodeSound(rules("mix", 2), four, [], ask("e")), { play: true, stop: [0, 1, 2] });
  // A row set to "replace" stops only its own previous sound.
  assert.deepEqual(decideZaicodeSound(rules("mix"), [voice("a"), voice("b")], [], ask("a", { replaceOwn: true })), { play: true, stop: [0] });
  // "Interface sounds one at a time" still cuts only interface sounds, and only in mix.
  const mixed = [voice("agent.done"), voice("ui.button", true), voice("ui.tab", true)];
  assert.deepEqual(decideZaicodeSound(rules("mix", 16, true), mixed, [], ask("ui.expand", { interface: true })), { play: true, stop: [1, 2] });
  assert.deepEqual(decideZaicodeSound(rules("mix", 16, true), mixed, [], ask("agent.failed")), { play: true, stop: [] });
  assert.deepEqual(decideZaicodeSound(rules("mix", 16, false), mixed, [], ask("ui.expand", { interface: true })), { play: true, stop: [] });
});

test("queue: one after another, a bounded line, the same sound waits once", () => {
  assert.deepEqual(decideZaicodeSound(rules("queue", 3), [], [], ask("a")), { play: true, stop: [] });
  assert.deepEqual(decideZaicodeSound(rules("queue", 3), [voice("a")], [], ask("b")), { play: false, wait: true });
  // Something already waits: a new sound lines up behind it even if nothing rings for a moment.
  assert.deepEqual(decideZaicodeSound(rules("queue", 3), [], ["b"], ask("c")), { play: false, wait: true });
  assert.deepEqual(decideZaicodeSound(rules("queue", 3), [voice("a")], ["b"], ask("b")), { play: false, wait: false }, "b waits already");
  assert.deepEqual(decideZaicodeSound(rules("queue", 3), [voice("a")], ["b", "c", "d"], ask("e")), { play: false, wait: false }, "the line is full");
  // Its own "replace": the same sound ringing alone restarts at once, still one at a time.
  assert.deepEqual(decideZaicodeSound(rules("queue", 3), [voice("a")], [], ask("a", { replaceOwn: true })), { play: true, stop: [0] });
  assert.deepEqual(decideZaicodeSound(rules("queue", 3), [voice("a")], [], ask("a")), { play: false, wait: true });
  // The interface rule belongs to mix: in a queue clicks wait like the rest.
  assert.deepEqual(decideZaicodeSound(rules("queue", 3, true), [voice("ui.tab", true)], [], ask("ui.button", { interface: true })), { play: false, wait: true });
});

test("cut: a new sound fades everything still ringing", () => {
  assert.deepEqual(decideZaicodeSound(rules("cut"), [], [], ask("a")), { play: true, stop: [] });
  assert.deepEqual(decideZaicodeSound(rules("cut"), [voice("a"), voice("b", true)], [], ask("c")), { play: true, stop: [0, 1] });
});

test("settings: mix up to 16 by default, anything else falls back safely", () => {
  assert.equal(normalizeZaicodeSoundOverlap(undefined), "mix");
  assert.equal(normalizeZaicodeSoundOverlap("queue"), "queue");
  assert.equal(normalizeZaicodeSoundOverlap("cut"), "cut");
  assert.equal(normalizeZaicodeSoundOverlap("loud"), "mix");
  assert.equal(normalizeZaicodeSoundLimit(undefined), 16);
  assert.equal(normalizeZaicodeSoundLimit(40), 16, "16 at most");
  assert.equal(normalizeZaicodeSoundLimit(0), 2);
  assert.equal(normalizeZaicodeSoundLimit(7.6), 8);
  assert.equal(normalizeZaicodeSoundLimit(Number.NaN), 16);
});

test("every one-shot goes through the rule; previews, the game and the background stay outside", () => {
  const engine = readFileSync(join(import.meta.dirname, "../src/zaicode/zaicodeSoundEvents.ts"), "utf8");
  assert.match(engine, /overlap: normalizeZaicodeSoundOverlap\(record\.overlap\),\s+overlapLimit: normalizeZaicodeSoundLimit\(record\.overlapLimit\),/);
  assert.match(engine, /overlap: "mix",\s+overlapLimit: ZAICODE_SOUND_LIMIT_MAX,/, "mix, 16 by default: nothing changes until the operator picks");
  // Event rows: the rule decides; a preview never waits or cuts.
  assert.match(engine, /return admitSound\(ctx, request, !options\.preview, \(\) => \{/);
  // Timers and reminders too; previews and SAIPEGGLE (ownMix) do not.
  assert.match(engine, /const pooled = !options\.preview && !options\.ownMix;/);
  assert.match(readFileSync(join(import.meta.dirname, "../src/zaicode/saipeggle/saipeggleSound.ts"), "utf8"), /ownMix: true/);
  // The line never stalls on a lost "ended", and STOP ALL empties it first.
  assert.match(engine, /setTimeout\(\(\) => finishVoice\(voice\), \(buffer\.duration \/ rate\) \* 1000 \+ 300\);/);
  assert.match(engine, /export function stopAllZaicodeSounds\(\): void \{\s+waiting\.length = 0;/);
  // The switch lives in Settings -> Sounds.
  const page = readFileSync(join(import.meta.dirname, "../src/settings/ZaicodeSoundSettings.tsx"), "utf8");
  assert.match(page, /<ZaicodeSoundOverlapSettings \/>/);
});
