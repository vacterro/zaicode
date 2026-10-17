import type { SessionDataLayer } from "./sessionDataLayer.js";
import { isZaicodeCleanupInProgress, isSessionRetired } from "@/zaicode/zaicodeCleanupFence.js";
import { nextZaicodeDoneSession, zaicodeDoneUnseen, useZaicodeSessionBriefs } from "@/zaicode/zaicodeContinue.js";

export interface AdaptivePrefetchTarget {
  layer: SessionDataLayer;
  activeSessionId: string | null;
  sessionIds: readonly string[];
}

/**
 * Bounded adaptive prefetch coordinator (PART 2).
 * Priority candidates:
 * 1. Current selected session (held by pane).
 * 2. Most recently selected sessions.
 * 3. Sessions adjacent to the active navigation target.
 * 4. Next unseen DONE session.
 * 5. High-confidence hover/focus navigation candidates.
 */
export class AdaptivePrefetchCoordinator {
  private readonly hoverByLayer = new Map<
    SessionDataLayer,
    { timer: ReturnType<typeof setTimeout>; sessionId: string; requestedAt: number }
  >();
  private readonly cooldownRecords = new Map<
    string,
    { expiresAt: number; failureCount: number; lastFailedAt: number }
  >();
  private readonly cooldowns = new Map<string, number>();
  private lastGlobalHoverAt = 0;
  private lastHoveredSessionId: string | null = null;

  private pruneExpiredCooldowns(): void {
    const now = Date.now();
    for (const [key, rec] of this.cooldownRecords.entries()) {
      if (now > rec.expiresAt) {
        this.cooldownRecords.delete(key);
      }
    }
    for (const [id, exp] of this.cooldowns.entries()) {
      if (now > exp) {
        this.cooldowns.delete(id);
      }
    }
  }

  markCooldown(
    sessionId: string,
    options?: { workspaceKey?: string; durationMs?: number } | number,
  ): void {
    this.pruneExpiredCooldowns();
    const durationOverride = typeof options === "number" ? options : options?.durationMs;
    const workspaceKey = typeof options === "object" ? options?.workspaceKey : undefined;
    const key = workspaceKey ? `${workspaceKey}::${sessionId}` : sessionId;

    const existing = this.cooldownRecords.get(key);
    const failureCount = (existing?.failureCount ?? 0) + 1;
    // Bounded exponential backoff: 5s, 10s, 20s, max 60s
    const backoffMs = durationOverride ?? Math.min(60_000, 5_000 * Math.pow(2, failureCount - 1));
    const now = Date.now();
    const expiresAt = now + backoffMs;

    this.cooldownRecords.set(key, {
      expiresAt,
      failureCount,
      lastFailedAt: now,
    });
    this.cooldowns.set(sessionId, expiresAt);

    // Bound cooldown map size to 200 to prevent unbounded memory growth
    if (this.cooldownRecords.size > 200) {
      const oldestKey = this.cooldownRecords.keys().next().value;
      if (oldestKey) this.cooldownRecords.delete(oldestKey);
    }
  }

  isCooldown(sessionId: string, workspaceKey?: string): boolean {
    const key = workspaceKey ? `${workspaceKey}::${sessionId}` : sessionId;
    const now = Date.now();
    const record = this.cooldownRecords.get(key);
    if (record) {
      if (now > record.expiresAt) {
        this.cooldownRecords.delete(key);
        this.cooldowns.delete(sessionId);
        return false;
      }
      return true;
    }
    const legacyExpires = this.cooldowns.get(sessionId);
    if (legacyExpires) {
      if (now > legacyExpires) {
        this.cooldowns.delete(sessionId);
        return false;
      }
      return true;
    }
    return false;
  }

  clearCooldown(sessionId: string, workspaceKey?: string): void {
    const key = workspaceKey ? `${workspaceKey}::${sessionId}` : sessionId;
    this.cooldownRecords.delete(key);
    this.cooldowns.delete(sessionId);
  }

  /**
   * 当活动会话或当前列表发生变化时，自适应调度相邻会话与未读 DONE 会话的预热。
   */
  scheduleAdjacentAndDonePrefetch(target: AdaptivePrefetchTarget): void {
    if (isZaicodeCleanupInProgress()) return;
    const { layer, activeSessionId, sessionIds } = target;
    if (!activeSessionId || sessionIds.length === 0) return;

    this.cancelHover(layer);

    const idx = sessionIds.indexOf(activeSessionId);
    if (idx !== -1) {
      // 1. 优先相邻候选：下一项与上一项
      const nextId = sessionIds[idx + 1];
      const prevId = sessionIds[idx - 1];
      if (nextId && !isSessionRetired(nextId) && !this.isCooldown(nextId)) {
        layer.prefetch(nextId);
      }
      if (prevId && !isSessionRetired(prevId) && !this.isCooldown(prevId)) {
        layer.prefetch(prevId);
      }
    }

    // 2. 检查下一个未看的 DONE 会话
    try {
      const briefs = useZaicodeSessionBriefs.getState().sessions;
      const nextDone = nextZaicodeDoneSession(zaicodeDoneUnseen(briefs), activeSessionId);
      if (nextDone && !isSessionRetired(nextDone.sessionId) && !this.isCooldown(nextDone.sessionId)) {
        layer.prefetch(nextDone.sessionId);
      }
    } catch {
      // Ignore
    }
  }

  /**
   * 鼠标悬停 / 键盘焦点的高确信度导航候选：测量自适应防抖，避免快速滑过时打爆 I/O。
   */
  onCandidateHover(layer: SessionDataLayer, sessionId: string): void {
    if (isZaicodeCleanupInProgress() || isSessionRetired(sessionId) || this.isCooldown(sessionId)) return;

    const existing = this.hoverByLayer.get(layer);
    if (existing?.sessionId === sessionId) return;

    if (existing) {
      clearTimeout(existing.timer);
      this.hoverByLayer.delete(layer);
    }

    const now = Date.now();
    const isRapidFlicker =
      this.lastHoveredSessionId !== null &&
      this.lastHoveredSessionId !== sessionId &&
      now - this.lastGlobalHoverAt < 120;
    this.lastHoveredSessionId = sessionId;
    this.lastGlobalHoverAt = now;
    // 自适应防抖：快速滑过增加防抖时间，沉稳停留保持 80ms
    const debounceMs = isRapidFlicker ? 150 : 80;

    const timer = setTimeout(() => {
      this.hoverByLayer.delete(layer);
      if (!isZaicodeCleanupInProgress() && !isSessionRetired(sessionId) && !this.isCooldown(sessionId)) {
        layer.prefetch(sessionId);
      }
    }, debounceMs);

    this.hoverByLayer.set(layer, { timer, sessionId, requestedAt: now });
  }

  cancelHover(layer?: SessionDataLayer): void {
    if (layer) {
      const existing = this.hoverByLayer.get(layer);
      if (existing) {
        clearTimeout(existing.timer);
        this.hoverByLayer.delete(layer);
      }
      return;
    }
    for (const { timer } of this.hoverByLayer.values()) {
      clearTimeout(timer);
    }
    this.hoverByLayer.clear();
  }
}

export const adaptivePrefetchCoordinator = new AdaptivePrefetchCoordinator();
