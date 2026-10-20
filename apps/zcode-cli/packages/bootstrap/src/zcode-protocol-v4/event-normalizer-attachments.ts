import type { TurnAttachmentMeta, TurnStartedPayload } from "@zcode/contracts";

export interface CanonicalTurnAttachment {
  ref?: string;
  fileName: string;
  mime: string;
  bytes: number;
  previewRef?: string;
}

// 附件投影保持纯函数；从事件归一化入口移出，避免突破已有文件行数约束。
export function normalizeAttachments(payload: TurnStartedPayload): {
  attachments?: readonly CanonicalTurnAttachment[];
} {
  if (payload.intent?.attachmentRefs && payload.intent.attachmentRefs.length > 0) {
    return { attachments: payload.intent.attachmentRefs.map((attachment) => ({ ...attachment })) };
  }
  if (!payload.attachments || payload.attachments.length === 0) return {};
  return { attachments: payload.attachments.map(normalizeAttachment) };
}

function normalizeAttachment(attachment: TurnAttachmentMeta): CanonicalTurnAttachment {
  return {
    ...(attachment.ref ? { ref: attachment.ref } : {}),
    fileName: attachment.fileName,
    mime: attachment.mime,
    bytes: attachment.bytes,
  };
}
