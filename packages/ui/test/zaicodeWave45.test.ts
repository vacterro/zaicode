import assert from "node:assert/strict";
import test from "node:test";
import { effectiveZaicodeWindows, type ZaicodeLimitWindow } from "@zcode/shared";
import { zaicodeOverflowFit } from "../src/zaicode/zaicodeOverflow.js";
import { sortZaicodeLogLines } from "../src/zaicode/zaicodeSaipenDetail.js";
import type { ZaicodeSaipenLogLine } from "../src/zaicode/zaicodeSaipenModel.js";
import { addToZaicodeAvatarUploads, normalizeZaicodeAvatarUploads, ZAICODE_AVATAR_UPLOADS_MAX } from "../src/zaicode/zaicodeAvatarUploads.js";
import { normalizeZaicodeNotifySettings, zaicodeNotifyChannels } from "../src/zaicode/zaicodeNotifications.js";
import { detectZaicodeWindowRefills, type ZaicodeRefillMemory } from "../src/zaicode/zaicodeLimitRefills.js";
import { zaicodeGlowStrength, zaicodeGlowsInUse } from "../src/zaicode/zaicodeGlow.js";
import {
  adjustZaicodeColor,
  generateZaicodePalette,
  hexToZaicodeHsl,
  normalizeZaicodeHex,
  zaicodeContrastRatio,
  zaicodeHslToHex,
  ZAICODE_NO_ADJUST,
} from "../src/zaicode/zaicodeColorMath.js";
import { normalizeZaicodeColorStudio, zaicodeEffectiveColorVariables } from "../src/zaicode/zaicodeColorStudio.js";
import { ZAICODE_PALETTES } from "../src/zaicode/zaicodePalettes.js";

test("icon rows: everything fits, or the leading icons that fit plus room for the ⋯ button", () => {
  assert.equal(zaicodeOverflowFit([28, 28, 28], 100, 2, 28), 3);
  // 5 x 28 + 4 gaps = 148 > 120: keep room for ⋯ (28 + 2) -> 90 left -> 3 icons (88).
  assert.equal(zaicodeOverflowFit([28, 28, 28, 28, 28], 120, 2, 28), 3);
  assert.equal(zaicodeOverflowFit([28, 28], 10, 2, 28), 0);
  assert.equal(zaicodeOverflowFit([], 50, 2, 28), 0);
});

const line = (key: string, date: string | null, time: string | null): ZaicodeSaipenLogLine => ({
  key,
  date,
  time,
  event: key,
  ticket: null,
  agent: null,
  tag: "RUN",
  text: key,
});

test("LOG order flips both ways by time stamp; same minute keeps the Event Graph order", () => {
  const lines = [line("E-1", "24.09.26", "23:59"), line("E-2", "25.09.26", "00:01"), line("E-3", "25.09.26", "00:01"), line("E-4", null, null)];
  assert.deepEqual(sortZaicodeLogLines(lines, "oldest-first").map((entry) => entry.key), ["E-1", "E-2", "E-3", "E-4"]);
  assert.deepEqual(sortZaicodeLogLines(lines, "newest-first").map((entry) => entry.key), ["E-4", "E-3", "E-2", "E-1"]);
  // A stamp from an earlier day sorts before, whatever the file order.
  const shuffled = [line("E-9", "25.09.26", "05:00"), line("E-8", "24.09.26", "05:00")];
  assert.deepEqual(sortZaicodeLogLines(shuffled, "oldest-first").map((entry) => entry.key), ["E-8", "E-9"]);
});

test("uploaded photos: newest first, stored once, capped, junk dropped", () => {
  const a = "data:image/png;base64,AAA";
  const b = "data:image/png;base64,BBB";
  let list = addToZaicodeAvatarUploads([], a, 1);
  list = addToZaicodeAvatarUploads(list, b, 2);
  list = addToZaicodeAvatarUploads(list, a, 3);
  assert.deepEqual(list.map((upload) => upload.dataUri), [a, b]);
  assert.equal(list[0]!.addedAt, 1, "re-picking a stored photo keeps its entry");
  for (let index = 0; index < 40; index += 1) list = addToZaicodeAvatarUploads(list, `data:image/png;base64,${index}`, 10 + index);
  assert.equal(list.length, ZAICODE_AVATAR_UPLOADS_MAX);
  assert.deepEqual(normalizeZaicodeAvatarUploads([{ id: "x", dataUri: "javascript:1" }, { id: "y", dataUri: a }, { id: "z", dataUri: a }]).length, 1);
});

test("notification delivery: per moment, in-app only, Windows only, both", () => {
  const row = { toast: true, system: false };
  const off = { toast: false, system: false };
  assert.deepEqual(zaicodeNotifyChannels({ delivery: "custom" }, row), { toast: true, system: false });
  assert.deepEqual(zaicodeNotifyChannels({ delivery: "windows" }, row), { toast: false, system: true });
  assert.deepEqual(zaicodeNotifyChannels({ delivery: "both" }, row), { toast: true, system: true });
  assert.deepEqual(zaicodeNotifyChannels({ delivery: "in-app" }, { toast: false, system: true }), { toast: true, system: false });
  assert.deepEqual(zaicodeNotifyChannels({ delivery: "both" }, off), { toast: false, system: false }, "a moment that is off stays off");
  const settings = normalizeZaicodeNotifySettings({ delivery: "nonsense", glow: { hover: true, fade: "yes" } });
  assert.equal(settings.delivery, "custom");
  assert.equal(settings.glow.hover, true);
  assert.equal(settings.glow.fade, true, "invalid values keep the default");
});

function windowOf(key: string, remaining: number, resetsAt: number | null): ZaicodeLimitWindow {
  return { key, label: key, group: "", groupLabel: "", remainingPercent: remaining, resetsAt, durationMinutes: 300, gatedBy: null, assumedFull: false };
}

test("a run of resets: every window whose reset time passed is announced at once, and only once", () => {
  const memory = new Map<string, ZaicodeRefillMemory>();
  const t0 = 1_000_000;
  const before = [windowOf("5h", 4, t0 + 60_000), windowOf("gemini", 10, t0 + 90_000)];
  const view = (windows: ZaicodeLimitWindow[], now: number) =>
    effectiveZaicodeWindows(windows, now).map((window) => ({ key: window.key, label: window.label, remainingPercent: window.remainingPercent }));
  assert.equal(detectZaicodeWindowRefills("acc", view(before, t0), memory).length, 0, "first reading only records");
  // Both reset times pass before any new reading: both are announced immediately (no re-read needed).
  const refills = detectZaicodeWindowRefills("acc", view(before, t0 + 120_000), memory);
  assert.deepEqual(refills.map((refill) => refill.key).sort(), ["5h", "gemini"]);
  // The old input (measured windows only) saw nothing at that moment: the bug behind "not all, not at once".
  const oldMemory = new Map<string, ZaicodeRefillMemory>();
  const measured = (windows: ZaicodeLimitWindow[]) => windows.map((window) => ({ key: window.key, label: window.label, remainingPercent: window.remainingPercent }));
  detectZaicodeWindowRefills("acc", measured(before), oldMemory);
  assert.equal(detectZaicodeWindowRefills("acc", measured(before), oldMemory).length, 0);
  // The real reading after the reset (100 %, new reset time) does not announce it a second time.
  const read = [windowOf("5h", 100, t0 + 18_000_000), windowOf("gemini", 99, t0 + 18_000_000)];
  assert.equal(detectZaicodeWindowRefills("acc", view(read, t0 + 180_000), memory).length, 0);
});

test("glow: fades with age when asked, ends when its quota starts going down", () => {
  const mark = { since: 0, until: 100, label: "5h reset", peak: 100 };
  assert.equal(zaicodeGlowStrength(mark, 0, true), 1);
  assert.ok(zaicodeGlowStrength(mark, 50, true) < 1);
  assert.ok(zaicodeGlowStrength(mark, 100, true) >= 0.3);
  assert.equal(zaicodeGlowStrength(mark, 90, false), 1);
  const marks: [string, typeof mark][] = [
    ["window:a|5h", mark],
    ["window:a|weekly", { ...mark, peak: 90 }],
  ];
  const now = new Map([
    ["window:a|5h", 97],
    ["window:a|weekly", 90],
  ]);
  assert.deepEqual(zaicodeGlowsInUse(marks, now), ["window:a|5h"]);
});

test("colour math: hex, HSL round trip, WCAG contrast, neutral adjust", () => {
  assert.equal(normalizeZaicodeHex("#abc"), "#AABBCC");
  assert.equal(normalizeZaicodeHex("d3b57a"), "#D3B57A");
  assert.equal(normalizeZaicodeHex("red"), null);
  assert.equal(zaicodeHslToHex(hexToZaicodeHsl("#D3B57A")), "#D3B57A");
  assert.equal(Math.round(zaicodeContrastRatio("#FFFFFF", "#000000")), 21);
  assert.equal(adjustZaicodeColor("#342012", ZAICODE_NO_ADJUST), "#342012");
  // +180 hue on a grey changes nothing; on a colour it moves the hue.
  assert.equal(adjustZaicodeColor("#808080", { ...ZAICODE_NO_ADJUST, hue: 180 }), "#808080");
  assert.notEqual(adjustZaicodeColor("#D3B57A", { ...ZAICODE_NO_ADJUST, hue: 180 }), "#D3B57A");
});

test("a palette from one colour is deterministic and readable in both polarities", () => {
  for (const dark of [true, false]) {
    const first = generateZaicodePalette("#3A7BD5", dark);
    assert.deepEqual(generateZaicodePalette("#3A7BD5", dark), first);
    assert.ok(zaicodeContrastRatio(first.textPrimary, first.background) >= 4.5, `text contrast (dark=${dark})`);
    assert.ok(zaicodeContrastRatio(first.textPrimary, first.surface) >= 4.5, `card text contrast (dark=${dark})`);
  }
});

test("Color Studio cascade: palette -> shifts -> single overrides; junk is dropped", () => {
  const palette = ZAICODE_PALETTES[0]!;
  const plain = zaicodeEffectiveColorVariables(palette, normalizeZaicodeColorStudio(null));
  assert.equal(plain["--color-background"], palette.tokens.background);
  const shifted = zaicodeEffectiveColorVariables(palette, normalizeZaicodeColorStudio({ adjust: { lightness: 20 } }));
  assert.notEqual(shifted["--color-background"], palette.tokens.background);
  const overridden = zaicodeEffectiveColorVariables(
    palette,
    normalizeZaicodeColorStudio({ adjust: { lightness: 20 }, overrides: { "--color-sidebar": "#123", "--not-a-var": "#fff", "--color-border": "blue" } }),
  );
  assert.equal(overridden["--color-sidebar"], "#112233", "an override wins over the shifted palette");
  assert.equal(overridden["--not-a-var"], undefined);
  assert.equal(overridden["--color-border"], shifted["--color-border"]);
  // Upstream colours (no palette): only the overrides are set.
  assert.deepEqual(zaicodeEffectiveColorVariables(null, normalizeZaicodeColorStudio({ overrides: { "--color-sidebar": "#000" } })), { "--color-sidebar": "#000000" });
  const studio = normalizeZaicodeColorStudio({
    customs: [{ slug: "custom-a", label: "", base: "nope", tokens: { background: "#010203", textPrimary: "zzz" } }, { slug: "evil", tokens: {} }],
    adjust: { hue: 999 },
  });
  assert.equal(studio.customs.length, 1);
  assert.equal(studio.customs[0]!.tokens.background, "#010203");
  assert.equal(studio.customs[0]!.tokens.textPrimary, palette.tokens.textPrimary, "a bad colour falls back to the base palette");
  assert.equal(studio.adjust.hue, 180);
});
