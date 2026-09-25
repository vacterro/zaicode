/* eslint-disable max-lines -- workspace 行同时承载折叠、远端状态和快捷操作，先保持同文件收口。 */
import {
  ZAICODE_SAIPEN_START_COMMAND,
  useZaicodePendingCommand,
  useZaicodeSaipen,
} from "@/zaicode/zaicodeSaipen.js";
import {
  saipenBoardShares,
} from "@/zaicode/zaicodeSaipenModel.js";
import {
  pushZaicodeArchiveBatch,
  registerZaicodeArchiveAll,
  registerZaicodeArchiveSome,
  useZaicodeArchiveUndo,
  type ZaicodeArchiveBatch,
} from "@/zaicode/zaicodeArchiveUndo.js";
import { ZaicodeWorkingIcon } from "@/zaicode/ZaicodeWorkingIcon.js";
import { ZaicodeProjectMainGlyph } from "@/zaicode/ZaicodeProjectMainGlyph.js";
import { useZaicodeHighlight, withZaicodeHighlight } from "@/zaicode/zaicodeHighlights.js";
import { useZaicodeMainSessionId, useZaicodeMainSessions } from "@/zaicode/zaicodeMainSession.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { useZaicodeProjectRuntime, type ZaicodeProjectRuntimeView } from "@/zaicode/zaicodeProjectRuntime.js";
import { getTaskListAttention, isTaskListRowActive } from "@/v4/taskListRowActivity.js";

/** Project labels share one adjustable colour strip width. Progress remains in the tooltip. */
function buildReadinessTint(runtime: ZaicodeProjectRuntimeView) {
  const color = runtime.color;
  const title = `${runtime.verdict.label}: ${runtime.verdict.reason}`;
  if (!color) return { style: undefined, title };
  return {
    title,
    style: {
      "--zaicode-list-label-color": `color-mix(in srgb, ${color} 16%, var(--color-background))`,
      color: `color-mix(in srgb, ${color} 35%, var(--color-foreground-subtle))`,
    } as CSSProperties,
  };
}
import { isZaicodeProductMode } from "@zcode/shared";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import {
  Archive,
  CheckIcon,
  CircleAlert,
  Cloud,
  CopyIcon,
  Ellipsis,
  Folder,
  FolderOpen,
  House,
  InfoIcon,
  ListTree,
  LoaderCircle,
  RefreshCwIcon,
  MessageCirclePlus,
  Play,
  Power,
  XIcon,
} from "lucide-react";
import type { useSortable } from "@dnd-kit/sortable";
import { BorderBeam } from "border-beam";
import { STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import { Button, buttonVariants } from "@/components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  ZAICODE_SLOT_GROUPS,
  slotGroupOf,
  useZaicodeSidebarPrefs,
  type ZaicodeSlotGroup,
} from "@/zaicode/zaicodeSidebarPrefs.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildWorkspaceSessionKey,
  formatRemoteWorkspaceDisplayLabel,
} from "@/lib/remoteWorkspaceHistory.js";
import { TaskList } from "@/TaskList.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import { ReconnectingRemoteWorkspaceLogTooltip } from "@/WorkspaceSidebar/ReconnectingRemoteWorkspaceLogTooltip.js";
import { cn } from "@/components/lib/utils.js";
import {
  TID_WORKSPACE_CLOSE,
  TID_WORKSPACE_FILE_TREE_BUTTON,
  TID_WORKSPACE_ITEM,
  testId,
} from "@zcode/shared";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useBaseWorkspaceServices, useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import {
  applyTaskQueryCacheMutation,
  invalidateTaskQueryCacheByScopes,
} from "@/store/taskQueryCacheStore.js";
import { useRemotePinnedTaskStore } from "@/store/remotePinnedTaskStore.js";
import { useRemoteTimelineTaskStore } from "@/store/remoteTimelineTaskStore.js";
import { logger } from "@/logger.js";
import {
  RemoteSyncDialogs,
  RemoteSyncMenuItems,
  shouldShowRemoteSyncActions,
} from "@/settings/RemoteSyncActions.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import { refreshWorkspacePluginCapabilitiesAfterRemoteSync } from "@/lib/remotePluginSyncRefresh.js";
import { useMcpStore } from "@/store/mcpStore.js";
import { TaskRowActionButton } from "@/workspace-grouped-tasks/task-row-action-button.js";
import { releaseWorkspaceRuntimeAfterProjectRemoval } from "@/lib/workspaceRuntimeRelease.js";
import {
  hasRunningWorkspaceChat,
  scanWindowsReservedDeviceNameFiles,
} from "@/lib/workspaceRemovalSafety.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { toast } from "@/components/ui/toast.js";
import { ZaicodeProjectEngineMenuItems, ZaicodeProjectWorkerChips } from "@/zaicode/ZaicodeProjectEngines.js";
import { toggleZaicodeProjectDisabled, useZaicodeProjectDisabled } from "@/zaicode/zaicodeProjectSwitch.js";
import { playZaicodeSound } from "@/zaicode/zaicodeSoundBus.js";
import {
  decideZaicodeProjectStart,
  decideZaicodeSessionContinue,
  describeZaicodeContinueCommand,
  registerZaicodeProjectContinue,
  zaicodeSessionBriefOf,
} from "@/zaicode/zaicodeContinue.js";
import { createZaicodeContinueHandle } from "@/zaicode/zaicodeContinueHost.js";

export type SortableBindings = Pick<ReturnType<typeof useSortable>, "attributes" | "listeners">;

// workspace 行在流式工具事件期间会因父级刷新而重渲染；
// TaskList 如果每次收到新的空数组，会把等价数据误判成变化并连带刷新任务行。
const EMPTY_PINNED_TASKS: ZCodeTaskMeta[] = [];

function isHomeWorkspacePath(path: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)$/.test(normalizedPath);
}

type SshRemoteTarget = Extract<NonNullable<WorkspaceTabState["remoteTarget"]>, { kind: "ssh" }>;

interface SshWorkspaceTooltipDetails {
  alias: string | null;
  hostLabel: string;
  workspacePath: string;
}

function formatSshRemoteHostLabel(target: SshRemoteTarget): string {
  const username = target.username.trim();
  const host = target.host.trim();
  const port = target.port ?? 22;
  return `${username}@${host}:${port}`;
}

function getSshWorkspaceTooltipDetails(tab: WorkspaceTabState): SshWorkspaceTooltipDetails | null {
  if (tab.remoteTarget?.kind !== "ssh") {
    return null;
  }

  return {
    alias: tab.remoteTarget.sshConfigAlias?.trim() || null,
    hostLabel: formatSshRemoteHostLabel(tab.remoteTarget),
    workspacePath: tab.workspacePath,
  };
}

export const WorkspaceSidebarItem = memo(function WorkspaceSidebarItem({
  tab,
  isActiveWorkspace,
  isExpanded,
  closeTab,
  toggleWorkspaceExpanded,
  onSelectTask,
  onStartDraftInWorkspace,
  taskItems,
  taskListLoading,
  taskListHasMore,
  taskListHasUnread = false,
  taskListLiveWorkflowCount = 0,
  onShowMoreTasks,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceErrorByWorkspaceKey,
  reconnectingRemoteWorkspaceLogsByWorkspaceKey,
  onReconnectRemoteWorkspace,
  onOpenFileTree,
  itemRef,
  itemStyle,
  sortableBindings,
  isDragging = false,
}: {
  tab: WorkspaceTabState;
  isActiveWorkspace: boolean;
  isExpanded: boolean;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  toggleWorkspaceExpanded: (workspacePath: string) => void;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onStartDraftInWorkspace: (targetWorkspacePath: string, targetWorkspaceIdentity?: string) => void;
  taskItems: ZCodeTaskMeta[];
  taskListLoading: boolean;
  taskListHasMore: boolean;
  taskListHasUnread?: boolean;
  /** 组内在跑的工作流 run 数；项目收起时在未读点旁画脉冲灯（>1 带数量）。 */
  taskListLiveWorkflowCount?: number;
  onShowMoreTasks: () => void;
  reconnectingRemoteWorkspaceKeys: string[];
  remoteWorkspaceErrorByWorkspaceKey: Record<string, string>;
  reconnectingRemoteWorkspaceLogsByWorkspaceKey: Record<string, RemoteConnectionLogEntry[]>;
  onReconnectRemoteWorkspace: (workspaceKey: string) => Promise<void>;
  onOpenFileTree?: (target: {
    workspacePath: string;
    workspaceName: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  }) => void;
  itemRef?: (node: HTMLLIElement | null) => void;
  itemStyle?: CSSProperties;
  sortableBindings?: SortableBindings;
  isDragging?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const workspaceZCodeState = useZCodeSessionStore((state) =>
    selectWorkspaceZCodeState(state, tab.workspacePath, tab.workspaceIdentity),
  );
  const activeTaskId = workspaceZCodeState.activeTaskId;
  const removeTaskState = useZCodeSessionStore((state) => state.removeTaskState);
  const upsertOptimisticTaskListItem = useZCodeSessionStore(
    (state) => state.upsertOptimisticTaskListItem,
  );
  const removeOptimisticTaskListItem = useZCodeSessionStore(
    (state) => state.removeOptimisticTaskListItem,
  );
  const setTaskUnreadIndicator = useZCodeSessionStore((state) => state.setTaskUnreadIndicator);
  const services = useWorkspaceServices(
    tab.workspacePath,
    tab.remoteSessionId,
    tab.workspaceIdentity,
    tab.remoteTarget,
  );
  const confirmDialog = useConfirmDialog();
  const baseServices = useBaseWorkspaceServices();
  const zcodeTaskService = services.zcodeTaskService;
  const taskItemsRef = useRef(taskItems);
  taskItemsRef.current = taskItems;
  const workspaceZCodeStateRef = useRef(workspaceZCodeState);
  workspaceZCodeStateRef.current = workspaceZCodeState;
  const findCurrentTaskItem = useCallback((taskId: string) => {
    // 流式刷新会重建 taskItems 数组，任务操作回调如果直接依赖数组，
    // 即使任务语义没变也会换引用，继续击穿 TaskListItem 的 memo。
    // 用 ref 在调用时读取最新列表，既保持回调稳定，也避免乐观更新拿到过期 meta。
    return taskItemsRef.current.find((task) => task.taskId === taskId) ?? null;
  }, []);
  const isHomeWorkspace = isHomeWorkspacePath(tab.workspacePath);
  const readOnlyReason =
    tab.availability === "unavailable-local-directory"
      ? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" })
      : undefined;
  const remoteWorkspaceKey = buildWorkspaceSessionKey(tab);
  const isRemoteWorkspace = Boolean(
    tab.remoteSessionId || tab.remoteTarget || tab.workspaceIdentity,
  );
  const isDisconnectedRemoteWorkspace = Boolean(isRemoteWorkspace && !tab.remoteSessionId);
  const isReconnectPending = Boolean(
    isDisconnectedRemoteWorkspace && reconnectingRemoteWorkspaceKeys.includes(remoteWorkspaceKey),
  );
  const remoteWorkspaceError = remoteWorkspaceErrorByWorkspaceKey[remoteWorkspaceKey];
  const workspaceSidebarLabel = formatRemoteWorkspaceDisplayLabel(tab.label, tab.remoteTarget);
  const sshWorkspaceTooltipDetails = getSshWorkspaceTooltipDetails(tab);
  const reconnectRuntimeLogs =
    reconnectingRemoteWorkspaceLogsByWorkspaceKey[remoteWorkspaceKey] ?? [];
  const showRemoteConnectionErrorNotice = Boolean(
    // 远程项目只要处于“断连”就显示叹号，会把“尚未连接/已断开但无错误”和“真实连接失败”混在一起，
    // 用户看到列表里的 warning 图标时无法判断是否真有故障。
    // 这里收敛成只有存在连接错误正文时才显示叹号，普通未连接状态仅保留重连入口。
    isDisconnectedRemoteWorkspace && !isReconnectPending && remoteWorkspaceError?.trim(),
  );
  const showReconnectAction = Boolean(isDisconnectedRemoteWorkspace);
  const showFileTreeAction = Boolean(onOpenFileTree && !isDisconnectedRemoteWorkspace);
  const showRemoteSkillSyncAction = shouldShowRemoteSyncActions({
    remoteSessionId: tab.remoteSessionId,
    remoteTarget: tab.remoteTarget,
    clientMode: "desktop-continuous" as const,
    hasLocalSourceService: Boolean(baseServices.skillSyncService),
  });
  // 远端工作区在“重连中”时，之前只有轻微背景呼吸效果，
  // 在侧边栏高密度列表里不够醒目，用户很难快速判断哪个容器仍在连接。
  // 这里复用 BorderBeam，只在重连进行中激活，让连接态反馈更清晰，
  // 同时避免在普通空闲态或断连态误显示为“仍在运行”。
  const shouldShowRemoteConnectingBorderBeam = isReconnectPending;
  const [isRemoteErrorCopied, setIsRemoteErrorCopied] = useState(false);
  const [remoteSkillSyncOpen, setRemoteSkillSyncOpen] = useState(false);
  const [remoteMcpSyncOpen, setRemoteMcpSyncOpen] = useState(false);
  const [remotePluginSyncOpen, setRemotePluginSyncOpen] = useState(false);
  const [workspaceRowHovered, setWorkspaceRowHovered] = useState(false);
  const [workspaceRowFocusWithin, setWorkspaceRowFocusWithin] = useState(false);
  const [workspaceActionMenuOpen, setWorkspaceActionMenuOpen] = useState(false);
  const [isHoverNone] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none)").matches,
  );
  const shouldMountWorkspaceRowActions =
    // workspace action 以前常驻 DOM，仅靠 opacity 隐藏；相邻 tooltip 会在
    // 浮层定位完成前误认隐藏 trigger，短暂显示到错误位置。改为交互时挂载，菜单打开时保活。
    workspaceRowHovered || workspaceRowFocusWithin || workspaceActionMenuOpen || isHoverNone;
  const remoteErrorCopyResetRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (remoteErrorCopyResetRef.current !== null) {
        window.clearTimeout(remoteErrorCopyResetRef.current);
      }
    };
  }, []);

  // ZAICODE (SRC-044) "project = MAIN": a click on the row opens MAIN; set below, once MAIN is known.
  const zaicodeOpenMainRef = useRef<() => boolean>(() => false);
  const handleWorkspaceOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (isDisconnectedRemoteWorkspace) {
        return;
      }
      if (zaicodeOpenMainRef.current()) {
        return;
      }

      // workspace 草稿导航本身会把 workspace 标记为展开。
      // 之前在 Collapsible 的 onOpenChange 里无论展开/收起都先激活 workspace，
      // 收起后的下一次点击会先被激活路径展开，再被 toggleWorkspaceExpanded 反向切回收起，
      // 表现出来就是"收起后再也打不开"。
      // 这里把职责拆开：展开时只走草稿导航；收起时只做 toggle，避免两条状态更新互相抵消。
      // ZAICODE: first click on an inactive project opens a new session there
      // (never collapses it); only a click on the already-active project toggles.
      if (!isActiveWorkspace) {
        onStartDraftInWorkspace(tab.workspacePath, tab.workspaceIdentity);
        return;
      }
      if (nextOpen) {
        if (!isExpanded) {
          // workspace 行表达“打开这个 workspace”，不是恢复它上次选中的 session。
          // 统一走上层草稿导航事务，让 workspace identity、group/pane 清理和 draft 聚焦一起收口。
          onStartDraftInWorkspace(tab.workspacePath, tab.workspaceIdentity);
        }
      } else if (isExpanded) {
        toggleWorkspaceExpanded(tab.workspacePath);
      }
    },
    [
      isDisconnectedRemoteWorkspace,
      isActiveWorkspace,
      isExpanded,
      onStartDraftInWorkspace,
      tab.workspaceIdentity,
      tab.workspacePath,
      toggleWorkspaceExpanded,
    ],
  );

  const handleSelectTask = useCallback(
    (taskId: string) => {
      // 性能优化：上层 handleSelectTask 已经会按 workspacePath 激活 tab。
      // 这里重复 activate 会额外触发一轮 tab store 更新，把整列 workspace 行都带着重渲染一次。
      onSelectTask(tab.workspacePath, taskId, tab.workspaceIdentity);
    },
    [onSelectTask, tab.workspaceIdentity, tab.workspacePath],
  );

  const handleActionMouseDown = useCallback((event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleActionMenuClick = useCallback((event: MouseEvent<HTMLElement>) => {
    // DropdownMenuContent 虽然通过 Portal 渲染到行外，React 合成 click 仍会沿组件树
    // 冒泡到外层 CollapsibleTrigger。收起的 workspace 点“移除”时，会先 closeTab，再被展开回调
    // 当成“打开 workspace”重新 addTab，表现为删不掉。菜单层统一截断 click，保留菜单选择与键盘语义。
    event.stopPropagation();
  }, []);

  const handleCreateThreadClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (readOnlyReason) {
        return;
      }
      onStartDraftInWorkspace(tab.workspacePath, tab.workspaceIdentity);
    },
    [onStartDraftInWorkspace, readOnlyReason, tab.workspaceIdentity, tab.workspacePath],
  );

  const queueZaicodeCommand = useZaicodePendingCommand((state) => state.queue);
  const zaicodeMainKey = tab.workspaceIdentity?.trim() || tab.workspacePath;
  const zaicodeMainSessionId = useZaicodeMainSessionId(zaicodeMainKey);
  const armZaicodeMain = useZaicodeMainSessions((state) => state.arm);
  const startFreshSaipen = useCallback(() => {
    // START 的新会话就是本项目的 MAIN（铁槽位）。
    armZaicodeMain(zaicodeMainKey);
    queueZaicodeCommand(tab.workspacePath, ZAICODE_SAIPEN_START_COMMAND);
    onStartDraftInWorkspace(tab.workspacePath, tab.workspaceIdentity);
  }, [armZaicodeMain, onStartDraftInWorkspace, queueZaicodeCommand, tab.workspaceIdentity, tab.workspacePath, zaicodeMainKey]);
  const startSaipen = useCallback(() => {
    if (readOnlyReason) return;
    // SRC-044：▶ 不再每次新建会话——先接着 MAIN（或被打断的会话）继续，确实无可继续时才新开 MAIN。
    const briefs = taskItemsRef.current.map((task) =>
      zaicodeSessionBriefOf(task, zaicodeMainKey, { workspacePath: tab.workspacePath }),
    );
    const decision = decideZaicodeProjectStart(zaicodeMainSessionId, briefs);
    if (decision.action === "fresh") {
      startFreshSaipen();
      return;
    }
    if (decision.action === "open") {
      onSelectTask(tab.workspacePath, decision.sessionId, tab.workspaceIdentity);
      toast(`START: ${decision.why}.`);
      return;
    }
    playZaicodeSound("ui.toggle");
    const handle = createZaicodeContinueHandle({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
      taskService: services.zcodeTaskService,
      agentService: services.zcodeAgentService,
    });
    void handle
      .send(decision.sessionId, decision.command)
      .then(() => {
        if (decision.makeMain) useZaicodeMainSessions.getState().setMain(zaicodeMainKey, decision.sessionId);
        toast(`START: ${decision.why} → ${describeZaicodeContinueCommand(decision.command)}`);
      })
      .catch((error: unknown) => {
        // MAIN 可能已被删除/归档：清掉失效的 MAIN，退回新开。
        logger.warn("[WorkspaceSidebarItem] START continue failed; starting a fresh MAIN", { error });
        if (!decision.makeMain) useZaicodeMainSessions.getState().clearMain(zaicodeMainKey);
        startFreshSaipen();
      });
  }, [
    onSelectTask,
    readOnlyReason,
    services.zcodeAgentService,
    services.zcodeTaskService,
    startFreshSaipen,
    tab.remoteSessionId,
    tab.workspaceIdentity,
    tab.workspacePath,
    zaicodeMainKey,
    zaicodeMainSessionId,
  ]);
  const handleZaicodeMainClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (zaicodeMainSessionId) {
        onSelectTask(tab.workspacePath, zaicodeMainSessionId, tab.workspaceIdentity);
        return;
      }
      if (readOnlyReason) return;
      // 还没有 MAIN：开一个新草稿，第一条消息发出后它就成为 MAIN。
      armZaicodeMain(zaicodeMainKey);
      onStartDraftInWorkspace(tab.workspacePath, tab.workspaceIdentity);
    },
    [
      armZaicodeMain,
      onSelectTask,
      onStartDraftInWorkspace,
      readOnlyReason,
      tab.workspaceIdentity,
      tab.workspacePath,
      zaicodeMainKey,
      zaicodeMainSessionId,
    ],
  );
  const handleStartSaipenClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      startSaipen();
    },
    [startSaipen],
  );

  const handleRemoveWorkspace = useCallback(async () => {
    const workspaceKey = tab.workspaceIdentity?.trim() || tab.workspacePath;
    logger.debug("[WorkspaceSidebarItem] 移除 workspace", {
      isExpanded,
      workspaceKey,
    });

    if (
      hasRunningWorkspaceChat({
        workspaceState: workspaceZCodeStateRef.current,
        taskItems: taskItemsRef.current,
      })
    ) {
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "workspaceSidebar.removeRunningWorkspace.title" }),
        description: intl.formatMessage({
          id: "workspaceSidebar.removeRunningWorkspace.description",
        }),
        confirmLabel: intl.formatMessage({ id: "workspaceSidebar.removeRunningWorkspace.confirm" }),
        cancelLabel: intl.formatMessage({ id: "common.cancel" }),
        confirmVariant: "destructive",
      });
      if (!confirmed) {
        logger.debug("[WorkspaceSidebarItem] 用户取消移除运行中 workspace", { workspaceKey });
        return;
      }
    }

    closeTab(tab.id);
    releaseWorkspaceRuntimeAfterProjectRemoval({
      tab: {
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity,
      },
      zcodeTaskService,
    });
    // 移除 workspace 只是移除入口和连接历史，不代表用户要隐藏历史任务：
    // 这里只失效缓存，保留 sqlite 任务索引原状态，避免重连同一 SSH workspace 后任务像“丢了”。
    invalidateTaskQueryCacheByScopes([
      {
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      },
    ]);

    if (!isRemoteWorkspace) {
      void scanWindowsReservedDeviceNameFiles(baseServices.fileService, tab.workspacePath)
        .then((result) => {
          if (result.findings.length === 0) {
            return;
          }
          const firstFinding = result.findings[0] ?? tab.workspacePath;
          toast(
            intl.formatMessage(
              { id: "workspaceSidebar.windowsReservedNameRisk" },
              { count: result.findings.length, path: firstFinding },
            ),
            { durationMs: 8_000, variant: "warning" },
          );
        })
        .catch((error: unknown) => {
          // Windows 保留设备名扫描只是移除后的兼容风险提示，失败不能影响 workspace 生命周期释放。
          logger.debug("[WorkspaceSidebarItem] Windows 保留名风险扫描失败", {
            workspaceKey,
            error,
          });
        });
    }
  }, [
    baseServices.fileService,
    closeTab,
    confirmDialog,
    intl,
    isExpanded,
    isRemoteWorkspace,
    tab.id,
    tab.workspaceIdentity,
    tab.workspacePath,
    zcodeTaskService,
  ]);

  const handleReconnectRemoteWorkspace = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!isDisconnectedRemoteWorkspace || isReconnectPending) {
        return;
      }

      void onReconnectRemoteWorkspace(remoteWorkspaceKey);
    },
    [
      isDisconnectedRemoteWorkspace,
      isReconnectPending,
      onReconnectRemoteWorkspace,
      remoteWorkspaceKey,
    ],
  );

  const handleOpenWorkspaceFileTree = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (isDisconnectedRemoteWorkspace || readOnlyReason || !onOpenFileTree) {
        return;
      }

      onOpenFileTree({
        workspacePath: tab.workspacePath,
        workspaceName: tab.label,
        workspaceIdentity: tab.workspaceIdentity,
        workspaceRemoteSessionId: tab.remoteSessionId,
      });
    },
    [
      isDisconnectedRemoteWorkspace,
      onOpenFileTree,
      readOnlyReason,
      tab.label,
      tab.remoteSessionId,
      tab.workspaceIdentity,
      tab.workspacePath,
    ],
  );

  // 这些 TaskList 操作以前在 JSX 中每次 render 都创建新闭包。
  // 流式事件刷新 workspace 行时，即使任务数据没变，也会穿透 TaskList/TaskListItem 的 memo。
  const handleRenameTask = useCallback(
    async (taskId: string, title: string) => {
      if (readOnlyReason) {
        return null;
      }
      const previousTask = findCurrentTaskItem(taskId);
      logger.info("[WorkspaceSidebarItem] rename service call start", {
        taskId,
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity,
        previousTitleLength: previousTask?.title.length,
        nextTitleLength: title.length,
      });
      let meta: ZCodeTaskMeta;
      try {
        meta = await zcodeTaskService.renameTask({
          taskId,
          workspacePath: tab.workspacePath,
          title,
          ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        });
      } catch (error) {
        logger.error("[WorkspaceSidebarItem] rename service call failed", {
          taskId,
          workspacePath: tab.workspacePath,
          workspaceIdentity: tab.workspaceIdentity,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      logger.info("[WorkspaceSidebarItem] rename service call resolved", {
        taskId,
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity,
        resolvedTitleLength: meta.title.length,
      });
      upsertOptimisticTaskListItem(tab.workspacePath, meta, tab.workspaceIdentity);
      if (tab.workspaceIdentity) {
        useRemoteTimelineTaskStore.getState().upsertTask(meta);
      }
      applyTaskQueryCacheMutation({
        previousTask: previousTask ?? meta,
        nextTask: meta,
        previousState: { pinned: false, archived: false },
        nextState: { pinned: false, archived: false },
      });
      logger.info("[WorkspaceSidebarItem] rename cache mutation applied", {
        taskId,
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity,
      });
      return meta;
    },
    [
      tab.workspaceIdentity,
      tab.workspacePath,
      findCurrentTaskItem,
      readOnlyReason,
      upsertOptimisticTaskListItem,
      zcodeTaskService,
    ],
  );

  const handleSetTaskPinned = useCallback(
    async (taskId: string, pinned: boolean) => {
      if (readOnlyReason) {
        return null;
      }
      const previousTask = findCurrentTaskItem(taskId);
      if (previousTask) {
        // workspace 内 pin 以前等远端/本地 RPC 返回后才更新全局 pinned 缓存，
        // pin 区会先消失再补回来。这里先乐观同步列表成员关系，失败时回滚。
        if (tab.workspaceIdentity && pinned) {
          useRemotePinnedTaskStore.getState().upsertTask(previousTask);
          useRemoteTimelineTaskStore
            .getState()
            .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
        }
        if (tab.workspaceIdentity && !pinned) {
          useRemotePinnedTaskStore
            .getState()
            .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
          useRemoteTimelineTaskStore.getState().upsertTask(previousTask);
        }
        applyTaskQueryCacheMutation({
          previousTask,
          nextTask: previousTask,
          previousState: { pinned: false, archived: false },
          nextState: { pinned, archived: false },
        });
      }
      try {
        const meta = await zcodeTaskService.setTaskPinned({
          taskId,
          workspacePath: tab.workspacePath,
          pinned,
          ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        });
        playZaicodeSound("session.pin");
        removeOptimisticTaskListItem(tab.workspacePath, taskId, tab.workspaceIdentity);
        if (tab.workspaceIdentity && pinned) {
          useRemotePinnedTaskStore.getState().upsertTask(meta);
          useRemoteTimelineTaskStore
            .getState()
            .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
        }
        if (tab.workspaceIdentity && !pinned) {
          useRemotePinnedTaskStore
            .getState()
            .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
          useRemoteTimelineTaskStore.getState().upsertTask(meta);
        }
        applyTaskQueryCacheMutation({
          previousTask: previousTask ?? meta,
          nextTask: meta,
          previousState: { pinned, archived: false },
          nextState: { pinned, archived: false },
        });
        return meta;
      } catch (error) {
        if (previousTask) {
          if (tab.workspaceIdentity && pinned) {
            useRemotePinnedTaskStore
              .getState()
              .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
            useRemoteTimelineTaskStore.getState().upsertTask(previousTask);
          }
          if (tab.workspaceIdentity && !pinned) {
            useRemotePinnedTaskStore.getState().upsertTask(previousTask);
            useRemoteTimelineTaskStore
              .getState()
              .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
          }
          applyTaskQueryCacheMutation({
            previousTask,
            nextTask: previousTask,
            previousState: { pinned, archived: false },
            nextState: { pinned: false, archived: false },
          });
        }
        throw error;
      }
    },
    [
      removeOptimisticTaskListItem,
      readOnlyReason,
      tab.workspaceIdentity,
      tab.workspacePath,
      findCurrentTaskItem,
      zcodeTaskService,
    ],
  );

  const pushArchiveUndo = useZaicodeArchiveUndo((state) => state.push);
  const reportArchiveFailure = useZaicodeArchiveUndo((state) => state.fail);
  const zaicodeProjectIsMain = useZaicodeSidebarPrefs((state) => state.projectIsMain) && isZaicodeProductMode();
  const zaicodeMainTask =
    zaicodeProjectIsMain && zaicodeMainSessionId
      ? (taskItems.find((task) => task.taskId === zaicodeMainSessionId) ?? null)
      : null;
  // The row stands for MAIN, so MAIN is not listed again under it; the rest are its helpers.
  const zaicodeChildTasks = useMemo(
    () => (zaicodeProjectIsMain && zaicodeMainSessionId ? taskItems.filter((task) => task.taskId !== zaicodeMainSessionId) : taskItems),
    [taskItems, zaicodeMainSessionId, zaicodeProjectIsMain],
  );
  const zaicodeMainOpen = Boolean(zaicodeMainTask && isActiveWorkspace && activeTaskId === zaicodeMainTask.taskId);
  zaicodeOpenMainRef.current = () => {
    // Clicking the row while MAIN is already open toggles the helpers as before.
    if (!zaicodeProjectIsMain || !zaicodeMainSessionId || zaicodeMainOpen) return false;
    onSelectTask(tab.workspacePath, zaicodeMainSessionId, tab.workspaceIdentity);
    return true;
  };
  const zaicodeSlotGroups = useZaicodeSidebarPrefs((state) => state.groups);
  const zaicodeDefaultSlot = useZaicodeSidebarPrefs((state) => state.defaultSlot);
  const zaicodeCtrlClickSlot = useZaicodeSidebarPrefs((state) => state.ctrlClickSlot);
  const zaicodeLiveIndicator = useZaicodeSidebarPrefs((state) => state.liveProjectIndicator);
  const zaicodeDimIdle = useZaicodeSidebarPrefs((state) => state.liveFirst && state.liveDimIdle);
  const setZaicodeSlotGroup = useZaicodeSidebarPrefs((state) => state.setGroup);
  const zaicodeSlotKey = buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity);
  const zaicodeSlotGroup = slotGroupOf(zaicodeSlotGroups, zaicodeSlotKey, zaicodeDefaultSlot);
  const zaicodeProjectOff = useZaicodeProjectDisabled(isZaicodeProductMode() ? zaicodeSlotKey : null);
  // ZAICODE rows keep the project name at one width: a fixed zone on the right shows the
  // status while idle and three actions (MAIN, START, more) on hover. Remote rows keep
  // upstream's layout (their reconnect / error controls need the room).
  const zaicodeCompactRow =
    isZaicodeProductMode() && !showReconnectAction && !showRemoteConnectionErrorNotice;
  // SRC-043: a compact row mounts its three actions once and swaps status <-> actions with
  // CSS group-hover, so moving the pointer over the list costs no React render at all.
  const zaicodeHoverZone = zaicodeCompactRow && !isHoverNone;
  const mountRowActions = zaicodeHoverZone || shouldMountWorkspaceRowActions;
  const zoneActionClass =
    zaicodeHoverZone && !workspaceActionMenuOpen ? "hidden group-hover:flex group-focus-within:flex" : undefined;
  const zoneStatusClass = zaicodeHoverZone
    ? workspaceActionMenuOpen
      ? "hidden"
      : "group-hover:hidden group-focus-within:hidden"
    : undefined;
  const zaicodeRunningCount = isZaicodeProductMode()
    ? taskItems.filter(isTaskListRowActive).length
    : 0;
  const zaicodeWaitingCount = isZaicodeProductMode()
    ? taskItems.filter(
        (task) => getTaskListAttention(task) !== null || Boolean(task.pendingInteraction),
      ).length
    : 0;
  /** Restores archived sessions (Ctrl+Z after a one-click archive in ZAICODE). */
  const restoreArchivedTasks = useCallback(
    async (tasks: readonly ZCodeTaskMeta[]) => {
      for (const task of tasks) {
        const meta = await zcodeTaskService.unarchiveTask({
          taskId: task.taskId,
          workspacePath: tab.workspacePath,
          ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        });
        applyTaskQueryCacheMutation({
          previousTask: task,
          nextTask: meta,
          previousState: { pinned: false, archived: true },
          nextState: { pinned: false, archived: false },
        });
        // 恢复后立即放回侧栏列表：只改 query cache 时，行要等 sessions-index 下一次推送才出现，
        // 操作员会以为 Ctrl+Z 没生效。
        upsertOptimisticTaskListItem(tab.workspacePath, meta, tab.workspaceIdentity);
        if (tab.workspaceIdentity) {
          useRemoteTimelineTaskStore.getState().upsertTask(meta);
        }
      }
    },
    [tab.workspaceIdentity, tab.workspacePath, upsertOptimisticTaskListItem, zcodeTaskService],
  );
  const archiveTaskNow = useCallback(
    async (taskId: string) => {
      const previousTask = findCurrentTaskItem(taskId);
      const meta = await zcodeTaskService.archiveTask({
        taskId,
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      });
      removeTaskState(tab.workspacePath, taskId, tab.workspaceIdentity);
      if (tab.workspaceIdentity) {
        useRemoteTimelineTaskStore
          .getState()
          .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
        useRemotePinnedTaskStore
          .getState()
          .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
      }
      applyTaskQueryCacheMutation({
        previousTask: previousTask ?? meta,
        nextTask: meta,
        previousState: { pinned: false, archived: false },
        nextState: { pinned: false, archived: true },
      });
      return meta;
    },
    [
      findCurrentTaskItem,
      removeTaskState,
      tab.workspaceIdentity,
      tab.workspacePath,
      zcodeTaskService,
    ],
  );
  // ZAICODE: archive every idle session of this project in one click; running ones stay visible.
  const archiveAllIdleTasks = useCallback(async (): Promise<ZaicodeArchiveBatch | null> => {
    if (readOnlyReason) return null;
    const running = new Set(
      taskItemsRef.current.filter(isTaskListRowActive).map((task) => task.taskId),
    );
    let candidates: ZCodeTaskMeta[];
    try {
      candidates = await zcodeTaskService.listTasks({
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      });
    } catch (error) {
      logger.error("[WorkspaceSidebarItem] archive all: list failed", { error });
      candidates = [...taskItemsRef.current];
    }
    const archived: ZCodeTaskMeta[] = [];
    for (const task of candidates) {
      if (running.has(task.taskId)) continue;
      try {
        archived.push(await archiveTaskNow(task.taskId));
      } catch (error) {
        logger.error("[WorkspaceSidebarItem] archive all: task failed", { taskId: task.taskId, error });
      }
    }
    if (archived.length === 0) return null;
    return {
      count: archived.length,
      label: `${archived.length} session${archived.length === 1 ? "" : "s"} in ${workspaceSidebarLabel}`,
      restore: () => restoreArchivedTasks(archived),
    };
  }, [
    archiveTaskNow,
    readOnlyReason,
    restoreArchivedTasks,
    tab.workspaceIdentity,
    tab.workspacePath,
    workspaceSidebarLabel,
    zcodeTaskService,
  ]);
  const handleArchiveAllTasks = useCallback(async () => {
    pushZaicodeArchiveBatch(await archiveAllIdleTasks());
  }, [archiveAllIdleTasks]);
  // SRC-044 CLEAR ALL DONE: archives exactly the sessions it names (the finished helpers).
  const archiveSomeTasks = useCallback(
    async (taskIds: readonly string[]): Promise<ZaicodeArchiveBatch | null> => {
      if (readOnlyReason) return null;
      const running = new Set(taskItemsRef.current.filter(isTaskListRowActive).map((task) => task.taskId));
      const archived: ZCodeTaskMeta[] = [];
      for (const taskId of taskIds) {
        if (running.has(taskId)) continue;
        try {
          archived.push(await archiveTaskNow(taskId));
        } catch (error) {
          logger.error("[WorkspaceSidebarItem] clear done: archive failed", { taskId, error });
        }
      }
      if (archived.length === 0) return null;
      return {
        count: archived.length,
        label: `${archived.length} session${archived.length === 1 ? "" : "s"} in ${workspaceSidebarLabel}`,
        restore: () => restoreArchivedTasks(archived),
      };
    },
    [archiveTaskNow, readOnlyReason, restoreArchivedTasks, workspaceSidebarLabel],
  );
  useEffect(() => {
    if (!isZaicodeProductMode()) return;
    return registerZaicodeArchiveSome(zaicodeSlotKey, archiveSomeTasks);
  }, [archiveSomeTasks, zaicodeSlotKey]);
  useEffect(() => {
    if (!isZaicodeProductMode()) return;
    return registerZaicodeArchiveAll(zaicodeSlotKey, archiveAllIdleTasks);
  }, [archiveAllIdleTasks, zaicodeSlotKey]);
  const handleArchiveTask = useCallback(
    async (taskId: string) => {
      if (readOnlyReason) {
        return null;
      }
      if (isZaicodeProductMode()) {
        try {
          const archivedMeta = await archiveTaskNow(taskId);
          pushArchiveUndo({
            label: `"${archivedMeta.title || taskId}"`,
            restore: () => restoreArchivedTasks([archivedMeta]),
          });
          return archivedMeta;
        } catch (error) {
          logger.error("[WorkspaceSidebarItem] archive failed", { taskId, error });
          reportArchiveFailure(error);
          return null;
        }
      }
      const previousTask = findCurrentTaskItem(taskId);
      const meta = await zcodeTaskService.archiveTask({
        taskId,
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      });
      removeTaskState(tab.workspacePath, taskId, tab.workspaceIdentity);
      if (tab.workspaceIdentity) {
        useRemoteTimelineTaskStore
          .getState()
          .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
        useRemotePinnedTaskStore
          .getState()
          .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
      }
      applyTaskQueryCacheMutation({
        previousTask: previousTask ?? meta,
        nextTask: meta,
        previousState: { pinned: false, archived: false },
        nextState: { pinned: false, archived: true },
      });
      return meta;
    },
    [
      archiveTaskNow,
      pushArchiveUndo,
      reportArchiveFailure,
      restoreArchivedTasks,
      removeTaskState,
      readOnlyReason,
      tab.workspaceIdentity,
      tab.workspacePath,
      findCurrentTaskItem,
      zcodeTaskService,
    ],
  );

  const handleSetTaskUnread = useCallback(
    async (taskId: string, unread: boolean) => {
      if (readOnlyReason) {
        return null;
      }
      const previousTask = findCurrentTaskItem(taskId);
      const meta = await zcodeTaskService.setTaskUnread({
        taskId,
        workspacePath: tab.workspacePath,
        unread,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      });
      setTaskUnreadIndicator(tab.workspacePath, taskId, unread, tab.workspaceIdentity);
      upsertOptimisticTaskListItem(tab.workspacePath, meta, tab.workspaceIdentity);
      if (tab.workspaceIdentity) {
        useRemoteTimelineTaskStore.getState().upsertTask(meta);
      }
      applyTaskQueryCacheMutation({
        previousTask: previousTask ?? meta,
        nextTask: meta,
        previousState: { pinned: false, archived: false },
        nextState: { pinned: false, archived: false },
      });
      return meta;
    },
    [
      setTaskUnreadIndicator,
      readOnlyReason,
      tab.workspaceIdentity,
      tab.workspacePath,
      findCurrentTaskItem,
      upsertOptimisticTaskListItem,
      zcodeTaskService,
    ],
  );

  const handleCopyRemoteWorkspaceError = useCallback(() => {
    if (!remoteWorkspaceError || remoteWorkspaceError.trim().length === 0) {
      return;
    }

    navigator.clipboard.writeText(remoteWorkspaceError).then(() => {
      setIsRemoteErrorCopied(true);
      if (remoteErrorCopyResetRef.current !== null) {
        window.clearTimeout(remoteErrorCopyResetRef.current);
      }
      remoteErrorCopyResetRef.current = window.setTimeout(() => {
        setIsRemoteErrorCopied(false);
        remoteErrorCopyResetRef.current = null;
      }, 1500);
    });
  }, [remoteWorkspaceError]);
  const renderWorkspaceIcon = () => {
    // workspace 行之前在 hover/展开时会把目录图标切成箭头，
    // 视觉上会多出一层“树形展开控件”的暗示；当前交互只需要保留项目图标本身，
    // 这样能减少噪音，也避免用户把它理解成独立的箭头开关。
    if (isExpanded && !isDisconnectedRemoteWorkspace) {
      return isRemoteWorkspace ? (
        <Cloud className="h-4 w-4 text-foreground-subtle" />
      ) : isHomeWorkspace ? (
        <House className="h-4 w-4 text-foreground-subtle" />
      ) : (
        <FolderOpen className="h-4 w-4 text-foreground-subtle" />
      );
    }

    return isRemoteWorkspace ? (
      <Cloud className="h-4 w-4 text-foreground-subtle" />
    ) : isHomeWorkspace ? (
      <House className="h-4 w-4 text-foreground-subtle" />
    ) : (
      <Folder className="h-4 w-4 text-foreground-subtle" />
    );
  };

  // ZAICODE：项目标题按 SAIPEN 就绪度淡淡着色（阻塞=红，进行中=金色进度，就绪=绿）。
  const zaicodeSaipen = useZaicodeSaipen(
    isZaicodeProductMode() ? tab.workspacePath : "",
    tab.workspaceIdentity,
  );
  // T-41: one verdict from the read model (SAIPEN projection + sessions + workers of this project).
  const zaicodeRuntime = useZaicodeProjectRuntime(
    isZaicodeProductMode() ? tab.workspacePath : "",
    tab.workspaceIdentity,
    zaicodeSaipen,
  );
  const boardShares = saipenBoardShares(zaicodeSaipen);
  // SRC-043: this row is how CONTINUE ALL and the session ▶ reach this project's own host.
  const zaicodeHasSaipenRef = useRef(false);
  zaicodeHasSaipenRef.current = Boolean(zaicodeSaipen);
  useEffect(() => {
    if (!isZaicodeProductMode() || readOnlyReason) return;
    return registerZaicodeProjectContinue(
      zaicodeSlotKey,
      createZaicodeContinueHandle({
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
        taskService: services.zcodeTaskService,
        agentService: services.zcodeAgentService,
      }),
    );
  }, [
    readOnlyReason,
    services.zcodeAgentService,
    services.zcodeTaskService,
    tab.remoteSessionId,
    tab.workspaceIdentity,
    tab.workspacePath,
    zaicodeSlotKey,
  ]);
  const handleContinueTask = useCallback(
    (taskId: string) => {
      const task = findCurrentTaskItem(taskId);
      if (!task) return;
      const decision = decideZaicodeSessionContinue(
        zaicodeSessionBriefOf(task, zaicodeSlotKey, { workspacePath: tab.workspacePath }),
        zaicodeHasSaipenRef.current,
      );
      if (decision.action === "open") {
        onSelectTask(tab.workspacePath, taskId, tab.workspaceIdentity);
        return;
      }
      const title = task.title || taskId;
      if (decision.action === "none") {
        toast(`"${title}" is ${decision.why}.`);
        return;
      }
      playZaicodeSound("ui.toggle");
      const handle = createZaicodeContinueHandle({
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
        taskService: services.zcodeTaskService,
        agentService: services.zcodeAgentService,
      });
      const sent = describeZaicodeContinueCommand(decision.command);
      void handle
        .send(taskId, decision.command)
        .then(() => toast(`Continued "${title}" → ${sent}`))
        .catch((error: unknown) => {
          logger.error("[WorkspaceSidebarItem] continue failed", { taskId, error });
          toast(`Could not continue "${title}": ${error instanceof Error ? error.message : String(error)}`, {
            variant: "warning",
          });
        });
    },
    [
      findCurrentTaskItem,
      onSelectTask,
      services.zcodeAgentService,
      services.zcodeTaskService,
      tab.remoteSessionId,
      tab.workspaceIdentity,
      tab.workspacePath,
      zaicodeSlotKey,
    ],
  );
  // ZAICODE (SRC-038): the operator's highlight for a project with work running / waiting.
  const zaicodeProjectWaitingLight = useZaicodeHighlight("projectWaiting", zaicodeWaitingCount > 0);
  const zaicodeProjectWorkingLight = useZaicodeHighlight("projectWorking", zaicodeRunningCount > 0);
  const zaicodeProjectLight = zaicodeProjectWaitingLight ?? zaicodeProjectWorkingLight;
  const readinessTint = zaicodeRuntime && zaicodeSaipen ? buildReadinessTint(zaicodeRuntime) : null;
  // Idle face of the ZAICODE row zone: working / waiting / switched off. Hover swaps it for
  // the actions in the same 60px, so nothing to the left ever moves.
  const zaicodeRowStatus = (
    <span className="flex shrink-0 items-center gap-1 text-ui-xs tabular-nums text-foreground-subtle">
      {zaicodeProjectOff ? (
        <span
          className="border border-border px-0.5 text-[10px] leading-3 text-foreground-subtlest"
          title="Switched off (Shift+click): no automatic agent or schedule works here"
          data-zaicode-project-off-badge
        >
          OFF
        </span>
      ) : null}
      {zaicodeLiveIndicator && zaicodeRunningCount > 0 ? (
        <span
          className="flex items-center gap-0.5"
          title={`${zaicodeRunningCount} session(s) working`}
          data-zaicode-project-working={zaicodeRunningCount}
        >
          <ZaicodeWorkingIcon className="size-3.5" />
          {zaicodeRunningCount > 1 ? zaicodeRunningCount : null}
        </span>
      ) : null}
      {zaicodeLiveIndicator && zaicodeWaitingCount > 0 ? (
        <span
          className="border border-[var(--color-warning)] px-0.5 text-[10px] leading-3 text-[var(--color-warning)]"
          title={`${zaicodeWaitingCount} session(s) waiting for you (question / permission)`}
        >
          ?{zaicodeWaitingCount > 1 ? zaicodeWaitingCount : ""}
        </span>
      ) : null}
    </span>
  );
  const workspaceLabelContent = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        {zaicodeProjectIsMain && zaicodeMainTask ? <ZaicodeProjectMainGlyph task={zaicodeMainTask} /> : renderWorkspaceIcon()}
      </span>
      <div
        {...withZaicodeHighlight(
          {
            className: "zaicode-list-label zaicode-project-label min-w-0 flex-1 truncate px-1 text-ui-base text-foreground-subtle",
            style: readinessTint?.style,
            title: readinessTint?.title,
          },
          zaicodeProjectLight,
        )}
        data-zaicode-readiness={zaicodeSaipen ? zaicodeRuntime?.verdict.state : undefined}
      >
        {workspaceSidebarLabel}
      </div>
      {isZaicodeProductMode() ? <ZaicodeProjectWorkerChips projectPath={tab.workspacePath} /> : null}
      {!zaicodeCompactRow && isZaicodeProductMode() && zaicodeLiveIndicator && zaicodeRunningCount > 0 ? (
        <span
          className="flex shrink-0 items-center gap-0.5 text-ui-xs tabular-nums text-foreground-subtle"
          title={`${zaicodeRunningCount} session(s) working`}
          data-zaicode-project-working={zaicodeRunningCount}
        >
          <ZaicodeWorkingIcon className="size-3.5" />
          {zaicodeRunningCount > 1 ? zaicodeRunningCount : null}
        </span>
      ) : null}
      {!zaicodeCompactRow && isZaicodeProductMode() && zaicodeLiveIndicator && zaicodeWaitingCount > 0 ? (
        <span
          className="shrink-0 border border-[var(--color-warning)] px-0.5 text-[10px] leading-3 text-[var(--color-warning)]"
          title={`${zaicodeWaitingCount} session(s) waiting for you (question / permission)`}
        >
          ?{zaicodeWaitingCount > 1 ? zaicodeWaitingCount : ""}
        </span>
      ) : null}
      {!isExpanded && taskListHasUnread ? (
        <span
          aria-hidden="true"
          data-workspace-unread-indicator="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500 dark:bg-sky-400"
        />
      ) : null}
      {!isExpanded && taskListLiveWorkflowCount > 0 ? (
        // 工作流运行行的组头汇总：
        // 只汇总在跑的 run；已结束未确认的行不上卷。
        <span
          data-workspace-workflow-indicator="true"
          data-count={String(taskListLiveWorkflowCount)}
          aria-label={intl.formatMessage(
            { id: "taskList.workflowRun.liveCount" },
            { count: String(taskListLiveWorkflowCount) },
          )}
          className="flex shrink-0 items-center gap-1 text-ui-xs leading-none text-foreground-subtle"
        >
          <span aria-hidden="true" className={cn("size-1.5 rounded-full", STATUS_DOT.running)} />
          {taskListLiveWorkflowCount > 1 ? taskListLiveWorkflowCount : null}
        </span>
      ) : null}
      {readOnlyReason ? (
        <ControlHintTooltip title={readOnlyReason} side="right" align="center">
          <span
            role="img"
            aria-label={readOnlyReason}
            tabIndex={0}
            className="flex size-4 shrink-0 items-center justify-center"
          >
            <CircleAlert className="size-3.5 text-destructive" />
          </span>
        </ControlHintTooltip>
      ) : null}
    </div>
  );

  return (
    <li
      ref={itemRef}
      style={itemStyle}
      className={cn(
        "space-y-2",
        zaicodeDimIdle && zaicodeRunningCount === 0 && zaicodeWaitingCount === 0 && "opacity-55",
        zaicodeProjectOff && "opacity-40",
      )}
      data-zaicode-project-off={zaicodeProjectOff ? "" : undefined}
    >
      <Collapsible
        className="flex flex-col gap-1"
        open={isExpanded && !isDisconnectedRemoteWorkspace}
        onOpenChange={handleWorkspaceOpenChange}
      >
        <BorderBeam
          size="line"
          colorVariant="colorful"
          duration={1.96}
          active={shouldShowRemoteConnectingBorderBeam}
          borderRadius={8}
        >
          <div
            className={cn(
              "group flex items-center gap-2 rounded-lg transition-[background-color,box-shadow]",
              isReconnectPending
                ? "bg-brand/10 workspace-remote-connecting-breathe"
                : isDisconnectedRemoteWorkspace
                  ? "bg-warning/8"
                  : null,
              // "sticky top-0 z-10", // TODO: 拖拽时让 workspace 项悬浮 不要抹掉
              isDragging && "bg-selected shadow-xl",
            )}
          >
            <CollapsibleTrigger asChild>
              <div
                role="button"
                tabIndex={0}
                data-testid={testId(TID_WORKSPACE_ITEM, tab.workspacePath)}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "default" }),
                  /*
                   * CollapsibleTrigger 会自动注入 aria-expanded。
                   * 这里复用了 ghost button 变体后，会命中全局 aria-expanded:bg-surface-hover
                   * 导致 workspace 项一展开就像"被选中"一样出现背景色。
                   * 局部把 aria-expanded 样式覆盖掉，只保留 hover，避免误导激活态。
                   * 断连的 remote workspace 不能展开任务列表，因此这里也要禁掉 hover 展开态提示，
                   * 避免用户看到“可展开”的反馈却点不开，只保留 warning 背景提示当前需要先重连。
                   */
                  "relative flex h-8 min-w-0 flex-1 justify-start gap-2 rounded-lg pl-2.5 pr-1 text-left text-foreground aria-expanded:bg-transparent aria-expanded:text-foreground",
                  "hover:bg-surface-hover hover:text-foreground",
                  isDisconnectedRemoteWorkspace &&
                    "hover:bg-transparent aria-expanded:bg-transparent",
                  // ZAICODE (SRC-043): no grab hand on hover; a row is clicked far more often than
                  // dragged, and the drag still works (8 px threshold) and shows its own overlay.
                  sortableBindings && !isZaicodeProductMode() && "cursor-grab active:cursor-grabbing",
                )}
                onMouseEnter={zaicodeHoverZone ? undefined : () => setWorkspaceRowHovered(true)}
                // 行在轮询刷新时可能重挂载，指针已在行内时不会再触发 mouseenter；移动即补上 hover。
                onMouseMove={zaicodeHoverZone ? undefined : () => setWorkspaceRowHovered(true)}
                onMouseLeave={zaicodeHoverZone ? undefined : () => setWorkspaceRowHovered(false)}
                onClickCapture={(event) => {
                  if (isZaicodeProductMode() && event.shiftKey && !event.ctrlKey && !event.metaKey) {
                    // ZAICODE：Shift+点击开关项目；关闭的项目变暗，自动 agent / Scheduler 不再处理它。
                    event.preventDefault();
                    event.stopPropagation();
                    playZaicodeSound("ui.toggle");
                    void toggleZaicodeProjectDisabled(zaicodeSlotKey);
                    return;
                  }
                  if (!isZaicodeProductMode() || !(event.ctrlKey || event.metaKey)) return;
                  // ZAICODE：Ctrl+点击把项目发到下方槽位（默认 SIDE2），不展开/不新建会话。
                  event.preventDefault();
                  event.stopPropagation();
                  setZaicodeSlotGroup(zaicodeSlotKey, zaicodeCtrlClickSlot);
                }}
                onContextMenu={(event) => {
                  if (!isZaicodeProductMode()) return;
                  // ZAICODE：项目行（含文件夹图标）右键总是打开项目菜单，第一屏就是槽位选择。
                  event.preventDefault();
                  event.stopPropagation();
                  setWorkspaceRowHovered(true);
                  setWorkspaceActionMenuOpen(true);
                }}
                onFocusCapture={() => setWorkspaceRowFocusWithin(true)}
                onBlurCapture={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setWorkspaceRowFocusWithin(false);
                  }
                }}
                {...(sortableBindings?.attributes ?? {})}
                {...(sortableBindings?.listeners ?? {})}
              >
                {sshWorkspaceTooltipDetails ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>{workspaceLabelContent}</TooltipTrigger>
                      <TooltipContent
                        side="right"
                        align="start"
                        sideOffset={6}
                        className="max-w-80 flex-col items-start gap-2 p-2.5 text-left"
                      >
                        <span className="text-ui-sm font-medium text-tooltip-foreground">
                          {intl.formatMessage({
                            id: "workspaceSidebar.sshConnectionTitle",
                          })}
                        </span>
                        <dl className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-ui-sm/relaxed text-tooltip-foreground">
                          {sshWorkspaceTooltipDetails.alias ? (
                            <>
                              <dt className="font-medium">
                                {intl.formatMessage({
                                  id: "workspaceSidebar.sshConnectionAlias",
                                })}
                              </dt>
                              <dd className="min-w-0 break-all font-mono">
                                {sshWorkspaceTooltipDetails.alias}
                              </dd>
                            </>
                          ) : null}
                          <dt className="font-medium">
                            {intl.formatMessage({
                              id: "workspaceSidebar.sshConnectionHost",
                            })}
                          </dt>
                          <dd className="min-w-0 break-all font-mono">
                            {sshWorkspaceTooltipDetails.hostLabel}
                          </dd>
                          <dt className="font-medium">
                            {intl.formatMessage({
                              id: "workspaceSidebar.sshConnectionPath",
                            })}
                          </dt>
                          <dd className="min-w-0 break-all font-mono">
                            {sshWorkspaceTooltipDetails.workspacePath}
                          </dd>
                        </dl>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  workspaceLabelContent
                )}

                <div className="flex shrink-0 items-center gap-2">
                  {/* {isRemoteWorkspace && isReconnectPending ? (
                    <ReconnectingRemoteWorkspaceLogTooltip
                      logs={reconnectRuntimeLogs}
                    />
                  ) : null} */}
                  <div
                    className={cn(
                      "flex shrink-0 items-center",
                      zaicodeCompactRow ? "w-[60px] justify-end" : "gap-1",
                    )}
                    data-zaicode-row-zone={
                      zaicodeHoverZone ? "hover" : zaicodeCompactRow ? (shouldMountWorkspaceRowActions ? "actions" : "status") : undefined
                    }
                  >
                    {zaicodeCompactRow && (zaicodeHoverZone || !shouldMountWorkspaceRowActions) ? (
                      <span className={cn("flex", zoneStatusClass)}>{zaicodeRowStatus}</span>
                    ) : null}
                    {mountRowActions ? (
                      <DropdownMenu
                        open={workspaceActionMenuOpen}
                        onOpenChange={setWorkspaceActionMenuOpen}
                      >
                        <ControlHintTooltip title={intl.formatMessage({ id: "common.more" })}>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size={zaicodeCompactRow ? "icon-xs" : "icon-sm"}
                              className={cn(
                                "shrink-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                                zaicodeCompactRow && "order-last",
                                zoneActionClass,
                              )}
                              onMouseDown={handleActionMouseDown}
                              aria-label={intl.formatMessage({ id: "common.more" })}
                            >
                              <Ellipsis className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                        </ControlHintTooltip>
                        <DropdownMenuContent align="end" onClick={handleActionMenuClick}>
                          {zaicodeCompactRow ? (
                            <>
                              <DropdownMenuItem
                                disabled={Boolean(readOnlyReason)}
                                onSelect={() => {
                                  if (!readOnlyReason) onStartDraftInWorkspace(tab.workspacePath, tab.workspaceIdentity);
                                }}
                              >
                                <MessageCirclePlus className="h-3.5 w-3.5" />
                                New session
                              </DropdownMenuItem>
                              {showFileTreeAction ? (
                                <DropdownMenuItem
                                  disabled={Boolean(readOnlyReason)}
                                  onSelect={() =>
                                    onOpenFileTree?.({
                                      workspacePath: tab.workspacePath,
                                      workspaceName: tab.label,
                                      workspaceIdentity: tab.workspaceIdentity,
                                      workspaceRemoteSessionId: tab.remoteSessionId,
                                    })
                                  }
                                >
                                  <ListTree className="h-3.5 w-3.5" />
                                  Files
                                </DropdownMenuItem>
                              ) : null}
                              <DropdownMenuItem
                                onSelect={() => void toggleZaicodeProjectDisabled(zaicodeSlotKey)}
                                title="Shift+click on the project does the same"
                              >
                                <Power className="h-3.5 w-3.5" />
                                {zaicodeProjectOff ? "Switch project on" : "Switch project off"}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                            </>
                          ) : null}
                          <RemoteSyncMenuItems
                            canSyncSkills={showRemoteSkillSyncAction}
                            canSyncMcp={showRemoteSkillSyncAction}
                            canSyncPlugins={showRemoteSkillSyncAction}
                            stopMouseDownPropagation
                            onOpenSkillSync={() => setRemoteSkillSyncOpen(true)}
                            onOpenMcpSync={() => setRemoteMcpSyncOpen(true)}
                            onOpenPluginSync={() => setRemotePluginSyncOpen(true)}
                          />
                          {isZaicodeProductMode() && !tab.workspaceIdentity?.trim() ? (
                            <ZaicodeProjectEngineMenuItems projectPath={tab.workspacePath} />
                          ) : null}
                          {isZaicodeProductMode() ? (
                            <>
                              <DropdownMenuLabel
                                className="text-ui-xs text-foreground-subtle"
                                title={`Ctrl+click on the project sends it to ${zaicodeCtrlClickSlot}`}
                              >
                                Move to slot · now {zaicodeSlotGroup}
                              </DropdownMenuLabel>
                              <DropdownMenuRadioGroup
                                value={zaicodeSlotGroup}
                                onValueChange={(value) =>
                                  setZaicodeSlotGroup(zaicodeSlotKey, value as ZaicodeSlotGroup)
                                }
                                className="grid grid-cols-3 gap-0.5 px-1 pb-1"
                                data-zaicode-slot-picker
                              >
                                {ZAICODE_SLOT_GROUPS.map((group) => (
                                  <DropdownMenuRadioItem
                                    key={group}
                                    value={group}
                                    className="min-h-6 justify-center border border-border px-1 py-0.5 text-ui-xs data-[state=checked]:border-[var(--zaicode-highlight,var(--color-border-hover))] data-[state=checked]:bg-selected [&>[data-slot=dropdown-menu-radio-item-indicator]]:hidden"
                                  >
                                    {group}
                                  </DropdownMenuRadioItem>
                                ))}
                              </DropdownMenuRadioGroup>
                              <DropdownMenuSeparator />
                            </>
                          ) : null}
                          {isZaicodeProductMode() && !readOnlyReason ? (
                            <DropdownMenuItem
                              onMouseDown={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                              }}
                              onSelect={() => void handleArchiveAllTasks()}
                              title="Archive every idle session of this project (running ones stay). Ctrl+Z restores."
                            >
                              <Archive className="h-3.5 w-3.5" />
                              Archive all sessions
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuItem
                            data-testid={testId(TID_WORKSPACE_CLOSE, tab.workspacePath)}
                            onMouseDown={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                            }}
                            onSelect={(event) => {
                              event.preventDefault();
                              void handleRemoveWorkspace();
                            }}
                          >
                            <XIcon className="h-3.5 w-3.5" />
                            {intl.formatMessage({
                              id: "workspaceSidebar.remove",
                            })}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                    {shouldMountWorkspaceRowActions && showFileTreeAction && !zaicodeCompactRow ? (
                      <span className="shrink-0">
                        {/* Project 文件树入口以前单独覆盖 hover:bg-surface-hover，
                            与 Pinned / Grouped 的 bg-hover 不一致；三种入口统一复用同一 action。 */}
                        <TaskRowActionButton
                          // 该按钮默认继承 ghost 的主前景色，导致同组的三个图标明暗不一致。
                          className="text-foreground-subtle hover:text-foreground"
                          label={intl.formatMessage({
                            id: "workspaceSidebar.showFileTree",
                          })}
                          onClick={handleOpenWorkspaceFileTree}
                          showTooltip
                          disabledReason={readOnlyReason}
                          testId={testId(TID_WORKSPACE_FILE_TREE_BUTTON, tab.workspacePath)}
                        >
                          <ListTree className="h-3.5 w-3.5" />
                        </TaskRowActionButton>
                      </span>
                    ) : null}
                    {showRemoteConnectionErrorNotice ? (
                      remoteWorkspaceError ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div
                                className="flex size-6 shrink-0 items-center justify-center !text-warning cursor-help"
                                aria-label={intl.formatMessage({
                                  id: "workspaceSidebar.notConnected",
                                })}
                              >
                                <InfoIcon className="h-3.5 w-3.5" />
                              </div>
                            </TooltipTrigger>
                            <TooltipContent
                              side="top"
                              align="center"
                              sideOffset={4}
                              className="w-72 max-w-72 items-center gap-2 p-2.5"
                            >
                              {/*
                               * 远端连接失败 tooltip 之前拆成“标题 + 内层卡片”两段结构，
                               * 在 sidebar 这种高密度区域里会显得层级过多，像一个迷你弹窗，不够轻。
                               * 这里收敛回普通 tooltip 语义：一层浮层里直接放错误正文和复制按钮，
                               * 保留可读性与复制能力，同时避免视觉上过度设计。
                               */}
                              <pre className="max-h-32 min-w-0 flex-1 overflow-auto text-ui-sm/relaxed whitespace-pre-wrap break-words font-mono text-tooltip-foreground">
                                {remoteWorkspaceError}
                              </pre>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-md"
                                className="mt-0.5 size-6 shrink-0 text-tooltip-foreground/80 hover:bg-tooltip-tag hover:text-tooltip-foreground"
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  handleCopyRemoteWorkspaceError();
                                }}
                                title={intl.formatMessage({
                                  id: isRemoteErrorCopied
                                    ? "chat.toolCall.copyError.copied"
                                    : "chat.toolCall.copyError",
                                })}
                                aria-label={intl.formatMessage({
                                  id: isRemoteErrorCopied
                                    ? "chat.toolCall.copyError.copied"
                                    : "chat.toolCall.copyError",
                                })}
                              >
                                {isRemoteErrorCopied ? (
                                  <CheckIcon className="size-3" />
                                ) : (
                                  <CopyIcon className="size-3" />
                                )}
                              </Button>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <ControlHintTooltip
                          title={intl.formatMessage({
                            id: "workspaceSidebar.notConnected",
                          })}
                        >
                          <div
                            className="flex size-6 shrink-0 items-center justify-center !text-warning"
                            aria-label={intl.formatMessage({
                              id: "workspaceSidebar.notConnected",
                            })}
                          >
                            <InfoIcon className="h-3.5 w-3.5" />
                          </div>
                        </ControlHintTooltip>
                      )
                    ) : null}
                    {showReconnectAction ? (
                      isReconnectPending ? (
                        <ReconnectingRemoteWorkspaceLogTooltip logs={reconnectRuntimeLogs}>
                          {/* SSH workspace 重连中时，右侧原本只有 spinning 图标，
                              用户无法在聊天页任务列表里确认连接卡在哪一步。这里复用 SSH dialog 的连接日志 tooltip，
                              保持行内布局稳定，同时把诊断信息放到 hover 浮层里。 */}
                          <div
                            role="status"
                            className={cn(
                              buttonVariants({ variant: "ghost", size: "icon-sm" }),
                              "shrink-0 text-foreground opacity-100 hover:bg-surface-hover hover:text-foreground",
                            )}
                            onMouseDown={handleActionMouseDown}
                            aria-label={intl.formatMessage({
                              id: "workspaceSidebar.connecting",
                            })}
                          >
                            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                          </div>
                        </ReconnectingRemoteWorkspaceLogTooltip>
                      ) : (
                        <ControlHintTooltip
                          title={intl.formatMessage({
                            id: "workspaceSidebar.reconnect",
                          })}
                          side="right"
                          align="center"
                        >
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="shrink-0 text-foreground opacity-100 hover:bg-surface-hover hover:text-foreground disabled:opacity-100"
                            onMouseDown={handleActionMouseDown}
                            onClick={handleReconnectRemoteWorkspace}
                            aria-label={intl.formatMessage({
                              id: "workspaceSidebar.reconnect",
                            })}
                          >
                            <RefreshCwIcon className="h-3.5 w-3.5" />
                          </Button>
                        </ControlHintTooltip>
                      )
                    ) : shouldMountWorkspaceRowActions && !zaicodeCompactRow ? (
                      <ControlHintTooltip
                        title={readOnlyReason ?? intl.formatMessage({ id: "taskList.newThread" })}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
                          onMouseDown={handleActionMouseDown}
                          onClick={handleCreateThreadClick}
                          disabled={Boolean(readOnlyReason)}
                          aria-label={intl.formatMessage({
                            id: "taskList.newThread",
                          })}
                        >
                          <MessageCirclePlus className="h-3.5 w-3.5" />
                        </Button>
                      </ControlHintTooltip>
                    ) : null}
                    {mountRowActions && isZaicodeProductMode() ? (
                      <ControlHintTooltip
                        title={
                          zaicodeMainSessionId
                            ? "MAIN — open this project's MAIN session (the iron slot where the work is started and planned)"
                            : "MAIN — no MAIN session yet: open a new one (your first message makes it MAIN)"
                        }
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size={zaicodeCompactRow ? "icon-xs" : "icon-sm"}
                          className={cn(
                            "shrink-0 hover:bg-surface-hover hover:text-foreground",
                            zaicodeMainSessionId
                              ? "text-[var(--zaicode-highlight,var(--color-warning))]"
                              : "text-foreground-subtle",
                            zoneActionClass,
                          )}
                          onMouseDown={handleActionMouseDown}
                          onClick={handleZaicodeMainClick}
                          aria-label={zaicodeMainSessionId ? "Open MAIN session" : "Create MAIN session"}
                          data-zaicode-main-button={zaicodeMainSessionId ? "open" : "create"}
                        >
                          <span className="text-ui-sm leading-none">{zaicodeMainSessionId ? "◆" : "◇"}</span>
                        </Button>
                      </ControlHintTooltip>
                    ) : null}
                    {mountRowActions && isZaicodeProductMode() && !readOnlyReason ? (
                      <ControlHintTooltip title={`START ${ZAICODE_SAIPEN_START_COMMAND} — continues MAIN (or the session that was cut off); a fresh MAIN only when there is nothing to continue`}>
                        <Button
                          type="button"
                          variant="ghost"
                          size={zaicodeCompactRow ? "icon-xs" : "icon-sm"}
                          className={cn("shrink-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground", zoneActionClass)}
                          onMouseDown={handleActionMouseDown}
                          onClick={handleStartSaipenClick}
                          aria-label={`START: continue MAIN with ${ZAICODE_SAIPEN_START_COMMAND}`}
                        >
                          <Play className="h-3.5 w-3.5" />
                        </Button>
                      </ControlHintTooltip>
                    ) : null}
                  </div>
                </div>
                {isZaicodeProductMode() && boardShares ? (
                  // SAIPEN board strip, filled from the right edge: BLOCKED red, TODO yellow, DONE green.
                  <span
                    className="pointer-events-none absolute bottom-0 left-2.5 flex h-[3px] flex-row-reverse"
                    style={{
                      width: "var(--zaicode-list-label-width, 112px)",
                      maxWidth: "calc(100% - 20px)",
                    }}
                    data-zaicode-board-strip
                  >
                    <span style={{ width: `${boardShares.blocked * 100}%`, background: "var(--color-destructive)" }} />
                    <span style={{ width: `${boardShares.todo * 100}%`, background: "var(--color-warning)" }} />
                    <span style={{ width: `${boardShares.done * 100}%`, background: "var(--color-success)" }} />
                  </span>
                ) : isZaicodeProductMode() && zaicodeSaipen && zaicodeRuntime?.color ? (
                  <span
                    className="pointer-events-none absolute bottom-0 left-2.5 h-[3px]"
                    style={{
                      width: "var(--zaicode-list-label-width, 112px)",
                      maxWidth: "calc(100% - 20px)",
                      backgroundColor: zaicodeRuntime.color,
                    }}
                  />
                ) : null}
              </div>
            </CollapsibleTrigger>
          </div>
        </BorderBeam>

        <CollapsibleContent>
          <TaskList
            workspacePath={tab.workspacePath}
            remoteSessionId={tab.remoteSessionId}
            workspaceIdentity={tab.workspaceIdentity}
            tasks={zaicodeChildTasks}
            pinnedTasks={EMPTY_PINNED_TASKS}
            activeTaskId={isActiveWorkspace ? activeTaskId : null}
            onSelectTask={handleSelectTask}
            showCreateButton={false}
            showFooter={false}
            loading={taskListLoading}
            hasMore={taskListHasMore}
            onShowMore={onShowMoreTasks}
            onRenameTask={handleRenameTask}
            onSetTaskPinned={handleSetTaskPinned}
            onArchiveTask={handleArchiveTask}
            onSetTaskUnread={handleSetTaskUnread}
            mainSessionId={isZaicodeProductMode() ? zaicodeMainSessionId : null}
            {...(isZaicodeProductMode() ? { onContinueTask: handleContinueTask } : {})}
            {...(isZaicodeProductMode()
              ? { onArchiveAllTasks: handleArchiveAllTasks }
              : {})}
            readOnlyReason={readOnlyReason}
          />
        </CollapsibleContent>
      </Collapsible>
      <RemoteSyncDialogs
        canSyncSkills={showRemoteSkillSyncAction}
        canSyncMcp={showRemoteSkillSyncAction}
        canSyncPlugins={showRemoteSkillSyncAction}
        skillOpen={remoteSkillSyncOpen}
        mcpOpen={remoteMcpSyncOpen}
        pluginOpen={remotePluginSyncOpen}
        onSkillOpenChange={setRemoteSkillSyncOpen}
        onMcpOpenChange={setRemoteMcpSyncOpen}
        onPluginOpenChange={setRemotePluginSyncOpen}
        localSkillSyncService={baseServices.skillSyncService}
        remoteSkillSyncService={services.skillSyncService}
        localMcpSyncService={baseServices.mcpSyncService}
        remoteMcpSyncService={services.mcpSyncService}
        localPluginSyncService={baseServices.pluginSyncService}
        remotePluginSyncService={services.pluginSyncService}
        localZCodeAgentService={baseServices.zcodeAgentService}
        remoteZCodeAgentService={services.zcodeAgentService}
        remoteTarget={tab.remoteTarget}
        skillWorkspacePath={tab.workspacePath}
        mcpWorkspacePath={tab.workspacePath}
        pluginWorkspacePath={tab.workspacePath}
        pluginLocalWorkspacePath={tab.localWorkspacePath}
        mcpLocalWorkspacePath={tab.localWorkspacePath}
        workspaceIdentity={tab.workspaceIdentity}
        onSkillsSynced={async () => {
          await invalidateDeferredDraftSessionForSkillChange({
            zcodeSessionService: services.zcodeSessionService,
            workspacePath: tab.workspacePath,
            workspaceIdentity: tab.workspaceIdentity,
            reason: "sidebar-remote-skill-sync",
          });
          await refreshSharedSkillStoreForWorkspace({
            workspacePath: tab.workspacePath,
            workspaceIdentity: tab.workspaceIdentity,
            skillsService: services.skillsService,
          });
        }}
        onMcpSynced={async () => {
          await useMcpStore
            .getState()
            .ensureLoadedForWorkspace(
              tab.workspacePath,
              services.mcpSyncService,
              tab.workspaceIdentity,
            );
        }}
        onPluginsSynced={async () => {
          await refreshWorkspacePluginCapabilitiesAfterRemoteSync({
            commandsService: services.commandsService,
            mcpSyncService: services.mcpSyncService,
            reason: "sidebar-remote-plugin-sync",
            skillsService: services.skillsService,
            workspaceIdentity: tab.workspaceIdentity,
            workspacePath: tab.workspacePath,
            zcodeAgentService: services.zcodeAgentService,
            zcodeSessionService: services.zcodeSessionService,
          });
        }}
      />
    </li>
  );
});
WorkspaceSidebarItem.displayName = "WorkspaceSidebarItem";
