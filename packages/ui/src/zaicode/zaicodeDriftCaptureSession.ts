import type { ZCodeTaskTarget } from "@zcode/services";
import { formatSessionDriftEvidence, type SessionDriftEvidence } from "./zaicodeSessionDriftFormat.js";
import { describeSessionDriftAttachments } from "./zaicodeSessionDriftAttachments.js";
import { readSessionDriftContext } from "./zaicodeSessionDriftCopy.js";
import { useDriftCaptureStore } from "./zaicodeDriftCaptureStore.js";
import { refreshBatchLease, LEASE_TTL_MS, type LeaseStorage } from "./zaicodeDriftCaptureLease.js";
import {
  joinPath,
  resumeSessionKey,
  sanitize,
  shortHash,
  utf8ByteLength,
  writeJson,
  type CaptureFiles,
} from "./zaicodeDriftCaptureSupport.js";
import type { DriftCaptureMetricsCollector } from "./zaicodeDriftCaptureMetrics.js";
import type { CaptureAllSessionDriftParams, SessionDriftCaptureResult } from "./zaicodeDriftCaptureTypes.js";

/**
 * Per-session capture with a crash-safe commit.
 *
 * STAGING -> VERIFYING -> COMMITTED. Nothing is published before the staged
 * bytes have been re-hashed from disk, and existing evidence is never
 * overwritten: a different digest is a hard conflict, an identical one is an
 * idempotent resume.
 */

export interface DiscoveredSession {
  project: { name?: string; path: string; identity?: string };
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  updatedAt?: number;
}

export interface DriftBatchCounters {
  done: number;
  failed: number;
  skipped: number;
}

export interface CommittedSessionProof {
  /** Digest recorded for the published evidence; absent on pre-T-395 manifests. */
  sha256?: string;
  outputPath?: string;
}

export interface DriftSessionCaptureContext {
  params: CaptureAllSessionDriftParams;
  fileService: CaptureFiles;
  batchId: string;
  batchDir: string;
  now: () => number;
  forceRecapture: boolean;
  skipUnchanged: boolean;
  /** Keyed by `resumeSessionKey`, so two workspaces cannot share a skip. */
  committedSessions: ReadonlyMap<string, CommittedSessionProof>;
  total: number;
  counters: DriftBatchCounters;
  results: SessionDriftCaptureResult[];
  perSession: unknown[];
  queueManifest: (status: string) => Promise<unknown>;
  leaseStorage?: LeaseStorage;
  ownerId: string;
  /** Called when ownership can no longer be proven; no new work may start. */
  onLeaseLost?: (reason: string) => void;
  metrics?: DriftCaptureMetricsCollector;
}

function projectDirOf(name: string | undefined, path: string): string {
  return `${sanitize(name || path)}-${shortHash(path)}`;
}

/**
 * Prove a resume skip against the disk instead of the manifest text.
 *
 * A manifest can outlive the file it names (manual cleanup, a moved vault, a
 * partially restored backup). Without a digest the entry cannot be proven, so
 * the session is recaptured and the immutable-evidence check still protects
 * any file that does exist.
 */
async function evidenceStillMatches(
  fileService: CaptureFiles,
  proof: CommittedSessionProof | undefined,
): Promise<boolean> {
  if (!proof?.outputPath || !proof.sha256) return false;
  try {
    const readBack = await fileService.sha256File({ path: proof.outputPath });
    return readBack.sha256 === proof.sha256;
  } catch {
    return false;
  }
}

export async function captureOneSession(
  ctx: DriftSessionCaptureContext,
  item: DiscoveredSession,
): Promise<SessionDriftCaptureResult> {
  const { params, fileService, batchId, batchDir, now } = ctx;
  const sessionDir = joinPath(
    batchDir,
    "projects",
    projectDirOf(item.project.name, item.project.path),
    "sessions",
    sanitize(item.sessionId),
  );
  const outputPath = joinPath(sessionDir, "evidence.md");
  const metadataPath = joinPath(sessionDir, "metadata.json");
  const shaPath = joinPath(sessionDir, "sha256.txt");
  const stagedEvidencePath = joinPath(sessionDir, ".staging", "evidence.md");

  if (!ctx.forceRecapture && ctx.committedSessions.has(resumeSessionKey(item.workspacePath, item.sessionId))) {
    // A resume may skip only what the disk still proves: the manifest entry
    // alone is a claim, and a deleted or edited evidence file must be recaptured
    // instead of silently staying missing.
    const proof = ctx.committedSessions.get(resumeSessionKey(item.workspacePath, item.sessionId));
    const stillIntact = await evidenceStillMatches(fileService, proof);
    if (stillIntact) {
      ctx.counters.skipped += 1;
      ctx.counters.done += 1;
      const result: SessionDriftCaptureResult = {
        projectId: item.workspaceIdentity ?? item.workspacePath,
        projectPath: item.workspacePath,
        sessionId: item.sessionId,
        outputPath: proof?.outputPath ?? outputPath,
        messages: 0,
        characters: 0,
        ...(proof?.sha256 ? { sha256: proof.sha256 } : {}),
        skipped: true,
        state: "UNCHANGED",
      };
      ctx.results.push(result);
      ctx.perSession.push({ ...result, status: "UNCHANGED" });
      params.onProgress?.(ctx.counters.done, ctx.total, item.sessionId);
      await ctx.queueManifest("CAPTURING");
      return result;
    }
  }

  // Incremental skip: the stored watermark still matches the live session.
  const existingReceipt = useDriftCaptureStore
    .getState()
    .getReceipt(item.sessionId, item.workspacePath, item.workspaceIdentity);
  if (
    !ctx.forceRecapture &&
    ctx.skipUnchanged &&
    existingReceipt?.verification === "SAVED_VERIFIED" &&
    item.updatedAt &&
    existingReceipt.watermarkUpdatedAt === item.updatedAt
  ) {
    ctx.counters.skipped += 1;
    ctx.counters.done += 1;
    params.onProgress?.(ctx.counters.done, ctx.total, item.sessionId);
    const result: SessionDriftCaptureResult = {
      projectId: item.workspaceIdentity ?? item.workspacePath,
      projectPath: item.workspacePath,
      sessionId: item.sessionId,
      outputPath: existingReceipt.outputPath,
      messages: existingReceipt.messages,
      characters: existingReceipt.characters,
      sha256: existingReceipt.sha256,
      skipped: true,
      state: "UNCHANGED",
    };
    ctx.results.push(result);
    ctx.perSession.push({ ...result, status: "UNCHANGED" });
    await ctx.queueManifest("CAPTURING");
    return result;
  }

  const store = useDriftCaptureStore.getState();
  store.markCapturing(item.sessionId);
  params.onProgress?.(ctx.counters.done, ctx.total, item.sessionId);
  const target: ZCodeTaskTarget = {
    sessionId: item.sessionId,
    workspacePath: item.workspacePath,
    workspaceIdentity: item.workspaceIdentity,
  };
  try {
    if (!target.sessionId.trim() || !target.workspacePath.trim())
      throw new Error("Invalid session/workspace identity");
    const [snapshot, context] = await Promise.all([
      params.sessionService
        .readSession({ ...target, repairImportedHistory: false })
        .then((s) => structuredClone(s)),
      (params.includeProtocolContext ?? true)
        ? readSessionDriftContext(fileService, target.workspacePath, now)
        : Promise.resolve([]),
    ]);
    const actual = snapshot.session;
    if (
      actual.sessionId !== target.sessionId ||
      actual.workspace.workspacePath !== target.workspacePath
    )
      throw new Error("Session/workspace identity mismatch");
    if (
      actual.workspace.workspaceIdentity &&
      actual.workspace.workspaceIdentity !== target.workspaceIdentity
    )
      throw new Error("Workspace identity mismatch");
    if (
      snapshot.messages.some(
        (m) =>
          m.info.sessionId !== actual.sessionId ||
          m.parts.some(
            (p) => p.sessionId !== actual.sessionId || p.messageId !== m.info.messageId,
          ),
      )
    )
      throw new Error("Message identity mismatch");

    const includeAttachmentReference =
      params.captureAttachmentsByReference ?? store.settings.captureAttachmentsByReference;
    const evidence: SessionDriftEvidence = {
      snapshot,
      target,
      requestedAt: now(),
      capturedAt: now(),
      context,
      app: params.app,
      includeAttachmentReference,
    };
    const text = formatSessionDriftEvidence(evidence);

    // STAGING: write to a per-session staging file, then verify what the
    // filesystem actually holds before publishing anything. The digest is
    // computed by the Host in bounded chunks, so a large transcript never
    // needs a second full copy in the renderer.
    const hostIoStart = Date.now();
    await fileService.writeTextFileAtomic({ path: stagedEvidencePath, content: text });
    const stagedDigest = await fileService.sha256File({ path: stagedEvidencePath });
    const sha = stagedDigest.sha256;
    ctx.metrics?.observeHostIo(Date.now() - hostIoStart);
    // The digest now comes from the bytes on disk. A truncated or corrupted
    // staging write shows up as a size that is not the text's UTF-8 length.
    if (stagedDigest.size !== utf8ByteLength(text)) {
      throw new Error("Staged size does not match the captured transcript");
    }

    // VERIFYING: publish atomically. Existing evidence is immutable; an
    // identical file makes a resumed batch idempotent, a different one is a
    // hard conflict (never overwrite forensic evidence).
    const verifyStart = Date.now();
    try {
      const existing = await fileService.stat({ path: outputPath });
      if (existing.type === "file") {
        const existingDigest = await fileService.sha256File({ path: outputPath });
        if (existingDigest.sha256 !== sha) {
          throw new Error(
            `Immutable evidence conflict: ${outputPath} exists with a different digest`,
          );
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fileService
      .writeTextFileAtomic({ path: outputPath, content: text, overwrite: false })
      .catch(async (error) => {
        // Resume of an already-committed session: identical bytes are fine.
        if (!/already exists/i.test(String(error))) throw error;
        const existingDigest = await fileService.sha256File({ path: outputPath });
        if (existingDigest.sha256 !== sha) throw error;
        return { path: outputPath, size: existingDigest.size };
      });

    // COMMITTED only after a real read-back digest matches.
    const verify = await fileService.sha256File({ path: outputPath });
    if (verify.sha256 !== sha) throw new Error("Post-write SHA-256 mismatch");
    ctx.metrics?.observeHostIo(Date.now() - verifyStart);

    // The attachment list belongs to the metadata, not to the transcript: it
    // is what a later review pack needs to copy local binaries on request.
    const attachments = describeSessionDriftAttachments(snapshot).map((attachment) =>
      includeAttachmentReference
        ? attachment
        : {
            mime: attachment.mime,
            ...(attachment.filename ? { filename: attachment.filename } : {}),
          },
    );
    await writeJson(fileService, metadataPath, {
      schemaVersion: 2,
      batchId,
      sessionId: target.sessionId,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      capturedAt: new Date(now()).toISOString(),
      captureMethod: "disk-verified",
      messages: snapshot.messages.length,
      characters: text.length,
      sha256: sha,
      fileSize: verify.size,
      watermarkUpdatedAt: item.updatedAt ?? actual.updatedAt,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    await fileService.writeTextFileAtomic({
      path: shaPath,
      content: `${sha}  evidence.md\n`,
    });

    store.recordReceipt({
      sessionId: target.sessionId,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      batchId,
      capturedAt: new Date(now()).toISOString(),
      messages: snapshot.messages.length,
      characters: text.length,
      sha256: sha,
      watermarkUpdatedAt: item.updatedAt ?? actual.updatedAt,
      outputPath,
      metadataPath,
      fileSize: verify.size,
      verification: "SAVED_VERIFIED",
      verifiedAt: new Date(now()).toISOString(),
    });
    ctx.metrics?.observeSession(verify.size);

    const result: SessionDriftCaptureResult = {
      projectId: target.workspaceIdentity ?? target.workspacePath,
      projectPath: target.workspacePath,
      sessionId: target.sessionId,
      outputPath,
      messages: snapshot.messages.length,
      characters: text.length,
      sha256: sha,
      state: "COMMITTED",
    };
    ctx.results.push(result);
    ctx.perSession.push({ ...result, status: "COMMITTED", fileSize: verify.size });
    return result;
  } catch (error) {
    ctx.counters.failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    const result: SessionDriftCaptureResult = {
      projectId: item.workspaceIdentity ?? item.workspacePath,
      projectPath: item.workspacePath,
      sessionId: item.sessionId,
      outputPath,
      messages: 0,
      characters: 0,
      error: message,
      state: "CAPTURE_FAILED",
    };
    ctx.results.push(result);
    ctx.perSession.push({ ...result, status: "CAPTURE_FAILED" });
    useDriftCaptureStore.getState().recordCaptureFailure({
      sessionId: item.sessionId,
      workspacePath: item.workspacePath,
      workspaceIdentity: item.workspaceIdentity,
      batchId,
      error: message,
      outputPath,
    });
    return result;
  } finally {
    useDriftCaptureStore.getState().clearCapturing(item.sessionId);
    ctx.counters.done += 1;
    params.onProgress?.(ctx.counters.done, ctx.total, item.sessionId);
    if (ctx.leaseStorage) {
      const refreshed = refreshBatchLease({
        storage: ctx.leaseStorage,
        ownerId: ctx.ownerId,
        batchId,
        now: now(),
      });
      if (!refreshed.ok) ctx.onLeaseLost?.(refreshed.reason);
    }
    useDriftCaptureStore.getState().updateActiveBatch(batchId, {
      done: ctx.counters.done,
      failed: ctx.counters.failed,
      skipped: ctx.counters.skipped,
      leaseExpiresAt: now() + LEASE_TTL_MS,
    });
    await ctx.queueManifest("CAPTURING");
  }
}
