import {
  evaluateZaicodeDelegation,
  normalizeZaicodeDelegationPolicy,
  zaicodeDelegationRequestSchema,
  type ZaicodeAgentDefinition,
  type ZaicodeDelegationPolicy,
  type ZaicodeDelegationRefusal,
  type ZaicodeJob,
  type ZaicodeJobCreateInput,
} from "@zcode/shared";
import type { ZaicodeJobRepo } from "./zaicodeJobRepo.js";

/**
 * 运行时委托（T-10）：正在运行的顶层 coordinator 任务请求一个 helper。
 * 策略（深度 1、预算、角色、当前运行）在 @zcode/shared 的纯函数里裁决；
 * 这里只取事实（父任务行、父 agent、全部 agent、已有子任务数）并在通过后
 * 经队列服务的唯一写路径创建子任务、pump。runId 即令牌：旧运行的请求一律拒绝。
 */

/** Agent-initiated delegation policy, JSON of ZaicodeDelegationPolicy in zaicode_settings. */
const DELEGATION_POLICY_SETTING_KEY = "delegation_policy";

export type ZaicodeDelegationResult =
  | { ok: true; child: ZaicodeJob }
  | { ok: false; reason: ZaicodeDelegationRefusal; detail: string };

type SettingsRepo = Pick<ZaicodeJobRepo, "getSetting" | "setSetting">;

export function readZaicodeDelegationPolicy(repo: SettingsRepo): ZaicodeDelegationPolicy {
  const raw = repo.getSetting(DELEGATION_POLICY_SETTING_KEY);
  try {
    return normalizeZaicodeDelegationPolicy(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeZaicodeDelegationPolicy(null);
  }
}

export function writeZaicodeDelegationPolicy(
  repo: SettingsRepo,
  policy: ZaicodeDelegationPolicy,
  now: number,
): ZaicodeDelegationPolicy {
  const normalized = normalizeZaicodeDelegationPolicy(policy);
  repo.setSetting(DELEGATION_POLICY_SETTING_KEY, JSON.stringify(normalized), now);
  return normalized;
}

export async function delegateZaicodeJobFromRun(
  deps: {
    repo: Pick<ZaicodeJobRepo, "get" | "listChildren" | "getSetting" | "setSetting">;
    getAgent: (agentId: string) => Promise<ZaicodeAgentDefinition | null>;
    listAgents?: () => Promise<ZaicodeAgentDefinition[]>;
    create: (input: ZaicodeJobCreateInput) => Promise<ZaicodeJob>;
    pump: (workspaceKey: string) => Promise<void>;
    now: () => number;
  },
  input: { parentJobId: string; runId: string; request: unknown },
): Promise<ZaicodeDelegationResult> {
  const parsed = zaicodeDelegationRequestSchema.safeParse(input.request);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_request",
      detail: parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "),
    };
  }
  const parent = await deps.repo.get(input.parentJobId);
  const parentAgent = parent ? await deps.getAgent(parent.agentId) : null;
  const agents = (await deps.listAgents?.()) ?? [];
  // 预算按父任务行计：重试会产生新任务行（retryOfJobId），恢复同一行不重置预算。
  const children = parent ? await deps.repo.listChildren(parent.id) : [];
  const decision = evaluateZaicodeDelegation({
    parent,
    parentAgent,
    runId: input.runId,
    request: parsed.data,
    agents,
    childrenOfParent: children.length,
    policy: readZaicodeDelegationPolicy(deps.repo),
  });
  if (!decision.ok) return decision;
  const owner = parent!;
  const child = await deps.create({
    workspaceKey: owner.workspaceKey,
    workspacePath: owner.workspacePath,
    workspaceIdentity: owner.workspaceIdentity,
    agentId: decision.agent.id,
    title: parsed.data.title,
    instructions: parsed.data.instructions,
    priority: owner.priority,
    status: "queued",
    parentJobId: owner.id,
  });
  await deps.pump(owner.workspaceKey);
  return { ok: true, child: (await deps.repo.get(child.id)) ?? child };
}
