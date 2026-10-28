import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelConfig, clearManualModelConfig } from "@zcode/provider";
import { modelConfigDataSchema } from "@zcode/shared/model-config";
import { createProviderModelDraftValues, resolveProviderModelDraftCommit } from "../src/settings/model-provider-section/ProviderModelMetadata.js";
import type { ProviderSettingsFormModel } from "../src/lib/providerSettingsFormTypes.js";
import { planZaicodeSubscriptionSync, zaicodeSubscriptionBaseUrl } from "@zcode/shared";

const config = {
  enabled: true,
  properties: { requiresMfjsToolSchema: false, contextWindow: 200000, inputFormat: { supportsText: true, supportsImage: true, supportsAudio: false, supportsVideo: false, supportsPdf: true }, outputFormat: { supportsText: true }, supportsToolCall: true, supportsJsonSchemaOutput: true, supportsNativeWebSearch: false, supportsMidConversationSystem: true },
  optionSpecs: { reasoningLevel: { values: ["low", "medium", "high"], map: '{"reasoning_effort": reasoningLevel}' }, maxOutputTokens: { max: 32000, map: '{"max_tokens": maxOutputTokens}' } },
};
const model: ProviderSettingsFormModel = { kind: "candidate", modelId: "transport-model", builtin: false, personalConfig: {}, inheritedConfig: config, config, hasPersonalConfig: false, executable: true, selectable: true };

test("display name survives draft save, JSON reload, enable toggle and recommended-config restore without changing the request ID", () => {
  const result = resolveProviderModelDraftCommit({ currentModel: model, draft: { ...createProviderModelDraftValues(model), displayNameValue: "My preferred model" } });
  assert.equal(result.status, "commit");
  if (result.status !== "commit") return;
  assert.equal(result.model.modelId, "transport-model");
  const reloaded = ModelConfig.fromData(modelConfigDataSchema.parse(JSON.parse(JSON.stringify(result.model.personalConfig))));
  assert.equal(reloaded.displayName, "My preferred model");
  assert.equal(reloaded.overlay(new ModelConfig({ enabled: false })).toJSON().displayName, "My preferred model");
  assert.equal(clearManualModelConfig(reloaded.toJSON()).displayName, "My preferred model");
  const cleared = resolveProviderModelDraftCommit({ currentModel: result.model, draft: { ...createProviderModelDraftValues(result.model), displayNameValue: "" } });
  assert.equal(cleared.status, "commit");
  if (cleared.status === "commit") assert.equal(cleared.model.personalConfig.displayName, null);
});

test("subscription refresh updates proxy credentials while preserving the user provider name", () => {
  const plan = planZaicodeSubscriptionSync({
    accounts: [{ connectionId: "a", provider: "codex", label: "Codex 1", identity: "home", active: true }],
    models: [], proxyUrl: "http://127.0.0.1:2222", apiKey: "new",
    existing: [{ providerId: "p", providerName: "My work account", baseUrl: zaicodeSubscriptionBaseUrl("http://127.0.0.1:1111", "a"), apiKey: "old", modelIds: ["transport-model"] }],
  });
  assert.equal(plan.update[0]?.overlay?.providerName, "My work account");
  assert.deepEqual(plan.update[0]?.remove, []);
});
