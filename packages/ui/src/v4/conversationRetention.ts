import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";

// Historical rows remain in the session log and can be paged back in. A live view
// must have a fixed cost even when a single autonomous turn runs for hours.
export const ZAICODE_LIVE_CONVERSATION_ROWS = 512;
export const ZAICODE_AUTO_LEADING_TURN_ROWS = 240;

export function retainConversationTail(
  snapshot: ConversationSnapshot,
  limit = ZAICODE_LIVE_CONVERSATION_ROWS,
): ConversationSnapshot {
  if (snapshot.rows.window.length <= limit) return snapshot;
  return {
    ...snapshot,
    rows: { ...snapshot.rows, window: snapshot.rows.window.slice(-limit) },
  };
}
