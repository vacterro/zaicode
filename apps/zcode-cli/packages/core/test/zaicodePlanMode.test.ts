import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolvePlanModeTransitionPermission,
  zaicodeBlocksAgentPlanMode,
} from "../src/permission/plan-mode-policy.js";

const zaicode = { ZCODE_ZAICODE_MODE: "1" } as NodeJS.ProcessEnv;
const upstream = {} as NodeJS.ProcessEnv;

test("ZAICODE mode denies a model's own EnterPlanMode (SRC-038: subSaipen delivers, no plan)", () => {
  const result = resolvePlanModeTransitionPermission({ toolName: "EnterPlanMode", mode: "yolo" }, zaicode);
  assert.equal(result?.behavior, "deny");
  assert.equal(result?.ruleId, "zaicode.plan.agentEnter");
});

test("upstream mode keeps EnterPlanMode allowed without a prompt", () => {
  const result = resolvePlanModeTransitionPermission({ toolName: "EnterPlanMode", mode: "yolo" }, upstream);
  assert.equal(result?.behavior, "allow");
});

test("ZAICODE_AGENT_PLAN_MODE=allow gives the tool back", () => {
  const env = { ...zaicode, ZAICODE_AGENT_PLAN_MODE: "allow" } as NodeJS.ProcessEnv;
  assert.equal(zaicodeBlocksAgentPlanMode(env), false);
  assert.equal(resolvePlanModeTransitionPermission({ toolName: "EnterPlanMode", mode: "build" }, env)?.behavior, "allow");
});

test("ExitPlanMode in a plan the operator chose still works in ZAICODE", () => {
  assert.equal(
    resolvePlanModeTransitionPermission({ toolName: "ExitPlanMode", mode: "plan" }, zaicode),
    undefined,
  );
});
