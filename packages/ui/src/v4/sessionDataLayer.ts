// SessionDataLayer（纯数据层）。
// Map<topic, SessionStore>，不知道「显示」这回事；生命周期 = 引用计数：
// 有 pane 引用 → 订阅；归零 → 延迟退订（keep-warm，防拖拽/切 pane 抖动）。
// 一个实例对应一条 host 连接；跨 workspace 分屏在 shell 层做
// Map<workspaceKey, SessionDataLayer>，本层不感知 workspace。
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import type { SessionOpenKind } from "@/lib/sessionOpenArmsTelemetry.js";
import { conversationTopic, type ConversationTransport } from "@/v4/transport.js";
import { logger } from "@/logger.js";
import type {
  CommandsQueryParams,
  CommandsQueryResult,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { isZaicodeCleanupInProgress, isSessionRetired } from "@/zaicode/zaicodeCleanupFence.js";
import { adaptivePrefetchCoordinator } from "@/v4/adaptivePrefetchCoordinator.js";

/** pane 持有的租约；release 幂等。 */
export interface SessionLease {
  readonly sessionId: string;
  readonly store: ConversationProjectionStore;
  /** 由数据层按 projection 生命周期判定，避免 pane 首次 render 时 snapshot 仍为空。 */
  readonly openKind: SessionOpenKind;
  /** pane acquire 的 Renderer 单调时钟起点。 */
  readonly startedAt: number;
  release(): void;
}

interface SessionDataLayerOptions {
  transport: ConversationTransport;
  /** 引用归零后延迟退订窗口（ms），默认 30s。 */
  keepWarmMs?: number;
  /** 预热池最大常驻容量，默认 3。 */
  maxWarmCapacity?: number;
  /** 是否为远程连接（远程连接池容量更严，默认 1）。 */
  isRemote?: boolean;
}

const SESSION_DATA_LAYER_KEEP_WARM_MS = 30_000;
const E2E_SESSION_DATA_LAYER_KEEP_WARM_MS = 1_000;
const DEFAULT_WARM_CAPACITY = 3;
const REMOTE_WARM_CAPACITY = 1;

function resolveSessionDataLayerKeepWarmMs(
  e2eStoreBridgeEnabled = shouldExposeE2EStoreBridge(),
): number {
  return e2eStoreBridgeEnabled
    ? E2E_SESSION_DATA_LAYER_KEEP_WARM_MS
    : SESSION_DATA_LAYER_KEEP_WARM_MS;
}

interface SessionEntry {
  store: ConversationProjectionStore;
  refCount: number;
  paneRefCount: number;
  keepWarmTimer: ReturnType<typeof setTimeout> | null;
  lastAccessedAt: number;
  connectPromise?: Promise<void>;
}

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function isHighMemoryPressure(): boolean {
  try {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } })?.memory;
    if (mem && mem.jsHeapSizeLimit > 0) {
      return mem.usedJSHeapSize / mem.jsHeapSizeLimit > 0.8;
    }
  } catch {
    // Ignore memory check errors
  }
  return false;
}

export class SessionDataLayer {
  readonly readHostNow = (): number | null => this.disposed ? null : this.transport.readHostNow?.() ?? null;
  private readonly transport: ConversationTransport;
  private readonly keepWarmMs: number;
  private readonly maxWarmCapacity: number;
  private readonly isRemote: boolean;
  private readonly entries = new Map<string, SessionEntry>();
  private readonly prefetchLeases = new Map<string, SessionLease>();
  private readonly prefetchQueue: string[] = [];
  private readonly inFlightColdPrefetches = new Set<string>();
  private readonly offFrame: () => void;
  private disposed = false;

  get activeColdPrefetches(): number {
    return this.inFlightColdPrefetches.size;
  }

  constructor(options: SessionDataLayerOptions) {
    this.transport = options.transport;
    this.keepWarmMs = options.keepWarmMs ?? resolveSessionDataLayerKeepWarmMs();
    this.isRemote = options.isRemote ?? false;
    this.maxWarmCapacity = options.maxWarmCapacity ?? (this.isRemote ? REMOTE_WARM_CAPACITY : DEFAULT_WARM_CAPACITY);
    // 连接级单监听：按 topic 扇入到各 store（pane 间共享的正是这一条连接）。
    this.offFrame = this.transport.onFrame((frame, context) => {
      this.entries.get(frame.topic)?.store.handleFrame(frame, context);
    });
  }

  /**
   * 取得 session 的投影 store。首个引用触发 subscribe（新开 pane 就是一次
   * subscribe，与刷新、新设备同一路径）；重复 acquire 共享同一 store（readonly，
   * 同 session 多 pane = 多视图）。
   */
  acquire(sessionId: string, isPrefetch = false): SessionLease {
    if (this.disposed) {
      throw new Error("SessionDataLayer 已释放，不能再 acquire");
    }
    if (isSessionRetired(sessionId)) {
      throw new Error(`Cannot acquire retired session: ${sessionId}`);
    }
    const topic = conversationTopic(sessionId);
    const startedAt = monotonicNow();

    // 前台直接打开优先于预热队列，并清除推测冷却
    if (!isPrefetch) {
      adaptivePrefetchCoordinator.clearCooldown(sessionId);
      const qIdx = this.prefetchQueue.indexOf(sessionId);
      if (qIdx !== -1) {
        this.prefetchQueue.splice(qIdx, 1);
      }
    }

    let entry = this.entries.get(topic);
    let openKind: SessionOpenKind;
    if (entry) {
      openKind = entry.keepWarmTimer !== null ? "keep_warm" : "warm";
      entry.refCount++;
      if (!isPrefetch) {
        entry.paneRefCount++;
      }
      entry.lastAccessedAt = startedAt;
      if (entry.keepWarmTimer !== null) {
        clearTimeout(entry.keepWarmTimer);
        entry.keepWarmTimer = null;
      }
    } else {
      const store = new ConversationProjectionStore(topic, this.transport);
      const connectPromise = store.connect({ rendererPrepareStartedAt: startedAt });
      entry = {
        store,
        refCount: 1,
        paneRefCount: isPrefetch ? 0 : 1,
        keepWarmTimer: null,
        lastAccessedAt: startedAt,
        connectPromise,
      };
      this.entries.set(topic, entry);
      openKind = "cold";
    }

    // 若活跃 pane 接管了预热中的 session，平滑转换并释放预热池引用的 lease
    if (!isPrefetch && this.prefetchLeases.has(sessionId)) {
      const prefetchLease = this.prefetchLeases.get(sessionId);
      this.prefetchLeases.delete(sessionId);
      prefetchLease?.release();
    }

    logger.lifecycle.info("v4 session data lease acquired", {
      event: "v4.session_data.acquire",
      isPrefetch,
      keepWarm: entry.keepWarmTimer !== null,
      module: "ui.v4.session_data_layer",
      openKind,
      refCount: entry.refCount,
      sessionId,
      status: "completed",
      topic,
    });

    let released = false;
    return {
      sessionId,
      store: entry.store,
      openKind,
      startedAt,
      release: () => {
        if (released) return;
        released = true;
        if (!isPrefetch) {
          entry.paneRefCount = Math.max(0, entry.paneRefCount - 1);
        }
        this.releaseEntry(topic);
      },
    };
  }

  /**
   * 适应性预热候选 session：受容量、内存压力、并发和 Clean Slate 约束。
   * 不发送 prompt，不产生付费调用。
   */
  prefetch(sessionId: string): void {
    if (this.disposed || isZaicodeCleanupInProgress() || isSessionRetired(sessionId)) {
      return;
    }
    const topic = conversationTopic(sessionId);
    const existing = this.entries.get(topic);
    if (existing) {
      existing.lastAccessedAt = monotonicNow();
      if (existing.keepWarmTimer !== null) {
        clearTimeout(existing.keepWarmTimer);
        existing.keepWarmTimer = null;
      }
      // 保持明确所有权不变量：无引用 entry 必须持有 real prefetch lease，不能无主常驻
      if (!this.prefetchLeases.has(sessionId)) {
        const lease = this.acquire(sessionId, true);
        this.prefetchLeases.set(sessionId, lease);
      }
      return;
    }
    if (this.prefetchLeases.has(sessionId) || this.inFlightColdPrefetches.has(sessionId)) {
      return;
    }
    if (this.inFlightColdPrefetches.size >= 1) {
      if (!this.prefetchQueue.includes(sessionId)) {
        if (this.prefetchQueue.length >= 10) {
          this.prefetchQueue.shift();
        }
        this.prefetchQueue.push(sessionId);
      }
      return;
    }

    this.executeColdPrefetch(sessionId);
  }

  private executeColdPrefetch(sessionId: string): void {
    const effectiveCapacity = isHighMemoryPressure() ? 1 : this.maxWarmCapacity;
    if (this.entries.size >= effectiveCapacity) {
      this.evictLeastRecentlyUsed();
    }
    if (this.entries.size >= effectiveCapacity) {
      return; // 所有常驻 session 均被活跃面板持有，放弃驱逐与预热
    }

    this.inFlightColdPrefetches.add(sessionId);
    let lease: SessionLease | null = null;
    try {
      lease = this.acquire(sessionId, true);
      this.prefetchLeases.set(sessionId, lease);
    } catch (error) {
      logger.warn("[sessionDataLayer] prefetch acquire error", { sessionId, error });
      this.inFlightColdPrefetches.delete(sessionId);
      adaptivePrefetchCoordinator.markCooldown(sessionId);
      this.pumpPrefetchQueue();
      return;
    }

    const topic = conversationTopic(sessionId);
    const entry = this.entries.get(topic);
    const connectPromise = entry?.connectPromise ?? Promise.resolve();

    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<void>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(new Error(`Prefetch connect timed out for session ${sessionId}`));
      }, 10_000);
    });

    Promise.race([connectPromise, timeoutPromise])
      .then(() => {
        if (entry?.store.getState().status === "error") {
          throw new Error(entry.store.getState().lastError ?? "subscription error");
        }
      })
      .catch((error) => {
        logger.warn("[sessionDataLayer] prefetch connect error or timeout", { sessionId, error });
        adaptivePrefetchCoordinator.markCooldown(sessionId);
        this.cancelPrefetch(sessionId);
      })
      .finally(() => {
        if (timeoutTimer !== null) {
          clearTimeout(timeoutTimer);
        }
        this.inFlightColdPrefetches.delete(sessionId);
        this.pumpPrefetchQueue();
      });
  }

  private pumpPrefetchQueue(): void {
    if (this.disposed || isZaicodeCleanupInProgress()) {
      this.prefetchQueue.length = 0;
      return;
    }
    if (this.inFlightColdPrefetches.size >= 1) {
      return;
    }
    while (this.prefetchQueue.length > 0) {
      const nextId = this.prefetchQueue.shift()!;
      if (isSessionRetired(nextId) || isZaicodeCleanupInProgress()) {
        continue;
      }
      const topic = conversationTopic(nextId);
      const existing = this.entries.get(topic);
      if (existing && existing.paneRefCount > 0) {
        continue;
      }
      if (this.prefetchLeases.has(nextId)) {
        continue;
      }
      this.executeColdPrefetch(nextId);
      break;
    }
  }

  cancelPrefetch(sessionId: string): void {
    const qIdx = this.prefetchQueue.indexOf(sessionId);
    if (qIdx !== -1) {
      this.prefetchQueue.splice(qIdx, 1);
    }
    const lease = this.prefetchLeases.get(sessionId);
    if (lease) {
      this.prefetchLeases.delete(sessionId);
      lease.release();
    }
  }

  clearPrefetches(): void {
    this.prefetchQueue.length = 0;
    for (const lease of this.prefetchLeases.values()) {
      lease.release();
    }
    this.prefetchLeases.clear();
  }

  private evictLeastRecentlyUsed(): void {
    let oldestTopic: string | null = null;
    let oldestTime = Infinity;
    for (const [topic, entry] of this.entries.entries()) {
      if (entry.paneRefCount === 0 && entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestTopic = topic;
      }
    }
    if (!oldestTopic) return;
    const entry = this.entries.get(oldestTopic);
    if (!entry) return;
    for (const [sId, lease] of this.prefetchLeases.entries()) {
      if (conversationTopic(sId) === oldestTopic) {
        this.prefetchLeases.delete(sId);
        lease.release();
        break;
      }
    }
    if (entry.keepWarmTimer !== null) {
      clearTimeout(entry.keepWarmTimer);
      entry.keepWarmTimer = null;
    }
    this.entries.delete(oldestTopic);
    void entry.store.close();
  }

  clearWarmPool(): void {
    this.clearPrefetches();
    for (const [topic, entry] of [...this.entries.entries()]) {
      if (entry.paneRefCount === 0) {
        if (entry.keepWarmTimer !== null) {
          clearTimeout(entry.keepWarmTimer);
        }
        this.entries.delete(topic);
        void entry.store.close();
      }
    }
  }

  invalidateSession(sessionId: string): void {
    this.cancelPrefetch(sessionId);
    const topic = conversationTopic(sessionId);
    const entry = this.entries.get(topic);
    if (entry) {
      if (entry.keepWarmTimer !== null) {
        clearTimeout(entry.keepWarmTimer);
      }
      this.entries.delete(topic);
      void entry.store.close();
    }
  }

  getWarmSnapshot(sessionId: string): ConversationSnapshot | null {
    const topic = conversationTopic(sessionId);
    return this.entries.get(topic)?.store.getState().snapshot ?? null;
  }

  getWarmStore(sessionId: string): ConversationProjectionStore | null {
    const topic = conversationTopic(sessionId);
    return this.entries.get(topic)?.store ?? null;
  }

  isWarm(sessionId: string): boolean {
    const topic = conversationTopic(sessionId);
    const entry = this.entries.get(topic);
    if (!entry) return false;
    const state = entry.store.getState();
    return Boolean(state.snapshot) || state.status === "live" || state.status === "connecting";
  }

  /** 当前活跃（含 keep-warm 中）的 session 数，测试与调试观测点。 */
  get size(): number {
    return this.entries.size;
  }

  /** renderer pending-command registry 的只读对账入口；仍复用本 layer 的同一 host connection。 */
  queryCommands(params: CommandsQueryParams): Promise<CommandsQueryResult> {
    return this.transport.queryCommands(params);
  }

  private releaseEntry(topic: string): void {
    const entry = this.entries.get(topic);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount > 0 || this.disposed) {
      logger.lifecycle.info("v4 session data lease released", {
        event: "v4.session_data.release",
        module: "ui.v4.session_data_layer",
        refCount: entry.refCount,
        status: "completed",
        topic,
      });
      return;
    }
    // 若当前常驻总数已超额定容量，直接驱逐退订，不再等待 30s
    const effectiveCapacity = isHighMemoryPressure() ? 1 : this.maxWarmCapacity;
    if (this.entries.size > effectiveCapacity) {
      this.entries.delete(topic);
      void entry.store.close();
      return;
    }

    // 关 pane ≠ 停 session：这里只是退订视图，session 在 CLI 里照跑。
    entry.keepWarmTimer = setTimeout(() => {
      this.entries.delete(topic);
      logger.lifecycle.info("v4 session data keep-warm expired", {
        event: "v4.session_data.keep_warm_expired",
        module: "ui.v4.session_data_layer",
        refCount: 0,
        status: "completed",
        topic,
      });
      void entry.store.close();
    }, this.keepWarmMs);
    logger.lifecycle.info("v4 session data lease released", {
      event: "v4.session_data.release",
      keepWarmMs: this.keepWarmMs,
      module: "ui.v4.session_data_layer",
      refCount: 0,
      status: "keep_warm",
      topic,
    });
  }

  /** 连接销毁时清场（window/workspace 卸载）。 */
  dispose(): void {
    if (this.disposed) return;
    logger.lifecycle.info("v4 session data layer dispose started", {
      entryCount: this.entries.size,
      event: "v4.session_data.dispose.started",
      module: "ui.v4.session_data_layer",
      status: "started",
    });
    this.disposed = true;
    this.clearPrefetches();
    this.offFrame();
    for (const entry of this.entries.values()) {
      if (entry.keepWarmTimer !== null) {
        clearTimeout(entry.keepWarmTimer);
      }
      void entry.store.close();
    }
    this.entries.clear();
    logger.lifecycle.info("v4 session data layer dispose completed", {
      event: "v4.session_data.dispose.completed",
      module: "ui.v4.session_data_layer",
      status: "completed",
    });
  }
}
