import type { IDisposable } from "@zcode/rpc";
import type { IZCodeAgentService, ZCodeAgentWorkspaceTarget } from "@zcode/services";
import { openProviderQuotaCircuit } from "@zcode/shared";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";

/**
 * T-168: 让派发进程自己成为记账的那一端。
 *
 * CLI 是 spawn 出来的子进程，只有它看得见 adapter 层的分类结果，所以它才是唯一能证明
 * 「这条 route 真的欠费到点」的地方。但 circuit 是一张进程内的 Map：在子进程里记账，
 * 宿主进程的 resolveProviderQuotaRoute 永远读到空表，那道闸门等于没装。
 *
 * 这里不新建 IPC。CLI 已经在 `v4/telemetry/event` 上报 model_request_failed，事实里带着
 * providerId / reason / retryable —— 那是活着的通道上唯一带 provider 身份的事件。宿主订阅
 * 这条既有事实流，把「已证实欠费」记进本进程的同一张表，读者和记账者终于在同一进程里。
 */
export function isProvenQuotaExhaustion(fact: ConversationTelemetryFact): boolean {
  if (fact.kind !== "model.request.status") return false;
  if (fact.status !== "model_request_failed") return false;
  // reason 取自 ModelRetryReason 这个封闭枚举：network_error / server_error / timeout /
  // auth_failed / invalid_request / proxy_error / tls_error / stale_connection 各自独立，
  // B2 点名的每一类都落不到 rate_limited 上；模型不存在更不会。retryable=false 才是
  // 「额度用尽」而不是「等一会再试」，与 CLI 侧 noteProviderQuotaCircuit 的判据同义。
  if (fact.reason !== "rate_limited") return false;
  return fact.retryable === false;
}

/** Record a proven exhaustion onto this process's circuit. False when the fact proves nothing. */
export function noteProviderQuotaCircuitFromFact(
  fact: ConversationTelemetryFact,
  now: number,
): boolean {
  if (fact.kind !== "model.request.status" || fact.status !== "model_request_failed") return false;
  if (!isProvenQuotaExhaustion(fact)) return false;
  openProviderQuotaCircuit({
    providerId: fact.providerId,
    now,
    reason:
      typeof fact.statusCode === "number" ? `rate_limited (${fact.statusCode})` : "rate_limited",
    // CLI 在这条事实上没有把 retry-after 带上来，所以闸门时长是我们自己的间隔，不是
    // provider 承诺的重置点。describeProviderQuotaRoute 会如实标成 estimated。
    retryAfterMs: null,
  });
  return true;
}

/**
 * Watch one workspace's model-request facts for the run's lifetime. The caller owns the
 * subscription and disposes it when the run settles, exactly like the terminal-outcome watcher
 * beside it -- a per-run listener cannot outlive the run that opened it.
 */
export function watchProviderQuotaCircuit(options: {
  agentService: Pick<IZCodeAgentService, "onDynamicConversationTelemetryFact">;
  target: ZCodeAgentWorkspaceTarget;
  now?(): number;
  logWarn?(message: string, error?: unknown): void;
}): IDisposable {
  const now = options.now ?? Date.now;
  return options.agentService.onDynamicConversationTelemetryFact(options.target)((fact) => {
    try {
      noteProviderQuotaCircuitFromFact(fact, now());
    } catch (error) {
      // 记账失败绝不能顺着通知分发抛回 Agent service；丢这一条事实，其余监听器照常。
      options.logWarn?.("ZAICODE: provider quota circuit bookkeeping failed", error);
    }
  });
}
