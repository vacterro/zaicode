import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import {
  ZAICODE_UI_DEFAULT_PREFS,
  normalizeZaicodeUiPrefs,
  zaicodeAutoRetryEnabled,
  zaicodeAutoRetryPatch,
  zaicodeAutoRetryScopeNext,
  type ZaicodeUiPrefs,
} from "../src/zaicode/zaicodeUiPrefs.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ZaicodeAutoRetryButton } from "../src/zaicode/ZaicodeAutoRetryButton.js";

// Server rendering always shows a store's initial snapshot, so the markup case is the
// shipped default: auto retry on, every project. The off case is the packaged oracle's
// job — it clicks the real switch in the running app.
const buttonHtml = () =>
  renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(ZaicodeAutoRetryButton, { projectKey: "p1" })),
  );

const prefs = (over: Partial<ZaicodeUiPrefs> = {}): ZaicodeUiPrefs => ({
  ...ZAICODE_UI_DEFAULT_PREFS,
  ...over,
});

test("SRC-135: stored prefs that are not the two answers fall back instead of poisoning the switch", () => {
  const norm = normalizeZaicodeUiPrefs({
    autoRetryScope: "everywhere",
    autoRetryProjects: { a: "yes", b: false, c: 1 },
  });
  assert.equal(norm.autoRetryScope, "global");
  assert.deepEqual(norm.autoRetryProjects, { b: false });

  const empty = normalizeZaicodeUiPrefs({ autoRetryProjects: "nope" });
  assert.deepEqual(empty.autoRetryProjects, {});
  assert.equal(empty.autoRetryScope, "global");
  assert.equal(empty.autoRetry, ZAICODE_UI_DEFAULT_PREFS.autoRetry);
});

test("SRC-135: global reach ignores every per-project answer; project reach keeps them apart", () => {
  const global = prefs({ autoRetry: true, autoRetryProjects: { p1: false } });
  assert.equal(zaicodeAutoRetryEnabled(global, "p1"), true, "a stale project answer must not leak into global");

  const scoped = prefs({ autoRetry: true, autoRetryScope: "project", autoRetryProjects: { p1: false } });
  assert.equal(zaicodeAutoRetryEnabled(scoped, "p1"), false, "the project's own answer wins");
  assert.equal(zaicodeAutoRetryEnabled(scoped, "p2"), true, "a project with no own answer takes the global one");

  assert.equal(zaicodeAutoRetryScopeNext("global"), "project");
  assert.equal(zaicodeAutoRetryScopeNext("project"), "global");
});

test("SRC-135: the switch writes the answer its scope says, without losing other projects", () => {
  const globalPatch = zaicodeAutoRetryPatch(prefs({ autoRetry: true, autoRetryProjects: { p1: false } }), "p1", false);
  assert.deepEqual(globalPatch, { autoRetry: false });

  const scoped = prefs({ autoRetryScope: "project", autoRetryProjects: { p1: true, p2: false } });
  const patch = zaicodeAutoRetryPatch(scoped, "p1", false);
  assert.equal(patch.autoRetry, undefined, "the global flag must stay untouched under project reach");
  assert.deepEqual(patch.autoRetryProjects, { p1: false, p2: false });
});

test("SRC-135: the composer button carries both switches and lights the lit one only", () => {
  const html = buttonHtml();
  assert.match(html, /data-testid="zaicode-auto-retry"/);
  assert.match(html, /data-zaicode-auto-retry="on"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /bg-selected/);
  assert.match(html, /data-testid="zaicode-auto-retry-scope"/);
  assert.match(html, /Everywhere/);

  // The highlight must hang off the answer, not be baked into the class list.
  const source = readFileSync(new URL("../src/zaicode/ZaicodeAutoRetryButton.tsx", import.meta.url), "utf8");
  assert.match(source, /cn\("cursor-pointer", enabled && "bg-selected text-foreground"\)/);
  assert.match(source, /onClick=\{\(\) => update\(zaicodeAutoRetryPatch\(prefs, projectKey, !enabled\)\)\}/);
  assert.match(source, /autoRetryScope: zaicodeAutoRetryScopeNext\(prefs\.autoRetryScope\)/);
});

test("SRC-135: the retry watcher asks the gate with the project's answer, not the raw flag", () => {
  const watch = readFileSync(new URL("../src/zaicode/zaicodeTurnRetryWatch.ts", import.meta.url), "utf8");
  assert.doesNotMatch(watch, /prefs\.autoRetry\b/, "the watcher must not read the bare global flag again");
  assert.match(watch, /zaicodeAutoRetryEnabled\(prefs, brief\.projectKey\)/);
  assert.match(watch, /zaicodeAutoRetryEnabled\(prefs, projectOf\.get\(sessionId\)/);

  const composer = readFileSync(new URL("../src/v4/ConversationComposer.tsx", import.meta.url), "utf8");
  assert.match(composer, /<ZaicodeAutoRetryButton projectKey=\{workspaceKey\} \/>/);
});
