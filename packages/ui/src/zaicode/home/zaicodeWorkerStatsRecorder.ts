import type { ZaicodeStatsWorkerSession } from "@zcode/shared";
import type { ZaicodeWorker } from "../zaicodeWorkers.js";

export type WorkerStatsProjection = Pick<
  ZaicodeWorker,
  "id" | "kind" | "short" | "projectPath" | "startedAt" | "endedAt" | "exitCode"
>;
export type WorkerStatsWriter = (sessions: ZaicodeStatsWorkerSession[]) => Promise<unknown>;

/** A worker's finished session, or null while it runs / when it is not a subscription worker. */
export function zaicodeWorkerSession(
  worker: WorkerStatsProjection,
  endedAt: number | null,
): ZaicodeStatsWorkerSession | null {
  if (worker.kind !== "worker") return null;
  const end = worker.endedAt ?? endedAt;
  if (end === null) return null;
  return {
    id: worker.id,
    startedAt: worker.startedAt,
    endedAt: end,
    project: worker.projectPath,
    engine: worker.short,
    exitCode: worker.exitCode,
  };
}

/** App-wide worker statistics recorder; durable deduplication belongs to the existing service. */
export class ZaicodeWorkerStatsRecorder {
  private readonly running = new Map<string, WorkerStatsProjection>();
  private readonly recorded = new Set<string>();
  private readonly pending = new Map<string, ZaicodeStatsWorkerSession>();
  private present = new Set<string>();
  private write: WorkerStatsWriter | undefined;
  private inflight: Promise<void> | null = null;

  observe(workers: readonly WorkerStatsProjection[], now: number): void {
    const present = new Set<string>();
    for (const worker of workers) {
      present.add(worker.id);
      if (worker.kind !== "worker") continue;
      this.running.set(worker.id, worker);
      if (
        worker.exitCode !== null &&
        !this.recorded.has(worker.id) &&
        !this.pending.has(worker.id)
      ) {
        const session = zaicodeWorkerSession(worker, now);
        if (session) this.pending.set(worker.id, session);
      }
    }
    for (const [id, worker] of this.running) {
      if (present.has(id)) continue;
      this.running.delete(id);
      if (this.recorded.has(id) || this.pending.has(id)) continue;
      const session = zaicodeWorkerSession(worker, now);
      if (session) this.pending.set(id, session);
    }
    // T-253 / PERF-005 — 永久去重属于 SQLite；已离开界面的已确认 id 不得积累成 renderer 历史。
    for (const id of this.recorded) if (!present.has(id)) this.recorded.delete(id);
    this.present = present;
  }

  flush(write?: WorkerStatsWriter): Promise<void> {
    this.write = write;
    if (this.inflight) return this.inflight;
    if (!write || this.pending.size === 0) return Promise.resolve();
    // T-253 — 缺席/失败不等于已记录；成功才删除 pending。每批最多 200，避免服务 slice 丢掉后缀。
    let drained = false;
    this.inflight = Promise.resolve()
      .then(async () => {
        while (this.write && this.pending.size > 0) {
          const batch: ZaicodeStatsWorkerSession[] = [];
          for (const session of this.pending.values()) {
            batch.push(session);
            if (batch.length === 200) break;
          }
          await this.write(batch);
          for (const session of batch) {
            if (this.pending.get(session.id) !== session) continue;
            this.pending.delete(session.id);
            if (this.present.has(session.id)) this.recorded.add(session.id);
          }
        }
        drained = true;
      })
      .finally(() => {
        this.inflight = null;
        // ACK 续体与 finally 之间可能又来了 worker；成功才继续排空，拒绝时必须等待原有重试触发。
        if (drained && this.write && this.pending.size > 0) return this.flush(this.write);
      });
    return this.inflight;
  }

  get retainedWorkerCount(): number {
    return this.running.size + this.recorded.size + this.pending.size;
  }
}
