/* oxlint-disable eslint(max-lines) -- the exporter holds the evidence copy policy and the pack document pass in one pass; splitting them would spread the fail-closed redaction rule across files. */
import type { IFileService } from "@zcode/services";
import {
  partitionSessionsForParts,
  redactSecrets,
} from "./zaicodeDriftCaptureContract.js";
import { useDriftCaptureStore } from "./zaicodeDriftCaptureStore.js";
import {
  joinPath,
  listPackFiles,
  parentPath,
  readFullText,
  readJson,
  relativeInside,
  sanitize,
  sessionDirOf,
  shortHash,
  VERIFY_SCRIPT,
  writeJson,
  MAX_REDACT_BYTES,
  type SourceManifest,
} from "./zaicodeDriftCaptureSupport.js";
import type {
  DriftPackAttachment,
  DriftPackExclusionReason,
  DriftPackRedactionState,
  DriftReviewPackProblem,
  DriftReviewPackRedactionPolicy,
  DriftReviewPackResult,
  DriftReviewPackSession,
  ExportDriftReviewPackParams,
} from "./zaicodeDriftCaptureTypes.js";
import { renderIndex, renderProblems, renderRootIndex } from "./zaicodeDriftReviewPackRender.js";
import { collectPackAttachments } from "./zaicodeDriftReviewPackAttachments.js";

/**
 * Portable review pack.
 *
 * The pack is self-contained: real evidence bytes are copied out of the vault,
 * every copy is re-hashed from disk, and the manifest stores relative paths
 * only, so it can be verified on another computer with no ZAICODE data
 * directory. Sessions that cannot be verified are reported as problems, never
 * shipped as if they were fine.
 */

interface PackSource {
  receipt: ReturnType<typeof useDriftCaptureStore.getState>["receipts"][string];
  size: number;
}

type EvidenceCopyResult =
  | { ok: true; state: DriftPackRedactionState; sha256: string; size: number }
  | { ok: false; state: DriftPackExclusionReason };

/**
 * Copy one verified source into the pack, failing closed on redaction.
 *
 * A source that cannot be scanned is never copied silently: the pack either
 * excludes it with a visible reason or, when the operator explicitly allowed
 * unscanned copies, carries it marked `UNREDACTED_AUTHORIZED`.
 */
async function writeEvidenceCopy(input: {
  fileService: ExportDriftReviewPackParams["fileService"];
  source: string;
  target: string;
  sourceSha256: string;
  redact: boolean;
  allowUnredacted: boolean;
}): Promise<EvidenceCopyResult> {
  const copyExact = async (state: DriftPackRedactionState): Promise<EvidenceCopyResult> => {
    await input.fileService.copyFile({ from: input.source, to: input.target, overwrite: true });
    const digest = await input.fileService.sha256File({ path: input.target });
    if (digest.sha256 !== input.sourceSha256) throw new Error("Packed evidence digest mismatch");
    return { ok: true, state, sha256: digest.sha256, size: digest.size };
  };
  const excludedOrAuthorized = async (
    reason: DriftPackExclusionReason,
  ): Promise<EvidenceCopyResult> =>
    input.allowUnredacted ? copyExact("UNREDACTED_AUTHORIZED") : { ok: false, state: reason };

  if (!input.redact) return copyExact("DISABLED");
  let sourceSize: number;
  try {
    const fileStat = await input.fileService.stat({ path: input.source });
    if (fileStat.type !== "file") throw new Error("not a file");
    sourceSize = fileStat.size ?? 0;
  } catch {
    return excludedOrAuthorized("REDACTION_FAILED");
  }
  if (sourceSize > MAX_REDACT_BYTES) {
    return excludedOrAuthorized("REDACTION_SKIPPED_OVERSIZE");
  }
  let raw: string;
  try {
    // readFullText reads in fixed chunks, re-checks the size afterwards and
    // rejects invalid UTF-8, so a truncated or half-written transcript cannot
    // be mistaken for a clean one.
    raw = await readFullText(input.fileService, input.source, sourceSize);
  } catch {
    return excludedOrAuthorized("REDACTION_FAILED");
  }
  const cleaned = redactSecrets(raw);
  if (cleaned === raw) return copyExact("SCANNED_UNCHANGED");
  await input.fileService.writeTextFileAtomic({ path: input.target, content: cleaned });
  const digest = await input.fileService.sha256File({ path: input.target });
  return { ok: true, state: "REDACTED", sha256: digest.sha256, size: digest.size };
}

export async function exportDriftReviewPack(
  params: ExportDriftReviewPackParams,
): Promise<DriftReviewPackResult> {
  const now = params.now ?? Date.now;
  const root = params.vaultRoot.replace(/[\\/]+$/, "");
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
  const exportDir = joinPath(root, "exports", stamp);
  const redact = params.redactCredentials ?? true;
  // A source that cannot be scanned is excluded unless the operator explicitly
  // authorized an unredacted pack. The default never ships unscanned bytes.
  const allowUnredacted = params.allowUnredactedSources ?? false;
  const format = params.format ?? "folder";
  // Binary attachments stay references by default: a pack never carries
  // payloads unless the operator opted in.
  const exportBinary = params.exportBinaryAttachments ?? false;
  const splitPartBytes = Math.max(1, params.splitPartBytes ?? 512 * 1024 * 1024);
  const store = useDriftCaptureStore.getState();

  const allReceipts = Object.values(store.receipts);
  const candidates = allReceipts.filter((receipt) => {
    if (params.batchId && receipt.batchId !== params.batchId) return false;
    if (params.scope === "changed") return receipt.verification === "SAVED_WITH_NEW_ACTIVITY";
    if (params.scope === "failed")
      return (
        receipt.captureFailed === true ||
        receipt.verification === "FILE_MISSING" ||
        receipt.verification === "INTEGRITY_FAILED"
      );
    return true;
  });

  const problems: DriftReviewPackProblem[] = [];
  const verified: PackSource[] = [];
  for (const receipt of candidates) {
    if (receipt.captureFailed) {
      problems.push({
        sessionId: receipt.sessionId,
        workspacePath: receipt.workspacePath,
        sourcePath: receipt.outputPath,
        reason: "CAPTURE_FAILED",
      });
      continue;
    }
    let fileStat: Awaited<ReturnType<IFileService["stat"]>>;
    try {
      fileStat = await params.fileService.stat({ path: receipt.outputPath });
      if (fileStat.type !== "file") throw new Error("not a file");
    } catch {
      problems.push({
        sessionId: receipt.sessionId,
        workspacePath: receipt.workspacePath,
        sourcePath: receipt.outputPath,
        reason: "FILE_MISSING",
        expectedSha256: receipt.sha256,
      });
      continue;
    }
    let digest: { sha256: string; size: number };
    try {
      digest = await params.fileService.sha256File({ path: receipt.outputPath });
    } catch {
      problems.push({
        sessionId: receipt.sessionId,
        workspacePath: receipt.workspacePath,
        sourcePath: receipt.outputPath,
        reason: "INTEGRITY_FAILED",
        expectedSha256: receipt.sha256,
      });
      continue;
    }
    if (digest.sha256 !== receipt.sha256) {
      problems.push({
        sessionId: receipt.sessionId,
        workspacePath: receipt.workspacePath,
        sourcePath: receipt.outputPath,
        reason: "INTEGRITY_FAILED",
        expectedSha256: receipt.sha256,
        actualSha256: digest.sha256,
      });
      continue;
    }
    // Reconcile the persisted marker with the filesystem at export time.
    store.recordVerification(
      receipt.sessionId,
      receipt.workspacePath,
      receipt.workspaceIdentity,
      "SAVED_VERIFIED",
      { fileSize: digest.size },
    );
    verified.push({ receipt, size: digest.size });
  }

  // Merge discovery receipts from the batches that produced these sessions.
  const batchIds = [...new Set(candidates.map((r) => r.batchId))];
  const batchManifests: Array<{ batchId: string; manifest: SourceManifest }> = [];
  for (const batchId of batchIds) {
    const manifest = await readJson<SourceManifest>(
      params.fileService,
      joinPath(root, "batches", batchId, "manifest.json"),
    );
    if (manifest) batchManifests.push({ batchId, manifest });
  }
  const projectReceipts = batchManifests.flatMap((b) => b.manifest.projects ?? []);
  // Coverage is built after the evidence copies exist: a source excluded by the
  // redaction policy is part of the same problem list the operator reads.
  const buildCoverage = () => ({
    batches: batchManifests.map((b) => ({
      batchId: b.batchId,
      status: b.manifest.status,
      discovery: b.manifest.discovery?.status,
      failedProjects: b.manifest.discovery?.failedProjects ?? 0,
    })),
    projects: projectReceipts,
    selectedProjects: batchManifests.flatMap((b) => b.manifest.discovery?.selectedProjects ?? []),
    sessions: {
      verified: sessionCount,
      missing: problems.filter((p) => p.reason === "FILE_MISSING").length,
      integrityFailed: problems.filter((p) => p.reason === "INTEGRITY_FAILED").length,
      captureFailed: problems.filter((p) => p.reason === "CAPTURE_FAILED").length,
      unverified: problems.filter((p) => p.reason === "UNVERIFIED").length,
      redactionFailed: problems.filter((p) => p.reason === "REDACTION_FAILED").length,
      redactionSkippedOversize: problems.filter(
        (p) => p.reason === "REDACTION_SKIPPED_OVERSIZE",
      ).length,
    },
    binaryAttachments: exportBinary
      ? "opt-in: local attachment files are copied into the pack"
      : "references-only",
    captureMethod: "disk-verified",
  });

  const parts = partitionSessionsForParts(verified, (item) => item.size, splitPartBytes);
  const partCount = Math.max(1, parts.length);
  const zipPaths: string[] = [];
  let sessionCount = 0;

  // Phase 1 copies the evidence; only phase 2 writes manifests and archives,
  // so every document reflects the complete problem list.
  const partDirs: string[] = [];
  const partSessions: DriftReviewPackSession[][] = [];
  for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
    const partDir =
      partCount > 1
        ? joinPath(exportDir, `part-${String(partIndex + 1).padStart(2, "0")}`)
        : exportDir;
    partDirs.push(partDir);
    const sessions: DriftReviewPackSession[] = [];
    for (const source of parts[partIndex] ?? []) {
      const receipt = source.receipt;
      const projectDir = `${sanitize(receipt.workspacePath.split(/[\\/]/).filter(Boolean).pop() || "project")}-${shortHash(receipt.workspacePath)}`;
      const sessionDir = joinPath(
        partDir,
        "sessions",
        projectDir,
        sanitize(receipt.sessionId),
      );
      const evidenceSource = receipt.outputPath;
      const evidenceTarget = joinPath(sessionDir, "evidence.md");
      let copy: EvidenceCopyResult;
      try {
        copy = await writeEvidenceCopy({
          fileService: params.fileService,
          source: evidenceSource,
          target: evidenceTarget,
          sourceSha256: receipt.sha256,
          redact,
          allowUnredacted,
        });
      } catch {
        problems.push({
          sessionId: receipt.sessionId,
          workspacePath: receipt.workspacePath,
          sourcePath: evidenceSource,
          reason: "REDACTION_FAILED",
          expectedSha256: receipt.sha256,
        });
        continue;
      }
      if (!copy.ok) {
        problems.push({
          sessionId: receipt.sessionId,
          workspacePath: receipt.workspacePath,
          sourcePath: evidenceSource,
          reason: copy.state,
          expectedSha256: receipt.sha256,
        });
        continue;
      }
      let metadata: string | undefined;
      if (receipt.metadataPath) {
        try {
          await params.fileService.copyFile({
            from: receipt.metadataPath,
            to: joinPath(sessionDir, "metadata.json"),
            overwrite: true,
          });
          metadata = "metadata.json";
        } catch {
          metadata = undefined;
        }
      }
      // Binary export opt-in: copy the attachment files that still exist on
      // the Host. Everything else stays a reference, and the manifest says so.
      const attachments: DriftPackAttachment[] = exportBinary
        ? await collectPackAttachments({
            fileService: params.fileService,
            metadataPath: receipt.metadataPath,
            sessionDir,
            partDir,
          })
        : [];
      if (copy.state !== "REDACTED" && receipt.outputPath) {
        try {
          await params.fileService.copyFile({
            from: joinPath(parentPath(receipt.outputPath), "sha256.txt"),
            to: joinPath(sessionDir, "sha256.txt"),
            overwrite: true,
          });
        } catch {
          // optional convenience file
        }
      }
      sessions.push({
        sessionId: receipt.sessionId,
        workspacePath: receipt.workspacePath,
        workspaceIdentity: receipt.workspaceIdentity,
        capturedAt: receipt.capturedAt,
        messages: receipt.messages,
        characters: receipt.characters,
        sourceSha256: receipt.sha256,
        sha256: copy.sha256,
        size: copy.size,
        evidence: relativeInside(partDir, evidenceTarget),
        metadata,
        redaction: copy.state,
        verification: "SAVED_VERIFIED",
        ...(attachments.length > 0 ? { attachments } : {}),
      });
    }
    sessionCount += sessions.length;
    partSessions.push(sessions);
  }
  const coverage = buildCoverage();

  const redactionPolicy: DriftReviewPackRedactionPolicy = {
    requested: redact,
    mode: redact ? "pattern-scan" : "disabled",
    maxScannedBytes: MAX_REDACT_BYTES,
    unscannedCopies: allowUnredacted ? "operator-authorized" : "excluded",
  };

  const writePartDocs = async (partDir: string, partIndex: number) => {
    const sessions = partSessions[partIndex] ?? [];
    const partProblems = partIndex === 0 ? problems : [];
    await writeJson(params.fileService, joinPath(partDir, "manifest.json"), {
      schemaVersion: 2,
      generatedAt: new Date(now()).toISOString(),
      scope: params.scope ?? "all",
      batchId: params.batchId,
      part: { index: partIndex + 1, count: partCount },
      capturePolicy: "read-only",
      captureMethod: "disk-verified",
      redaction: redactionPolicy,
      note: "All paths in this manifest are relative to the pack folder.",
      sessions,
      problems: partProblems,
      coverage,
      binaryAttachments: exportBinary
        ? "opt-in: local attachment files are copied into the pack"
        : "references-only: attachment data is never embedded",
    });
    const checksums = [
      ...sessions.map((s) => `${s.sha256}  ${s.evidence}`),
      ...sessions.flatMap((s) =>
        (s.attachments ?? [])
          .filter((attachment) => attachment.sha256)
          .map((attachment) => `${attachment.sha256}  ${attachment.name}`),
      ),
    ].join("\n");
    await params.fileService.writeTextFileAtomic({
      path: joinPath(partDir, "checksums.sha256.txt"),
      content: `${checksums}\n`,
    });
    await params.fileService.writeTextFileAtomic({
      path: joinPath(partDir, "verify.mjs"),
      content: VERIFY_SCRIPT,
    });
    await params.fileService.writeTextFileAtomic({
      path: joinPath(partDir, "index.md"),
      content: renderIndex({
        generatedAt: new Date(now()).toISOString(),
        scope: params.scope ?? "all",
        partIndex,
        partCount,
        coverage,
        sessions,
        problems: partProblems,
        redaction: redactionPolicy,
        allowUnredacted,
      }),
    });
    if (format !== "zip") return;

    // The archive names come from the pack's own relative paths, so a ZIP
    // entry can never point at a directory that does not exist in the pack.
    const entries: Array<{ name: string; path: string }> = [
      { name: "index.md", path: joinPath(partDir, "index.md") },
      { name: "manifest.json", path: joinPath(partDir, "manifest.json") },
      { name: "checksums.sha256.txt", path: joinPath(partDir, "checksums.sha256.txt") },
      { name: "verify.mjs", path: joinPath(partDir, "verify.mjs") },
    ];
    for (const session of sessions) {
      entries.push({ name: session.evidence, path: joinPath(partDir, session.evidence) });
      if (session.metadata) {
        const metadataName = `${sessionDirOf(session.evidence)}${session.metadata}`;
        entries.push({ name: metadataName, path: joinPath(partDir, metadataName) });
      }
      for (const attachment of session.attachments ?? []) {
        if (!attachment.sha256) continue;
        entries.push({ name: attachment.name, path: joinPath(partDir, attachment.name) });
      }
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.name)) throw new Error(`Duplicate ZIP entry: ${entry.name}`);
      seen.add(entry.name);
      const entryStat = await params.fileService.stat({ path: entry.path }).catch(() => undefined);
      if (!entryStat || entryStat.type !== "file") {
        throw new Error(`ZIP entry has no source file: ${entry.name} -> ${entry.path}`);
      }
    }
    const zip = await params.fileService.createZipArchive({
      outPath: `${partDir}.zip`,
      entries,
    });
    if (zip.entries !== entries.length) {
      throw new Error(
        `ZIP archive holds ${zip.entries} entries, expected ${entries.length}`,
      );
    }
    if (!(zip.size > 0)) throw new Error("ZIP archive is empty");
    const zipStat = await params.fileService.stat({ path: zip.path });
    if (zipStat.size !== zip.size) throw new Error("ZIP archive size changed after creation");
    zipPaths.push(zip.path);
  };

  for (let index = 0; index < partCount; index += 1) {
    await writePartDocs(partDirs[index]!, index);
  }

  const rootProblemPath = joinPath(exportDir, "missing-sources.md");
  const rootIndexPath = joinPath(exportDir, "index.md");
  const rootManifestPath = joinPath(exportDir, "manifest.json");
  await params.fileService.writeTextFileAtomic({
    path: rootProblemPath,
    content: renderProblems(problems),
  });
  await writeJson(params.fileService, rootManifestPath, {
    schemaVersion: 2,
    generatedAt: new Date(now()).toISOString(),
    scope: params.scope ?? "all",
    batchId: params.batchId,
    parts: partCount,
    partFolders:
      partCount > 1
        ? Array.from({ length: partCount }, (_, i) => `part-${String(i + 1).padStart(2, "0")}`)
        : ["."],
    zipPaths: zipPaths.map((zip) => relativeInside(exportDir, zip)),
    redaction: redactionPolicy,
    // verify.mjs reads this array; for a single part the pack root IS the part.
    sessions: partCount === 1 ? (partSessions[0] ?? []) : [],
    sessionCount,
    problems,
    problemCount: problems.length,
    coverage,
    files: listPackFiles(partCount),
  });
  if (partCount > 1) {
    await params.fileService.writeTextFileAtomic({
      path: rootIndexPath,
      content: renderRootIndex({
        generatedAt: new Date(now()).toISOString(),
        coverage,
        partCount,
        zipPaths: zipPaths.map((zip) => relativeInside(exportDir, zip)),
        problems,
      }),
    });
  }

  return {
    exportDir,
    indexPath: rootIndexPath,
    manifestPath: rootManifestPath,
    zipPaths,
    parts: partCount,
    sessions: sessionCount,
    problems: problems.length,
  };
}
