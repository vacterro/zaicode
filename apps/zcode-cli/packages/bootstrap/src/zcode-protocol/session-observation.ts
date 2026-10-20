import type { ZCodeSessionContextUsage } from "@zcode/shared";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import type { SessionUsageSeed } from "../zcode-protocol-v4/product-projection.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/** Existing-only observation: querying liveness never activates a cold runtime. */
export async function readSessionExecutionLiveness(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  workIds: readonly string[],
) {
  const record = context.sessions.get(sessionId);
  if (!record || typeof record.app.runtime.getExecutionLiveness !== "function") return null;
  const proof = await record.app.runtime.getExecutionLiveness(workIds);
  if (context.sessions.get(sessionId) !== record) return null;
  const preparing = record.activeAbortController;
  // 正在准备的真实命令也持有 owner；历史 running 字段和挂载视图不能充当此证据。
  if (!proof.released && !proof.foregroundExecutionId && preparing && !preparing.signal.aborted) {
    return { ...proof, foregroundExecutionId: `preparing:${sessionId}` };
  }
  return proof;
}

export function normalizeStoredTitleSource(
  source: string | undefined,
): NonNullable<SessionSummary["titleSource"]> {
  if (source === "custom") return "custom";
  if (source === "default") return "default";
  return "generated";
}

export function sessionUsageSeedFromRuntimeContextUsage(
  contextUsage: ZCodeSessionContextUsage | undefined,
  contextWindowOverride?: number,
): SessionUsageSeed | null {
  if (!contextUsage || contextUsage.used <= 0) {
    return null;
  }
  return {
    contextWindow: {
      usedTokens: contextUsage.used,
      maxTokens: contextWindowOverride ?? null,
      autoCompactThresholdTokens: null,
      ...(contextUsage.cache ? { cache: contextUsage.cache } : {}),
      ...(contextUsage.breakdown ? { breakdown: contextUsage.breakdown } : {}),
    },
  };
}

