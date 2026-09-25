import assert from "node:assert/strict";
import test from "node:test";
import { resolveInitialModelSelection } from "../src/model-selection-config.js";
import type { ProviderRegistryView } from "../src/registry.js";

function model(modelId: string) {
  return {
    modelId,
    config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
  };
}

// Minimal registry with real ids: GLM account plan first (as in the real registry order), SAIRoute second.
const registry = {
  revision: 1,
  providers: [
    { providerId: "account:zai-individual-coding-plan", config: {}, models: [model("GLM-5.3")] },
    { providerId: "new-provider", config: {}, models: [model("SAIFREN")] },
  ],
} as unknown as ProviderRegistryView;

function withMode<T>(enabled: boolean, run: () => T): T {
  const previous = process.env.ZCODE_ZAICODE_MODE;
  process.env.ZCODE_ZAICODE_MODE = enabled ? "1" : "0";
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.ZCODE_ZAICODE_MODE;
    else process.env.ZCODE_ZAICODE_MODE = previous;
  }
}

test("ZAICODE: new drafts default to the operator provider, not GLM", () => {
  const result = withMode(true, () => resolveInitialModelSelection({ registry }));
  assert.equal(result.source, "registry-fallback");
  assert.equal(result.source !== "none" && result.selection.providerId, "new-provider");
});

test("ZAICODE: a configured GLM default yields to the operator provider", () => {
  const result = withMode(true, () =>
    resolveInitialModelSelection({
      registry,
      configuredDefault: {
        providerId: "account:zai-individual-coding-plan",
        modelId: "GLM-5.3",
        options: { reasoningLevel: "high" },
      },
    }),
  );
  assert.equal(result.source !== "none" && result.selection.providerId, "new-provider");
});

test("ZAICODE: GLM stays the fallback when it is the only provider", () => {
  const onlyGlm = { revision: 1, providers: [registry.providers[0]!] } as ProviderRegistryView;
  const result = withMode(true, () => resolveInitialModelSelection({ registry: onlyGlm }));
  assert.equal(
    result.source !== "none" && result.selection.providerId,
    "account:zai-individual-coding-plan",
  );
});

test("upstream mode keeps registry order", () => {
  const result = withMode(false, () => resolveInitialModelSelection({ registry }));
  assert.equal(
    result.source !== "none" && result.selection.providerId,
    "account:zai-individual-coding-plan",
  );
});
