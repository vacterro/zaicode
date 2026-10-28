import assert from "node:assert/strict";
import test from "node:test";
import * as pane from "../src/lib/workspaceSidePane.js";

const toggle = (current: pane.WorkspaceSidePaneState | null, collapsed = false) => {
  const fn = (pane as typeof pane & { toggleSaipenSidePane?: (value: typeof current, owner?: string | null, collapsed?: boolean) => typeof current }).toggleSaipenSidePane;
  assert.equal(typeof fn, "function");
  return fn!(current, null, collapsed);
};
test("visible SAIPEN toggles closed and preserves the other side tabs", () => {
  const opened = pane.activateSaipenSidePane(null);
  assert.equal(toggle(opened), null);
  const withGit = pane.activateSaipenSidePane(pane.activateGitSidePane(null));
  const closed = toggle(withGit);
  assert.equal(closed?.tabs.length, 1);
  assert.equal(pane.getActiveSidePaneTab(closed)?.type, "git");
});
test("a collapsed STATE inspector is revealed and the generic Add action stays open-only", () => {
  const opened = pane.activateSaipenSidePane(null);
  assert.equal(pane.getActiveSidePaneTab(toggle(opened, true))?.type, "saipen");
  assert.equal(pane.activateSaipenSidePane(opened).tabs.length, 1);
});
