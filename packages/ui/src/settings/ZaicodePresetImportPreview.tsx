import type { ImportPreview } from "@/zaicode/zaicodePresetApply.js";
import { importPreviewLines, presetDateLabel } from "@/zaicode/zaicodePresetLabels.js";

/**
 * What an imported preset file would do, shown before anything is stored (T-125): what page it is for, what it
 * would change, which own sounds come along, what was left out as unreadable. Then a name, and one of three
 * ways forward. Presentational: the menu owns the state.
 */

const button = "flex items-center gap-1 border border-border px-1.5 py-px text-foreground-subtle hover:bg-hover hover:text-foreground disabled:opacity-40";

export function ZaicodePresetImportPreview({
  preview,
  sectionTitle,
  name,
  busy,
  onName,
  onAdd,
  onAddAndApply,
  onCancel,
}: {
  preview: ImportPreview;
  sectionTitle: string;
  name: string;
  busy: boolean;
  onName: (name: string) => void;
  onAdd: () => void;
  onAddAndApply: () => void;
  onCancel: () => void;
}) {
  const notes = preview.notes;
  const made = [presetDateLabel(preview.file.createdAt), preview.file.app ? `by ${preview.file.app}` : ""].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-col gap-2" data-zaicode-preset-import>
      <div>
        <div className="text-ui-base text-foreground">Import a {sectionTitle} preset</div>
        {made ? <div className="text-foreground-subtlest">{made}</div> : null}
      </div>
      <ul className="flex flex-col gap-1 text-foreground-subtle">
        {importPreviewLines(preview, sectionTitle).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {notes.length > 0 ? (
        <ul className="flex flex-col gap-1 border border-border bg-background px-2 py-1 text-foreground" role="status">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      <label className="flex items-center gap-2 text-foreground-subtle">
        Name
        <input
          value={name}
          maxLength={60}
          aria-label="Name for the imported preset"
          className="min-w-0 flex-1 border border-border bg-background px-1 text-foreground"
          onChange={(event) => onName(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-center gap-1">
        <button type="button" className={button} disabled={busy} onClick={onAddAndApply}>
          Add and apply
        </button>
        <button type="button" className={button} disabled={busy} onClick={onAdd}>
          Add to list
        </button>
        <button type="button" className={button} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
