import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createCustomAboutDialogHtml } from "../src/main/aboutWindow.js";

const BASE = {
  applicationName: "ZAICODE",
  appVersion: "1.2.3",
  copyright: "ZAICODE, built on ZCode. Copyright © 2026 vacterro.",
  optimizationLine: "",
  versionLabel: "Version",
  okButtonLabel: "OK",
};

const PNG_DATA_URI = "data:image/png;base64,iVBORw0KGgo=";

test("SRC-114 about: the brand mark is ZAICODE's own when the logo is available", () => {
  const html = createCustomAboutDialogHtml({ ...BASE, logoDataUri: PNG_DATA_URI });
  assert.match(html, /<img class="app-logo-img" src="data:image\/png;base64,/);
  assert.doesNotMatch(html, /viewBox="0 0 256 218"/, "the vendor vector mark must be gone");
});

test("SRC-114 about: a missing logo falls back to the vector mark instead of a blank", () => {
  const html = createCustomAboutDialogHtml({ ...BASE });
  assert.doesNotMatch(html, /<img class="app-logo-img"/, "no logo was supplied, so none is drawn");
  assert.match(html, /viewBox="0 0 256 218"/, "the fallback still draws something");
});

test("SRC-114 about: it says what the program is and where the source is", () => {
  const html = createCustomAboutDialogHtml({
    ...BASE,
    tagline: "Coding agents on your projects, in your own subscriptions.",
    repository: "github.com/vacterro/zaicode",
  });
  assert.match(html, /class="tagline">Coding agents on your projects/);
  assert.match(html, /class="repository">github\.com\/vacterro\/zaicode/);
  // The content has to fit the card, so the card got taller with the extra lines.
  const cardHeight = Number(html.match(/\.about-window \{[^}]*height: (\d+)px/)?.[1]);
  assert.ok(Number.isFinite(cardHeight) && cardHeight >= 300, `card height ${cardHeight}px`);
});

test("SRC-114 about: upstream ZCode keeps its own About, without a tagline", () => {
  const html = createCustomAboutDialogHtml({ ...BASE, applicationName: "ZCode Desktop App" });
  assert.doesNotMatch(html, /class="tagline"/);
  assert.doesNotMatch(html, /class="repository"/);
});

test("SRC-114 about: text from the build is escaped, not injected", () => {
  const html = createCustomAboutDialogHtml({
    ...BASE,
    applicationName: '<script>alert("x")</script>',
    copyright: "a & b < c",
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /a &amp; b &lt; c/);
});

test("SRC-114 about: the logo is staged where the main process looks for it", () => {
  const staged = join(import.meta.dirname, "../build/zaicode-logo-128.png");
  assert.ok(existsSync(staged), `${staged} must exist or a packaged About has no brand mark`);
  assert.ok(readFileSync(staged).length > 0);

  const config = readFileSync(join(import.meta.dirname, "../electron-builder.config.js"), "utf-8");
  assert.match(
    config,
    /from: "build\/zaicode-logo-128\.png",\s*\n\s*to: "zaicode-logo-128\.png"/,
    "the logo must be copied into resources, or process.resourcesPath finds nothing",
  );
});