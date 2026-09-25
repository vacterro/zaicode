import {
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  type CollaborationMode,
} from "@zcode/contracts";

interface PlanModeTransitionContext {
  toolName: string;
  mode: CollaborationMode;
  planEnabled?: boolean;
  prePlanMode?: Exclude<CollaborationMode, "plan">;
}

interface PlanModeTransitionPermission {
  behavior: "allow" | "deny";
  reason: string;
  ruleId: string;
}

/**
 * ZAICODE (SRC-038): SAIPEN already plans every piece of work, so a model never
 * switches itself into plan mode there -- a subSaipen that stops to ask for plan
 * approval delivers nothing. The operator still picks plan mode by hand in the
 * composer; `ZAICODE_AGENT_PLAN_MODE=allow` gives the tool back.
 */
export function zaicodeBlocksAgentPlanMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = (env.ZCODE_ZAICODE_MODE ?? "").trim().toLowerCase();
  if (!["1", "true", "on", "yes"].includes(mode)) return false;
  return (env.ZAICODE_AGENT_PLAN_MODE ?? "").trim().toLowerCase() !== "allow";
}

export function resolvePlanModeTransitionPermission(
  context: PlanModeTransitionContext,
  env: NodeJS.ProcessEnv = process.env,
): PlanModeTransitionPermission | undefined {
  if (context.toolName === ENTER_PLAN_MODE_TOOL_NAME && zaicodeBlocksAgentPlanMode(env)) {
    return {
      behavior: "deny",
      reason:
        "ZAICODE: agents do not switch themselves into plan mode here -- SAIPEN already plans the work. Do not write a plan for approval; carry out the task now and deliver the result.",
      ruleId: "zaicode.plan.agentEnter",
    };
  }
  if (context.toolName === ENTER_PLAN_MODE_TOOL_NAME) {
    return {
      behavior: "allow",
      reason: "EnterPlanMode switches to plan mode without a permission prompt",
      ruleId: "tool.plan.enter",
    };
  }

  if (
    context.toolName === EXIT_PLAN_MODE_TOOL_NAME &&
    !(context.planEnabled ?? context.mode === "plan")
  ) {
    return {
      behavior: "deny",
      reason: "ExitPlanMode can only be used while plan mode is active",
      ruleId: "mode.plan.exitOnly",
    };
  }

  return undefined;
}
