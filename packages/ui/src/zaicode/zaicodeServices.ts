import type { IServiceAccessor, IZaicodeAgentService, IZaicodeJobService } from "@zcode/services";

/** ZAICODE 产品层服务包；远端 host 未注册时解析为 null，调用方必须显示不可用状态。 */
export interface ZaicodeServices {
  agents: IZaicodeAgentService;
  jobs: IZaicodeJobService;
}

export interface ZaicodeWorkspaceContext {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export function resolveZaicodeServices(accessor: IServiceAccessor): ZaicodeServices | null {
  if (!accessor.zaicodeAgentService || !accessor.zaicodeJobService) return null;
  return { agents: accessor.zaicodeAgentService, jobs: accessor.zaicodeJobService };
}
