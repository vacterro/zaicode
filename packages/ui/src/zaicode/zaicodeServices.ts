import type {
  IModelSelectionService,
  IServiceAccessor,
  IZaicodeAgentService,
  IZaicodeAuditService,
  IZaicodeJobService,
} from "@zcode/services";

/** ZAICODE 产品层服务包；远端 host 未注册时解析为 null，调用方必须显示不可用状态。 */
export interface ZaicodeServices {
  agents: IZaicodeAgentService;
  jobs: IZaicodeJobService;
  /** A3 audit campaigns (T-66); absent when the host predates the audit service. */
  audits: IZaicodeAuditService | null;
  /** The machine's available provider/model view; the store validates a seeded default against it. */
  modelSelection: IModelSelectionService;
}

export interface ZaicodeWorkspaceContext {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

/** One bundle per agent service instance, so the same services always give the same object. */
const bundles = new WeakMap<IZaicodeAgentService, ZaicodeServices>();

/**
 * The same services resolve to the SAME object (T-133). Components call this during render and list the result in
 * effect dependencies; a fresh object on every render re-ran Settings -> ZAICODE's loading effect on every render,
 * and each load's setState rendered again: 650 queue/agent RPCs a second for as long as the page was open (1.4 GB of
 * host log on 27.09). A new bundle is made only when one of the services itself changes.
 */
export function resolveZaicodeServices(accessor: IServiceAccessor): ZaicodeServices | null {
  const agents = accessor.zaicodeAgentService;
  const jobs = accessor.zaicodeJobService;
  if (!agents || !jobs) return null;
  const audits = accessor.zaicodeAuditService ?? null;
  const modelSelection = accessor.modelSelectionService;
  const known = bundles.get(agents);
  if (known && known.jobs === jobs && known.audits === audits && known.modelSelection === modelSelection) return known;
  const bundle: ZaicodeServices = { agents, jobs, audits, modelSelection };
  bundles.set(agents, bundle);
  return bundle;
}
