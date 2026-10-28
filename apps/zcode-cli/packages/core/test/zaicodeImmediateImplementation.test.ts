import assert from "node:assert/strict";
import test from "node:test";
import { PermissionService } from "../src/permission/service.js";
import { createEnterPlanModeProviderDescription } from "../src/tool/handlers/plan-mode-prompts.js";

function withProduct(env: Record<string, string | undefined>, run: () => void) {
  const keys = ["ZCODE_ZAICODE_MODE", "ZAICODE_AGENT_PLAN_MODE", "ZAICODE_PERMISSION_PROMPTS"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
    run();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
}

test("ZAICODE planning guidance says implement directly and spends no proactive-plan boilerplate", () => {
  withProduct({ ZCODE_ZAICODE_MODE: "1" }, () => {
    const description = createEnterPlanModeProviderDescription();
    assert.match(description, /implement.*directly/i);
    assert.doesNotMatch(description, /proactively|Prefer using EnterPlanMode/);
    assert.ok(description.length < 600);
  });
});

test("actual permission owner allows edits while denying unsolicited planning before full access", () => {
  withProduct({ ZCODE_ZAICODE_MODE: "1" }, () => {
    const permissions = new PermissionService();
    assert.equal(permissions.checkPermission({ toolName: "Edit", input: { file_path: "fixture.ts" }, riskLevel: "low", mode: "yolo", planEnabled: false }).allowed, true);
    const plan = permissions.checkPermission({ toolName: "EnterPlanMode", input: {}, riskLevel: "low", mode: "yolo", planEnabled: false });
    assert.equal(plan.allowed, false);
    assert.equal(plan.ruleId, "zaicode.plan.agentEnter");
  });
});

test("upstream and an explicit configured planning override retain proactive planning", () => {
  for (const env of [{}, { ZCODE_ZAICODE_MODE: "1", ZAICODE_AGENT_PLAN_MODE: "allow" }]) {
    withProduct(env, () => assert.match(createEnterPlanModeProviderDescription(), /proactively/));
  }
});
