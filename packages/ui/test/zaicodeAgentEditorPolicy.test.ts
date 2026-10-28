import assert from "node:assert/strict";
import test from "node:test";
import { resolveZaicodRoutePlan } from "@zcode/shared";
import { buildZaicodeAgentEditorRoutingFields } from "../src/zaicode/zaicodeAgentEditorPolicy.js";
import { routePlanStatusMessageId } from "../src/zaicode/zaicodeStatus.js";
import {
  backendForPool,
  buildPoolGroups,
  findLegacyPoolOption,
  poolHintId,
} from "../src/zaicode/zaicodeRoutingModel.js";

const restrictedPolicy = {
  allowedTools: ["ReadFile", "Bash"],
  disallowedTools: ["Bash"],
};

test("unrelated editor save preserves existing allow and deny lists, defaults to yolo", () => {
  assert.deepEqual(buildZaicodeAgentEditorRoutingFields("direct", restrictedPolicy, false), {
    backend: "direct",
    toolPolicy: {
      ...restrictedPolicy,
      permissionMode: "yolo",
    },
  });
});

test("plan-mode change preserves existing allow and deny lists", () => {
  assert.deepEqual(buildZaicodeAgentEditorRoutingFields("direct", restrictedPolicy, true), {
    backend: "direct",
    toolPolicy: {
      ...restrictedPolicy,
      permissionMode: "plan",
    },
  });
});

test("selected backend is included in the editor save fields", () => {
  assert.equal(buildZaicodeAgentEditorRoutingFields("sairoute", {}, false).backend, "sairoute");
});

test("editor status: a selected pool is ready, a missing pool asks for one", () => {
  const poolPlan = resolveZaicodRoutePlan({
    agentId: "agent-1",
    role: "custom",
    backend: "sairoute",
    configuredSelection: { providerId: "sairoute", modelId: "SAIFREN" },
  });
  const missingPlan = resolveZaicodRoutePlan({
    agentId: "agent-2",
    role: "custom",
    backend: "direct",
  });

  assert.equal(routePlanStatusMessageId(poolPlan), "zaicode.route.directReady");
  assert.equal(routePlanStatusMessageId(missingPlan), "zaicode.route.directNeedsSelection");
});

// Pool model: SAIFREN / SAIOPP are models of the 9router-backed SAIRoute provider.

const providers = [
  {
    providerId: "openai-compat",
    providerName: "Other",
    enabled: true,
    models: [{ modelId: "gpt-x", selectable: true }],
  },
  {
    providerId: "custom-1",
    providerName: "SAIRoute",
    enabled: true,
    models: [
      { modelId: "SAIFREN", selectable: true },
      { modelId: "SAIOPP", selectable: true },
      { modelId: "hidden", selectable: false },
    ],
  },
  {
    providerId: "disabled",
    providerName: "Off",
    enabled: false,
    models: [{ modelId: "m", selectable: true }],
  },
];

test("pool groups list router providers first and drop disabled/unselectable entries", () => {
  const groups = buildPoolGroups(providers);
  assert.deepEqual(
    groups.map((group) => [group.providerLabel, group.isRouter]),
    [
      ["SAIRoute", true],
      ["Other", false],
    ],
  );
  assert.deepEqual(
    groups[0]!.options.map((option) => option.modelId),
    ["SAIFREN", "SAIOPP"],
  );
});

test("known pools carry their description", () => {
  assert.equal(poolHintId("SAIFREN"), "zaicode.pool.hint.saifren");
  assert.equal(poolHintId("saiopp"), "zaicode.pool.hint.saiopp");
  assert.equal(poolHintId("gpt-x"), null);
});

test("backend intent label follows the provider kind", () => {
  assert.equal(backendForPool("custom-1", "SAIRoute"), "sairoute");
  assert.equal(backendForPool("openai-compat", "Other"), "direct");
});

test("legacy saifren agents get the SAIFREN pool preselected", () => {
  const groups = buildPoolGroups(providers);
  const legacy = findLegacyPoolOption("saifren", groups);
  assert.equal(legacy?.providerId, "custom-1");
  assert.equal(legacy?.modelId, "SAIFREN");
  assert.equal(findLegacyPoolOption("direct", groups), null);
});
