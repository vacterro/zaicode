import assert from "node:assert/strict";
import test from "node:test";
import { ZAICODE_SPLASH_PLACEHOLDER_PNG_BASE64, ZAICODE_SPLASH_PLACEHOLDER_SIZE } from "@zcode/shared";
import { zaicodeSplashPage } from "../src/main/zaicodeSplashFiles.js";

// SRC-062: "the first [splash] can still be just a fragment for some reason;
// make a separate placeholder for that". Until the picture is decoded, and for
// good when it cannot be read, the splash shows the SAIPEN emblem instead of a
// half-drawn or cut-off picture. (The root launcher does the same in C#; it is
// compiled and checked outside this package.)

test("the placeholder is a real 128 x 128 PNG", () => {
  const png = Buffer.from(ZAICODE_SPLASH_PLACEHOLDER_PNG_BASE64, "base64");
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IHDR width and height, big-endian, right after the signature and chunk header.
  assert.equal(png.readUInt32BE(16), ZAICODE_SPLASH_PLACEHOLDER_SIZE);
  assert.equal(png.readUInt32BE(20), ZAICODE_SPLASH_PLACEHOLDER_SIZE);
});

test("the page shows the emblem first and the picture only once it is decoded", () => {
  const page = zaicodeSplashPage("custom.png");
  assert.match(page, /img-src 'self' data:;/, "the inline emblem is allowed by the page's own policy");
  assert.ok(page.includes(`src="data:image/png;base64,${ZAICODE_SPLASH_PLACEHOLDER_PNG_BASE64}"`));
  assert.match(page, /#picture \{[^}]*visibility: hidden;/, "the picture waits hidden");
  assert.match(page, /#placeholder \{[^}]*image-rendering: pixelated;/, "the emblem stays hard-edged");
  // Revealed only after decode(); a broken picture (naturalWidth 0) keeps the emblem.
  assert.match(page, /if \(!picture\.naturalWidth\) return;/);
  assert.match(page, /picture\.decode\(\)\.then\(done/);
  assert.match(page, /picture\.classList\.add\("ready"\)/);
  assert.match(page, /getElementById\("placeholder"\)\.classList\.add\("gone"\)/);
});
