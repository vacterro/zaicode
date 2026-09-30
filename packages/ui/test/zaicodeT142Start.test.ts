import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

/** Execute the actual composer callback with deterministic owner ports. */
function harness({ engine = false, disabled = false, sessionId = "current" } = {}) {
  const source = readFileSync(process.env.ZAICODE_T142_START_SUBJECT ?? new URL("../src/prompt-editor/ZaicodeSaipenControls.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("controls.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "start") callback = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(callback);
  const calls: string[] = [];
  const start = runInNewContext(ts.transpileModule(`(${callback.getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    engineAccount: engine ? { id: "paid" } : null, disabled, sessionId,
    workspacePath: "project", workspaceIdentity: "identity", mainKey: "identity",
    ZAICODE_SAIPEN_START_COMMAND: "/goal cc all",
    sendWork: (command: string) => calls.push(`current:${command}`),
    onCommand: (command: string) => calls.push(`draft:${command}`),
    armMain: () => calls.push("arm-main"),
    openFreshSession: (_path: string, _identity: string, command: string) => calls.push(`fresh:${command}`),
    routeZaicodeSubscriptionPrompt: () => calls.push("worker"),
  }) as (event?: { shiftKey: boolean }) => void;
  return { calls, start };
}

test("Shift START sends the goal here even with a subscription selected, preserving MAIN", () => {
  const { calls, start } = harness({ engine: true });
  start({ shiftKey: true });
  assert.deepEqual(calls, ["current:/goal cc all"]);
});

test("plain START still creates fresh MAIN; a hotkey calls the same default behavior", () => {
  const fresh = harness(); fresh.start({ shiftKey: false });
  assert.deepEqual(fresh.calls, ["arm-main", "fresh:/goal cc all"]);
  const hotkey = harness(); hotkey.start();
  assert.deepEqual(hotkey.calls, fresh.calls);
});

test("Shift START respects current composer admission and plain START keeps worker routing", () => {
  const blocked = harness({ disabled: true }); blocked.start({ shiftKey: true });
  assert.deepEqual(blocked.calls, []);
  const worker = harness({ engine: true }); worker.start();
  assert.deepEqual(worker.calls, ["worker"]);
});
