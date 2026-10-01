/**
 * ZAICODE 屏幕卡片：形状与常驻上限。
 *
 * 单独成模块，而不是继续堆在 zaicodeNotifications 里——通知设置、卡片队列和
 * "fresh from the oven" 高亮是三件事，各自已经够长；上限又是 SRC-116 TRACK A
 * 加进来的硬约束，单独放才能一眼看见它是什么、为什么是这个数。
 */

export interface ZaicodeToastAction {
  label: string;
  run: () => void;
  /** Keep the card open after the action (e.g. a counter). */
  keepOpen?: boolean;
}

export interface ZaicodeToast {
  id: number;
  scenario: string;
  /** Small caption in the card's title bar ("Limits · Claude 1"). */
  header: string;
  title: string;
  body: string;
  /** Short state line in the accent colour ("Refilled", "Time's up"). */
  status: string;
  accent: string;
  createdAt: number;
  /** Epoch ms, or null = until dismissed. */
  expiresAt: number | null;
  actions: ZaicodeToastAction[];
  /** Same key replaces the older card instead of stacking. */
  key?: string;
}

/**
 * 常驻卡片上限。
 *
 * 两种 toast 会永久累积：keyless 卡片走 `!toast.key || item.key !== toast.key` 的 filter，
 * 每次都追加而不是顶掉旧的；`seconds = 0` 的卡片 expiresAt 为 null，只能手关。
 * 自 Autonomous 跑几小时后这两个集合能把通知栈撑到几百张，每张都带 body 字符串和
 * action 闭包。带 action 的卡片永远不参与回收——"Approve"/"Retry" 被静默丢掉比多占
 * 一点内存严重得多。
 */
export const ZAICODE_TOAST_LIMIT = 12;

export function boundZaicodeToasts(
  toasts: readonly ZaicodeToast[],
  now: number,
  limit: number = ZAICODE_TOAST_LIMIT,
): ZaicodeToast[] {
  // 到期卡片先清掉：它们的移除回调可能没跑到，但内容已经没人看了。
  const alive = toasts.filter((toast) => toast.expiresAt === null || toast.expiresAt > now);
  if (alive.length <= limit) return alive;
  const evictable = alive.filter((toast) => toast.actions.length === 0);
  const surplus = Math.min(evictable.length, alive.length - limit);
  if (surplus === 0) return alive;
  const oldestFirst = [...evictable].sort((left, right) => left.createdAt - right.createdAt);
  const dropped = new Set(oldestFirst.slice(0, surplus).map((toast) => toast.id));
  return alive.filter((toast) => !dropped.has(toast.id));
}
