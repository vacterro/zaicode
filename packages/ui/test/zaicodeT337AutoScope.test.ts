import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IZaicodeAuditService } from "@zcode/services";
import { ZaicodeAutoSettingsPanel, ZaicodeSidebarAutoButton } from "../src/zaicode/ZaicodeAutoSettings.js";
import { useZaicodeAuditStore } from "../src/zaicode/zaicodeAuditStore.js";

test("T-337: AUTO settings name both editing targets, inheritance and the three scoped settings", () => {
  const html = renderToStaticMarkup(createElement(ZaicodeAutoSettingsPanel, {
    audits: null, workspaceKey: "remote/project", projectName: "Current project name",
  }));
  assert.match(html, /Apply AUTO settings to/);
  assert.match(html, /Current project<\/button>/);
  assert.match(html, /Global<\/button>/);
  assert.match(html, /data-zaicode-auto-edit-scope="global"/);
  assert.match(html, /Inherited from Global/);
  assert.match(html, /AUTO continue project work/);
  assert.match(html, /Run A3 audits after project work/);
  assert.match(html, /Maximum automatic audits per project/);
});

test("T-337: sidebar AUTO displays the effective source and stays honest without a service", () => {
  const html = renderToStaticMarkup(createElement(ZaicodeSidebarAutoButton, {
    audits: null, className: "test-button", workspaceKey: "remote/project", projectName: "Project name",
  }));
  assert.match(html, /data-zaicode-auto-scope="global"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /disabled/);
  assert.match(html, /Auto OFF/);
  assert.match(html, /Project name/);
});

test("T-337: scoped writes suspend AUTO until acknowledged and refresh the existing policy mirror", async () => {
  const before = useZaicodeAuditStore.getState();
  let acknowledge!: () => void;
  const pending = new Promise<void>((resolve) => { acknowledge = resolve; });
  const calls: unknown[] = [];
  const audits = {
    setProjectAutoSettings: async (...args: unknown[]) => { calls.push(args); await pending; },
    getState: async () => ({ campaigns: [], smartMode: true, autoProjects: { "remote/project": { smartMode: false } }, autoAudits: true, maxCycles: 10, runId: "run", autoWaves: true }),
  } as unknown as IZaicodeAuditService;
  try {
    const write = before.setProjectAutoSettings(audits, "remote/project", { smartMode: false });
    assert.equal(useZaicodeAuditStore.getState().policySaving, true);
    assert.equal(useZaicodeAuditStore.getState().autoProjects["remote/project"], undefined, "pending intent cannot claim a saved override");
    acknowledge();
    await write;
    assert.deepEqual(calls, [["remote/project", { smartMode: false }]]);
    assert.deepEqual(useZaicodeAuditStore.getState().autoProjects, { "remote/project": { smartMode: false } });
    assert.equal(useZaicodeAuditStore.getState().policySaving, false);
  } finally { useZaicodeAuditStore.setState(before); }
});

test("T-337: rejected scoped writes retain existing policy and expose the actual error", async () => {
  const before = useZaicodeAuditStore.getState();
  const audits = { setProjectAutoSettings: async () => { throw new Error("scope storage unavailable"); } } as unknown as IZaicodeAuditService;
  try {
    await before.setProjectAutoSettings(audits, "remote/project", { smartMode: true });
    assert.equal(useZaicodeAuditStore.getState().autoProjects, before.autoProjects);
    assert.equal(useZaicodeAuditStore.getState().policySaving, false);
    assert.match(useZaicodeAuditStore.getState().error!, /scope storage unavailable/);
  } finally { useZaicodeAuditStore.setState(before); }
});
