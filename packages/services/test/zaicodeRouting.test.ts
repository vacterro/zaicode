import assert from "node:assert/strict";
import test from "node:test";
import { describeZaicodRouteFailure, resolveZaicodRoutePlan } from "@zcode/shared";

test("ZAICODE routing: direct route resolves a complete selection into an execution identity", () => {
  const plan = resolveZaicodRoutePlan({
    agentId: "agent-1",
    role: "implementer",
    configuredSelection: { providerId: "provider-x", modelId: "model-y" },
  });
  assert.equal(plan.failureClassification, "none");
  assert.equal(plan.fallbackReason, null);
  assert.equal(plan.executionIdentity, "direct:provider-x/model-y");
  assert.deepEqual(plan.resolvedSelection, { providerId: "provider-x", modelId: "model-y" });
  assert.equal(describeZaicodRouteFailure(plan, "Implementer"), "");
});

test("ZAICODE routing: provider/model references alone never become an execution route", () => {
  const plan = resolveZaicodRoutePlan({
    agentId: "agent-1",
    role: "researcher",
    providerRef: "provider-x",
    modelRef: "model-y",
  });
  assert.equal(plan.resolvedSelection, null);
  assert.equal(plan.failureClassification, "route-unresolved");
  assert.equal(plan.fallbackReason, "selection-missing");
  assert.equal(plan.executionIdentity, "direct:unresolved");
  assert.match(
    describeZaicodRouteFailure(plan, "Researcher"),
    /^route-unresolved: agent 'Researcher' has no model pool selected/,
  );
});

test("ZAICODE routing: router backends execute through the configured pool selection", () => {
  // SAIFREN/SAIOPP 是 SAIRoute provider 下的模型池；旧 sairoute 值不再派发失败。
  const plan = resolveZaicodRoutePlan({
    agentId: "agent-1",
    role: "implementer",
    configuredSelection: { providerId: "sairoute", modelId: "SAIFREN" },
    backend: "sairoute",
  });
  assert.equal(plan.backend, "sairoute");
  assert.deepEqual(plan.resolvedSelection, { providerId: "sairoute", modelId: "SAIFREN" });
  assert.equal(plan.failureClassification, "none");
  assert.equal(plan.executionIdentity, "sairoute:sairoute/SAIFREN");
  assert.equal(describeZaicodRouteFailure(plan, "Implementer"), "");
});

test("ZAICODE routing: a router backend without a pool selection still fails closed", () => {
  const plan = resolveZaicodRoutePlan({ agentId: "agent-1", role: "custom", backend: "saifren" });
  assert.equal(plan.resolvedSelection, null);
  assert.equal(plan.failureClassification, "route-unresolved");
  assert.equal(plan.fallbackReason, "selection-missing");
});
