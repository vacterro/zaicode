import {
  freezeZaicodeRuntimeIdentity,
  zaicodeProjectTopology,
  type ZaicodeProjectTopology,
  type ZaicodeRuntimeIdentity,
} from "@zcode/shared";
import { readZaicodeWorkerIdentities, type ZaicodeWorkerIdentity } from "./zaicodeWorkerRecords.js";

/**
 * The runtime registry (T-42): every execution ZAICODE started itself (the
 * CLI workers) as one list of runtime identities.
 * It reads identity records only; where a worker is shown (panel, window,
 * chip) or which sidebar slot a project sits in is not an input, so no layout
 * change can alter an answer here. Agent sessions keep their identity in the
 * agent runtime (task id, host owner / lease); MAIN is a pointer to one of
 * them, not an execution authority.
 */

/** The ZAICODE window holds a worker's PTY. */
export const ZAICODE_WORKER_LEASE_HOLDER = "zaicode-window";

export function zaicodeWorkerRuntimeIdentity(worker: ZaicodeWorkerIdentity): ZaicodeRuntimeIdentity {
  const running = worker.exitCode === null;
  return freezeZaicodeRuntimeIdentity({
    runtimeId: worker.id,
    workId: null,
    owner: worker.accountId,
    role: worker.kind,
    generation: worker.generation,
    engine: worker.vendor,
    projectPath: worker.projectPath,
    lease: running ? { holder: ZAICODE_WORKER_LEASE_HOLDER, since: worker.startedAt } : null,
    health: running ? "running" : worker.exitCode === 0 ? "exited" : "failed",
  });
}

export function readZaicodeRuntimeRegistry(): ZaicodeRuntimeIdentity[] {
  return readZaicodeWorkerIdentities().map(zaicodeWorkerRuntimeIdentity);
}

export function readZaicodeProjectTopology(projectPath: string): ZaicodeProjectTopology {
  return zaicodeProjectTopology(readZaicodeRuntimeRegistry(), projectPath);
}
