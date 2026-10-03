import { create } from "zustand";
import type {
  ZaicodeAgentCreateInput,
  ZaicodeAgentDefinition,
  ZaicodeAgentDiagnostic,
  ZaicodeAgentTemplate,
  ZaicodeAgentUpdatePatch,
  ZaicodeJob,
  ZaicodeJobCreateInput,
  ZaicodeJobDiagnostic,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import type { ZaicodeServices, ZaicodeWorkspaceContext } from "@/zaicode/zaicodeServices.js";
import { resolveZaicodeDefaultSelection } from "./zaicodeDefaultModel.js";

interface ZaicodeStoreState {
  agents: ZaicodeAgentDefinition[];
  agentDiagnostics: ZaicodeAgentDiagnostic[];
  jobs: ZaicodeJob[];
  jobDiagnostics: ZaicodeJobDiagnostic[];
  templates: ZaicodeAgentTemplate[];
  maxConcurrency: number;
  autoRun: boolean;
  loading: boolean;
  error: string | null;
  selectedAgentId: string | null;
  selectedJobId: string | null;
  selectAgent: (agentId: string | null) => void;
  selectJob: (jobId: string | null) => void;
  refresh: (services: ZaicodeServices, workspace: ZaicodeWorkspaceContext) => Promise<void>;
  refreshAutoRun: (services: ZaicodeServices | null) => Promise<boolean>;
  createAgent: (
    services: ZaicodeServices,
    workspace: ZaicodeWorkspaceContext,
    input: ZaicodeAgentCreateInput,
  ) => Promise<ZaicodeAgentDefinition | null>;
  updateAgent: (
    services: ZaicodeServices,
    workspace: ZaicodeWorkspaceContext,
    agentId: string,
    patch: ZaicodeAgentUpdatePatch,
  ) => Promise<void>;
  duplicateAgent: (
    services: ZaicodeServices,
    workspace: ZaicodeWorkspaceContext,
    agentId: string,
  ) => Promise<void>;
  removeAgent: (
    services: ZaicodeServices,
    workspace: ZaicodeWorkspaceContext,
    agentId: string,
  ) => Promise<void>;
  createJob: (
    services: ZaicodeServices,
    workspace: ZaicodeWorkspaceContext,
    input: Omit<ZaicodeJobCreateInput, "workspaceKey" | "workspacePath" | "workspaceIdentity">,
  ) => Promise<ZaicodeJob | null>;
  dispatchJob: (
    services: ZaicodeServices,
    workspace: ZaicodeWorkspaceContext,
    jobId: string,
  ) => Promise<void>;
  pumpQueue: (services: ZaicodeServices, workspace: ZaicodeWorkspaceContext) => Promise<void>;
  cancelJob: (
    services: ZaicodeServices,
    workspace: ZaicodeWorkspaceContext,
    jobId: string,
  ) => Promise<void>;
  retryJob: (
    services: ZaicodeServices,
    workspace: ZaicodeWorkspaceContext,
    jobId: string,
  ) => Promise<void>;
  resumeJob: (
    services: ZaicodeServices,
    workspace: ZaicodeWorkspaceContext,
    jobId: string,
  ) => Promise<void>;
  removeJob: (
    services: ZaicodeServices,
    workspace: ZaicodeWorkspaceContext,
    jobId: string,
  ) => Promise<void>;
  reorderJob: (
    services: ZaicodeServices,
    workspace: ZaicodeWorkspaceContext,
    jobId: string,
    direction: "up" | "down",
  ) => Promise<void>;
  setMaxConcurrency: (
    services: ZaicodeServices,
    workspace: ZaicodeWorkspaceContext,
    value: number,
  ) => Promise<void>;
  setAutoRun: (
    services: ZaicodeServices,
    workspace: ZaicodeWorkspaceContext,
    enabled: boolean,
  ) => Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useZaicodeStore = create<ZaicodeStoreState>((set, get) => {
  let autoRunQuery = 0;
  const runAction = async <T>(
    services: ZaicodeServices,
    workspace: ZaicodeWorkspaceContext,
    action: () => Promise<T>,
    after?: (value: T) => void,
  ): Promise<T | null> => {
    try {
      const value = await action();
      after?.(value);
      await get().refresh(services, workspace);
      return value;
    } catch (error) {
      logger.error("[zaicode] 操作失败", { error: describeError(error) });
      set({ error: describeError(error) });
      return null;
    }
  };

  return {
    agents: [],
    agentDiagnostics: [],
    jobs: [],
    jobDiagnostics: [],
    templates: [],
    maxConcurrency: 1,
    // 主机设置读取前不承诺自动派发；持久化默认值仍由 job service 决定。
    autoRun: false,
    loading: false,
    error: null,
    selectedAgentId: null,
    selectedJobId: null,

    selectAgent: (agentId) => set({ selectedAgentId: agentId, selectedJobId: null }),
    selectJob: (jobId) => set({ selectedJobId: jobId, selectedAgentId: null }),

    refreshAutoRun: async (services) => {
      const query = ++autoRunQuery;
      if (!services) {
        set({ autoRun: false });
        return false;
      }
      try {
        const autoRun = await services.jobs.getAutoRun();
        // 迟到的设置读取不能覆盖用户刚确认的开关，或给旧 tick 授权。
        if (query !== autoRunQuery) return false;
        set({ autoRun });
        return autoRun;
      } catch (error) {
        if (query === autoRunQuery) {
          set({ autoRun: false });
          logger.error("[zaicode] Autopilot 设置读取失败", { error: describeError(error) });
        }
        return false;
      }
    },

    refresh: async (services, workspace) => {
      set({ loading: true });
      try {
        const agentsResult = await services.agents.list();
        const jobsResult = await services.jobs.list({ workspaceKey: workspace.workspaceKey });
        const templates = await services.agents.listTemplates();
        const maxConcurrency = await services.jobs.getMaxConcurrency();
        await get().refreshAutoRun(services);
        set({
          agents: agentsResult.agents,
          agentDiagnostics: agentsResult.diagnostics,
          jobs: jobsResult.jobs,
          jobDiagnostics: jobsResult.diagnostics,
          templates,
          maxConcurrency,
          loading: false,
          error: null,
        });
      } catch (error) {
        logger.error("[zaicode] 加载失败", { error: describeError(error) });
        set({ loading: false, error: describeError(error) });
      }
    },

    createAgent: async (services, workspace, input) => {
      // SRC-038: a new agent without a pool takes the default model for new tasks, so it runs at once.
      // T-102: only seed the default when it still resolves against this machine's available
      // provider/model view. A stale localStorage default (e.g. a SAIFREN pool this machine
      // never configured) must not be written onto the agent as if it were ready to dispatch;
      // leave the selection unresolved so the UI can tell the operator what is missing.
      const wantsDefault = !(input.modelSelection || input.providerRef || input.modelRef);
      let withPool = input;
      if (wantsDefault) {
        const view = await services.modelSelection.getView();
        const resolved = resolveZaicodeDefaultSelection(view);
        if (resolved) {
          withPool = { ...input, modelSelection: resolved };
        }
      }
      const created = await runAction(services, workspace, () => services.agents.create(withPool));
      if (created) set({ selectedAgentId: created.id, selectedJobId: null });
      return created;
    },

    updateAgent: async (services, workspace, agentId, patch) => {
      await runAction(services, workspace, () => services.agents.update(agentId, patch));
    },

    duplicateAgent: async (services, workspace, agentId) => {
      const created = await runAction(services, workspace, () =>
        services.agents.duplicate(agentId),
      );
      if (created) set({ selectedAgentId: created.id });
    },

    removeAgent: async (services, workspace, agentId) => {
      await runAction(
        services,
        workspace,
        () => services.agents.remove(agentId),
        () => {
          if (get().selectedAgentId === agentId) set({ selectedAgentId: null });
        },
      );
    },

    createJob: async (services, workspace, input) => {
      const created = await runAction(services, workspace, () =>
        services.jobs.create({
          ...input,
          workspaceKey: workspace.workspaceKey,
          workspacePath: workspace.workspacePath,
          ...(workspace.workspaceIdentity
            ? { workspaceIdentity: workspace.workspaceIdentity }
            : {}),
        }),
      );
      if (created) set({ selectedJobId: created.id, selectedAgentId: null });
      return created;
    },

    dispatchJob: async (services, workspace, jobId) => {
      await runAction(services, workspace, () => services.jobs.dispatch(jobId));
    },

    pumpQueue: async (services, workspace) => {
      await runAction(services, workspace, () => services.jobs.pump(workspace.workspaceKey));
    },

    cancelJob: async (services, workspace, jobId) => {
      await runAction(services, workspace, () => services.jobs.cancel(jobId));
    },

    retryJob: async (services, workspace, jobId) => {
      await runAction(services, workspace, () => services.jobs.retry(jobId));
    },

    resumeJob: async (services, workspace, jobId) => {
      await runAction(services, workspace, () => services.jobs.resume(jobId));
    },

    removeJob: async (services, workspace, jobId) => {
      await runAction(
        services,
        workspace,
        () => services.jobs.remove(jobId),
        () => {
          if (get().selectedJobId === jobId) set({ selectedJobId: null });
        },
      );
    },

    reorderJob: async (services, workspace, jobId, direction) => {
      await runAction(services, workspace, () => services.jobs.reorder(jobId, direction));
    },

    setMaxConcurrency: async (services, workspace, value) => {
      await runAction(services, workspace, () => services.jobs.setMaxConcurrency(value));
    },

    setAutoRun: async (services, workspace, enabled) => {
      await runAction(services, workspace, async () => {
        await services.jobs.setAutoRun(enabled);
        autoRunQuery += 1;
        set({ autoRun: enabled });
        // 打开自动驾驶时立即消化已排队任务，而不是等下一次入队。
        if (enabled) await services.jobs.pump(workspace.workspaceKey);
      });
    },
  };
});
