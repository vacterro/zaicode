import { z } from "zod";
import { zaicodeAgentRoleSchema, type ZaicodeAgentDefinition, type ZaicodeAgentRole } from "./zaicode-agents.js";
import type { ZaicodeJob } from "./zaicode-jobs.js";

/**
 * Agent-initiated delegation (T-10), within the operator's scope decision
 * (SRC-033): only a running top-level coordinator job may hand work to a
 * helper; depth is exactly 1 (a child never delegates); a fixed budget of
 * children per parent; only the allowed helper roles; every child carries
 * its parent link; results come back through the queue (and the child's own
 * SAIMAIL telegram). No child takes over the protocol: it runs as a queued
 * job like any other, it does not claim the parent's Work.
 *
 * This module is the policy, pure: the job service applies it before it
 * creates a child, the host only carries requests to the service.
 */

export interface ZaicodeDelegationPolicy {
  /** Roles whose jobs may delegate. */
  parentRoles: readonly ZaicodeAgentRole[];
  /** Roles a child may have. Never "coordinator": a coordinator child could not delegate anyway. */
  childRoles: readonly ZaicodeAgentRole[];
  /** Children one parent run may create in total. */
  maxChildrenPerParent: number;
}

export const ZAICODE_DELEGATION_DEFAULT_POLICY: ZaicodeDelegationPolicy = {
  parentRoles: ["coordinator"],
  childRoles: ["implementer", "auditor", "researcher", "hunter", "tester", "cleaner", "wikier", "translator"],
  maxChildrenPerParent: 3,
};

export const ZAICODE_DELEGATION_MAX_CHILDREN_LIMIT = 8;

/** What an agent writes to ask for a helper. Either a specific agent or a role. */
export const zaicodeDelegationRequestSchema = z
  .object({
    agentId: z.string().trim().min(1).max(200).optional(),
    role: zaicodeAgentRoleSchema.optional(),
    title: z.string().trim().min(1).max(200),
    instructions: z.string().trim().min(1).max(20_000),
  })
  .strict()
  .refine((request) => Boolean(request.agentId || request.role), { message: "agentId or role is required" });

export type ZaicodeDelegationRequest = z.infer<typeof zaicodeDelegationRequestSchema>;

export type ZaicodeDelegationRefusal =
  | "parent_not_found"
  | "parent_not_running"
  | "stale_run"
  | "parent_is_child"
  | "parent_role_not_allowed"
  | "budget_exhausted"
  | "agent_not_found"
  | "agent_disabled"
  | "child_role_not_allowed"
  | "invalid_request";

export type ZaicodeDelegationDecision =
  | { ok: true; agent: ZaicodeAgentDefinition }
  | { ok: false; reason: ZaicodeDelegationRefusal; detail: string };

export function normalizeZaicodeDelegationPolicy(raw: unknown): ZaicodeDelegationPolicy {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ZaicodeDelegationPolicy, unknown>>;
  const roles = (list: unknown, fallback: readonly ZaicodeAgentRole[]) => {
    if (!Array.isArray(list)) return fallback;
    const parsed = list.flatMap((item) => {
      const role = zaicodeAgentRoleSchema.safeParse(item);
      return role.success ? [role.data] : [];
    });
    return [...new Set(parsed)];
  };
  const d = ZAICODE_DELEGATION_DEFAULT_POLICY;
  const max = typeof value.maxChildrenPerParent === "number" && Number.isFinite(value.maxChildrenPerParent)
    ? Math.min(ZAICODE_DELEGATION_MAX_CHILDREN_LIMIT, Math.max(0, Math.round(value.maxChildrenPerParent)))
    : d.maxChildrenPerParent;
  return {
    parentRoles: roles(value.parentRoles, d.parentRoles),
    childRoles: roles(value.childRoles, d.childRoles).filter((role) => role !== "coordinator"),
    maxChildrenPerParent: max,
  };
}

/**
 * The decision for one request. `runId` is the parent run the request came
 * from: a request left over from an earlier run of the same job is stale.
 */
export function evaluateZaicodeDelegation(input: {
  parent: ZaicodeJob | null;
  parentAgent: ZaicodeAgentDefinition | null;
  runId: string;
  request: ZaicodeDelegationRequest;
  agents: readonly ZaicodeAgentDefinition[];
  childrenOfParent: number;
  policy: ZaicodeDelegationPolicy;
}): ZaicodeDelegationDecision {
  const { parent, parentAgent, request, policy } = input;
  if (!parent) return { ok: false, reason: "parent_not_found", detail: "the delegating job is not in the queue" };
  if (parent.parentJobId) {
    return { ok: false, reason: "parent_is_child", detail: "a child job cannot delegate (depth is exactly 1)" };
  }
  if (parent.status !== "running") {
    return { ok: false, reason: "parent_not_running", detail: `the delegating job is ${parent.status}` };
  }
  if (parent.runId !== input.runId) {
    return { ok: false, reason: "stale_run", detail: "the request belongs to an earlier run of this job" };
  }
  if (!parentAgent || !policy.parentRoles.includes(parentAgent.role)) {
    return {
      ok: false,
      reason: "parent_role_not_allowed",
      detail: `only ${policy.parentRoles.join(", ") || "no role"} jobs may delegate`,
    };
  }
  if (input.childrenOfParent >= policy.maxChildrenPerParent) {
    return {
      ok: false,
      reason: "budget_exhausted",
      detail: `this run already created ${input.childrenOfParent} of ${policy.maxChildrenPerParent} allowed helpers`,
    };
  }
  const agent = request.agentId
    ? (input.agents.find((candidate) => candidate.id === request.agentId) ?? null)
    : (input.agents.find((candidate) => candidate.role === request.role && candidate.enabled) ??
      input.agents.find((candidate) => candidate.role === request.role) ??
      null);
  if (!agent) {
    return {
      ok: false,
      reason: "agent_not_found",
      detail: request.agentId ? `no agent ${request.agentId}` : `no ${request.role} agent (create one on the ZAICODE page)`,
    };
  }
  if (!agent.enabled) return { ok: false, reason: "agent_disabled", detail: `${agent.name} is disabled` };
  if (!policy.childRoles.includes(agent.role) || agent.role === "coordinator") {
    return {
      ok: false,
      reason: "child_role_not_allowed",
      detail: `${agent.role} is not an allowed helper role (${policy.childRoles.join(", ")})`,
    };
  }
  return { ok: true, agent };
}

/**
 * The paragraph a delegating job's prompt carries: how to ask for a helper
 * and where the answer appears. The channel is a folder only this run knows.
 */
export function zaicodeDelegationInstructions(input: {
  spoolDir: string;
  policy: ZaicodeDelegationPolicy;
}): string {
  return [
    "## Delegation (ZAICODE)",
    `You may hand parts of this task to helper agents, at most ${input.policy.maxChildrenPerParent} for this run.`,
    `Allowed helper roles: ${input.policy.childRoles.join(", ")}. Helpers cannot delegate further.`,
    `To ask for one, write a JSON file (name ending in .json) into ${input.spoolDir}`,
    'with {"role": "tester", "title": "short title", "instructions": "what to do and what to report"}',
    '(or "agentId" instead of "role" for a specific agent).',
    "ZAICODE answers next to it in <name>.result.json: the helper's job id, or why it was refused.",
    "When a helper finishes, <childJobId>.done.json appears in the same folder with its outcome.",
    "Helpers start when a queue slot is free, which may be only after this run ends: do not wait",
    "for them; finish your own part and say in your report which helpers you asked for.",
    "Helpers run as ordinary queued jobs in this project; they do not take over your SAIPEN Work.",
  ].join("\n");
}

/** The paragraph a helper's prompt carries: who asked, and how to report back. */
export function zaicodeChildInstructions(input: { parentJobId: string; parentTitle: string }): string {
  return [
    "## You are a helper (ZAICODE delegation)",
    `The job ${input.parentJobId} ("${input.parentTitle}") asked for this. You cannot delegate further.`,
    "Do only what is asked here; do not claim or close the parent's SAIPEN Work.",
    "End with a short report of what you did and what you found. If SAIMAIL is set up",
    "(SAIMAIL_WORKSPACE), also send that report as a telegram to the Work owner.",
  ].join("\n");
}
