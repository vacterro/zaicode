import type { TranscriptView } from "@/lib/transcriptView.js";
import { cn } from "@/components/lib/utils.js";

const MODES = [
  ["compact", "Compact", "Normal summaries and manual detail disclosure"],
  ["full", "Full", "Expand loaded tool, thought and work details"],
  ["full-unbounded", "Full without scroll", "Expand every loaded detail without inner output scrollbars"],
  ["only-text", "Only text", "User and assistant messages, with essential errors and controls"],
] as const;

export function ConversationTranscriptControl({
  view,
  onChange,
}: {
  view: TranscriptView;
  onChange: (view: TranscriptView) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Transcript view"
      data-transcript-control="true"
      // 只是一组按钮：所在的那一行（时间线顶部）负责边框、间距与均匀分布。
      className="flex shrink-0 flex-wrap items-center gap-1 text-ui-xs"
    >
      <span className="mr-1 text-foreground-subtle">Transcript</span>
      {MODES.map(([mode, label, hint]) => (
        <button
          key={mode}
          type="button"
          title={hint}
          aria-pressed={view === mode}
          data-transcript-choice={mode}
          className={cn(
            "border border-border px-2 py-1 hover:bg-hover focus-visible:outline focus-visible:outline-1",
            view === mode ? "bg-accent font-bold text-foreground" : "text-foreground-subtle",
          )}
          onClick={() => onChange(mode)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
