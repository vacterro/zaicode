import { executionLivenessSchema, type ExecutionLivenessSnapshot } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { V4GatewayHost } from "./v4-gateway.js";

type Publisher = { getSnapshot(): ConversationSnapshot };
type IndexMetadata = { createdAt: number; lastActivityAt: number; parentSessionId?: string };
interface LivenessIndexHost {
  publishers(): Iterable<[string, Publisher]>;
  publisher(sessionId: string): Publisher | undefined;
  observe?(sessionId: string, workIds: readonly string[]): Promise<ExecutionLivenessSnapshot | null>;
  metadata(sessionId: string): IndexMetadata | null | undefined;
  publish(sessionId: string): void;
  onError(error: unknown): void;
  now(): number;
}

export function createExecutionLivenessIndexOwner(
  host: V4GatewayHost,
  publishers: ReadonlyMap<string, Publisher>,
  publish: (sessionId: string) => void,
  now: () => number,
): ExecutionLivenessIndexOwner {
  return new ExecutionLivenessIndexOwner({
    publishers: () => publishers, publisher: (id) => publishers.get(id),
    observe: host.getSessionExecutionLiveness?.bind(host),
    metadata: (id) => host.getSessionIndexMeta?.(id), publish,
    onError: (error) => host.onError?.("v4.executionLiveness.observe", error), now,
  });
}

/** One observation owner; heartbeats never mutate a conversation publisher or progress timestamp. */
export class ExecutionLivenessIndexOwner {
  private readonly proofs = new Map<string, { seq: number; proof: ExecutionLivenessSnapshot }>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly requested = new Set<string>();
  private disposed = false;

  constructor(private readonly host: LivenessIndexHost) {}

  async refreshActive(): Promise<void> {
    if (!this.host.observe || this.disposed) return;
    const active: string[] = [];
    for (const [id, publisher] of this.host.publishers()) {
      const snapshot = publisher.getSnapshot();
      if (snapshot.control.phase === "running" || snapshot.control.phase === "prewarming" ||
          snapshot.backgroundWorks.some((work) => work.status === "running") || !this.proofs.has(id)) active.push(id);
    }
    await Promise.all(active.map((id) => this.refresh(id)));
  }

  refresh(sessionId: string): Promise<void> {
    if (!this.host.observe || this.disposed) return Promise.resolve();
    const pending = this.inFlight.get(sessionId);
    if (pending) { this.requested.add(sessionId); return pending; }
    const publisher = this.host.publisher(sessionId);
    if (!publisher) return Promise.resolve();
    const snapshot = publisher.getSnapshot();
    const workIds = snapshot.backgroundWorks.filter((work) => work.status === "running").map((work) => work.workId);
    const task = Promise.resolve().then(async () => {
      const value = await this.host.observe!(sessionId, workIds);
      // 查询期间换代或完成，旧租约不能把新 owner/终态改回 running。
      if (!value || this.disposed || this.host.publisher(sessionId) !== publisher || publisher.getSnapshot().seq !== snapshot.seq) return;
      this.proofs.set(sessionId, { seq: snapshot.seq, proof: executionLivenessSchema.parse(value) });
      this.host.publish(sessionId);
    }).catch((error) => this.host.onError(error)).finally(() => {
      if (this.inFlight.get(sessionId) !== task) return;
      this.inFlight.delete(sessionId);
      if (this.requested.delete(sessionId) && !this.disposed) void this.refresh(sessionId);
    });
    this.inFlight.set(sessionId, task);
    return task;
  }

  resolveMeta(sessionId: string): IndexMetadata & { executionLiveness?: ExecutionLivenessSnapshot } {
    const meta = this.host.metadata(sessionId);
    const cached = this.proofs.get(sessionId);
    return {
      createdAt: meta?.createdAt ?? 0,
      lastActivityAt: meta?.lastActivityAt ?? this.host.now(),
      ...(meta?.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
      ...(cached && cached.seq === this.host.publisher(sessionId)?.getSnapshot().seq ? { executionLiveness: cached.proof } : {}),
    };
  }

  dispose(): void {
    this.disposed = true;
    this.proofs.clear();
    this.inFlight.clear();
    this.requested.clear();
  }
}
