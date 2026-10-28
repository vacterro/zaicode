import assert from "node:assert/strict";
import test from "node:test";
import { completeNewModelSelection, normalizeModelSelection } from "../src/model-selection-config.js";
import { resolveEffectiveModelSelection } from "../src/effective-model-selection.js";
import type { ProviderRegistryView } from "../src/registry.js";

process.env.ZCODE_ZAICODE_MODE = "1";

const registry = {
  revision: 1,
  providers: [
    {
      providerId: "binary-provider",
      config: {},
      models: [
        { modelId: "binary", config: { optionSpecs: { reasoningLevel: { values: ["on", "off"] } } } },
        { modelId: "graded", config: { optionSpecs: { reasoningLevel: { values: ["low", "medium", "high"] } } } },
      ],
    },
  ],
} as unknown as ProviderRegistryView;

test("binary Thought defaults to on even when the provider puts off last", () => {
  assert.equal(
    completeNewModelSelection(registry, { providerId: "binary-provider", modelId: "binary" })?.options?.reasoningLevel,
    "on",
  );
});

test("saved binary off is interpreted as on for the next request", () => {
  const saved = { providerId: "binary-provider", modelId: "binary", options: { reasoningLevel: "off" } };
  assert.equal(normalizeModelSelection(registry, saved)?.options?.reasoningLevel, "on");
  const effective = resolveEffectiveModelSelection({
    registry,
    selection: saved,
    classifyProvider: () => "ordinary",
  });
  assert.equal(effective.selectionIssue, undefined);
  assert.equal(effective.effectiveSelection?.options?.reasoningLevel, "on");
  assert.equal(saved.options.reasoningLevel, "off", "saved history is not rewritten");
});

test("graded reasoning choices retain their selected level", () => {
  const selection = { providerId: "binary-provider", modelId: "graded", options: { reasoningLevel: "low" } };
  assert.equal(normalizeModelSelection(registry, selection)?.options?.reasoningLevel, "low");
  assert.equal(
    resolveEffectiveModelSelection({ registry, selection, classifyProvider: () => "ordinary" }).effectiveSelection?.options?.reasoningLevel,
    "low",
  );
});

test("ordinary ZCode mode retains the provider's binary choice", () => {
  process.env.ZCODE_ZAICODE_MODE = "0";
  try {
    const selection = { providerId: "binary-provider", modelId: "binary", options: { reasoningLevel: "off" } };
    assert.equal(normalizeModelSelection(registry, selection)?.options?.reasoningLevel, "off");
  } finally {
    process.env.ZCODE_ZAICODE_MODE = "1";
  }
});
