// T-296 conversation subscription diagnostics.
//
// Two jobs only: give the user a copyable diagnostic reference, and record the FIRST
// failure of a subscription before any recovery loop starts. Both are missing today —
// the running build logs subscription faults through `logger.warn`, which a production
// renderer build suppresses, so a real recoveryFailed left no trace anywhere and the
// error card carried an internal reason code with no underlying cause.
//
// Field whitelist is a hard boundary: nothing here records prompts, tool output,
// credentials, or rejected payload values. A schema fault contributes only an issue
// code, a field path, and an expected/actual type category.
import type { TopicFrameDeliveryKind } from "@zcode/shared/zcode-protocol-v4";

export type SubscriptionFaultCategory =
  | "transport"
  | "decoder"
  | "schema"
  | "publisher"
  | "recovery"
  | "runtime"
  | "unknown";

export interface SubscriptionFaultClassification {
  readonly category: SubscriptionFaultCategory;
  /** User-facing first known underlying cause; never quotes payload content. */
  readonly cause: string;
}

interface FaultRule {
  readonly match: (reasonCode: string) => boolean;
  readonly result: SubscriptionFaultClassification;
}

const FAULT_RULES: readonly FaultRule[] = [
  {
    match: (code) => code.includes("initialFrameMissing"),
    result: {
      category: "transport",
      cause: "首个权威帧未到达，当前订阅无法建立水位",
    },
  },
  {
    match: (code) => code.includes("frameGap"),
    result: {
      category: "publisher",
      cause: "服务端投递的帧区间不衔接本地水位",
    },
  },
  {
    match: (code) => code.includes("assemblyFaultUnknown"),
    result: {
      category: "decoder",
      cause: "physical 帧组装失败（无 deliveryKind 的未定型 fault）",
    },
  },
  {
    match: (code) => code.includes("initialFrameStagingOverflow"),
    result: {
      category: "transport",
      cause: "订阅激活前的首帧物理批次已残缺（超出暂存上限）",
    },
  },
  {
    match: (code) => code.includes("notOwned"),
    result: {
      category: "publisher",
      cause: "host 已不认这份订阅所有权（scope 换代或错位退订）",
    },
  },
  {
    match: (code) => code.includes("resyncGenerationMismatch"),
    result: {
      category: "publisher",
      cause: "resync 返回的 subscriptionId 与请求不一致",
    },
  },
  {
    match: (code) =>
      code.includes("runtimeRestarted") ||
      code.includes("runtime is not running") ||
      code.includes("transport closed") ||
      code.includes("client disposed") ||
      code.includes("client is disposed"),
    result: {
      category: "runtime",
      cause: "本地 agent runtime 换代或回收，打断了在途订阅",
    },
  },
  {
    match: (code) => code.includes("recoveryFrameTimedOut"),
    result: {
      category: "recovery",
      cause: "恢复窗口内没有收到可衔接的权威帧",
    },
  },
  {
    match: (code) => code.startsWith("fault.subscription.recoveryFailed"),
    result: { category: "recovery", cause: "有界恢复阶梯耗尽" },
  },
  {
    // 整帧被严格逻辑 schema 拒绝（T-294 一致性发现）：这是 schema 边界，
    // 不是物理解码边界——归到 decoder 会让下一次事故继续找错人。
    match: (code) =>
      /schema|Schema/.test(code) || code.includes("frameAssemblyInvalidPayload"),
    result: { category: "schema", cause: "逻辑帧未通过严格 schema 校验" },
  },
  {
    match: (code) => code.startsWith("proto."),
    result: { category: "decoder", cause: "physical 帧解码被 fail-closed 拒绝" },
  },
];

export function classifySubscriptionFault(reasonCode: string): SubscriptionFaultClassification {
  for (const rule of FAULT_RULES) {
    if (rule.match(reasonCode)) return rule.result;
  }
  return { category: "unknown", cause: "未分类的订阅故障" };
}

export interface SubscriptionFaultDetail {
  deliveryKind: TopicFrameDeliveryKind | null;
  subscriptionId: string;
  generation: number;
  logicalFrameOrdinal?: number | null;
  frameKind?: "snapshot" | "deltas" | null;
  fromSeq?: number | null;
  toSeq?: number | null;
  /** Sanitized schema issue summary (code + path + type category), never values. */
  schemaIssue?: string | null;
}

export interface SubscriptionFirstFailure extends Required<SubscriptionFaultDetail> {
  reasonCode: string;
  category: SubscriptionFaultCategory;
  cause: string;
  at: string;
}

export interface SubscriptionDiagnosticsSnapshot {
  diagnosticId: string;
  topic: string;
  /** Category and reason of the FIRST failure seen, or null while healthy. */
  faultCategory: SubscriptionFaultCategory | null;
  reasonCode: string | null;
  firstCause: string | null;
  firstFailure: SubscriptionFirstFailure | null;
  framesSeen: number;
  initialFrameSeen: boolean;
  recoveryAttempts: number;
  terminal: boolean;
  generation: number;
}

let diagnosticSequence = 0;

/**
 * Per-store diagnostic recorder. `topic` is an opaque `conversation/<sessionId>`
 * identifier already used in logs; it holds no user content.
 */
export class SubscriptionDiagnostics {
  readonly diagnosticId: string;
  private firstFailure: SubscriptionFirstFailure | null = null;
  private frameCount = 0;
  private initialFrameSeen = false;
  private recoveryAttempts = 0;
  private terminal = false;
  private generation = 0;

  constructor(private readonly topic: string) {
    diagnosticSequence += 1;
    this.diagnosticId = `sub-${Date.now().toString(36)}-${diagnosticSequence.toString(36)}`;
  }

  noteGeneration(generation: number): void {
    this.generation = generation;
  }

  /** 已接纳的 logical frame 数；首个失败的记录以它为「首帧」判据。 */
  get framesSeen(): number {
    return this.frameCount;
  }

  noteFrame(deliveryKind: TopicFrameDeliveryKind | null): void {
    this.frameCount += 1;
    if (deliveryKind === "initial") this.initialFrameSeen = true;
  }

  /** Records the FIRST failure only; later faults belong to the recovery loop. */
  noteFault(reasonCode: string, detail: SubscriptionFaultDetail): void {
    if (this.firstFailure) return;
    const { category, cause } = classifySubscriptionFault(reasonCode);
    this.firstFailure = {
      reasonCode,
      category,
      cause,
      deliveryKind: detail.deliveryKind,
      subscriptionId: detail.subscriptionId,
      generation: detail.generation,
      logicalFrameOrdinal: detail.logicalFrameOrdinal ?? null,
      frameKind: detail.frameKind ?? null,
      fromSeq: detail.fromSeq ?? null,
      toSeq: detail.toSeq ?? null,
      schemaIssue: detail.schemaIssue ?? null,
      at: new Date().toISOString(),
    };
  }

  /**
   * Terminal reason with no preceding detailed fault (for example a runtime recycle
   * that never produced a frame). Keeps the panel truthful instead of showing an
   * unexplained internal code.
   */
  noteTerminalReason(reasonCode: string): void {
    this.terminal = true;
    if (this.firstFailure) return;
    const { category, cause } = classifySubscriptionFault(reasonCode);
    this.firstFailure = {
      reasonCode,
      category,
      cause,
      deliveryKind: null,
      subscriptionId: "",
      generation: this.generation,
      logicalFrameOrdinal: null,
      frameKind: null,
      fromSeq: null,
      toSeq: null,
      schemaIssue: null,
      at: new Date().toISOString(),
    };
  }

  noteRecoveryAttempt(): void {
    this.recoveryAttempts += 1;
  }

  noteHealthy(): void {
    this.recoveryAttempts = 0;
  }

  noteTerminal(): void {
    this.terminal = true;
  }

  snapshot(): SubscriptionDiagnosticsSnapshot {
    return {
      diagnosticId: this.diagnosticId,
      topic: this.topic,
      faultCategory: this.firstFailure?.category ?? null,
      reasonCode: this.firstFailure?.reasonCode ?? null,
      firstCause: this.firstFailure?.cause ?? null,
      firstFailure: this.firstFailure ? { ...this.firstFailure } : null,
      framesSeen: this.framesSeen,
      initialFrameSeen: this.initialFrameSeen,
      recoveryAttempts: this.recoveryAttempts,
      terminal: this.terminal,
      generation: this.generation,
    };
  }

  /**
   * Sanitized local diagnostic bundle for clipboard/log attachment. Counts, codes,
   * ordinals and identifiers only — the fault detail carries no payload bytes.
   */
  toSanitizedText(): string {
    const snapshot = this.snapshot();
    const lines = [
      `diagnosticId: ${snapshot.diagnosticId}`,
      `topic: ${snapshot.topic}`,
      `generation: ${snapshot.generation}`,
      `framesSeen: ${snapshot.framesSeen}`,
      `initialFrameSeen: ${snapshot.initialFrameSeen}`,
      `recoveryAttempts: ${snapshot.recoveryAttempts}`,
      `terminal: ${snapshot.terminal}`,
    ];
    const first = snapshot.firstFailure;
    if (first) {
      lines.push(
        `firstFault.reasonCode: ${first.reasonCode}`,
        `firstFault.category: ${first.category}`,
        `firstFault.cause: ${first.cause}`,
        `firstFault.deliveryKind: ${first.deliveryKind ?? "unknown"}`,
        `firstFault.frameKind: ${first.frameKind ?? "unknown"}`,
        `firstFault.logicalFrameOrdinal: ${first.logicalFrameOrdinal ?? "unknown"}`,
        `firstFault.seq: ${first.fromSeq ?? "?"}->${first.toSeq ?? "?"}`,
        `firstFault.subscriptionId: ${first.subscriptionId || "unknown"}`,
        `firstFault.at: ${first.at}`,
      );
      if (first.schemaIssue) lines.push(`firstFault.schemaIssue: ${first.schemaIssue}`);
    }
    return lines.join("\n");
  }
}
