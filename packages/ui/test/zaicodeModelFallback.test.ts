import assert from "node:assert/strict";
import test from "node:test";
import {
  isOfficialGlmProvider,
  pickZaicodeFallbackModel,
  pickZaicodeRouterComboFailover,
} from "../src/zaicode/zaicodeModelFallback.js";
import {
  recordRouteFailure,
  resetAllRouteHealth,
} from "@zcode/shared";
import { routeComposerSelection } from "../src/zaicode/zaicodeQuotaRoute.js";

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

test("fallback skips GLM and prefers SAIFREN over a different preferred model", () => {
  assert.deepEqual(pickZaicodeFallbackModel({ providers }), {
    providerId: "new-provider",
    modelId: "SAIFREN",
  });
  assert.deepEqual(
    pickZaicodeFallbackModel({
      providers,
      preferredSelection: { providerId: "new-provider", modelId: "SAIOPP" },
    }),
    { providerId: "new-provider", modelId: "SAIFREN" },
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

test("pickZaicodeRouterComboFailover advances past failing combo model to next eligible model", () => {
  resetAllRouteHealth();
  const now = 12345678;
  const comboModels = ["model-1", "model-2", "model-3"];

  // model-1 fails with gateway_timeout
  recordRouteFailure({ comboId: "SAIFREN", modelId: "model-1" }, { providerCode: "gateway_timeout" }, now);

  const failover = pickZaicodeRouterComboFailover({
    comboId: "SAIFREN",
    comboModels,
    currentModelId: "model-1",
    now,
  });

  assert.equal(failover.modelId, "model-2");
  assert.equal(failover.allInCooldown, false);
});

test("routeComposerSelection immediately advances to fallback when requested route is in cooldown", () => {
  resetAllRouteHealth();
  const now = 20000000;
  const view = {
    providers: [
      { providerId: "primary-provider", models: [{ modelId: "primary-model" }] },
      { providerId: "new-provider", models: [{ modelId: "SAIFREN" }] },
    ],
  };

  // Primary model is in cooldown due to gateway timeout
  recordRouteFailure({ comboId: "primary-provider", modelId: "primary-model" }, { providerCode: "gateway_timeout" }, now);

  const routed = routeComposerSelection(
    { providerId: "primary-provider", modelId: "primary-model" },
    view as any,
    now,
  );

  assert.equal(routed.fallback, true);
  assert.equal(routed.selection.providerId, "new-provider");
  assert.equal(routed.selection.modelId, "SAIFREN");
  assert.ok(routed.holdUntil);
});

test("routeComposerSelection falls back via pickZaicodeFallbackModel and never mistakes sibling combo for internal candidate", () => {
  resetAllRouteHealth();
  const now = 30000000;
  const view = {
    providers: [
      {
        providerId: "new-provider",
        models: [{ modelId: "SAIFREN" }, { modelId: "GLM-5.3" }],
      },
      {
        providerId: "backup-provider",
        models: [{ modelId: "BACKUP-MODEL" }],
      },
    ],
  };

  // SAIFREN is in cooldown
  recordRouteFailure({ comboId: "new-provider", modelId: "SAIFREN" }, { providerCode: "gateway_timeout" }, now);

  const routed = routeComposerSelection(
    { providerId: "new-provider", modelId: "SAIFREN" },
    view as any,
    now,
  );

  assert.equal(routed.fallback, true);
  // Must NOT select sibling combo GLM-5.3 on same provider
  assert.equal(routed.selection.providerId, "backup-provider");
  assert.equal(routed.selection.modelId, "BACKUP-MODEL");
  assert.ok(routed.holdUntil);
});


