import { createContext, useContext } from "react";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

export type LegacyTranscriptView =
  | "compact"
  | "full"
  | "full-unbounded"
  | "only-text"
  | "only-thoughts"
  | "only-tools";

export const TRANSCRIPT_SECTIONS = ["user", "assistant", "thoughts", "tools"] as const;
export type TranscriptSection = (typeof TRANSCRIPT_SECTIONS)[number];
export interface TranscriptSectionsView {
  kind: "sections";
  expanded: boolean;
  sections: Record<TranscriptSection, { visible: boolean; scroll: boolean }>;
}
export type TranscriptView = LegacyTranscriptView | TranscriptSectionsView;

export function isSectionsTranscriptView(
  view: TranscriptView | undefined,
): view is TranscriptSectionsView {
  return typeof view === "object" && view !== null && view.kind === "sections";
}

/** 旧预设只在读取时投影；首次操作仍通过原来的 preference owner 写入。 */
export function resolveTranscriptSections(
  view: TranscriptView | undefined,
  compactThoughts = true,
): TranscriptSectionsView {
  if (isSectionsTranscriptView(view)) return view;
  const thoughtsOnly = view === "only-thoughts";
  const toolsOnly = view === "only-tools";
  const textOnly = view === "only-text";
  const unbounded = view === "full-unbounded" || thoughtsOnly || toolsOnly;
  return {
    kind: "sections",
    expanded: view === "full" || unbounded,
    sections: {
      user: { visible: !thoughtsOnly && !toolsOnly, scroll: !unbounded },
      assistant: { visible: !thoughtsOnly && !toolsOnly, scroll: false },
      thoughts: {
        visible:
          !textOnly &&
          !toolsOnly &&
          (view === "compact" || view === undefined ? compactThoughts : true),
        scroll: !unbounded,
      },
      tools: { visible: !textOnly && !thoughtsOnly, scroll: !unbounded },
    },
  };
}

export function updateTranscriptSection(
  view: TranscriptView,
  section: TranscriptSection,
  patch: Partial<{ visible: boolean; scroll: boolean }>,
): TranscriptSectionsView {
  const current = resolveTranscriptSections(view);
  return {
    ...current,
    sections: { ...current.sections, [section]: { ...current.sections[section], ...patch } },
  };
}

export function transcriptViewName(view: TranscriptView): string {
  return isSectionsTranscriptView(view) ? "sections" : view;
}

export function transcriptShowsToolExtras(view: TranscriptView | undefined): boolean {
  return isSectionsTranscriptView(view) ? view.sections.tools.visible : view !== "only-text";
}

export function transcriptShowsAssistantExtras(view: TranscriptView | undefined): boolean {
  return isSectionsTranscriptView(view)
    ? view.sections.assistant.visible
    : !isFilteredTranscriptView(view);
}

export function transcriptShowsWorkStatus(view: TranscriptView | undefined): boolean {
  return isSectionsTranscriptView(view)
    ? (view.sections.user.visible || view.sections.assistant.visible) &&
        (view.sections.thoughts.visible || view.sections.tools.visible)
    : !isFilteredTranscriptView(view);
}

const TRANSCRIPT_VIEWS: readonly LegacyTranscriptView[] = [
  "compact",
  "full",
  "full-unbounded",
  "only-text",
  "only-thoughts",
  "only-tools",
];

export function normalizeTranscriptView(value: unknown): TranscriptView {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    if (
      raw.kind === "sections" &&
      raw.sections &&
      typeof raw.sections === "object" &&
      !Array.isArray(raw.sections)
    ) {
      const defaults = resolveTranscriptSections("compact");
      const sectionValues = raw.sections as Record<string, unknown>;
      // 保持已规范值的引用，避免无关 UI 偏好写入让时间线清空测高缓存。
      if (
        Object.keys(raw).length === 3 &&
        typeof raw.expanded === "boolean" &&
        Object.keys(sectionValues).length === 4 &&
        TRANSCRIPT_SECTIONS.every((key) => {
          const entry = sectionValues[key];
          if (
            !entry ||
            typeof entry !== "object" ||
            Array.isArray(entry) ||
            Object.keys(entry).length !== 2
          )
            return false;
          const fields = entry as Record<string, unknown>;
          return typeof fields.visible === "boolean" && typeof fields.scroll === "boolean";
        })
      )
        return value as TranscriptSectionsView;
      return {
        kind: "sections",
        expanded: typeof raw.expanded === "boolean" ? raw.expanded : false,
        sections: Object.fromEntries(
          TRANSCRIPT_SECTIONS.map((key) => {
            const entry = sectionValues[key];
            const candidate =
              entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
            return [
              key,
              {
                visible:
                  typeof candidate.visible === "boolean"
                    ? candidate.visible
                    : defaults.sections[key].visible,
                scroll:
                  typeof candidate.scroll === "boolean"
                    ? candidate.scroll
                    : defaults.sections[key].scroll,
              },
            ];
          }),
        ) as TranscriptSectionsView["sections"],
      };
    }
  }
  return typeof value === "string" && (TRANSCRIPT_VIEWS as readonly string[]).includes(value)
    ? (value as TranscriptView)
    : "compact";
}

export const TranscriptViewContext = createContext<TranscriptView>("compact");
export const isExpandedTranscriptView = (view: TranscriptView | undefined) =>
  isSectionsTranscriptView(view)
    ? view.expanded
    : view === "full" ||
      view === "full-unbounded" ||
      view === "only-thoughts" ||
      view === "only-tools";
export const useExpandedTranscript = () =>
  isExpandedTranscriptView(useContext(TranscriptViewContext));
/**
 * Views that must never cap loaded detail behind an inner max-height: the main
 * timeline is the only scroller. "Full without scroll" set this rule; the two
 * single-purpose views (T-298) keep it so reasoning / tool output expand in the
 * page instead of inside a nested scroll container.
 */
export const isUnboundedTranscriptView = (
  view: TranscriptView | undefined,
  section: TranscriptSection = "tools",
) =>
  isSectionsTranscriptView(view)
    ? !view.sections[section].scroll
    : view === "full-unbounded" || view === "only-thoughts" || view === "only-tools";
export const useUnboundedTranscript = (section: TranscriptSection = "tools") =>
  isUnboundedTranscriptView(useContext(TranscriptViewContext), section);
export const useTranscriptSectionsView = () => {
  const view = useContext(TranscriptViewContext);
  return isSectionsTranscriptView(view) ? view : null;
};

/** Views that project a filtered row set, so rows unrelated to the view hide. */
export const isFilteredTranscriptView = (view: TranscriptView | undefined) =>
  isSectionsTranscriptView(view)
    ? TRANSCRIPT_SECTIONS.some((key) => !view.sections[key].visible)
    : view === "only-text" || view === "only-thoughts" || view === "only-tools";

export function projectTranscriptRows(
  rows: readonly ConversationRow[],
  view: TranscriptView,
): readonly ConversationRow[] {
  if (isSectionsTranscriptView(view)) {
    if (TRANSCRIPT_SECTIONS.every((key) => view.sections[key].visible)) return rows;
    const anyVisible = TRANSCRIPT_SECTIONS.some((key) => view.sections[key].visible);
    return rows.filter((row) => {
      if (
        row.kind === "timelineMarker" &&
        row.marker.type === "goalVerify" &&
        (row.marker.outcome === "failed" || row.marker.outcome === "notSatisfied")
      )
        return true;
      if (!anyVisible) return false;
      if (row.kind === "turnHeader" || row.kind === "timelineMarker") return true;
      if (row.kind === "userInput") return view.sections.user.visible;
      if (row.kind === "assistantText") return view.sections.assistant.visible;
      if (row.kind === "reasoning") return view.sections.thoughts.visible;
      if (
        row.kind === "toolCall" ||
        row.kind === "artifact" ||
        row.kind === "subagent" ||
        row.kind === "hookInvocation"
      )
        return view.sections.tools.visible;
      return false;
    });
  }
  if (view === "only-thoughts") {
    // Reasoning in chronological order, with turn boundaries for orientation.
    // Neither the user's words nor the assistant's prose nor tool output here.
    return rows.filter((row) => row.kind === "turnHeader" || row.kind === "reasoning");
  }
  if (view === "only-tools") {
    // Actual tool calls in chronological order: name, arguments, status, result
    // and grouping come with the row itself, so nothing is re-projected here.
    return rows.filter((row) => row.kind === "turnHeader" || row.kind === "toolCall");
  }
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
