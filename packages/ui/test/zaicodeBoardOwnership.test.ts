import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { openZaicodeSaipenView, useZaicodeActions } from "../src/zaicode/zaicodeActions.js";

afterEach(() => useZaicodeActions.setState({ openSaipen: null, saipenSidebar: null }));

test("draft Board toggles only its own project", () => {
  assert.equal(openZaicodeSaipenView("V:/draft"), true);
  assert.equal(useZaicodeActions.getState().saipenSidebar?.workspacePath, "V:/draft");
  assert.equal(openZaicodeSaipenView("V:/draft"), true);
  assert.equal(useZaicodeActions.getState().saipenSidebar, null);
});

test("binding a chat removes a previous project's global Board", () => {
  openZaicodeSaipenView("V:/old");
  let clicks = 0;
  useZaicodeActions.getState().setOpenSaipen(() => { clicks++; return true; });
  assert.equal(useZaicodeActions.getState().saipenSidebar, null);
  openZaicodeSaipenView("V:/chat");
  assert.equal(clicks, 1);
  assert.equal(useZaicodeActions.getState().saipenSidebar, null);
});

test("a native owner has priority even if a stale same-project inspector remains", () => {
  let clicks = 0;
  useZaicodeActions.setState({
    saipenSidebar: { workspacePath: "V:/chat" },
    openSaipen: () => { clicks++; return true; },
  });
  openZaicodeSaipenView("V:/chat");
  assert.equal(clicks, 1);
  assert.equal(useZaicodeActions.getState().saipenSidebar, null);
});

test("a mismatched native owner cannot create another project's global Board", () => {
  useZaicodeActions.getState().setOpenSaipen(() => false);
  assert.equal(openZaicodeSaipenView("V:/other"), false);
  assert.equal(useZaicodeActions.getState().saipenSidebar, null);
});

test("workspace native opener takes precedence without an active task and prevents global inspector", () => {
  let openedTarget: unknown = null;
  useZaicodeActions.getState().setOpenSaipen((target) => {
    openedTarget = target;
    return true;
  });
  assert.equal(useZaicodeActions.getState().saipenSidebar, null);
  assert.equal(openZaicodeSaipenView("V:/workspace"), true);
  assert.deepEqual(openedTarget, { workspacePath: "V:/workspace", workspaceIdentity: undefined });
  assert.equal(useZaicodeActions.getState().saipenSidebar, null);
});

