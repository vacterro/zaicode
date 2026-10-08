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

// T-248 / SRC-160:R012 — 活跃轮询窗口：3 秒一次的全量读取不能随终结历史无限增长。
// 读取本身会带回窗口之外仍未终结的行，所以队列里在跑/待跑的任务一条都不会被截掉。
const ZAICODE_ACTIVE_POLL_JOB_LIMIT = 200;

export const useZaicodeStore = create<ZaicodeStoreState>((set, get) => {
  let autoRunQuery = 0;
  // T-249 / SRC-160:R013 — 队列事实有三个重叠读取源：挂载 effect、3 秒轮询、每次
  // runAction。同一时刻只跑一趟读取；期间到达的调用合并成一趟后续读取并各自等待
  // 满足自己请求的那一趟，所以改完数据的调用看到的仍是改完之后的快照。提交前若已有
  // 更新的请求（包括切换工作区），这一趟的快照直接丢弃，由新请求的那一趟覆盖。
  let passGeneration = 0;
  let passCommit = 0;
  let passRunning = false;
  let passPending: { services: ZaicodeServices; workspace: ZaicodeWorkspaceContext } | null =
    null;
  const passWaiters: { generation: number; resolve: () => void }[] = [];

  const settlePassWaiters = () => {
    while (true) {
      const next = passWaiters[0];
      if (!next || next.generation > passCommit) return;
      passWaiters.shift();
      next.resolve();
    }
  };

  const runRefreshPass = async (
    services: ZaicodeServices,
    workspace: ZaicodeWorkspaceContext,
    generation: number,
  ): Promise<void> => {
    set({ loading: true });
    try {
      const [agentsResult, jobsResult, templates, maxConcurrency] = await Promise.all([
        services.agents.list(),
        services.jobs.list({
          workspaceKey: workspace.workspaceKey,
          limit: ZAICODE_ACTIVE_POLL_JOB_LIMIT,
        }),
        services.agents.listTemplates(),
        services.jobs.getMaxConcurrency(),
        // refreshAutoRun 自带 generation 护栏，放进同一趟读取，轮询不再多跑一个来回。
        get().refreshAutoRun(services),
      ]);
      // 已被更新的请求取代（含工作区已切换）：丢弃旧快照，让新请求提交。
      if (generation !== passGeneration) return;
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
      if (generation !== passGeneration) return;
      set({ loading: false, error: describeError(error) });
    }
  };

  const drainRefreshPasses = async (): Promise<void> => {
    while (passPending) {
      const request = passPending;
      passPending = null;
      const generation = passGeneration;
      await runRefreshPass(request.services, request.workspace, generation);
      if (generation > passCommit) passCommit = generation;
      settlePassWaiters();
    }
    passRunning = false;
  };

  const requestRefresh = (
    services: ZaicodeServices,
    workspace: ZaicodeWorkspaceContext,
  ): Promise<void> => {
    const generation = ++passGeneration;
    passPending = { services, workspace };
    if (!passRunning) {
      passRunning = true;
      void drainRefreshPasses().catch((error: unknown) => {
        passRunning = false;
        logger.error("[zaicode] 队列读取调度失败", { error: describeError(error) });
        passCommit = Math.max(passCommit, generation);
        settlePassWaiters();
      });
    }
    return new Promise<void>((resolve) => {
      passWaiters.push({ generation, resolve });
      settlePassWaiters();
    });
  };

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

    refresh: (services, workspace) => requestRefresh(services, workspace),

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
