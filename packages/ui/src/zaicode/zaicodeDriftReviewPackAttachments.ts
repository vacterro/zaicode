import {
  joinPath,
  readJson,
  relativeInside,
  sanitize,
  type PackFiles,
} from "./zaicodeDriftCaptureSupport.js";
import type { DriftPackAttachment } from "./zaicodeDriftCaptureTypes.js";

/**
 * Binary export opt-in for a review pack.
 *
 * Only attachment files that still exist on the Host are copied into the pack.
 * Everything else stays a reference, and the manifest says which is which: a
 * pack never claims a binary it does not carry.
 */
export async function collectPackAttachments(params: {
  fileService: PackFiles;
  metadataPath?: string;
  sessionDir: string;
  partDir: string;
}): Promise<DriftPackAttachment[]> {
  const attachments: DriftPackAttachment[] = [];
  if (!params.metadataPath) return attachments;
  const source = await readJson<{
    attachments?: { mime: string; filename?: string; localPath?: string }[];
  }>(params.fileService, params.metadataPath);
  for (const [index, attachment] of (source?.attachments ?? []).entries()) {
    const fallbackName = attachment.filename ?? `attachment-${index + 1}`;
    if (!attachment.localPath) {
      attachments.push({
        name: fallbackName,
        note: "no local file: the bytes stay in the source session",
      });
      continue;
    }
    try {
      const fileStat = await params.fileService.stat({ path: attachment.localPath });
      if (fileStat.type !== "file") throw new Error("not a file");
      const target = joinPath(params.sessionDir, "attachments", sanitize(fallbackName));
      await params.fileService.copyFile({
        from: attachment.localPath,
        to: target,
        overwrite: true,
      });
      const digest = await params.fileService.sha256File({ path: target });
      attachments.push({
        name: relativeInside(params.partDir, target),
        sha256: digest.sha256,
        size: digest.size,
      });
    } catch {
      attachments.push({
        name: fallbackName,
        note: "not copied: the source file is not readable on the Host",
      });
    }
  }
  return attachments;
}
