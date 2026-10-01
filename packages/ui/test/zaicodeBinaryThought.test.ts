import assert from "node:assert/strict";
import test from "node:test";
import { resolveModelThoughtOption } from "../src/lib/modelThoughtOption.js";

process.env.ZCODE_ZAICODE_MODE = "1";

const view = (values: string[] | null) => ({
  providers: [{
    providerId: "p",
    models: [{ modelId: "m", config: { optionSpecs: { reasoningLevel: values ? { values } : null } } }],
  }],
}) as never;

test("a binary off/on model has no Thought switch", () => {
  assert.equal(resolveModelThoughtOption({ modelSelectionView: view(["off", "on"]), providerId: "p", modelId: "m" }), null);
  assert.equal(resolveModelThoughtOption({ modelSelectionView: view(["on", "off"]), providerId: "p", modelId: "m" }), null);
});

test("explicit graded levels remain selectable and unsupported models show no switch", () => {
  const option = resolveModelThoughtOption({ modelSelectionView: view(["low", "medium", "high"]), providerId: "p", modelId: "m" });
  assert.deepEqual(option?.options?.map((entry) => entry.value), ["low", "medium", "high"]);
  assert.equal(resolveModelThoughtOption({ modelSelectionView: view(null), providerId: "p", modelId: "m" }), null);
});
