import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { presetSoundIds } from "../src/zaicode/zaicodePresetFile.js";
import { heaviestPoolSound, normalizeZaicodePool, seedPool, togglePoolMember, type ZaicodePoolEntry } from "../src/zaicode/zaicodeSoundPools.js";
import { addZaicodePoolMember, removeZaicodePoolMember, setZaicodeSoundSelectionMode, toggleZaicodePoolMember, toggleZaicodePoolPin } from "../src/zaicode/zaicodeSoundPoolActions.js";
import { ZAICODE_SOUND_EVENTS, readZaicodeSoundSettings, setZaicodeSoundEvent, zaicodeSetPoolWeight, type ZaicodeSoundEventSetting } from "../src/zaicode/zaicodeSoundSettingsModel.js";
import { ZaicodePoolMembers, ZaicodePoolSummary } from "../src/settings/ZaicodePoolMembers.js";

/**
 * SRC-090 (T-127): "adding sounds to a random-sound pool is not intuitive -- to add another sound I first have to add a
 * duplicate, or first confirm another sound to add". The old control had one button that added whatever the row's single
 * dropdown pointed at, so a second, different sound meant changing the dropdown first. These tests are the operator's
 * sentence as facts: a pool is built by choosing sounds, one after another, and nothing is lost switching modes.
 */

const A = "fastprompter:A.wav";
const B = "fastprompter:B.wav";
const C = "fastprompter:C.wav";
const pool = (ids: string[], weights: number[] = ids.map(() => 1), extra: Partial<ZaicodePoolEntry> = {}): ZaicodePoolEntry[] =>
  ids.map((id, index) => ({ id, weight: weights[index] ?? 1, locked: false, missing: false, ...extra }));

test("P1 a pool built by choosing three different sounds in a row has three members with equal shares; choosing one again takes it out", () => {
  let entries: ZaicodePoolEntry[] = [];
  for (const sound of [A, B, C]) entries = togglePoolMember(entries, sound);
  assert.deepEqual(entries.map((entry) => entry.id), [A, B, C]);
  assert.deepEqual(normalizeZaicodePool(entries).shares.map((share) => share.percent).sort(), [33.33, 33.33, 33.34]);
  assert.deepEqual(togglePoolMember(entries, B).map((entry) => entry.id), [A, C], "the second pick of a member removes it");
  assert.deepEqual(entries.map((entry) => entry.id), [A, B, C], "the pool that was passed in is not edited");
});

test("P2 a sound added to a tuned pool gets a fair share, not the sliver a weight of 1 would give beside 50 and 30", () => {
  const added = togglePoolMember(pool([A, B], [50, 30]), C);
  const shares = normalizeZaicodePool(added).shares;
  assert.ok(shares.find((share) => share.id === C)!.percent > 25, `${shares.map((share) => share.percent).join(" / ")}`);
  assert.equal(added.find((entry) => entry.id === C)!.weight, 40, "the mean of the members that count");
});

test("P3 a pinned share stays where it was when a sound joins", () => {
  const entries = pool([A, B], [1, 1]);
  entries[0]!.locked = true;
  const shares = normalizeZaicodePool(togglePoolMember(entries, C)).shares;
  assert.equal(shares.find((share) => share.id === A)!.percent, 50);
  assert.equal(shares.reduce((sum, share) => sum + share.percent, 0), 100);
});

test("P4 into a pool the current sound is the first member; out of it the heaviest member is the sound", () => {
  assert.deepEqual(seedPool([], A), [{ id: A, weight: 1, locked: false, missing: false }]);
  assert.deepEqual(seedPool(pool([B]), A).map((entry) => entry.id), [B], "an existing pool is never reseeded");
  assert.deepEqual(seedPool([], ""), [], "there is nothing to seed from");
  assert.equal(heaviestPoolSound(pool([A, B, C], [1, 5, 5]), "x"), B, "the first of equals");
  assert.equal(heaviestPoolSound([...pool([A], [9], { missing: true }), ...pool([B], [2])], "x"), B, "a missing file cannot be the sound");
  assert.equal(heaviestPoolSound([...pool([A], [0]), ...pool([B], [0])], "x"), "x", "nothing that can play: the event keeps the sound it had");
  assert.equal(heaviestPoolSound([], "x"), "x");
});

// ---------------------------------------------------------------- the stored table

const eventId = ZAICODE_SOUND_EVENTS[0]!.id;
const row = (): ZaicodeSoundEventSetting => readZaicodeSoundSettings().events[eventId]!;

test("P5 single -> pool -> three picks -> single keeps a sound, and the pool waits for the next switch", () => {
  setZaicodeSoundEvent(eventId, { sound: A, soundMode: "single", pool: [] });
  setZaicodeSoundSelectionMode(eventId, "pool");
  assert.equal(row().soundMode, "pool");
  assert.deepEqual(row().pool.map((entry) => entry.id), [A], "the sound the event had is the first member: the list is never empty");
  toggleZaicodePoolMember(eventId, B);
  toggleZaicodePoolMember(eventId, C);
  assert.deepEqual(row().pool.map((entry) => entry.id), [A, B, C]);
  zaicodeSetPoolWeight(eventId, C, 9);
  setZaicodeSoundSelectionMode(eventId, "single");
  assert.equal(row().soundMode, "single");
  assert.equal(row().sound, C, "the heaviest member");
  assert.equal(row().pool.length, 3, "the pool is kept");
  setZaicodeSoundSelectionMode(eventId, "pool");
  assert.deepEqual(row().pool.map((entry) => entry.id), [A, B, C], "the same members come back, none added twice");
});

test("P6 two quick picks both land: each one reads the table at the click, not a copy the screen drew before", () => {
  setZaicodeSoundEvent(eventId, { sound: A, soundMode: "pool", pool: [] });
  toggleZaicodePoolMember(eventId, A);
  toggleZaicodePoolMember(eventId, B);
  toggleZaicodePoolMember(eventId, C);
  assert.deepEqual(row().pool.map((entry) => entry.id), [A, B, C]);
});

test("P7 adding a member that is already there changes nothing about it (weight and pin stay)", () => {
  setZaicodeSoundEvent(eventId, { sound: A, soundMode: "pool", pool: pool([A, B], [3, 1]) });
  toggleZaicodePoolPin(eventId, A);
  addZaicodePoolMember(eventId, A);
  const a = row().pool.find((entry) => entry.id === A)!;
  assert.deepEqual([a.weight, a.locked], [3, true]);
  addZaicodePoolMember(eventId, C);
  assert.deepEqual(row().pool.map((entry) => entry.id), [A, B, C]);
  removeZaicodePoolMember(eventId, B);
  assert.deepEqual(row().pool.map((entry) => entry.id), [A, C]);
});

test("P8 an empty pool plays the event's own sound, and going single from an empty pool changes no sound", () => {
  setZaicodeSoundEvent(eventId, { sound: B, soundMode: "pool", pool: [] });
  setZaicodeSoundSelectionMode(eventId, "single");
  assert.equal(row().sound, B);
});

// ---------------------------------------------------------------- what the person sees

const eventDef = ZAICODE_SOUND_EVENTS[0]!;
const poolRow = (entries: ZaicodePoolEntry[], soundMode: "pool" | "single" = "pool"): ZaicodeSoundEventSetting => ({
  enabled: true,
  sound: A,
  gainDb: 0,
  normalizeDb: 0,
  mode: "overlay",
  soundMode,
  pool: entries,
});
// The adding control (a picker, which plays audio) is the parent's; here it is a marker so the line around it can be read.
const html = (entries: ZaicodePoolEntry[]): string =>
  renderToStaticMarkup(createElement(ZaicodePoolMembers, { event: eventDef, row: poolRow(entries), add: createElement("i", null, "ADD-CONTROL"), onListen: () => undefined }));

test("P9 the members are listed at once under one control that adds sounds; the old duplicate-first button and the show/hide step are gone", () => {
  const three = html(pool([A, B, C]));
  assert.match(three, /ADD-CONTROL/);
  assert.match(three, /data-zaicode-pool-members/, "no extra click to see the members");
  for (const id of [A, B, C]) assert.ok(three.includes(`data-zaicode-pool-member="${id}"`), id);
  assert.match(three, /3 sounds\. One plays each time, by weight\./);
  assert.match(three, /33\.33%/);
  assert.doesNotMatch(three, /add &quot;fastprompter|add "fastprompter/, "no button that adds whatever the single dropdown points at");
  assert.doesNotMatch(three, /member\(s\)/, "no show / hide N member(s) step");
});

test("P10 'pin' means something only with two or more members (or while one is pinned, so it can be let go)", () => {
  assert.doesNotMatch(html(pool([A])), /pin/);
  assert.match(html(pool([A])), /1 sound\. Add another/);
  assert.equal((html(pool([A, B])).match(/>pin</g) ?? []).length, 2);
  assert.match(html([{ id: A, weight: 1, locked: true, missing: false }]), />pinned</);
});

test("P11 an empty pool says what plays meanwhile; the row's own cell says how many", () => {
  assert.match(html([]), /Empty: this event plays its own sound until you add some\./);
  assert.doesNotMatch(html([]), /data-zaicode-pool-members/);
  const summary = (entries: ZaicodePoolEntry[]) => renderToStaticMarkup(createElement(ZaicodePoolSummary, { row: poolRow(entries) }));
  assert.match(summary([]), /Pool: empty/);
  assert.match(summary(pool([A])), /Pool: 1 sound</);
  assert.match(summary(pool([A, B, C])), /Pool: 3 sounds</);
});

test("P12 a preset carries a pool: its members that are the person's own files travel with it", () => {
  const settings = {
    "zaicode-sound-events-v1": { events: { [eventId]: { soundMode: "pool", pool: pool([A, "customization:Horse/a.wav", "custom:sidebar.project"]) } } },
  } as never;
  assert.deepEqual(presetSoundIds(settings), ["customization:Horse/a.wav", "custom:sidebar.project"]);
});

// ---------------------------------------------------------------- wiring

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const source = (relative: string): string => readFileSync(join(srcRoot, relative), "utf8");

test("P13 the row shows the pool summary instead of a sound picker in pool mode; the picker has its several-choice mode; an imported file joins the pool", () => {
  const table = source("settings/ZaicodeSoundSettings.tsx");
  assert.match(table, /row\.soundMode === "pool" \? \(\s*<ZaicodePoolSummary row=\{row\} \/>/);
  const picker = source("zaicode/ZaicodeSoundPicker.tsx");
  assert.match(picker, /if \(multi\) return multi\.onToggle\(sound\);/, "a pick in several-choice mode toggles and the list stays open");
  assert.match(picker, /multi \? \(picked\(id\) \? "remove" : "add"\) : "use"/);
  assert.match(source("zaicode/zaicodeSoundEvents.ts"), /soundMode === "pool"\) addZaicodePoolMember\(id, `custom:\$\{id\}`\)/);
  const controls = source("settings/ZaicodeSoundPoolControls.tsx");
  assert.match(controls, /toggleZaicodePoolMember\(event\.id, sound\)/, "a pick in the add control flips membership");
  assert.match(controls, /label: "Add sounds to the pool…"/, "the control says what it does, not which sound it holds");
  assert.match(controls, /if \(row\.soundMode !== "pool"\) return null;/, "a single-sound event draws no pool line");
});
