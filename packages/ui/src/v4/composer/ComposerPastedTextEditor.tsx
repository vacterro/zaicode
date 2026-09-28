import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { pastedTextMetadata } from "@/lib/chatAttachments.js";

/**
 * The composer-side editor for a pasted-text attachment (Wave 2).
 *
 * The chip exists so a 200 KB paste does not sit in the input; this dialog is
 * what makes that honest. It shows the COMPLETE text, counts it, and hands
 * back exactly what the operator typed. Cancel mutates nothing, so a stray
 * Escape cannot change what the model will receive.
 *
 * Labels arrive as props: the composer owns the locale, this file stays a
 * plain view.
 */
export function ComposerPastedTextEditor({
  open,
  filename,
  text,
  saving,
  title,
  hint,
  saveLabel,
  cancelLabel,
  describe,
  onCancel,
  onSave,
}: {
  open: boolean;
  filename: string;
  text: string;
  saving: boolean;
  title: string;
  hint: string;
  saveLabel: string;
  cancelLabel: string;
  describe: (meta: { chars: number; lines: number; bytes: number }) => string;
  onCancel: () => void;
  onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState(text);
  // Reopening must show the payload as it is NOW, not the last edit.
  useEffect(() => {
    if (open) setDraft(text);
  }, [open, text]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onCancel();
      }}
    >
      <DialogContent className="flex h-[85vh] max-h-[85vh] w-[min(96vw,60rem)] flex-col gap-3 sm:max-w-[min(96vw,60rem)]">
        <DialogHeader>
          <DialogTitle className="text-ui-lg">{title}</DialogTitle>
          <DialogDescription className="text-ui-sm">
            {hint}
            <span className="mt-1 block truncate text-foreground-subtlest" title={filename}>
              {filename}
            </span>
          </DialogDescription>
        </DialogHeader>
        <textarea
          data-composer-pasted-text-editor="true"
          spellCheck={false}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="min-h-0 flex-1 resize-none border border-border bg-background p-2 font-mono text-ui-sm text-foreground"
        />
        <p className="text-ui-sm text-foreground-subtle" data-composer-pasted-text-meta="true">
          {describe(pastedTextMetadata(draft))}
        </p>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={saving} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            data-composer-pasted-text-save="true"
            disabled={saving || draft === text}
            onClick={() => onSave(draft)}
          >
            {saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
