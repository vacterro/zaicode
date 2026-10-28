import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkspaceKey } from "@zcode/shared";
import { addZaicodeAutostartJob, decideZaicodeAutostartJob, readZaicodeAutostartJobs, runZaicodeAutostartNow } from "../src/zaicode/zaicodeAutostart.js";
import { useZaicodeDisabledProjects } from "../src/zaicode/zaicodeProjectSwitch.js";
import { zaicodeSidebarDragWidth, resolveZaicodeSidebarWidth } from "../src/zaicode/zaicodeSidebarWidth.js";
import { openZaicodeSaipenView, useZaicodeActions } from "../src/zaicode/zaicodeActions.js";

test("an OFF project waits without consuming its occurrence and can run when enabled within catch-up", async () => {
  const now = Date.now();
  const projectPath = "C:/scheduler-admission-fixture";
  const key = resolveWorkspaceKey({ workspacePath: projectPath });
  const job = addZaicodeAutostartJob({ projectPath, engineId: "pool:start", trigger: "at", at: now - 1000, catchUpMinutes: 15 });
  useZaicodeDisabledProjects.setState({ keys: [key] });
  assert.equal(decideZaicodeAutostartJob(job, now).state, "waiting-project");
  await runZaicodeAutostartNow(job.id);
  const saved = readZaicodeAutostartJobs().find((value) => value.id === job.id)!;
  assert.deepEqual(saved.firedEvents, []);
  assert.equal(saved.lastRunAt, null);
  assert.equal(saved.enabled, true);
  useZaicodeDisabledProjects.setState({ keys: [] });
  assert.equal(decideZaicodeAutostartJob(saved, now).state, "due");
  assert.equal(decideZaicodeAutostartJob(saved, now + 16 * 60_000).state, "missed");
});

test("dragging near the default width snaps in either sidebar placement without rewriting stored widths", () => {
  assert.equal(zaicodeSidebarDragWidth(300, -25, false), 264);
  assert.equal(zaicodeSidebarDragWidth(300, 47, true), 264);
  assert.equal(zaicodeSidebarDragWidth(300, -23, false), 277);
  assert.equal(zaicodeSidebarDragWidth(300, 49, true), 251);
  assert.equal(resolveZaicodeSidebarWidth(275), 275);
});

test("a second STATE click closes the exact draft inspector while a different project replaces it", () => {
  useZaicodeActions.setState({ openSaipen: null, saipenSidebar: null });
  openZaicodeSaipenView("C:/state-fixture", "remote-a");
  openZaicodeSaipenView("C:/state-fixture", "remote-a");
  assert.equal(useZaicodeActions.getState().saipenSidebar, null);
  openZaicodeSaipenView("C:/state-fixture", "remote-a");
  openZaicodeSaipenView("C:/state-fixture", "remote-b");
  assert.equal(useZaicodeActions.getState().saipenSidebar?.workspaceIdentity, "remote-b");
});

test("STATE closes the visible draft inspector after the workspace opener registers", () => {
  useZaicodeActions.setState({ openSaipen: null, saipenSidebar: null });
  openZaicodeSaipenView("C:/state-fixture");
  let opened = 0;
  useZaicodeActions.getState().setOpenSaipen(() => { opened += 1; return true; });
  openZaicodeSaipenView("C:/state-fixture");
  assert.equal(useZaicodeActions.getState().saipenSidebar, null);
  assert.equal(opened, 0);
});
