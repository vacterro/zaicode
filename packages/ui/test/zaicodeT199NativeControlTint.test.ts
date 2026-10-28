import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

/**
 * SRC-133: the whiteness in sliders and the other native controls is a hole in a dark
 * theme. Two halves, and either one alone still shows white: Chromium paints a range input
 * light unless the document declares a dark surface, and it stays the browser's own grey
 * unless something gives it an accent. The pixels themselves are the packaged oracle's
 * job; this locks the two decisions in place.
 */
test("SRC-133: the dark surface is not a browser-only setting", () => {
  const theme = source("../src/useTheme.ts");
  const fn = theme.slice(theme.indexOf("function syncBrowserThemeSurface"));
  const surface = fn.indexOf("root.style.colorScheme = resolved");
  const guard = fn.indexOf("hasAttribute(BROWSER_THEME_SURFACE_ATTRIBUTE)");
  assert.ok(surface > -1, "the document still declares its color-scheme");
  assert.ok(guard > -1, "the browser-only surface attribute survives");
  assert.ok(
    surface < guard,
    `color-scheme must be set before the browser-only early return (surface at ${surface}, guard at ${guard}) -- otherwise the desktop app, which never carries the attribute, keeps the browser's light controls`,
  );
});

test("SRC-133: the slider carries the palette tint", () => {
  const palettes = source("../src/zaicode/zaicodePalettes.ts");
  const rule = palettes.slice(palettes.indexOf('html.zaicode-fonts input[type="range"]'));
  assert.match(
    rule.slice(0, 120),
    /accent-color: var\(--zaicode-highlight, var\(--color-accent\)\);/,
    "the native slider rail and thumb take the active palette highlight",
  );
  const appearance = source("../src/zaicode/zaicodeAppearance.ts");
  assert.match(
    appearance,
    /\$\{ZAICODE_CRISP_CSS\}/,
    "the rule still travels with the style element the appearance apply writes",
  );
});