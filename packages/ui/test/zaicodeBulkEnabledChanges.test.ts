import assert from "node:assert/strict";
import test from "node:test";
import { zaicodeBulkEnabledChanges } from "../src/settings/model-provider-section/zaicodeBulkEnabledChanges.js";

const model = (modelId: string, enabled?: boolean) => ({
  modelId,
  config: enabled === undefined ? {} : { enabled },
});

test("REQ-007: bulk set carries only models that actually flip", () => {
  assert.deepEqual(
    zaicodeBulkEnabledChanges(
      [model("a", true), model("b", false), model("c")],
      false,
    ),
    [
      { modelId: "a", enabled: false },
      { modelId: "c", enabled: false },
    ],
  );
  assert.deepEqual(zaicodeBulkEnabledChanges([model("a", true)], true), []);
  assert.deepEqual(zaicodeBulkEnabledChanges([], true), []);
});

test("REQ-007: enable-only-one flips the target on and everything else off", () => {
  assert.deepEqual(
    zaicodeBulkEnabledChanges([model("a", true), model("b", true), model("c", false)], true, "c"),
    [
      { modelId: "a", enabled: false },
      { modelId: "b", enabled: false },
      { modelId: "c", enabled: true },
    ],
  );
  assert.deepEqual(zaicodeBulkEnabledChanges([model("a", true)], true, "a"), []);
});
