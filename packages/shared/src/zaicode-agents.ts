import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";
import { ZAICODE_ROUTE_BACKENDS, type ZaicodeRouteBackend } from "./zaicode-routing.js";

/**
 * ZAICODE agent 定义（handoff M5）契约。
 *
 * 定义只保存对 Provider/模型的引用（标识），绝不保存凭据或 Provider 配置副本；
 * 持久化读取必须经 zaicodeAgentDefinitionSchema 校验，损坏定义不得静默放行。
 * 命名与上游 agent/subagent 架构保持兼容：本层是操作员可见的产品定义，
 * 执行时仍经上游 task/session 运行时，不引入第二套会话状态机。
 */

export const ZAICODE_AGENT_ROLES = [
  "coordinator",
  "implementer",
  "auditor",
  "researcher",
  "hunter",
  "tester",
  "cleaner",
  "wikier",
  "translator",
  "custom",
] as const;

export type ZaicodeAgentRole = (typeof ZAICODE_AGENT_ROLES)[number];

export const zaicodeAgentRoleSchema = z.enum(ZAICODE_AGENT_ROLES);

export const ZAICODE_AGENT_ID_PREFIX = "zaicode-agent:";

/** 稳定 id：创建时生成一次，重命名不改变；id 是队列与执行记录的唯一引用。 */
export function createZaicodeAgentId(): string {
  // 用平台自带 crypto，不引入 node:crypto 依赖，保持 shared 可被 renderer/web 安全导入。
  return `${ZAICODE_AGENT_ID_PREFIX}${globalThis.crypto.randomUUID()}`;
}

/** 工具/权限策略；权限档位沿用上游 permissionMode 语义，不新增权限体系。 */
export const zaicodeAgentToolPolicySchema = z
  .object({
    allowedTools: z.array(z.string().trim().min(1)).optional(),
    disallowedTools: z.array(z.string().trim().min(1)).optional(),
    permissionMode: z.enum(["yolo", "auto", "plan"]).optional(),
  })
  .strict();

export type ZaicodeAgentToolPolicy = z.infer<typeof zaicodeAgentToolPolicySchema>;

export const zaicodeAgentDefinitionSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    role: zaicodeAgentRoleSchema,
    instructions: z.string(),
    enabled: z.boolean(),
    /** 配置的模型选择；与实际执行模型（actualModelSelection）区分展示。 */
    modelSelection: modelSelectionSchema.optional(),
    /** Provider 引用（标识）；未绑定模型选择时用于展示与调度定向。 */
    providerRef: z.string().trim().min(1).optional(),
    /** 模型引用（标识）。 */
    modelRef: z.string().trim().min(1).optional(),
    /** 可选推理档位；仅在所选 Provider/模型支持时透传。 */
    reasoningEffort: z.string().trim().min(1).optional(),
    toolPolicy: zaicodeAgentToolPolicySchema,
    /** 路由后端；default="direct"。SAIFREN/SAIRoute/9router 目前是声明位，选用时走 fail-closed。 */
    backend: z.enum(ZAICODE_ROUTE_BACKENDS).default("direct"),
    /** 来自哪个内置模板；模板只是初始值，之后可自由编辑。 */
    templateId: z.string().trim().min(1).optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();

export type ZaicodeAgentDefinition = z.infer<typeof zaicodeAgentDefinitionSchema>;

/** 损坏/不可解释的持久化定义不得静默消失：以诊断行的形式与列表一起返回。 */
export interface ZaicodeAgentDiagnostic {
  agentId?: string;
  code: "invalid-definition";
  message: string;
}

export interface ZaicodeAgentListResult {
  agents: ZaicodeAgentDefinition[];
  diagnostics: ZaicodeAgentDiagnostic[];
}

/** 创建参数：id/时间戳由服务生成。 */
export interface ZaicodeAgentCreateInput {
  name: string;
  role: ZaicodeAgentRole;
  instructions: string;
  enabled?: boolean;
  modelSelection?: ZaicodeAgentDefinition["modelSelection"];
  providerRef?: string;
  modelRef?: string;
  reasoningEffort?: string;
  toolPolicy?: ZaicodeAgentToolPolicy;
  backend?: ZaicodeRouteBackend;
  templateId?: string;
}

/** 更新补丁：未提供的字段保持原值；id 与创建时间不可变。 */
export interface ZaicodeAgentUpdatePatch {
  name?: string;
  role?: ZaicodeAgentRole;
  instructions?: string;
  enabled?: boolean;
  modelSelection?: ZaicodeAgentDefinition["modelSelection"] | null;
  providerRef?: string | null;
  modelRef?: string | null;
  reasoningEffort?: string | null;
  toolPolicy?: ZaicodeAgentToolPolicy;
  backend?: ZaicodeRouteBackend | null;
}

/** 内置模板：只提供初始值，应用逻辑不得硬编码具体模板名/agent 名。 */
export interface ZaicodeAgentTemplate {
  id: string;
  name: string;
  role: ZaicodeAgentRole;
  description: string;
  instructions: string;
  toolPolicy: ZaicodeAgentToolPolicy;
  /** SRC-038: the template the one-click "Hit & go" button uses (runs /goal cc all). */
  hitAndGo?: boolean;
}
