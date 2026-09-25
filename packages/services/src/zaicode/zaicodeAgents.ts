import { ServiceChannels } from "@zcode/shared";
import type {
  ZaicodeAgentCreateInput,
  ZaicodeAgentDefinition,
  ZaicodeAgentListResult,
  ZaicodeAgentTemplate,
  ZaicodeAgentUpdatePatch,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// ZAICODE agent 定义服务通道：操作员可见的产品定义 CRUD + 内置模板实例化。
// 定义只引用 Provider/模型标识；凭据与 Provider 配置不进入本层。

export interface IZaicodeAgentService {
  /** 列出全量定义；损坏的持久化行以 diagnostics 返回，不静默丢弃。 */
  list(): Promise<ZaicodeAgentListResult>;
  get(agentId: string): Promise<ZaicodeAgentDefinition | null>;
  create(input: ZaicodeAgentCreateInput): Promise<ZaicodeAgentDefinition>;
  /** 未提供的字段保持不变；null 明确清除可选字段；不存在的 id 返回 null。 */
  update(agentId: string, patch: ZaicodeAgentUpdatePatch): Promise<ZaicodeAgentDefinition | null>;
  duplicate(agentId: string): Promise<ZaicodeAgentDefinition | null>;
  remove(agentId: string): Promise<boolean>;
  listTemplates(): Promise<ZaicodeAgentTemplate[]>;
  /** 从内置模板创建；模板只是初始值，之后可自由编辑。 */
  createFromTemplate(templateId: string, name?: string): Promise<ZaicodeAgentDefinition>;
}

export const IZaicodeAgentService = createServiceDescriptor<IZaicodeAgentService>(
  ServiceChannels.ZaicodeAgents,
);
