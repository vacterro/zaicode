import type { ZaicodeStatsWorkerSession } from "@zcode/shared";
import type { ZaicodeWorker } from "../zaicodeWorkers.js";

export type WorkerStatsProjection = Pick<ZaicodeWorker, "id" | "kind" | "short" | "projectPath" | "startedAt" | "endedAt" | "exitCode">;
export type WorkerStatsWriter = (sessions: ZaicodeStatsWorkerSession[]) => Promise<unknown>;

/** A worker's finished session, or null while it runs / when it is not a subscription worker. */
export function zaicodeWorkerSession(worker: WorkerStatsProjection, endedAt: number | null): ZaicodeStatsWorkerSession | null {
  if (worker.kind !== "worker") return null;
  const end = worker.endedAt ?? endedAt;
  if (end === null) return null;
  return { id: worker.id, startedAt: worker.startedAt, endedAt: end, project: worker.projectPath, engine: worker.short, exitCode: worker.exitCode };
}

/** App-wide worker statistics recorder; durable deduplication belongs to the existing service. */
export class ZaicodeWorkerStatsRecorder {
  private readonly running = new Map<string, WorkerStatsProjection>();
  private readonly recorded = new Set<string>();
  private pending: ZaicodeStatsWorkerSession[] = [];

  observe(workers: readonly WorkerStatsProjection[], now: number): void {
    const finished: ZaicodeStatsWorkerSession[] = [];
    const present = new Set<string>();
    for (const worker of workers) {
      present.add(worker.id);
      this.running.set(worker.id, worker);
      if (worker.exitCode !== null && !this.recorded.has(worker.id)) {
        const session = zaicodeWorkerSession(worker, now);
        if (session) finished.push(session);
        this.recorded.add(worker.id);
      }
    }
    for (const [id, worker] of this.running) {
      if (present.has(id)) continue;
      this.running.delete(id);
      if (this.recorded.has(id)) continue;
      this.recorded.add(id);
      const session = zaicodeWorkerSession(worker, now);
      if (session) finished.push(session);
    }
    this.pending = finished;
  }

  flush(write?: WorkerStatsWriter): Promise<void> {
    const finished = this.pending;
    this.pending = [];
    return finished.length > 0 && write ? write(finished).then(() => undefined).catch(() => undefined) : Promise.resolve();
  }

  get retainedWorkerCount(): number {
    return this.running.size + this.recorded.size + this.pending.length;
  }
}
