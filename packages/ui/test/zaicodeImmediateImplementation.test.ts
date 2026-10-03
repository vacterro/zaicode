import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelectionView } from "@zcode/services";
import type { V4ComposerDraft } from "../src/v4/composer/composerDraftStore.js";

const storage = new Map<string, string>();
const local = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
};
Object.defineProperty(globalThis, "localStorage", { value: local, configurable: true });
Object.defineProperty(globalThis, "window", {
  value: Object.assign(new EventTarget(), { localStorage: local }),
  configurable: true,
});
Object.defineProperty(globalThis, "__ZAICODE_PRODUCT_MODE__", { value: true, writable: true });
const product = (enabled: boolean) =>
  Object.defineProperty(globalThis, "__ZAICODE_PRODUCT_MODE__", { value: enabled });
const { persistV4ComposerDraft, readV4ComposerDraft } =
  await import("../src/v4/composer/composerDraftStore.js");
const { applyComposerPlanTransition } =
  await import("../src/v4/composer/composerPlanTransition.js");
const { createComposerSubmissionConfig } =
  await import("../src/v4/composer/composerSubmissionConfig.js");
const selection = {
  providerId: "fixture",
  modelId: "fixture-model",
  options: { reasoningLevel: "medium" },
};
const view = {
  providers: [
    {
      providerId: "fixture",
      models: [
        {
          modelId: "fixture-model",
          config: { optionSpecs: { reasoningLevel: { values: ["medium"] } } },
        },
      ],
    },
  ],
} as unknown as ModelSelectionView;

test("legacy Plan draft resumes as implementation and freezes Plan off without losing content/model", () => {
  product(true);
  persistV4ComposerDraft("fixture", undefined, "legacy", {
    text: "Implement the requested change",
    mode: "plan",
    planEnabled: true,
    modelSelection: selection,
  });
  const draft = readV4ComposerDraft("fixture", undefined, "legacy")!;
  assert.equal(draft.planEnabled, false);
  assert.equal(draft.text, "Implement the requested change");
  assert.deepEqual(draft.modelSelection, selection);
  const submission = createComposerSubmissionConfig(draft, view)!;
  assert.ok(submission);
  assert.equal(submission.planEnabled, false);
  assert.ok(Object.isFrozen(submission));
});

test("a deliberately selected Plan remains explicit after saving and submits true", () => {
  product(true);
  persistV4ComposerDraft("fixture", undefined, "explicit", {
    text: "Design this first",
    mode: "yolo",
    planEnabled: true,
    planChoice: "explicit",
    modelSelection: selection,
  } as Omit<V4ComposerDraft, "updatedAt">);
  const draft = readV4ComposerDraft("fixture", undefined, "explicit")!;
  assert.equal(draft.planEnabled, true);
  assert.equal(createComposerSubmissionConfig(draft, view)?.planEnabled, true);
});

test("replayed automatic plan entry cannot enable Plan in the default draft", () => {
  product(true);
  const transition = { toolCallId: "old-plan", planEnabled: true } as Parameters<
    typeof applyComposerPlanTransition
  >[1];
  const draft = applyComposerPlanTransition(
    { text: "Continue", mode: "yolo", planEnabled: false, updatedAt: 0 },
    transition,
  );
  assert.equal(draft.planEnabled, false);
  assert.equal(draft.lastPlanTransitionId, "old-plan");
  assert.equal(applyComposerPlanTransition(draft, transition), draft);
});

test("explicit planning exits normally and a repeated exit stays idempotent", () => {
  product(true);
  const initial = {
    text: "",
    mode: "yolo",
    planEnabled: true,
    planChoice: "explicit",
    updatedAt: 0,
  } as V4ComposerDraft;
  const exit = { toolCallId: "exit-plan", planEnabled: false } as Parameters<
    typeof applyComposerPlanTransition
  >[1];
  const draft = applyComposerPlanTransition(initial, exit);
  assert.equal(draft.planEnabled, false);
  assert.equal(applyComposerPlanTransition(draft, exit), draft);
});

test("upstream Plan draft and transitions keep their own behavior", () => {
  product(false);
  try {
    persistV4ComposerDraft("fixture", undefined, "upstream", { text: "Plan", mode: "plan" });
    assert.equal(readV4ComposerDraft("fixture", undefined, "upstream")?.planEnabled, true);
    assert.equal(
      applyComposerPlanTransition({ text: "", updatedAt: 0 }, {
        toolCallId: "plan",
        planEnabled: true,
      } as Parameters<typeof applyComposerPlanTransition>[1]).planEnabled,
      true,
    );
  } finally {
    product(true);
  }
});
