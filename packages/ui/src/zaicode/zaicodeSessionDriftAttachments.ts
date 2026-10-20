import type { ZCodeMessagePart, ZCodeSessionStateSnapshot } from "@zcode/shared";

export interface SessionDriftAttachmentReference {
  readonly mime: string;
  readonly filename?: string;
  readonly reference: string;
  readonly elidedPayloadCharacters: number;
  /** Set when the attachment points at a file on the Host filesystem. */
  readonly localPath?: string;
}

/** Binary attachments remain references; never fetch or inline their payload. */
export function describeSessionDriftFilePart(
  part: Extract<ZCodeMessagePart, { type: "file" }>,
): SessionDriftAttachmentReference {
  const { mime, filename, url } = part;
  const localPath = localAttachmentPath(part);
  if (!url.startsWith("data:"))
    return { mime, filename, reference: url, elidedPayloadCharacters: 0, ...(localPath ? { localPath } : {}) };
  const comma = url.indexOf(",");
  const descriptor = comma >= 0 ? url.slice(0, comma) : url;
  const payload = comma >= 0 ? url.length - comma - 1 : 0;
  return {
    mime,
    filename,
    reference: `${descriptor},<${payload} characters of inline payload not copied into this text document; the bytes remain in the source session>`,
    elidedPayloadCharacters: payload,
  };
}

/**
 * The local file an attachment came from, when the source recorded one.
 * Inline data URLs and remote URLs have no local file: their bytes stay in the
 * source session and are never copied into a pack.
 */
export function localAttachmentPath(
  part: Extract<ZCodeMessagePart, { type: "file" }>,
): string | undefined {
  const candidates = [
    part.url,
    (part.metadata as Record<string, unknown> | undefined)?.originalUrl,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const value = candidate.trim();
    if (!value || value.startsWith("data:")) continue;
    if (/^https?:\/\//i.test(value) || value.startsWith("file://")) continue;
    if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\"))
      return value;
  }
  return undefined;
}

/** Every attachment of a captured snapshot, in source order. */
export function describeSessionDriftAttachments(
  snapshot: ZCodeSessionStateSnapshot,
): SessionDriftAttachmentReference[] {
  const attachments: SessionDriftAttachmentReference[] = [];
  for (const message of snapshot.messages) {
    for (const part of message.parts) {
      if (part.type === "file") attachments.push(describeSessionDriftFilePart(part));
    }
  }
  return attachments;
}
