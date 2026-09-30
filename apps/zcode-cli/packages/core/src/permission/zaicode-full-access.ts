import type { CollaborationMode } from "@zcode/contracts";

/**
 * ZAICODE full access (T-136 / SRC-100): "remove the approvals, ZAICODE is FULL ACCESS by default".
 *
 * New drafts already started in yolo, but a session keeps the mode it was stored with: old and
 * imported sessions, the task-index syncer and the runtime's own fallback all say `build`
 * ("Ask before changes"), and `auto` is reserved upstream and denies everything. Such a session
 * stopped on a "Permission required" card for every command. In ZAICODE the decision itself is full
 * access for every mode except plan, which the operator picks by hand.
 *
 * Kept: plan mode, questions the agent asks the user (not approvals), the self-kill guard,
 * tools the operator disallowed and project deny rules. `ZAICODE_PERMISSION_PROMPTS=on` gives
 * upstream's prompts back.
 */

export const ZAICODE_FULL_ACCESS_RULE_ID = "zaicode.fullAccess";
export const ZAICODE_FULL_ACCESS_REASON = "ZAICODE runs with full access: no approval prompts";

const TRUTHY = new Set(["1", "true", "on", "yes"]);

function truthy(value: string | undefined): boolean {
  return TRUTHY.has((value ?? "").trim().toLowerCase());
}

export function zaicodeFullAccessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!truthy(env.ZCODE_ZAICODE_MODE)) return false;
  const prompts = (env.ZAICODE_PERMISSION_PROMPTS ?? "").trim().toLowerCase();
  return !(TRUTHY.has(prompts) || prompts === "ask");
}

/** True when this decision is ZAICODE full access: product mode on, prompts not asked back, not plan. */
export function zaicodeFullAccessApplies(
  context: { mode: CollaborationMode; planEnabled?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!zaicodeFullAccessEnabled(env)) return false;
  const planEnabled = context.planEnabled ?? context.mode === "plan";
  return !planEnabled && context.mode !== "plan";
}
