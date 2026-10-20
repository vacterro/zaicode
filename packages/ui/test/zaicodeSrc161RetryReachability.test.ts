import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import {
  ZaicodeAutoRetryButton,
  ZaicodeAutoRetryPanel,
  zaicodeAutoRetryTitle,
} from "../src/zaicode/ZaicodeAutoRetryButton.js";
import { readFileSync } from "node:fs";
import { rightClickOpensSettings } from "../src/zaicode/zaicodeUiPrefs.js";
import { zaicodeEffectiveAutoRetry, zaicodeEffectiveAutoRetryFor } from "../src/zaicode/zaicodeRetryPolicy.js";
import { ZAICODE_UI_DEFAULT_PREFS } from "../src/zaicode/zaicodeUiPrefs.js";

// SRC-161:REQ-002 — "after choosing the app-menu option, the Auto retry right-click settings
// become unusable and the tooltip stays pinned at 'Auto retry off · Auto is off'".
//
// Two defects, two contracts. (1) The switch that disables the panel sat inside the panel, and
// the menu it promised does not exist for a plain button, so the choice was a one-way door.
// (2) The effective answer is ANDed with the sidebar's Auto — a gate the button does not own —
// and the tooltip named it with a phrase nothing else in the product uses, so no click ever
// changed what the operator read.

const render = (node: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, node));

const buttonHtml = () => render(createElement(ZaicodeAutoRetryButton, { projectKey: "p1" }));

test("REQ-002 / SRC-162: no choice can leave the Auto retry right button dead", () => {
  // SRC-161 kept the "opens the app menu" mode behind a Shift+right-click hatch; the operator
  // still read a dead right button. The mode itself is gone: a stored OFF is ignored.
  assert.equal(rightClickOpensSettings({ rightClickSettings: { retry: false } }, "retry"), true);
  const shared = readFileSync(new URL("../src/zaicode/ZaicodePrefControls.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(shared, /Opens the app menu/);
  assert.match(shared, /onContextMenu=\{\(event\) => \{[^}]*event\.preventDefault\(\);/s);
});

test("REQ-002: the composer tooltip is exactly the effective answer, never a re-derived string", () => {
  const prefs = { ...ZAICODE_UI_DEFAULT_PREFS, autoRetry: true };
  const at = (gate: { sessionMode?: "on" | "off"; halted: boolean }) =>
    zaicodeEffectiveAutoRetry(prefs, "p1", null, gate);

  assert.equal(
    zaicodeAutoRetryTitle(at({ halted: false })),
    "Auto retry on — a failed turn is sent again by itself",
  );
  assert.equal(
    zaicodeAutoRetryTitle(at({ halted: true })),
    "Auto retry off · All retries stopped",
  );

  // The shipped markup carries exactly that title: whatever the machine's persisted prefs are,
  // the button must print the projection's own string, computed independently here.
  const html = buttonHtml();
  const expected = zaicodeAutoRetryTitle(zaicodeEffectiveAutoRetryFor("p1", null));
  assert.ok(html.includes(`aria-label="${expected}"`),
    `rendered aria-label must be the projection title: ${expected}`);
});
test("SRC-183: the panel leads to retry settings without a misleading Audits gate", () => {
  const html = render(createElement(ZaicodeAutoRetryPanel, { effectiveLabel: "Global ON", preference: true }));
  assert.match(html, /Global ON/);
  assert.match(html, /Open retry settings/);
  assert.doesNotMatch(html, /Sidebar Auto|Open Audits|retry-master-off/);
});

test("REQ-002: every reason names the surface that owns it", () => {
  const prefs = { ...ZAICODE_UI_DEFAULT_PREFS, autoRetry: true };
  const at = (gate: { sessionMode?: "on" | "off"; halted: boolean }) =>
    zaicodeEffectiveAutoRetry(prefs, "p1", "s1", gate);

  assert.equal(at({ halted: false }).reason, null);
  assert.equal(at({ halted: true }).reason, "All retries stopped");
  assert.equal(
    at({ sessionMode: "off", halted: false }).reason,
    "Session auto-continue is off",
  );
  assert.equal(
    zaicodeEffectiveAutoRetry({ ...prefs, autoRetry: false }, "p1", null, { halted: false }).reason,
    "global retry preference is off",
  );
});
