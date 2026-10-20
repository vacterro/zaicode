import { CheckIcon, CopyIcon, AlertCircleIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import type { SessionCopyState } from "@/zaicode/useZaicodeSessionDriftCopy.js";

export interface ConversationSessionCopyAction {
  enabled: boolean;
  onCopy: () => Promise<void>;
  state: SessionCopyState;
}

/**
 * One action copies the authoritative selected-session forensic document.
 */
export function ConversationSessionCopyButton({
  action,
}: {
  action: ConversationSessionCopyAction;
}) {
  const { state } = action;
  const reading = state.status === "reading";
  const hint =
    state.detail ??
    (reading
      ? "Reading session..."
      : "Copy every surviving recorded event of this selected session, with complete tool evidence and the captured snapshot watermark");
  const Icon =
    state.status === "copied" ? CheckIcon : state.status === "error" ? AlertCircleIcon : CopyIcon;
  return (
    <span className="flex min-w-6 shrink-0 items-stretch">
      <button
        type="button"
        aria-label="Copy forensic session"
        title={hint}
        data-session-copy={state.status}
        disabled={!action.enabled || reading}
        onClick={() => {
          void action.onCopy();
        }}
        className={cn(
          "flex min-w-6 shrink-0 items-center justify-center gap-1 border border-border px-1 py-1 text-ui-xs hover:bg-hover focus-visible:outline focus-visible:outline-1 disabled:opacity-50",
          state.status === "copied"
            ? "text-success"
            : state.status === "error"
              ? "text-destructive"
              : "text-foreground-subtle",
        )}
      >
        <Icon className="size-3 shrink-0" />
        <span className="w-28 @max-[1000px]/transcript:hidden">
          {reading
            ? "Reading session..."
            : state.status === "copied"
              ? "Copied forensic"
              : state.status === "error"
                ? "Copy failed"
                : "Copy forensic"}
        </span>
        <span className="sr-only" role="status" aria-live="polite">
          {state.status === "idle" ? "" : hint}
        </span>
      </button>
    </span>
  );
}
