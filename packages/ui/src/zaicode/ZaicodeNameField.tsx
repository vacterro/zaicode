import { useRef, useState } from "react";
import { cn } from "@/components/lib/utils.js";

/**
 * Asking for a name inside the window (T-128). `window.prompt` does not exist in the desktop app -- it throws
 * "prompt() is not supported." -- so every button that called it (New folder, Rename folder, Save as preset) did nothing
 * at all. This is the replacement: a text field with its two buttons, Enter to accept and Escape to leave, that sits
 * where the question is asked.
 */

/** What was typed, or `fallback` when it is empty: a name field that is left blank still gives the button a result. */
export function resolveZaicodeName(draft: string, fallback: string, maxLength = 60): string {
  const name = draft.replace(/\s+/g, " ").trim().slice(0, maxLength).trim();
  return name || fallback;
}

const buttonClass =
  "flex items-center border border-border px-1.5 py-px text-ui-xs text-foreground-subtle hover:bg-hover hover:text-foreground disabled:opacity-40";

export function ZaicodeNameField({
  initial,
  fallback,
  label,
  confirmLabel,
  maxLength = 60,
  className,
  onSubmit,
  onCancel,
}: {
  initial: string;
  /** The name used when the field is left empty (default: `initial`). */
  fallback?: string;
  /** What the field is for: it labels the input for people and for screen readers. */
  label: string;
  confirmLabel: string;
  maxLength?: number;
  className?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  // A blur that comes from pressing Escape must not count as an accept; Enter and the button both go through submit().
  const done = useRef(false);
  const submit = () => {
    if (done.current) return;
    done.current = true;
    onSubmit(resolveZaicodeName(draft, fallback ?? initial, maxLength));
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };
  return (
    <form
      className={cn("flex flex-col gap-1", className)}
      data-zaicode-name-field
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="text-ui-xs text-foreground-subtle" htmlFor="zaicode-name-field-input">
        {label}
      </label>
      <input
        id="zaicode-name-field-input"
        autoFocus
        value={draft}
        maxLength={maxLength}
        aria-label={label}
        className="w-full border border-border bg-background px-1 py-px text-ui-xs text-foreground"
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancel();
          }
        }}
      />
      <div className="flex items-center justify-end gap-1">
        <button type="button" className={buttonClass} onClick={cancel}>
          Cancel
        </button>
        <button type="submit" className={cn(buttonClass, "border-[var(--zaicode-highlight,var(--color-border-hover))] text-foreground")}>
          {confirmLabel}
        </button>
      </div>
    </form>
  );
}
