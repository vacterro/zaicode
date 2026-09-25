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
import { readZaicodeDefaultModel } from "./zaicodeDefaultModel.js";

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
    autoRun: true,
    loading: false,
    error: null,
    selectedAgentId: null,
    selectedJobId: null,

    selectAgent: (agentId) => set({ selectedAgentId: agentId, selectedJobId: null }),
    selectJob: (jobId) => set({ selectedJobId: jobId, selectedAgentId: null }),

    refresh: async (services, workspace) => {
      set({ loading: true });
      try {
        const agentsResult = await services.agents.list();
        const jobsResult = await services.jobs.list({ workspaceKey: workspace.workspaceKey });
        const templates = await services.agents.listTemplates();
        const maxConcurrency = await services.jobs.getMaxConcurrency();
        const autoRun = await services.jobs.getAutoRun();
        set({
          agents: agentsResult.agents,
          agentDiagnostics: agentsResult.diagnostics,
          jobs: jobsResult.jobs,
          jobDiagnostics: jobsResult.diagnostics,
          templates,
          maxConcurrency,
          autoRun,
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
      const fallback = input.modelSelection || input.providerRef || input.modelRef ? null : readZaicodeDefaultModel();
      const withPool = fallback ? { ...input, modelSelection: { providerId: fallback.providerId, modelId: fallback.modelId } } : input;
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
        // 打开自动驾驶时立即消化已排队任务，而不是等下一次入队。
        if (enabled) await services.jobs.pump(workspace.workspaceKey);
      });
    },
  };
});
