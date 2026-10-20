// T-296 (SRC-209): the packaged ZAICODE conversation Queue must not turn one
// transport/subscription fault into a full-screen unknown error, and the next
// occurrence must say WHICH boundary failed first.
//
// The chain here is real, not scripted at the logical level:
//   logical frame -> encodeTopicWireFrames (real physical wire, crc32/fragments)
//   -> createAckActivationBarrier (real ACK activation staging)
//   -> createTopicWireDecoder + TopicWireFrameAssembler (real fail-closed assembly)
//   -> conversationTopicFrameSchema (real strict logical schema)
//   -> ConversationProjectionStore (real projection/recovery state machine)
//   -> resolveConversationSubscriptionSurface + SessionSubscriptionErrorPanel (real UI decision)
//
// Only the host RPCs (subscribe/resync ACKs) are scripted; every frame crosses the real
// physical encoder and decoder, so a fault the test observes is a fault the shipped
// renderer would also observe.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  conversationSnapshotSchema,
  conversationTopic,
  conversationTopicFrameSchema,
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  TopicWireFrameAssembler,
  V4_WIRE_PROTOCOL_VERSION,
  type ConversationRow,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type TopicFrameDeliveryKind,
  type TopicWireFrameCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { SessionDataLayer } from "../src/v4/sessionDataLayer.js";
// 真实生产快照工厂（纯函数、只 import type）：手写快照一旦偏离 schema，
// 装配器会静默拒绝整帧——测试就再也测不到恢复逻辑。这里用生产产物的形状，
// 再用真实 schema 自证合法。
import { createInitialConversationSnapshot } from "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/projection-state.js";
import { createAckActivationBarrier } from "../src/v4/ackActivationBarrier.js";
import { createTopicWireDecoder } from "../src/v4/topicWireDecoder.js";
import {
  classifySubscriptionFault,
  SubscriptionDiagnostics,
} from "../src/v4/subscriptionDiagnostics.js";
import {
  diagnosticSummaryText,
  hasTrustworthyConversationProjection,
  resolveConversationSubscriptionSurface,
  severityForFaultCategory,
  SessionSubscriptionErrorPanel,
} from "../src/v4/SessionSubscriptionErrorPanel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import type { ConversationTransport } from "../src/v4/transport.js";

const row = (rowId: number): ConversationRow =>
  ({
    kind: "assistantText",
    rowId,
    turnId: "turn-1",
    text: `row-${rowId}`,
    entityId: `e-${rowId}`,
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    state: "complete",
  }) as ConversationRow;

/** 生产形状的初始快照 + 给定水位/行；由真实 schema 自证合法。 */
function snapshotAt(sessionId: string, seq: number, rowIds: number[]): ConversationSnapshot {
  const candidate = {
    ...createInitialConversationSnapshot(sessionId, "epoch"),
    seq,
    revision: 1,
    rows: {
      window: rowIds.map((id) => row(id)),
      firstRowId: rowIds[0] ?? null,
      totalCount: rowIds.length,
    },
  };
  const parsed = conversationSnapshotSchema.safeParse(candidate);
  assert.ok(
    parsed.success,
    `fixture must satisfy the real snapshot schema: ${
      parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))
    }`,
  );
  return parsed.data as ConversationSnapshot;
}

/**
 * 一个合法的 Queue intent：strict schema 只接受它自己的键。
 * 用来证明「一个未知键足以让整帧被拒」——T-294 的一致性发现。
 */
function queueItem(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceCommandId: "cmd-1",
    queueItemId: "qi-1",
    clientId: "client-1",
    kind: "sendText",
    text: "hello",
    delivery: { requested: "queue", admitted: "queue" },
    order: { admissionSeq: 1 },
    steer: { state: "notRequested" },
    dispatch: { state: "queued" },
    admittedAt: 1_700_000_000_000,
    ...extra,
  };
}

function snapshotFrame(
  topic: string,
  subscriptionId: string,
  snapshot: ConversationSnapshot,
): ConversationTopicFrame {
  return {
    topic,
    subscriptionId,
    fromSeq: 0,
    toSeq: snapshot.seq,
    sentAt: 1_700_000_000_000,
    payload: { kind: "snapshot", snapshot },
  } as unknown as ConversationTopicFrame;
}

function deltasFrame(
  topic: string,
  subscriptionId: string,
  fromSeq: number,
  toSeq: number,
): ConversationTopicFrame {
  return {
    topic,
    subscriptionId,
    fromSeq,
    toSeq,
    sentAt: 1_700_000_000_000,
    payload: { kind: "deltas", deltas: [{ op: "row.appended", row: row(toSeq) }] },
  } as unknown as ConversationTopicFrame;
}

/**
 * Renderer-side conversation transport built from the REAL production physical
 * components. The host half only decides ACK modes.
 */
class RealWireTransport {
  subscribeCount = 0;
  resyncRequests: Array<{ subscriptionId: string; forceSnapshot: boolean }> = [];
  unsubscribeCount = 0;
  sendCommandCount = 0;
  /** ACK mode the scripted host returns for a resync. */
  resyncMode: "snapshot" | "resume" = "snapshot";

  private subSeq = 0;
  private logicalOrdinal = 0;
  private pendingToken: object | null = null;
  private readonly topicBySubscriptionId = new Map<string, string>();
  private readonly frameListeners = new Set<
    (frame: ConversationTopicFrame, context?: { deliveryKind: TopicFrameDeliveryKind }) => void
  >();
  private readonly faultListeners = new Set<
    (fault: {
      topic: string;
      subscriptionId: string;
      reasonCode?: string;
      deliveryKind?: TopicFrameDeliveryKind;
      logicalFrameOrdinal?: number;
      logicalFrameId?: string;
      schemaIssue?: string;
    }) => void
  >();

  private readonly assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
  private readonly decoder = createTopicWireDecoder<ConversationTopicFrame>(
    this.assembler,
    (frame, deliveryKind) => {
      for (const listener of this.frameListeners) listener(frame, { deliveryKind });
    },
    (fault) => {
      for (const listener of this.faultListeners) listener(fault);
    },
  );
  private readonly barrier = createAckActivationBarrier<TopicWireFrameCandidate>((wire) =>
    this.decoder.accept(wire),
  );

  constructor(readonly topic: string) {}

  /** Host side: push a real logical frame through the real physical encoder. */
  emitLogical(
    frame: ConversationTopicFrame,
    deliveryKind: TopicFrameDeliveryKind,
    /** 物理帧字节预算；给出可行值时真实编码器会切分成 fragment 批次。 */
    maxPhysicalFrameBytes?: number,
  ): TopicWireFrameCandidate[] {
    // 线上 ordinal 是帧序，不是 seq：用同一个 seq 再发一帧（生产里常见于
    // 补帧/重发）不能因此被墓碑吞掉，否则测试会「没故障也没帧」。
    const ordinal = (this.logicalOrdinal += 1);
    const wires = encodeTopicWireFrames(frame, {
      deliveryKind,
      topic: frame.topic,
      subscriptionId: frame.subscriptionId,
      logicalFrameId: `lf-${frame.payload.kind}-${ordinal}`,
      logicalFrameOrdinal: ordinal,
      ...(maxPhysicalFrameBytes === undefined ? {} : { maxPhysicalFrameBytes }),
      measurePhysicalFrameBytes: (wire) =>
        measureTopicNotificationEnvelopeBytes(wire as never).maxBytes,
    });
    for (const wire of wires) this.barrier.accept(wire);
    return wires as unknown as TopicWireFrameCandidate[];
  }

  /** Host side: emit a fragment batch whose checksum cannot match. */
  emitCorruptFragment(
    subscriptionId: string,
    deliveryKind: TopicFrameDeliveryKind,
    /** 墓碑按 ordinal 判定：同一 ordinal 重发会被静默吞掉，矩阵需要单调序号。 */
    ordinal = 99,
  ): void {
    // 只坏 checksum：字节长度必须自洽，否则先撞上 lengthMismatch，测不到目标那一层。
    const payload = Buffer.from(JSON.stringify({ kind: "probe" }), "utf8");
    // 线上 ordinal 是一条连接上单调的帧序：坏帧也占号，否则随后的 recovery 帧
    // 会以「更早的 ordinal」被装配器按迟到帧静默丢弃——那是测试的幻觉，不是生产行为。
    this.logicalOrdinal = Math.max(this.logicalOrdinal, ordinal);
    this.barrier.accept({
      wireVersion: V4_WIRE_PROTOCOL_VERSION,
      kind: "fragment",
      deliveryKind,
      // 每个坏帧都是一个不同的 logical frame：复用 id 会让装配器按墓碑/重复静默吞掉，
      // 矩阵需要每一次投递都真的到达那个边界。
      logicalFrameId: `lf-corrupt-${ordinal}`,
      logicalFrameOrdinal: ordinal,
      topic: this.topic,
      subscriptionId,
      fragmentIndex: 0,
      fragmentCount: 1,
      logicalBytes: payload.byteLength,
      checksum: { algorithm: "crc32", value: "00000000" },
      dataBase64: payload.toString("base64"),
    } as unknown as TopicWireFrameCandidate);
  }

  readonly transport = {
    onFrame: (
      listener: (
        frame: ConversationTopicFrame,
        context?: { deliveryKind: TopicFrameDeliveryKind },
      ) => void,
    ) => {
      this.frameListeners.add(listener);
      return () => this.frameListeners.delete(listener);
    },
    onAssemblyFault: (listener: never) => {
      this.faultListeners.add(listener as never);
      return () => this.faultListeners.delete(listener as never);
    },
    onRuntimeRestart: () => () => {},
    subscribe: (params: { topic: string }) => {
      this.subscribeCount += 1;
      this.subSeq += 1;
      const subscriptionId = `sub-${this.subSeq}`;
      this.pendingToken = this.barrier.begin(params.topic);
      this.barrier.bind(this.pendingToken, subscriptionId);
      this.topicBySubscriptionId.set(subscriptionId, params.topic);
      return Promise.resolve({
        ack: { subscriptionId, mode: "snapshot", logEpoch: "epoch" },
      }) as never;
    },
    activate: (subscriptionId: string) => {
      this.barrier.activate(subscriptionId);
    },
    resync: (params: { subscriptionId: string; forceSnapshot?: boolean }) => {
      this.resyncRequests.push({
        subscriptionId: params.subscriptionId,
        forceSnapshot: params.forceSnapshot === true,
      });
      const topic = this.topicBySubscriptionId.get(params.subscriptionId);
      if (topic) this.decoder.recover(topic, params.subscriptionId);
      return Promise.resolve({
        ack: { subscriptionId: params.subscriptionId, mode: this.resyncMode, logEpoch: "epoch" },
      }) as never;
    },
    unsubscribe: () => {
      this.unsubscribeCount += 1;
      return Promise.resolve();
    },
    sendCommand: () => {
      this.sendCommandCount += 1;
      return Promise.reject(new Error("sendCommand is not scripted"));
    },
    queryCommands: () => Promise.reject(new Error("queryCommands is not scripted")),
  } as unknown as ConversationTransport;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fixture(sessionId = "t296") {
  const topic = conversationTopic(sessionId);
  const host = new RealWireTransport(topic);
  // 真实数据层：帧按 topic 扇入 store 的这条路由就是生产路由
  // （sessionDataLayer.ts 的连接级单监听），测试不自己复刻。
  const layer = new SessionDataLayer({ transport: host.transport, keepWarmMs: 30_000 });
  const lease = layer.acquire(sessionId);
  return { topic, sessionId, host, layer, lease, store: lease.store };
}

/** acquire 的 connect 是 fire-and-forget；等到订阅真的被 ACK。 */
async function waitForSubscription(f: ReturnType<typeof fixture>): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    const subscriptionId = f.store.getState().subscriptionId;
    if (subscriptionId) return subscriptionId;
    await tick();
  }
  throw new Error("store never recorded a subscriptionId");
}

/** 等一次真正的换代订阅（store 拿到与旧 id 不同的 subscriptionId）。 */
async function waitForNewSubscription(
  f: ReturnType<typeof fixture>,
  previous: string,
): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    const subscriptionId = f.store.getState().subscriptionId;
    if (subscriptionId && subscriptionId !== previous) return subscriptionId;
    await tick();
  }
  throw new Error("store never re-subscribed");
}

async function connectWithInitial(f: ReturnType<typeof fixture>, seq = 10): Promise<string> {
  const subscriptionId = await waitForSubscription(f);
  f.host.emitLogical(
    snapshotFrame(f.topic, subscriptionId, snapshotAt(f.sessionId, seq, [1, 2, 3])),
    "initial",
  );
  assert.equal(f.store.getState().snapshot?.seq, seq, "the real initial snapshot reaches the store");
  return subscriptionId;
}

test("T-296 1: a real corrupt physical frame is the first failure recorded, before the recovery loop", async () => {
  const f = fixture();
  const subscriptionId = await connectWithInitial(f);

  f.host.emitCorruptFragment(subscriptionId, "online");
  await tick();

  const diagnostics = f.store.getSubscriptionDiagnostics();
  assert.ok(diagnostics.firstFailure, "the first failure must be recorded, not swallowed");
  assert.equal(
    diagnostics.firstFailure.reasonCode,
    "proto.frameAssemblyChecksumMismatch",
    "the decoder's own reason code is what gets recorded",
  );
  assert.equal(diagnostics.firstFailure.category, "decoder");
  assert.equal(diagnostics.firstFailure.deliveryKind, "online");
  assert.equal(
    diagnostics.firstFailure.logicalFrameOrdinal,
    99,
    "the failing logical frame ordinal survives the transport boundary",
  );
  // Correlation id exists and is stable for this subscription store.
  assert.match(diagnostics.diagnosticId, /^sub-[a-z0-9]+-[a-z0-9]+$/);
  assert.equal(
    f.store.getSubscriptionDiagnostics().diagnosticId,
    diagnostics.diagnosticId,
    "the diagnostic reference must be stable so the user can quote it",
  );
  f.layer.dispose();
});

test("T-296 2: a schema fault records a sanitized issue summary and never a payload value", async () => {
  const f = fixture();
  const subscriptionId = await connectWithInitial(f);

  // 未知键落在 strict 的 Queue item 上（快照信封本身非 strict）：一个未知键
  // 就足以让整帧被拒——这正是 T-294 一致性问题在真实链路里的形态。
  const unknownKeyFrame = {
    ...snapshotFrame(f.topic, subscriptionId, snapshotAt(f.sessionId, 10, [1, 2, 3])),
    payload: {
      kind: "snapshot",
      snapshot: {
        ...snapshotAt(f.sessionId, 10, [1, 2, 3]),
        queue: { items: [queueItem({ leakedSecretField: "do-not-log-me" })], autoDrain: true },
      },
    },
  } as unknown as ConversationTopicFrame;
  f.host.emitLogical(unknownKeyFrame, "online");
  await tick();

  const first = f.store.getSubscriptionDiagnostics().firstFailure;
  assert.equal(first?.reasonCode, "proto.frameAssemblyInvalidPayload");
  assert.equal(first?.category, "schema");
  assert.ok(first?.schemaIssue, "a schema failure must carry its sanitized shape summary");
  assert.match(first.schemaIssue!, /code=/);
  assert.match(first.schemaIssue!, /path=/);
  assert.ok(
    first.schemaIssue!.includes("leakedSecretField"),
    "the field NAME is the diagnosis and is reported",
  );
  assert.ok(
    !first.schemaIssue!.includes("do-not-log-me"),
    "the sanitized summary must not contain the rejected payload value",
  );
  const bundle = diagnosticSummaryText(f.store.getSubscriptionDiagnostics());
  assert.ok(!bundle.includes("do-not-log-me"), "the copyable bundle must not carry payload values");
  f.layer.dispose();
});

test("T-296 3: a loss of the initial frame plus a repeat fault no longer blanks a verified transcript", async () => {
  const f = fixture();
  const subscriptionId = await connectWithInitial(f);
  const before = f.store.getState();
  assert.equal(before.projectionVerified, true, "an applied snapshot marks the projection verified");

  // A Queue-shaped resync run: the recovery delivery itself keeps failing.
  f.store.recoverFromStaleAuthority();
  await tick();
  assert.equal(f.host.resyncRequests.length, 1);
  f.host.emitLogical(deltasFrame(f.topic, subscriptionId, 999, 1000), "recovery");
  await tick();

  const state = f.store.getState();
  assert.equal(state.snapshot?.seq, 10, "a gap is never guessed into the projection");
  assert.equal(
    resolveConversationSubscriptionSurface({
      status: state.status,
      snapshot: state.snapshot,
      projectionVerified: state.projectionVerified,
    }),
    state.status === "error" ? "fault-banner" : "live",
    "a verified projection keeps the transcript surface, never the whole-screen panel",
  );
  assert.notEqual(
    resolveConversationSubscriptionSurface({
      status: "error",
      snapshot: state.snapshot,
      projectionVerified: true,
    }),
    "fault-panel",
    "the operator's incident surface (full-screen error over a live transcript) must be unreachable",
  );
  f.layer.dispose();
});

test("T-296 4: the last-good projection policy is verification, not row count", () => {
  const empty = snapshotAt("t296", 0, []);
  assert.equal(
    hasTrustworthyConversationProjection(empty, true),
    true,
    "a valid empty projection is real history, not an unverified screen",
  );
  assert.equal(
    hasTrustworthyConversationProjection(snapshotAt("t296", 5, [1, 2]), false),
    false,
    "rows that were never verified against a watermark are not trustworthy",
  );
  assert.equal(
    resolveConversationSubscriptionSurface({
      status: "error",
      snapshot: empty,
      projectionVerified: true,
    }),
    "fault-banner",
  );
  assert.equal(
    resolveConversationSubscriptionSurface({
      status: "error",
      snapshot: snapshotAt("t296", 5, [1, 2]),
      projectionVerified: false,
    }),
    "fault-panel",
    "with no verified projection the explicit whole-screen error remains correct",
  );
});

test("T-296 5: the error panel shows the fault category, the first cause and a copyable reference", async () => {
  const f = fixture();
  const subscriptionId = await connectWithInitial(f);
  f.host.emitCorruptFragment(subscriptionId, "online");
  await tick();
  const diagnostics = f.store.getSubscriptionDiagnostics();
  assert.equal(diagnostics.faultCategory, "decoder");

  const html = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      null,
      createElement(SessionSubscriptionErrorPanel, {
        error: "fault.subscription.recoveryFailed",
        sessionId: f.sessionId,
        workspacePath: "/tmp/workspace",
        onReconnect: () => {},
        diagnostics,
      }),
    ),
  );
  assert.match(html, /v4-subscription-diagnostic-reference/, "the copyable reference is rendered");
  assert.ok(html.includes(diagnostics.diagnosticId), "the diagnostic id is visible to the user");
  assert.ok(html.includes("physical 帧解码被 fail-closed 拒绝"), "the first known cause is shown");
  assert.match(html, /v4-subscription-copy-diagnostics/, "the sanitized bundle can be copied");
  assert.match(html, /v4-subscription-feedback-with-logs/, "log attachment is an explicit choice");
  f.layer.dispose();
});

test("T-296 6: severity and classification follow the fault category, not a fixed P2", () => {
  assert.equal(severityForFaultCategory("decoder"), "P1-高");
  assert.equal(severityForFaultCategory("schema"), "P1-高");
  assert.equal(severityForFaultCategory("transport"), "P1-高");
  assert.equal(severityForFaultCategory("recovery"), "P2-中");
  assert.equal(severityForFaultCategory(null), "P2-中");

  assert.equal(classifySubscriptionFault("fault.subscription.initialFrameStagingOverflow").category, "transport");
  assert.equal(classifySubscriptionFault("fault.subscription.notOwned").category, "publisher");
  assert.equal(classifySubscriptionFault("fault.subscription.recoveryFrameTimedOut").category, "recovery");
  assert.equal(classifySubscriptionFault("fault.subscription.runtimeRestarted").category, "runtime");
  assert.equal(classifySubscriptionFault("proto.frameAssemblyOrdinalConflict").category, "decoder");
  assert.equal(classifySubscriptionFault("something.new").category, "unknown");
});

test("T-296 7: the first failure is kept, later faults in the recovery loop do not overwrite it", () => {
  const diagnostics = new SubscriptionDiagnostics("conversation/sess-t296");
  diagnostics.noteFault("proto.frameAssemblyChecksumMismatch", {
    deliveryKind: "initial",
    generation: 1,
    subscriptionId: "sub-1",
    logicalFrameOrdinal: 7,
  });
  diagnostics.noteFault("fault.subscription.recoveryFailed", {
    deliveryKind: "recovery",
    generation: 3,
    subscriptionId: "sub-3",
  });
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.firstFailure?.reasonCode, "proto.frameAssemblyChecksumMismatch");
  assert.equal(snapshot.framesSeen, 0);
  assert.equal(snapshot.terminal, false);

  diagnostics.noteRecoveryAttempt();
  diagnostics.noteRecoveryAttempt();
  diagnostics.noteTerminalReason("fault.subscription.recoveryFailed");
  const terminal = diagnostics.snapshot();
  assert.equal(terminal.recoveryAttempts, 2);
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.firstFailure?.reasonCode, "proto.frameAssemblyChecksumMismatch");
});

test("T-296 8: a terminal failure with no detailed fault still explains itself instead of showing a bare code", () => {
  const diagnostics = new SubscriptionDiagnostics("conversation/sess-t296");
  diagnostics.noteTerminalReason("ZCode agent runtime 已被回收，重连未成功");
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.terminal, true);
  assert.ok(snapshot.reasonCode, "an unclassified terminal reason is still reported");
  assert.equal(snapshot.faultCategory, "unknown");
  assert.ok(snapshot.firstCause, "the panel always has a user-readable cause line");
});

// ---------------------------------------------------------------------------
// Phase 4：场景矩阵 A–J。每一行都跨真实物理编码器、真实 fail-closed 解码器、
// 真实严格 schema、真实 store 状态机与真实 UI 决策面；脚本化的只有 host 的
// subscribe/resync ACK 模式。矩阵存在的意义是：同一个「恢复失败」终态在不同
// 边界上的第一因必须指向各自真正坏掉的那一层。
// ---------------------------------------------------------------------------

test("T-296 A (cold start): the initial snapshot applies and nothing is reported as a fault", async () => {
  const f = fixture("t296-a");
  await connectWithInitial(f, 10);
  const state = f.store.getState();
  const diagnostics = f.store.getSubscriptionDiagnostics();
  assert.equal(state.status, "live");
  assert.equal(state.projectionVerified, true);
  assert.equal(state.snapshot?.rows.window.length, 3);
  assert.equal(diagnostics.framesSeen, 1);
  assert.equal(diagnostics.initialFrameSeen, true);
  assert.equal(diagnostics.faultCategory, null);
  assert.equal(diagnostics.firstFailure, null);
  assert.equal(
    resolveConversationSubscriptionSurface({
      status: state.status,
      snapshot: state.snapshot,
      projectionVerified: state.projectionVerified,
    }),
    "live",
  );
  f.layer.dispose();
});

test("T-296 B (initial frame lost): the first failure is the missing base, and recovery rebuilds the projection", async () => {
  const f = fixture("t296-b");
  const subscriptionId = await waitForSubscription(f);
  // ACK 声称 snapshot，到达的却是 delta：没有 applied base 的 delta 不能拼进投影。
  f.host.emitLogical(deltasFrame(f.topic, subscriptionId, 10, 11), "initial");
  await tick();

  const diagnostics = f.store.getSubscriptionDiagnostics();
  assert.equal(diagnostics.firstFailure?.reasonCode, "fault.subscription.initialFrameMissing");
  assert.equal(diagnostics.firstFailure?.category, "transport");
  assert.equal(diagnostics.firstFailure?.deliveryKind, "initial");
  assert.equal(f.store.getState().snapshot, null, "the missing base is never guessed into a projection");
  assert.equal(f.host.resyncRequests.length, 1, "the response to a missing base is a recovery request");
  assert.equal(f.host.resyncRequests[0].forceSnapshot, true);

  f.host.emitLogical(
    snapshotFrame(f.topic, subscriptionId, snapshotAt("t296-b", 11, [1, 2, 3])),
    "recovery",
  );
  await tick();
  const state = f.store.getState();
  assert.equal(state.snapshot?.seq, 11, "the recovery frame rebuilds the projection");
  assert.equal(state.projectionVerified, true);
  assert.equal(
    f.store.getSubscriptionDiagnostics().firstFailure?.reasonCode,
    "fault.subscription.initialFrameMissing",
    "recovery does not erase the record of what failed first",
  );
  f.layer.dispose();
});

test("T-296 C (physical fragmentation): a split logical frame reassembles and applies whole", async () => {
  const f = fixture("t296-c");
  const subscriptionId = await waitForSubscription(f);
  const rowIds = Array.from({ length: 40 }, (_, index) => index + 1);
  const wires = f.host.emitLogical(
    snapshotFrame(f.topic, subscriptionId, snapshotAt("t296-c", 12, rowIds)),
    "initial",
    2048,
  );
  await tick();
  assert.ok(wires.length > 1, "the real encoder really fragmented the logical frame");
  assert.equal(f.store.getState().snapshot?.seq, 12, "the reassembled frame is applied whole");
  assert.equal(
    f.store.getState().snapshot?.rows.window.length,
    40,
    "every fragment of the logical frame is accounted for",
  );
  assert.equal(f.store.getState().projectionVerified, true);
  assert.equal(f.store.getSubscriptionDiagnostics().firstFailure, null);
  f.layer.dispose();
});

test("T-296 D (physical corruption): the decoder boundary is the recorded first cause", async () => {
  const f = fixture("t296-d");
  const subscriptionId = await connectWithInitial(f, 10);
  f.host.emitCorruptFragment(subscriptionId, "online", 7);
  await tick();

  const diagnostics = f.store.getSubscriptionDiagnostics();
  assert.equal(diagnostics.firstFailure?.reasonCode, "proto.frameAssemblyChecksumMismatch");
  assert.equal(diagnostics.firstFailure?.category, "decoder");
  assert.equal(diagnostics.firstFailure?.logicalFrameOrdinal, 7);
  assert.equal(f.host.resyncRequests.length, 1);
  assert.equal(f.store.getState().snapshot?.seq, 10, "the last verified projection is untouched");
  f.layer.dispose();
});

test("T-296 E (strict schema): a rejected frame stays a schema boundary and leaks no payload value", async () => {
  const f = fixture("t296-e");
  const subscriptionId = await connectWithInitial(f, 10);
  const rejected = {
    ...snapshotFrame(f.topic, subscriptionId, snapshotAt("t296-e", 10, [1, 2, 3])),
    payload: {
      kind: "snapshot",
      snapshot: {
        ...snapshotAt("t296-e", 10, [1, 2, 3]),
        queue: { items: [queueItem({ leakedSecretField: "do-not-log-me" })], autoDrain: true },
      },
    },
  } as unknown as ConversationTopicFrame;
  f.host.emitLogical(rejected, "online");
  await tick();

  const diagnostics = f.store.getSubscriptionDiagnostics();
  assert.equal(diagnostics.firstFailure?.reasonCode, "proto.frameAssemblyInvalidPayload");
  assert.equal(diagnostics.firstFailure?.category, "schema");
  assert.ok(diagnostics.firstFailure?.schemaIssue?.includes("leakedSecretField"));
  assert.ok(!diagnostics.firstFailure!.schemaIssue!.includes("do-not-log-me"));
  const state = f.store.getState();
  assert.equal(state.snapshot?.seq, 10, "a rejected frame never replaces the verified projection");
  assert.equal(
    resolveConversationSubscriptionSurface({
      status: "error",
      snapshot: state.snapshot,
      projectionVerified: state.projectionVerified,
    }),
    "fault-banner",
    "a rejected frame degrades liveness, it does not blank a verified transcript",
  );
  f.layer.dispose();
});

test("T-296 F (late duplicate): a superseded frame is dropped silently, never as a fault", async () => {
  const f = fixture("t296-f");
  const subscriptionId = await connectWithInitial(f, 10);
  f.host.emitLogical(deltasFrame(f.topic, subscriptionId, 5, 10), "online");
  await tick();

  assert.equal(f.store.getState().snapshot?.seq, 10);
  assert.equal(f.store.getState().status, "live");
  assert.equal(f.host.resyncRequests.length, 0, "a duplicate is not a reason to re-subscribe");
  assert.equal(f.store.getSubscriptionDiagnostics().firstFailure, null);
  assert.equal(
    f.store.getSubscriptionDiagnostics().framesSeen,
    2,
    "the frame was seen — it was just not an event",
  );
  f.layer.dispose();
});

test("T-296 G (frame gap): the publisher boundary is named and the watermark never advances by guessing", async () => {
  const f = fixture("t296-g");
  const subscriptionId = await connectWithInitial(f, 10);
  f.host.emitLogical(deltasFrame(f.topic, subscriptionId, 12, 13), "online");
  await tick();

  const diagnostics = f.store.getSubscriptionDiagnostics();
  assert.equal(diagnostics.firstFailure?.reasonCode, "fault.subscription.frameGap");
  assert.equal(diagnostics.firstFailure?.category, "publisher");
  assert.equal(diagnostics.firstFailure?.fromSeq, 12);
  assert.equal(diagnostics.firstFailure?.toSeq, 13);
  assert.equal(f.store.getState().snapshot?.seq, 10, "a gap never advances the watermark");
  assert.notEqual(
    f.store.getState().status,
    "error",
    "a publisher gap degrades the stream; it is not an execution failure",
  );
  assert.equal(
    resolveConversationSubscriptionSurface({
      status: f.store.getState().status,
      snapshot: f.store.getState().snapshot,
      projectionVerified: f.store.getState().projectionVerified,
    }),
    "live",
    "the verified transcript keeps its surface while recovery runs",
  );
  assert.equal(f.host.resyncRequests.length, 1);
  f.layer.dispose();
});

test("T-296 H (bounded recovery exhausted): the terminal state names the FIRST failing boundary, not the escalation", async () => {
  const f = fixture("t296-h");
  let subscriptionId = await connectWithInitial(f, 10);
  // 恢复 ACK 立即返回：这条路径的现实形态是「恢复投递本身持续失败」，
  // 不该由真实 timeout 决定测试时长。
  f.host.resyncMode = "resume";
  let ordinal = 100;
  for (let cycle = 0; cycle < 6 && f.store.getState().status !== "error"; cycle += 1) {
    for (let burst = 0; burst < 3; burst += 1) {
      ordinal += 1;
      f.host.emitCorruptFragment(subscriptionId, "recovery", ordinal);
      await tick();
    }
    if (f.store.getState().status === "error") break;
    subscriptionId = await waitForNewSubscription(f, subscriptionId);
  }

  const state = f.store.getState();
  const diagnostics = f.store.getSubscriptionDiagnostics();
  assert.equal(state.status, "error");
  assert.equal(state.lastError, "fault.subscription.recoveryFailed");
  assert.equal(diagnostics.terminal, true);
  assert.ok(diagnostics.recoveryAttempts >= 3, "the bounded ladder was really exhausted");
  assert.equal(
    diagnostics.firstFailure?.reasonCode,
    "proto.frameAssemblyChecksumMismatch",
    "the operator-visible reason must be the first real boundary, never the recovery escalation",
  );
  assert.equal(diagnostics.firstFailure?.category, "decoder");
  assert.equal(state.snapshot?.seq, 10, "the verified projection is preserved, not blanked");
  assert.equal(
    resolveConversationSubscriptionSurface({
      status: state.status,
      snapshot: state.snapshot,
      projectionVerified: state.projectionVerified,
    }),
    "fault-banner",
    "the operator's incident surface (whole-screen panel over live history) stays unreachable",
  );
  f.layer.dispose();
});

test("T-296 I (session switching): one connection keeps each topic in its own store", async () => {
  const host = new RealWireTransport(conversationTopic("t296-i1"));
  const layer = new SessionDataLayer({ transport: host.transport, keepWarmMs: 30_000 });
  const first = layer.acquire("t296-i1");
  const second = layer.acquire("t296-i2");
  const subscriptionIdOf = async (store: { getState(): { subscriptionId: string | null } }) => {
    for (let i = 0; i < 50; i += 1) {
      const subscriptionId = store.getState().subscriptionId;
      if (subscriptionId) return subscriptionId;
      await tick();
    }
    throw new Error("store never recorded a subscriptionId");
  };
  const topic1 = conversationTopic("t296-i1");
  const topic2 = conversationTopic("t296-i2");
  const id1 = await subscriptionIdOf(first.store);
  const id2 = await subscriptionIdOf(second.store);

  host.emitLogical(snapshotFrame(topic1, id1, snapshotAt("t296-i1", 3, [1])), "initial");
  host.emitLogical(snapshotFrame(topic2, id2, snapshotAt("t296-i2", 7, [1, 2])), "initial");
  await tick();
  assert.equal(first.store.getState().snapshot?.seq, 3);
  assert.equal(second.store.getState().snapshot?.seq, 7, "one topic's frame never lands in another's store");
  assert.equal(first.store.getState().snapshot?.rows.window.length, 1);
  assert.equal(second.store.getState().snapshot?.rows.window.length, 2);

  first.release();
  await tick();
  host.emitLogical(deltasFrame(topic2, id2, 7, 8), "online");
  await tick();
  assert.equal(
    second.store.getState().snapshot?.seq,
    8,
    "closing one view does not stop another session's stream",
  );
  assert.equal(layer.size, 2, "the released view is kept warm, not destroyed");
  layer.dispose();
});

test("T-296 J (recoverable transport fault): the route recovers and a transport error never becomes an execution failure", async () => {
  const f = fixture("t296-j");
  const subscriptionId = await connectWithInitial(f, 10);
  f.host.emitCorruptFragment(subscriptionId, "online", 55);
  await tick();

  assert.equal(f.store.getSubscriptionDiagnostics().firstFailure?.logicalFrameOrdinal, 55);
  assert.equal(f.host.resyncRequests.length, 1, "a recoverable fault asks for recovery");
  // host 侧 resync 会清掉 fail-closed 路由（decoder.recover），随后投递衔接合法的恢复帧。
  f.host.emitLogical(deltasFrame(f.topic, subscriptionId, 10, 11), "recovery");
  await tick();

  const state = f.store.getState();
  assert.equal(state.snapshot?.seq, 11, "the stream continues from the verified watermark");
  assert.equal(state.projectionVerified, true);
  assert.equal(state.status, "live");
  assert.equal(state.lastError, null);
  assert.equal(f.store.getSubscriptionDiagnostics().terminal, false);
  f.layer.dispose();
});
