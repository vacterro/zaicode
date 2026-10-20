import { useContext, type ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import {
  isSectionsTranscriptView,
  TranscriptViewContext,
  type TranscriptView,
} from "@/lib/transcriptView.js";

/** 消息正文的视口只读同一过滤偏好；时间和操作栏不进入内部滚动区。 */
export function ConversationAssistantBody({
  children,
  view,
}: {
  children: ReactNode;
  view?: TranscriptView;
}) {
  const inherited = useContext(TranscriptViewContext);
  const effective = view ?? inherited;
  const scrolling = isSectionsTranscriptView(effective) && effective.sections.assistant.scroll;
  return (
    <div
      data-conversation-selectable="true"
      data-transcript-section="assistant"
      data-transcript-scroll={scrolling ? "on" : "off"}
      className={cn("w-full text-ui-base", scrolling && "max-h-80 overflow-y-auto")}
    >
      {children}
    </div>
  );
}
