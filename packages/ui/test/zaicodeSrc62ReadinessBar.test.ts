import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZAICODE_READINESS_TONE_COLORS, ZaicodeReadinessBar } from "../src/zaicode/ZaicodeReadinessBar.js";
import { decorateZaicodeAccountGroups } from "../src/zaicode/zaicodeSubscriptionSync.js";

// SRC-062: "in the model picker the colours mix and the readiness bars of the
// providers cannot be seen". The old bar's track was `bg-surface`, the same
// token as the menu (`--color-popover` = palette surface), so only a hovered
// row showed it, and its fills were fixed dark hex values that sank into most
// Wintage palettes.

test("the bar draws on the palette's own tokens, never on the menu's surface", () => {
  const html = renderToStaticMarkup(
    createElement(ZaicodeReadinessBar, {
      view: { percent: 64, tone: "good", color: ZAICODE_READINESS_TONE_COLORS.good, text: "64%", title: "t" },
    }),
  );
  assert.doesNotMatch(html, /bg-surface/, "the track is not the menu's own colour");
  assert.match(html, /background:var\(--color-background/, "the track is the palette background (darker than any menu)");
  assert.match(html, /border:1px solid var\(--color-foreground-subtlest/, "a frame in the palette's muted text colour");
  assert.match(html, /width:64%/);
  assert.match(html, /data-zaicode-account-readiness="good"/);
});

test("every tone follows the palette; no tone is a fixed dark hex", () => {
  for (const [tone, color] of Object.entries(ZAICODE_READINESS_TONE_COLORS)) {
    assert.match(color, /^var\(--color-/, `${tone} reads a palette token first`);
  }
});

test("an unknown account is a hatched, dashed box with a dash, not an invisible strip", () => {
  const [group] = decorateZaicodeAccountGroups([{ key: "registry-provider:p1", label: "Cline 1" }], {
    providerAccount: { p1: "cl-1" },
    readiness: { "cl-1": { remaining: null, tone: "unknown", text: "?", title: "Cline 1: the vendor gives no quota numbers" } },
  });
  assert.equal(group!.readiness!.text, "—");
  const html = renderToStaticMarkup(createElement(ZaicodeReadinessBar, { view: group!.readiness! }));
  assert.match(html, /dashed/);
  assert.match(html, /repeating-linear-gradient/);
  assert.match(html, /—/);
});

test("a nearly empty account still shows one pixel of fill", () => {
  const html = renderToStaticMarkup(
    createElement(ZaicodeReadinessBar, {
      view: { percent: 2, tone: "bad", color: ZAICODE_READINESS_TONE_COLORS.bad, text: "2%", title: "t" },
    }),
  );
  assert.match(html, /min-width:1px/);
});
