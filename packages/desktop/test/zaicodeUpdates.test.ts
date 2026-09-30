import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ZaicodeUpdatesState } from "@zcode/shared";
import {
  ZAICODE_UPDATE_SCRIPT,
  ZaicodeUpdatesController,
  isZaicodeManagedInstall,
  resolveZaicodeInstallRoot,
  type ZaicodeScriptRunner,
} from "../src/main/zaicodeUpdates.js";

/**
 * T-134 (SRC-097): "ZAICODE + SAIPEN + SAIMAIL as one whole, so that I can
 * update them separately and it all comes in by itself". The controller runs
 * install\Update-ZAICODE.ps1; here a stand-in runner answers, so nothing
 * touches git, PowerShell or the network.
 */

const ROOT = "C:\\Z";

function report(mode: "check" | "update", components: Record<string, unknown>[]): string {
  return JSON.stringify({ schema: 1, managed: true, mode, log: "C:\\Z\\install\\logs\\x.log", components });
}

function part(id: string, status: string, extra: Record<string, unknown> = {}) {
  return { id, title: id, dir: `C:\\Z\\${id}`, branch: "main", version: "1", head: "a".repeat(40), remote: "b".repeat(40), behind: status === "available" ? 2 : 0, ahead: 0, dirty: false, status, detail: "", subjects: [], ...extra };
}

function controller(runner: ZaicodeScriptRunner, managed = true) {
  const dir = mkdtempSync(join(tmpdir(), "zaicode-updates-"));
  const changes: ZaicodeUpdatesState[] = [];
  const instance = new ZaicodeUpdatesController({ root: ROOT, managed, runner, storePath: join(dir, "zaicode-updates.json"), now: () => 1000, onChange: (state) => changes.push(state) });
  return { instance, changes, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("R1 the install root: the launcher's variable first, else found above the app; a developer checkout is not 'installed'", () => {
  const present = new Set([join("C:\\Z", ZAICODE_UPDATE_SCRIPT), join("D:\\other", ZAICODE_UPDATE_SCRIPT), join("C:\\Z", "install", "install-state.json")]);
  const exists = (path: string) => present.has(path);
  assert.equal(resolveZaicodeInstallRoot({ env: { ZAICODE_INSTALL_ROOT: "D:\\other" }, execPath: "C:\\Z\\zcode\\packages\\desktop\\dist\\win-unpacked\\ZAICODE.exe", exists }), "D:\\other");
  assert.equal(resolveZaicodeInstallRoot({ env: {}, execPath: "C:\\Z\\zcode\\packages\\desktop\\dist\\win-unpacked\\ZAICODE.exe", exists }), "C:\\Z");
  assert.equal(resolveZaicodeInstallRoot({ env: { ZAICODE_INSTALL_ROOT: "E:\\gone" }, execPath: "C:\\elsewhere\\app.exe", exists }), null);
  assert.equal(isZaicodeManagedInstall("C:\\Z", exists), true);
  assert.equal(isZaicodeManagedInstall("D:\\other", exists), false);
  assert.equal(isZaicodeManagedInstall(null, exists), false);
});

test("R2 check asks the script with -Check -Json and fills the four parts; nothing is changed", async () => {
  const calls: string[][] = [];
  const runner: ZaicodeScriptRunner = async (script, args) => {
    calls.push([script, ...args]);
    return { code: 0, stdout: report("check", [part("workspace", "current"), part("app", "available"), part("saipen", "current"), part("saimail", "offline")]), stderr: "" };
  };
  const { instance, changes, cleanup } = controller(runner);
  try {
    const state = await instance.check();
    assert.deepEqual(calls, [[join(ROOT, ZAICODE_UPDATE_SCRIPT), "-Check", "-Json"]]);
    assert.deepEqual(state.components.map((entry) => [entry.id, entry.status]), [["workspace", "current"], ["app", "available"], ["saipen", "current"], ["saimail", "offline"]]);
    assert.equal(state.busy, null);
    assert.equal(state.lastCheckAt, 1000);
    // The window saw it start and finish.
    assert.deepEqual(changes.map((entry) => entry.busy), ["check", null]);
  } finally {
    cleanup();
  }
});

test("R3 one part updates on its own: only that part is named, the others keep their last report", async () => {
  const calls: string[][] = [];
  let first = true;
  const runner: ZaicodeScriptRunner = async (_script, args) => {
    calls.push([...args]);
    if (first) {
      first = false;
      return { code: 0, stdout: report("check", [part("workspace", "current"), part("app", "available"), part("saipen", "available"), part("saimail", "current")]), stderr: "" };
    }
    return { code: 0, stdout: report("update", [part("saipen", "updated", { detail: "aaaaaaaa -> bbbbbbbb; SAIPEN launcher refreshed" })]), stderr: "" };
  };
  const { instance, cleanup } = controller(runner);
  try {
    await instance.check();
    const state = await instance.apply(["saipen"]);
    assert.deepEqual(calls[1], ["-Json", "-Component", "saipen"]);
    assert.deepEqual(state.components.map((entry) => [entry.id, entry.status]), [["workspace", "current"], ["app", "available"], ["saipen", "updated"], ["saimail", "current"]]);
    assert.equal(state.lastUpdateAt, 1000);
  } finally {
    cleanup();
  }
});

test("R4 the schedule updates by itself only the parts set to, and only when something is new", async () => {
  const calls: string[][] = [];
  const runner: ZaicodeScriptRunner = async (_script, args) => {
    calls.push([...args]);
    if (args.includes("-Check")) {
      return { code: 0, stdout: report("check", [part("workspace", "available"), part("app", "available"), part("saipen", "current"), part("saimail", "available")]), stderr: "" };
    }
    return { code: 0, stdout: report("update", [part("workspace", "updated"), part("saimail", "updated")]), stderr: "" };
  };
  const { instance, cleanup } = controller(runner);
  try {
    instance.setAuto("app", false);
    const result = await instance.tick();
    assert.deepEqual(calls.map((args) => args.join(" ")), ["-Check -Json", "-Json -Component workspace,saimail"]);
    assert.deepEqual(result, { checked: true, updated: ["workspace", "saimail"] });
    assert.equal(instance.state().components.find((entry) => entry.id === "app")!.status, "available", "the part set to manual waits for the button");
  } finally {
    cleanup();
  }
});

test("R5 a developer checkout never updates by itself unless a part is switched on", async () => {
  const calls: string[][] = [];
  const runner: ZaicodeScriptRunner = async (_script, args) => {
    calls.push([...args]);
    return { code: 0, stdout: report("check", [part("workspace", "available"), part("app", "available")]), stderr: "" };
  };
  const { instance, cleanup } = controller(runner, false);
  try {
    const result = await instance.tick();
    assert.deepEqual(result, { checked: true, updated: [] });
    assert.equal(calls.length, 1, "only the look, no update");
  } finally {
    cleanup();
  }
});

test("R6 one run at a time; a script without a report is an error the card shows, not a silent success", async () => {
  let release: (() => void) | null = null;
  let runs = 0;
  const runner: ZaicodeScriptRunner = (_script, _args) =>
    new Promise((resolve) => {
      runs++;
      release = () => resolve({ code: 1, stdout: "", stderr: "git.exe not found" });
    });
  const { instance, cleanup } = controller(runner);
  try {
    const first = instance.check();
    const second = instance.apply(["app"]);
    assert.equal(runs, 1, "the second request joined the running one");
    release!();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.error, b.error);
    assert.match(a.error ?? "", /gave no report \(exit 1\): git\.exe not found/);
    assert.equal(a.busy, null);
  } finally {
    cleanup();
  }
});

test("R7 the per-part switches and the last report survive a restart", async () => {
  const runner: ZaicodeScriptRunner = async () => ({ code: 0, stdout: report("check", [part("saipen", "available")]), stderr: "" });
  const { instance, dir, cleanup } = controller(runner);
  try {
    instance.setAuto("saimail", false);
    await instance.check();
    const stored = JSON.parse(readFileSync(join(dir, "zaicode-updates.json"), "utf8")) as { auto: Record<string, boolean> };
    assert.equal(stored.auto.saimail, false);
    const again = new ZaicodeUpdatesController({ root: ROOT, managed: true, runner, storePath: join(dir, "zaicode-updates.json") });
    assert.equal(again.state().auto.saimail, false);
    assert.equal(again.state().auto.app, true);
    assert.deepEqual(again.state().components.map((entry) => [entry.id, entry.status]), [["saipen", "available"]]);
  } finally {
    cleanup();
  }
});
