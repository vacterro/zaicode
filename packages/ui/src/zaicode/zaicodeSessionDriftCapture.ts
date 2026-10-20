import { readZaicodeKnownProjects } from "./zaicodeScheduler.js";
import {
  classifyProjectDiscovery,
  isHelperDriftSession,
  summarizeDiscovery,
  type DriftDiscoverySummary,
  type DriftProjectDiscoveryReceipt,
  type DriftProjectSkip,
} from "./zaicodeDriftCaptureContract.js";
import { isZaicodeProjectDisabled } from "./zaicodeProjectSwitch.js";
import { useZaicodeMainSessions, zaicodeMainSessionIdOf } from "./zaicodeMainSession.js";
import { useDriftCaptureStore } from "./zaicodeDriftCaptureStore.js";
import {
  acquireBatchLease,
  defaultLeaseStorage,
  LEASE_TTL_MS,
  releaseBatchLease,
  startLeaseHeartbeat,
  WINDOW_OWNER_ID,
  type LeaseStorage,
} from "./zaicodeDriftCaptureLease.js";
import {
  joinPath,
  readFullText,
  readJson,
  readJsonExact,
  resumeSessionKey,
  writeJson,
  type CaptureFiles,
  type SourceManifest,
} from "./zaicodeDriftCaptureSupport.js";
import {
  captureOneSession,
  type CommittedSessionProof,
  type DiscoveredSession,
  type DriftBatchCounters,
} from "./zaicodeDriftCaptureSession.js";
import {
  createDriftCaptureMetricsCollector,
  type DriftCaptureMetrics,
} from "./zaicodeDriftCaptureMetrics.js";
import type {
  CaptureAllSessionDriftParams,
  DriftCaptureBatchSummary,
  SessionDriftCaptureResult,
} from "./zaicodeDriftCaptureTypes.js";

/**
 * Drift capture batch.
 *
 * Discovery keeps every selected project and its exact failure, the batch owns
 * itself durably through a lease, and the manifest is reconciled on disk after
 * every session. A batch is never reported as COMPLETE while a project failed
 * to be listed.
 */

const MAX_CONCURRENCY = 4;

export async function captureAllSessionDrift(
  params: CaptureAllSessionDriftParams,
): Promise<SessionDriftCaptureResult[]> {
  const batch = await captureAllSessionDriftDetailed(params);
  return [...batch.results];
}

export async function captureAllSessionDriftDetailed(
  params: CaptureAllSessionDriftParams,
): Promise<DriftCaptureBatchSummary> {
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const store = useDriftCaptureStore.getState();
  const concurrency = Math.max(
    1,
    Math.min(MAX_CONCURRENCY, params.concurrency ?? store.settings.concurrency ?? 3),
  );
  const skipUnchanged = params.skipUnchanged ?? store.settings.skipUnchanged;
  const forceRecapture = params.forceRecapture ?? store.settings.forceRecapture;
  const includeHelperSessions = params.includeHelperSessions ?? store.settings.includeHelperSessions;
  const includeDisabledProjects =
    params.includeDisabledProjects ?? store.settings.includeDisabledProjects;
  const projects = readZaicodeKnownProjects();
  const ownerId = params.ownerId ?? WINDOW_OWNER_ID;
  const leaseStorage: LeaseStorage | undefined = params.leaseStorage ?? defaultLeaseStorage();
  const root = params.vaultRoot.replace(/[\\/]+$/, "");

  const active = useDriftCaptureStore.getState().activeBatch;
  const resumeCandidate =
    params.resumeBatchId ??
    (active &&
    active.status === "CAPTURING" &&
    active.vaultRoot.replace(/[\\/]+$/, "") === root
      ? active.batchId
      : undefined);
  const batchId =
    resumeCandidate ??
    `${new Date(now()).toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  const batchDir = joinPath(root, "batches", batchId);
  const manifestPath = joinPath(batchDir, "manifest.json");

  if (leaseStorage) {
    const lease = await acquireBatchLease({
      storage: leaseStorage,
      ownerId,
      batchId,
      now: now(),
      sleep,
    });
    if (!lease.ok) throw new Error(lease.reason);
  }

  const committedSessions = resumeCandidate
    ? await readCommittedSessions(params.fileService, manifestPath)
    : new Map<string, CommittedSessionProof>();

  // Discovery keeps every selected project and its exact failure. A project
  // that cannot be listed is never reported as "no sessions".
  const receipts: DriftProjectDiscoveryReceipt[] = [];
  const skippedProjects: DriftProjectSkip[] = [];
  const discovered: DiscoveredSession[] = [];
  const mainSessions = useZaicodeMainSessions.getState().byWorkspace;
  for (const project of projects) {
    // A project switched off in the sidebar is a policy decision, not a
    // failure: it is recorded as skipped and never breaks the COMPLETE status.
    if (!includeDisabledProjects && isZaicodeProjectDisabled(project.key)) {
      skippedProjects.push({
        projectPath: project.path,
        projectName: project.name || project.path,
        reason: "project-disabled",
      });
      continue;
    }
    try {
      const sessions = await params.sessionService.listSessions({
        workspacePath: project.path,
        workspaceIdentity: project.identity,
        includeArchived: params.includeHistorical ?? store.settings.includeHistorical,
      });
      const mainSessionId = params.mainSessionIds
        ? params.mainSessionIds[project.key]
        : (zaicodeMainSessionIdOf(mainSessions, project.key) ?? undefined);
      let rejected = 0;
      let skipped = 0;
      for (const session of sessions) {
        const workspacePath = session.workspace.workspacePath || project.path;
        if (!session.sessionId?.trim() || !workspacePath.trim()) {
          rejected += 1;
          continue;
        }
        if (
          !includeHelperSessions &&
          isHelperDriftSession(
            { sessionId: session.sessionId, sessionKind: session.sessionKind },
            mainSessionId,
          )
        ) {
          skipped += 1;
          continue;
        }
        discovered.push({
          project,
          sessionId: session.sessionId,
          workspacePath,
          workspaceIdentity: session.workspace.workspaceIdentity ?? project.identity,
          updatedAt: session.updatedAt,
        });
      }
      receipts.push(
        classifyProjectDiscovery({
          project,
          sessions,
          rejectedSessions: rejected,
          skippedSessions: skipped,
        }),
      );
    } catch (error) {
      receipts.push(classifyProjectDiscovery({ project, error }));
    }
  }
  const discovery = summarizeDiscovery(receipts, skippedProjects);

  const createdAt = new Date(now()).toISOString();
  const existingManifest = resumeCandidate
    ? await readJson<SourceManifest & { createdAt?: string }>(params.fileService, manifestPath)
    : undefined;
  const total = discovered.length;
  const counters: DriftBatchCounters = { done: 0, failed: 0, skipped: 0 };
  const results: SessionDriftCaptureResult[] = [];
  const perSession: unknown[] = [];
  const startedAt = existingManifest?.createdAt ?? createdAt;
  // The metrics use the real clock, not the injected `now`: a duration
  // measured against a frozen test clock would be a made-up number.
  const metrics = createDriftCaptureMetricsCollector();
  metrics.start();
  let finalMetrics: DriftCaptureMetrics | undefined;

  useDriftCaptureStore.getState().setActiveBatch({
    batchId,
    ownerId,
    vaultRoot: root,
    startedAt,
    total,
    done: 0,
    failed: 0,
    skipped: 0,
    status: "CAPTURING",
    leaseExpiresAt: now() + LEASE_TTL_MS,
  });

  const manifestStatus = (): "COMPLETE" | "PARTIAL" | "FAILED" => {
    if (counters.failed > 0) return counters.done - counters.failed > 0 ? "PARTIAL" : "FAILED";
    if (discovery.status !== "COMPLETE") return "PARTIAL";
    return "COMPLETE";
  };

  const manifestSnapshot = (status: string) => ({
    schemaVersion: 2,
    batchId,
    createdAt: startedAt,
    updatedAt: new Date(now()).toISOString(),
    requestedScope: "all",
    captureMethod: "disk-verified",
    capturePolicy: "read-only",
    outputRoot: root,
    selectedProjects: discovery.selectedProjects,
    selectedSessions: discovered.map((d) => d.sessionId),
    projects: receipts,
    discovery,
    status,
    progress: { total, done: counters.done, failed: counters.failed, skipped: counters.skipped },
    perSessionResults: perSession,
    ...(finalMetrics ? { metrics: finalMetrics } : {}),
  });

  // A manifest write failure is a batch failure: the vault would otherwise
  // claim COMPLETE with no durable record of what it captured. The first error
  // is kept and rethrown after the run, and it downgrades the final status.
  let manifestError: Error | undefined;
  let manifestChain: Promise<unknown> = Promise.resolve();
  const queueManifest = (status: string) => {
    manifestChain = manifestChain.then(async () => {
      if (manifestError) return;
      try {
        await writeJson(params.fileService, manifestPath, manifestSnapshot(status));
      } catch (error) {
        manifestError = error instanceof Error ? error : new Error(String(error));
      }
    });
    return manifestChain;
  };
  await queueManifest("CAPTURING");

  // A slow Host read can outlive the lease. The heartbeat keeps the claim alive
  // while this window is genuinely working, and reports a lost claim instead of
  // letting a second window start capturing the same batch.
  let leaseLostReason: string | undefined;
  const context = {
    params,
    fileService: params.fileService,
    batchId,
    batchDir,
    now,
    forceRecapture,
    skipUnchanged,
    committedSessions,
    total,
    counters,
    results,
    perSession,
    queueManifest,
    leaseStorage,
    ownerId,
    onLeaseLost: (reason: string) => {
      leaseLostReason ??= reason;
    },
    metrics,
  };

  const stopHeartbeat =
    leaseStorage === undefined
      ? () => {}
      : startLeaseHeartbeat({
          storage: leaseStorage,
          ownerId,
          batchId,
          now,
          onLost: (reason) => {
            leaseLostReason = reason;
          },
        });

  let cursor = 0;
  async function worker() {
    while (cursor < discovered.length) {
      // Ownership is checked before every session: once another window holds
      // the batch, this one stops instead of writing a second copy.
      if (leaseLostReason) return;
      const idx = cursor++;
      await captureOneSession(context, discovered[idx]!);
    }
  }
  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    await manifestChain;
  } finally {
    stopHeartbeat();
  }

  finalMetrics = metrics.stop();
  // A batch is COMPLETE only when the manifest that says so is durably on
  // disk and this window still owned it to the end. A hidden write failure or
  // a lost lease would leave the vault claiming more than it captured, so both
  // downgrade the status instead.
  const durable = manifestError === undefined && leaseLostReason === undefined;
  const status = durable ? manifestStatus() : "FAILED";
  await queueManifest(status);
  useDriftCaptureStore.getState().updateActiveBatch(batchId, {
    status: status === "COMPLETE" ? "COMMITTED" : "FAILED",
    done: counters.done,
    failed: counters.failed,
    skipped: counters.skipped,
  });
  if (status !== "FAILED") {
    // Keep a failed batch record so a later run can see what broke; only a
    // completed or partially completed batch clears the active marker.
    useDriftCaptureStore.getState().clearActiveBatch(batchId);
  }

  await updateCaptureIndex(params.fileService, root, {
    batchId,
    createdAt: startedAt,
    updatedAt: new Date(now()).toISOString(),
    status,
    path: batchDir,
    progress: { total, done: counters.done, failed: counters.failed, skipped: counters.skipped },
    discoveryStatus: discovery.status,
    failedProjects: discovery.failedProjects,
  }).catch(() => {
    // The index is a convenience list; the batch manifest is the record.
    // Losing the index must not turn a durable batch into a thrown error.
  });

  if (leaseStorage) releaseBatchLease({ storage: leaseStorage, ownerId, batchId });

  if (leaseLostReason) {
    throw new Error(`${leaseLostReason}. The batch stopped before every session was captured.`);
  }
  if (manifestError) {
    throw new Error(
      `The batch manifest could not be written: ${manifestError.message}. Nothing is reported as complete.`,
    );
  }

  return {
    batchId,
    batchDir,
    discovery,
    status,
    total,
    committed: results.filter((r) => r.state === "COMMITTED").length,
    skipped: counters.skipped,
    failed: counters.failed,
    results,
    metrics: finalMetrics,
  };
}

async function readCommittedSessions(
  fileService: CaptureFiles,
  manifestPath: string,
): Promise<Map<string, CommittedSessionProof>> {
  const committed = new Map<string, CommittedSessionProof>();
  let manifest: SourceManifest | undefined;
  try {
    manifest = await readJsonExact<SourceManifest>(fileService, manifestPath);
  } catch (error) {
    throw new Error(
      `Cannot resume batch: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const result of manifest?.perSessionResults ?? []) {
    if (result.state !== "COMMITTED" && result.state !== "UNCHANGED") continue;
    if (!result.sessionId) continue;
    const workspacePath = result.projectPath ?? "";
    // Pre-T-395 manifests carry no digest. The persisted receipt does, and the
    // resume still proves the bytes against it instead of recapturing every
    // healthy session (or skipping on the manifest's word alone).
    const receipt = Object.values(useDriftCaptureStore.getState().receipts).find(
      (entry) =>
        entry.sessionId === result.sessionId &&
        (workspacePath === "" || entry.workspacePath === workspacePath),
    );
    committed.set(
      resumeSessionKey(workspacePath || receipt?.workspacePath || "", result.sessionId),
      {
        sha256: result.sha256 ?? receipt?.sha256,
        outputPath: result.outputPath ?? receipt?.outputPath,
      },
    );
  }
  return committed;
}

async function updateCaptureIndex(
  fileService: CaptureFiles,
  root: string,
  entry: unknown,
): Promise<void> {
  const indexPath = joinPath(root, "capture-index.json");
  let index: { batches: unknown[]; quarantined?: string[] } = { batches: [] };
  try {
    // The index grows with every batch, so it is read as a whole document: a
    // 256 KiB slice would turn a large history into "malformed" and quarantine
    // a perfectly good index.
    const parsed = await readJsonExact<{ batches?: unknown; quarantined?: string[] }>(
      fileService,
      indexPath,
    );
    if (parsed) {
      if (!Array.isArray(parsed.batches)) throw new Error("batches is not an array");
      index = { batches: parsed.batches, quarantined: parsed.quarantined };
    }
  } catch {
    // Never destroy a malformed index: keep a byte-preserving quarantine copy
    // first, and only then start a fresh index that names the quarantine.
    const raw = await fileService
      .stat({ path: indexPath })
      .then((fileStat) => readFullText(fileService, indexPath, fileStat.size ?? 0))
      .catch(() => undefined);
    if (raw !== undefined) {
      const quarantineName = `capture-index.corrupt-${Date.now()}.json`;
      await fileService.writeTextFileAtomic({
        path: joinPath(root, quarantineName),
        content: raw,
        overwrite: false,
      });
      index = { batches: [], quarantined: [quarantineName] };
    }
  }
  index.batches.unshift(entry);
  await writeJson(fileService, indexPath, index);
}

export type { DriftDiscoverySummary };
export { exportDriftReviewPack } from "./zaicodeDriftReviewPack.js";
export type {
  DriftReviewPackProblem,
  DriftReviewPackResult,
  DriftReviewPackSession,
  ExportDriftReviewPackParams,
} from "./zaicodeDriftCaptureTypes.js";
