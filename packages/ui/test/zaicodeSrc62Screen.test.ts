import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { normalizeZaicodeScreenMode, zaicodePixelLook } from "@zcode/shared";
import { zaicodeCompactLook } from "../src/zaicode/zaicodeAppearance.js";

// SRC-062: "a separate setting for 2K-4K monitor owners, who do not need the
// pixel look -- pixels look great on Full HD, find an elegant solution for good
// monitors" and "the same for laptop users at 1366x768, so it adapts there".

const root = join(import.meta.dirname, "../..");
const src = (path: string) => readFileSync(join(root, path), "utf8");

test("auto: pixels up to 125 % scaling, smooth from 150 % up; pixel / smooth are fixed", () => {
  assert.deepEqual([1, 1.25, 1.49, 1.5, 1.75, 2, 3].map((scale) => zaicodePixelLook("auto", scale)), [true, true, true, false, false, false, false]);
  assert.equal(zaicodePixelLook("pixel", 2), true);
  assert.equal(zaicodePixelLook("smooth", 1), false);
  assert.equal(zaicodePixelLook("auto", Number.NaN), true, "an unknown scale keeps the old default");
});

test("the old pixel switch migrates: off stays smooth, everything else becomes auto", () => {
  assert.equal(normalizeZaicodeScreenMode(undefined, false), "smooth");
  assert.equal(normalizeZaicodeScreenMode(undefined, true), "auto");
  assert.equal(normalizeZaicodeScreenMode("0", "0"), "smooth");
  assert.equal(normalizeZaicodeScreenMode("1", "1"), "auto");
  assert.equal(normalizeZaicodeScreenMode("pixel"), "pixel");
  assert.equal(normalizeZaicodeScreenMode("neon"), "auto");
});

test("auto size: compact on a 1366x768 laptop and on Full HD at 150 %, normal on larger work areas", () => {
  const area = (width: number, height: number) => zaicodeCompactLook("auto", { width, height });
  assert.equal(area(1366, 728), true, "1366x768 laptop");
  assert.equal(area(1280, 680), true, "1920x1080 at 150 %");
  assert.equal(area(1920, 1040), false, "1920x1080 at 100 %");
  assert.equal(area(1536, 824), false, "1920x1080 at 125 %");
  assert.equal(area(2560, 1400), false, "1440p");
  assert.equal(zaicodeCompactLook("compact", { width: 3840, height: 2100 }), true);
  assert.equal(zaicodeCompactLook("normal", { width: 1366, height: 728 }), false);
});

test("wired: the start reads Windows scaling before the app is ready; compact is whole pixels", () => {
  assert.match(src("desktop/src/main/index.ts"), /zaicodePixelExactAtStart\(readZaicodeLauncherPreferences\(\)\)/);
  const fonts = src("desktop/src/main/zaicodeCrispFonts.ts");
  assert.match(fonts, /AppliedDPI/);
  assert.match(fonts, /zaicodePixelLook\(preferences\.screen, windowsPrimaryScale\(\)\)/);
  const appearance = src("ui/src/zaicode/zaicodeAppearance.ts");
  assert.match(appearance, /matchMedia\(`\(resolution: \$\{scale\}dppx\)`\)/, "auto re-decides when the window moves to another monitor");
  for (const line of appearance.match(/--text-ui-[a-z]+: calc\(var\(--ui-font-size\) [+-] \d+px\);/g) ?? []) assert.match(line, /\d+px/);
  assert.match(src("ui/src/zaicode/ZaicodeFooterMenus.tsx"), /<ZaicodeScreenMenuItems \/>/);
});
