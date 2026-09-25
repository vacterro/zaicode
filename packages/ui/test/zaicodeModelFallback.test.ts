import assert from "node:assert/strict";
import test from "node:test";
import {
  isOfficialGlmProvider,
  pickZaicodeFallbackModel,
} from "../src/zaicode/zaicodeModelFallback.js";

const providers = [
  { providerId: "account:zai-individual-coding-plan", models: [{ modelId: "GLM-5.3" }] },
  { providerId: "new-provider", models: [{ modelId: "SAIFREN" }, { modelId: "SAIOPP" }] },
];

test("GLM account providers (and legacy builtin ids) are recognised", () => {
  assert.equal(isOfficialGlmProvider("account:zai-start-plan"), true);
  assert.equal(isOfficialGlmProvider("account:bigmodel-offpeak-idle-plan"), true);
  assert.equal(isOfficialGlmProvider("builtin:zai"), true);
  assert.equal(isOfficialGlmProvider("new-provider"), false);
  assert.equal(isOfficialGlmProvider(null), false);
});

test("fallback skips GLM and prefers a non-GLM preferred selection", () => {
  assert.deepEqual(pickZaicodeFallbackModel({ providers }), {
    providerId: "new-provider",
    modelId: "SAIFREN",
  });
  assert.deepEqual(
    pickZaicodeFallbackModel({
      providers,
      preferredSelection: { providerId: "new-provider", modelId: "SAIOPP" },
    }),
    { providerId: "new-provider", modelId: "SAIOPP" },
  );
  assert.deepEqual(
    pickZaicodeFallbackModel({
      providers,
      preferredSelection: { providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3" },
    }),
    { providerId: "new-provider", modelId: "SAIFREN" },
  );
});

test("no fallback when only GLM is configured", () => {
  assert.equal(pickZaicodeFallbackModel({ providers: [providers[0]!] }), null);
  assert.equal(pickZaicodeFallbackModel(null), null);
});
