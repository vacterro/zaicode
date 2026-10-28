import assert from "node:assert/strict";
import { test } from "node:test";
import { beginProviderSave, isCurrentProviderSave } from "../src/settings/model-provider-section/providerSaveGenerations.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

/** Exercise the actual component callback without mounting its unrelated connection dialogs. */
function componentSaveHarness() {
  const source = readFileSync(join(import.meta.dirname, "../src/settings/model-provider-section/InlineEditableProviderCard.tsx"), "utf8");
  const ast = ts.createSourceFile("card.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Node | undefined;
  let legacyGuard = "";
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "runSaveOperation" && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
    if (ts.isFunctionDeclaration(node) && node.name?.text === "shouldApplyProviderSaveCompletion") legacyGuard = node.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(callback, "the component's real save callback exists");
  const states = new Map<string, string>();
  const draftRevisionRef = { current: 0 };
  const js = ts.transpileModule(`${legacyGuard}\nconst runSaveOperation = ${callback.getText(ast)};\nrunSaveOperation;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const save = runInNewContext(js, {
    beginProviderSave, isCurrentProviderSave, draftRevisionRef,
    selfSaveRequestedRef: { current: false }, saveGenerationsRef: { current: new Map() },
    saveNotificationRef: { current: { providerId: "ag", providerDisplayName: "Antigravity", formatMessage: ({ id }: { id: string }) => id,
      showFeedback: ({ key, state }: { key: string; state: string }) => states.set(key, state) } },
  }) as (operation: () => Promise<void>, target: { modelId: string }) => Promise<void>;
  return { save, states, draftRevisionRef };
}

test("the card settles both concurrent model saves even when the provider draft changes in between", async () => {
  const { save, states, draftRevisionRef } = componentSaveHarness();
  let finish!: () => void;
  const pending = save(() => new Promise<void>((resolve) => { finish = resolve; }), { modelId: "low" });
  await save(async () => {}, { modelId: "high" });
  draftRevisionRef.current += 1;
  finish(); await pending;
  assert.equal(states.get("model-save:ag:low"), "success");
  assert.equal(states.get("model-save:ag:high"), "success");
});

test("the card settles a failed model save after a different model completed", async () => {
  const { save, states } = componentSaveHarness();
  let fail!: (error: Error) => void;
  const pending = save(() => new Promise<void>((_resolve, reject) => { fail = reject; }), { modelId: "low" });
  await save(async () => {}, { modelId: "high" });
  fail(new Error("network unavailable"));
  await assert.rejects(pending, /network unavailable/);
  assert.equal(states.get("model-save:ag:low"), "failure");
  assert.equal(states.get("model-save:ag:high"), "success");
});

test("different model saves settle independently, even after another draft edit", () => {
  const generations = new Map<string, number>();
  const first = beginProviderSave(generations, "model-save:ag:flash-low");
  beginProviderSave(generations, "model-save:ag:flash-high");
  beginProviderSave(generations, "provider-save:ag");
  assert.equal(isCurrentProviderSave(generations, "model-save:ag:flash-low", first), true);
});

test("out-of-order saves of the same model cannot replace the latest feedback", () => {
  const generations = new Map<string, number>();
  const older = beginProviderSave(generations, "model-save:ag:flash");
  const latest = beginProviderSave(generations, "model-save:ag:flash");
  assert.equal(isCurrentProviderSave(generations, "model-save:ag:flash", older), false);
  assert.equal(isCurrentProviderSave(generations, "model-save:ag:flash", latest), true);
});
