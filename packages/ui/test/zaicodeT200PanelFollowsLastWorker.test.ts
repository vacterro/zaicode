import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { zaicodePanelShouldAutoCollapse } from "../src/zaicode/zaicodeWorkerPrefs.js";

/**
 * SRC-134: the last worker leaves an empty panel behind and the operator has to collapse
 * it by hand. The rule is the transition, not the emptiness: a panel opened empty on
 * purpose must stay open, or Alt+W would look broken.
 */
test("SRC-134: the panel folds away exactly when it loses its last worker", () => {
  assert.equal(zaicodePanelShouldAutoCollapse(1, 0, false), true, "the one worker minimized or closed");
  assert.equal(zaicodePanelShouldAutoCollapse(3, 0, false), true, "the last of several does the same");

  assert.equal(zaicodePanelShouldAutoCollapse(0, 0, false), false, "opened empty on purpose stays open");
  assert.equal(zaicodePanelShouldAutoCollapse(2, 1, false), false, "one worker left, still a live panel");
  assert.equal(zaicodePanelShouldAutoCollapse(1, 1, false), false, "the same worker re-rendering is not a loss");
  assert.equal(zaicodePanelShouldAutoCollapse(1, 0, true), false, "already collapsed: nothing to fold");
});

test("SRC-134: the panel effect drives the pref instead of hiding itself", () => {
  const parts = readFileSync(new URL("../src/zaicode/zaicodeWorkerPrefs.ts", import.meta.url), "utf8");
  const hook = parts.slice(parts.indexOf("export function useZaicodePanelFollowsLastWorker"));
  assert.match(hook.slice(0, 600), /was\.current = count/);
  assert.match(hook.slice(0, 600), /zaicodePanelShouldAutoCollapse\(before, count, collapsed\)/);
  assert.match(hook.slice(0, 600), /useZaicodeWorkerPrefs\.getState\(\)\.update\(\{ panelCollapsed: true \}\)/);

  const panel = readFileSync(new URL("../src/zaicode/ZaicodeWorkersPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /useZaicodePanelFollowsLastWorker\(panelWorkers\.length, collapsed\)/);
});
