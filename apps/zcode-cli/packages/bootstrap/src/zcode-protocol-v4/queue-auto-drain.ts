import type { GoalStatus } from "@zcode/contracts";

/**
 * ZAICODE (SRC-044 "sent to queue, nothing happens")：goal 未完成时，目标续跑循环
 * 发现队列里有待处理项就让路（runtimeCommandQueue.hasPending → 返回），而这里又要求
 * goal 为 null/complete 才自动提升队首——两边互等，排队的输入永远不发。ZAICODE 里
 * 操作员排进队列的输入就是下一步：会话空闲时直接提升，不论 goal 状态；
 * 发出的 `/goal …` 本身会替换目标，普通输入跑完后 goal 续跑照常接上。
 */
export function zaicodeQueueDrainsPastGoal(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "on", "yes"].includes((env.ZCODE_ZAICODE_MODE ?? "").trim().toLowerCase());
}

/**
 * 普通 queue 的唯一自动提升闸门。fail-open 不在这里开旁路：verifier 仍先把
 * target 持久化为 complete，再与显式 pass 共用这一条判断。
 */
export function shouldAutoDrainV4QueueHead(input: {
  autoDrain: boolean;
  dispatchState: "queued" | "reserved" | "promoting";
  sessionBusy: boolean;
  targetStatus: GoalStatus | null;
  /** ZAICODE：空闲时不再等待未完成的 goal。 */
  drainPastGoal?: boolean;
}): boolean {
  return (
    input.autoDrain &&
    input.dispatchState === "queued" &&
    !input.sessionBusy &&
    (input.drainPastGoal === true || input.targetStatus === null || input.targetStatus === "complete")
  );
}
