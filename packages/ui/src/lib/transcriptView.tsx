import { createContext, useContext } from "react";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

export type TranscriptView = "compact" | "full" | "only-text";

export function normalizeTranscriptView(value: unknown): TranscriptView {
  return value === "full" || value === "only-text" ? value : "compact";
}

export const TranscriptViewContext = createContext<TranscriptView>("compact");
export const useExpandedTranscript = () => useContext(TranscriptViewContext) === "full";

export function projectTranscriptRows(
  rows: readonly ConversationRow[],
  view: TranscriptView,
): readonly ConversationRow[] {
  if (view !== "only-text") return rows;
  // 必须在工具分组之前过滤；CUA 和历史折叠可能消费中间正文，不能只隐藏工具 DOM。
  return rows.filter(
    (row) =>
      row.kind === "turnHeader" ||
      row.kind === "userInput" ||
      row.kind === "assistantText" ||
      (row.kind === "timelineMarker" &&
        row.marker.type === "goalVerify" &&
        (row.marker.outcome === "failed" || row.marker.outcome === "notSatisfied")),
  );
}
