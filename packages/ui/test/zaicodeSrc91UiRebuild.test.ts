import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZaicodeFolderMenu } from "../src/zaicode/ZaicodeProjectFolderParts.js";
import { ZaicodeNameField, resolveZaicodeName } from "../src/zaicode/ZaicodeNameField.js";
import { zaicodeWorkerCloseRequest } from "../src/zaicode/zaicodeWorkerClose.js";
import type { ZaicodeWorker } from "../src/zaicode/zaicodeWorkers.js";

/**
 * SRC-091 (T-128): "rebuild the UI where it is poor and clumsy". The pass found what the operator's examples had in
 * common: controls that were never looked at running. In the desktop app `window.prompt` throws "prompt() is not
 * supported.", so New folder, Rename folder and Save as preset did nothing; the folder menu could not open at all
 * (a second `open` flag that started false and returned nothing); and the confirmations were the operating system's
 * blocking dialog. Each is rebuilt in the window, and these tests fail on the old source.
 */

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const source = (path: string): string => readFileSync(join(srcRoot, path), "utf8").replace(/\r\n/g, "\n");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test("U1 no code in the window calls the browser's own dialogs: prompt() does not exist in the app, confirm() blocks and beeps", () => {
  const found: string[] = [];
  for (const file of sourceFiles(srcRoot)) {
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    for (const match of text.matchAll(/\b(?:window|globalThis|self)\.(prompt|confirm|alert)\s*\(/g)) found.push(`${relative(srcRoot, file)}: ${match[0]}`);
  }
  assert.deepEqual(found, []);
});

test("U2 a name field gives back what was typed, tidied, and the fallback when it was left blank", () => {
  assert.equal(resolveZaicodeName("  Night   shift ", "My text"), "Night shift");
  assert.equal(resolveZaicodeName("   ", "New folder"), "New folder");
  assert.equal(resolveZaicodeName("", "New folder"), "New folder");
  assert.equal(resolveZaicodeName("x".repeat(100), "n", 60).length, 60);
  assert.equal(resolveZaicodeName(`${" ".repeat(59)}ab`, "n", 60), "ab");
});

test("U3 the name field says what it asks, starts on the suggestion and offers the two ways out", () => {
  const html = renderToStaticMarkup(createElement(ZaicodeNameField, { initial: "New folder", label: "Folder name", confirmLabel: "Create", onSubmit: () => undefined, onCancel: () => undefined }));
  assert.match(html, /Folder name/);
  assert.match(html, /value="New folder"/);
  assert.match(html, /autofocus|autoFocus/i);
  assert.match(html, />Cancel</);
  assert.match(html, />Create</);
  assert.match(html, /type="submit"/, "Enter in the field submits through the form");
});

test("U4 the folder menu is there when the header opens it, with Rename and Delete; the old menu rendered nothing", () => {
  const folder = { id: "folder-reviews", name: "Reviews", order: 0, collapsed: false };
  const html = renderToStaticMarkup(createElement(ZaicodeFolderMenu, { folder, onClose: () => undefined }));
  assert.match(html, /data-zaicode-folder-menu="folder-reviews"/);
  assert.match(html, /role="menu"/);
  assert.match(html, />Rename folder</);
  assert.match(html, />Delete folder \(projects are kept\)</);
  const parts = source("zaicode/ZaicodeProjectFolderParts.tsx");
  assert.doesNotMatch(parts, /if \(!open\) return null;/, "the menu holds no second open flag of its own");
  assert.match(parts, /<ZaicodeFolderMenu folder=\{folder\} onClose=\{\(\) => setMenuOpen\(false\)\} \/>/);
});

test("U5 New folder asks for the name in a popover and Rename in the menu; Delete folder asks in the app's own dialog", () => {
  const parts = source("zaicode/ZaicodeProjectFolderParts.tsx");
  assert.match(parts, /<ZaicodeNameField\s+initial="New folder"/);
  assert.match(parts, /confirmLabel="Create"/);
  assert.match(parts, /confirmLabel="Rename"/);
  assert.match(parts, /confirmVariant: "destructive"/);
  assert.match(parts, /useConfirmDialogStore\s*\.getState\(\)\s*\.requestConfirmation\(/);
  assert.doesNotMatch(parts, /createFolder\(name\.trim\(\)/, "the old prompt result handling is gone");
});

const worker = (patch: Partial<ZaicodeWorker>): ZaicodeWorker => ({ id: "w1", short: "C1", label: "Claude Code", projectName: "proj-a", projectPath: "V:/proj-a", exitCode: null, ...patch }) as ZaicodeWorker;

test("U6 closing a running worker asks (in the app's dialog, red button); an ended one, or the setting off, closes without a question", () => {
  const asked = zaicodeWorkerCloseRequest(worker({}), true);
  assert.ok(asked);
  assert.match(asked!.title, /^Stop .*\?$/);
  assert.match(asked!.description ?? "", /Claude Code process in V:\/proj-a ends and its terminal closes\./);
  assert.equal(asked!.confirmLabel, "Stop and close");
  assert.equal(asked!.confirmVariant, "destructive");
  assert.equal(zaicodeWorkerCloseRequest(worker({ exitCode: 0 }), true), null, "an ended worker needs no question");
  assert.equal(zaicodeWorkerCloseRequest(worker({}), false), null, "the setting off: no question");
  const parts = source("zaicode/ZaicodeWorkerParts.tsx");
  assert.match(parts, /request && !\(await useConfirmDialogStore\.getState\(\)\.requestConfirmation\(request\)\)\) return;/, "a declined question stops the close");
});

test("U7 Clear all done runs on the first click; a plan reset and the Session text import ask in the app's own dialog, before anything happens", () => {
  const clear = source("zaicode/ZaicodeClearAllDone.tsx");
  // SRC-161:REQ-005 supersedes the T-128 dialog for this one action: it is reversible
  // (one Ctrl+Z restores the archive) and its own tooltip lists what it will do, so it
  // runs on the first click. No other confirmation is weakened -- the two below still
  // ask, and a behavioural test pins the first-click run.
  assert.equal(clear.indexOf("requestConfirmation("), -1, "CLEAR ALL DONE asks nothing");
  assert.equal(clear.indexOf("confirmDialogStore"), -1, "the confirmation store is not even imported");
  const runStart = clear.indexOf("const run = async () => {");
  assert.ok(runStart > 0 && clear.indexOf("archiveZaicodeSessions(byProject)") > runStart, "the tidy-up runs inside the click handler itself");
  assert.ok(clear.includes("CLEAR ALL DONE") && clear.includes("${describe(plan)}"), "what it will do stays on the button's own tooltip");
  const resets = source("zaicode/ZaicodeCodingPlanResets.tsx");
  const resetAsk = resets.indexOf("requestConfirmation({");
  assert.ok(resetAsk > 0 && resets.indexOf("await resets.reset(kind)") > resetAsk, "a reset is asked for before it is spent");
  assert.match(resets, /confirmVariant: "destructive"/, "a reset is used up for good: red");
  assert.ok(resets.indexOf("if (!confirmed) return;") > resetAsk && resets.indexOf("if (!confirmed) return;") < resets.indexOf("await resets.reset(kind)"), "a declined dialog stops it");
  const text = source("settings/ZaicodeSessionTextSettings.tsx");
  const importAsk = text.indexOf("requestConfirmation({");
  assert.ok(importAsk > 0 && text.indexOf("store.importDocument(text)") > importAsk, "the import says what it replaces, then asks");
  assert.ok(text.indexOf("if (!confirmed) {") > importAsk && text.indexOf("if (!confirmed) {") < text.indexOf("store.importDocument(text)"), "a declined dialog leaves the settings alone");
  assert.match(text, /<ZaicodeNameField initial="My text"/, "Save as preset asks for its name in place");
  assert.match(text, /naming \? \(/);
});
