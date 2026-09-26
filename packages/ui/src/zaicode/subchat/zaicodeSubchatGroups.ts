import type { ZaicodeSubchatConversation } from "@zcode/shared";
import { zaicodeLiveRunFolderKey } from "../zaicodeLiveRuns.js";

/**
 * SUBCHAT chats listed like projects (SRC-048): one group per project folder
 * (Windows paths compared without case), the group with the newest chat
 * first, each with how many of its chats are answering right now.
 */

export interface ZaicodeSubchatGroup {
  key: string;
  projectPath: string;
  conversations: ZaicodeSubchatConversation[];
  running: number;
}

export function groupZaicodeSubchats(
  conversations: readonly ZaicodeSubchatConversation[],
  isRunning: (id: string) => boolean,
): ZaicodeSubchatGroup[] {
  const groups = new Map<string, ZaicodeSubchatGroup>();
  for (const conversation of conversations) {
    const key = zaicodeLiveRunFolderKey(conversation.projectPath);
    const group = groups.get(key) ?? { key, projectPath: conversation.projectPath, conversations: [], running: 0 };
    group.conversations.push(conversation);
    if (isRunning(conversation.id)) group.running += 1;
    groups.set(key, group);
  }
  const newest = (group: ZaicodeSubchatGroup) => Math.max(...group.conversations.map((conversation) => conversation.updatedAt));
  return [...groups.values()].sort((a, b) => newest(b) - newest(a));
}
