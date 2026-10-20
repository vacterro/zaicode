import { useMemo, useState } from "react";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { validateDriftStorageRoot } from "./zaicodeDriftCaptureContract.js";
import { useDriftCaptureStore } from "./zaicodeDriftCaptureStore.js";

// SAIHANDOFF: the drift capture center needs a complete, explicit settings
// surface. A rejected path is reported, never silently replaced by another
// destination, and evidence is never deleted behind the operator's back.

const FIELD_CLASS =
  "border border-border bg-surface px-1.5 py-0.5 text-ui-xs text-foreground outline-none focus:border-focus";

function BooleanField({
  label,
  checked,
  onChange,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  title?: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-ui-xs text-foreground-subtle" title={title}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function ZaicodeDriftSettings({
  defaultStorageRoot,
}: {
  /** The vault location used when no explicit storage root is configured. */
  defaultStorageRoot: string;
}) {
  const settings = useDriftCaptureStore((state) => state.settings);
  const updateSettings = useDriftCaptureStore((state) => state.updateSettings);
  const platform = usePlatform();
  const [rootDraft, setRootDraft] = useState(settings.storageRoot);
  const validation = useMemo(() => validateDriftStorageRoot(rootDraft), [rootDraft]);
  const effectiveRoot = settings.storageRoot.trim() || defaultStorageRoot;

  return (
    <details className="border border-border/60 bg-surface/40 px-2 py-1 text-ui-xs" data-zaicode-drift-settings>
      <summary className="cursor-pointer text-foreground-subtle">
        Drift capture settings
      </summary>
      <div className="mt-1.5 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="text-foreground-subtle" htmlFor="zaicode-drift-storage-root">
            Storage directory
          </label>
          <input
            id="zaicode-drift-storage-root"
            className={`${FIELD_CLASS} min-w-64 flex-1`}
            value={rootDraft}
            placeholder={defaultStorageRoot}
            onChange={(event) => setRootDraft(event.target.value)}
            onBlur={() => {
              if (!validation.ok) {
                toast(validation.reason ?? "Invalid storage directory", { variant: "warning" });
                return;
              }
              updateSettings({ storageRoot: rootDraft.trim() });
            }}
          />
          <button
            type="button"
            className="border border-border bg-surface px-1.5 py-0.5 text-foreground-subtle hover:bg-hover"
            title="Pick the folder that holds the drift evidence vault"
            onClick={() => {
              void platform.selectDirectory().then((picked) => {
                // A cancelled dialog changes nothing: the current destination
                // stays exactly as it was.
                if (!picked) return;
                setRootDraft(picked);
                updateSettings({ storageRoot: picked });
              });
            }}
          >
            Browse
          </button>
          <button
            type="button"
            className="border border-border bg-surface px-1.5 py-0.5 text-foreground-subtle hover:bg-hover"
            onClick={() => {
              if (!validation.ok) {
                toast(validation.reason ?? "Invalid storage directory", { variant: "warning" });
                return;
              }
              updateSettings({ storageRoot: rootDraft.trim() });
              void platform.openInFileManager(effectiveRoot);
            }}
          >
            Open
          </button>
        </div>
        {!validation.ok ? (
          <p className="text-ui-xs text-error" role="alert">
            {validation.reason}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <BooleanField
            label="Include historical sessions"
            checked={settings.includeHistorical}
            onChange={(value) => updateSettings({ includeHistorical: value })}
          />
          <BooleanField
            label="Include helper sessions"
            checked={settings.includeHelperSessions}
            onChange={(value) => updateSettings({ includeHelperSessions: value })}
          />
          <BooleanField
            label="Include switched-off projects"
            checked={settings.includeDisabledProjects}
            onChange={(value) => updateSettings({ includeDisabledProjects: value })}
          />
          <BooleanField
            label="Include protocol context"
            checked={settings.includeProtocolContext}
            onChange={(value) => updateSettings({ includeProtocolContext: value })}
          />
          <BooleanField
            label="Keep attachment references"
            checked={settings.captureAttachmentsByReference}
            onChange={(value) => updateSettings({ captureAttachmentsByReference: value })}
            title="Attachments are stored as references; bytes stay out of the evidence."
          />
          <BooleanField
            label="Export binary attachments"
            checked={settings.exportBinaryAttachments}
            onChange={(value) => updateSettings({ exportBinaryAttachments: value })}
            title="Off by default: exported packs carry transcript text and references only."
          />
          <BooleanField
            label="Skip unchanged sessions"
            checked={settings.skipUnchanged}
            onChange={(value) => updateSettings({ skipUnchanged: value })}
          />
          <BooleanField
            label="Force recapture"
            checked={settings.forceRecapture}
            onChange={(value) => updateSettings({ forceRecapture: value })}
          />
          <BooleanField
            label="Notify when finished"
            checked={settings.notifyOnComplete}
            onChange={(value) => updateSettings({ notifyOnComplete: value })}
          />
          <BooleanField
            label="Ask before deleting evidence"
            checked={settings.confirmDeleteEvidence}
            onChange={(value) => updateSettings({ confirmDeleteEvidence: value })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label className="text-foreground-subtle">
            Concurrency
            <input
              type="number"
              min={1}
              max={4}
              className={`${FIELD_CLASS} ml-1 w-14`}
              value={settings.concurrency}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (!Number.isFinite(value)) return;
                updateSettings({ concurrency: Math.max(1, Math.min(4, Math.trunc(value))) });
              }}
            />
          </label>
          <label className="text-foreground-subtle">
            Storage warning (GB)
            <input
              type="number"
              min={1}
              className={`${FIELD_CLASS} ml-1 w-16`}
              value={Math.max(1, Math.round(settings.maxStorageWarningBytes / 1024 ** 3))}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (!Number.isFinite(value)) return;
                updateSettings({ maxStorageWarningBytes: Math.max(1, value) * 1024 ** 3 });
              }}
            />
          </label>
          <label className="text-foreground-subtle">
            Review pack
            <select
              className={`${FIELD_CLASS} ml-1`}
              value={settings.exportBundleFormat}
              onChange={(event) =>
                updateSettings({
                  exportBundleFormat: event.target.value === "zip" ? "zip" : "folder",
                })
              }
            >
              <option value="folder">Folder</option>
              <option value="zip">ZIP archive</option>
            </select>
          </label>
          <label className="text-foreground-subtle">
            Split part size (MB)
            <input
              type="number"
              min={16}
              className={`${FIELD_CLASS} ml-1 w-20`}
              value={Math.max(16, Math.round(settings.exportSplitPartBytes / 1024 ** 2))}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (!Number.isFinite(value)) return;
                updateSettings({ exportSplitPartBytes: Math.max(16, value) * 1024 ** 2 });
              }}
            />
          </label>
        </div>
        <p className="text-ui-xs text-foreground-subtlest">
          Evidence is read-only. Retiring a session removes its marker but keeps the archived
          files; deleting evidence is an explicit action that{" "}
          {settings.confirmDeleteEvidence ? "asks first" : "deletes without asking"}.
        </p>
      </div>
    </details>
  );
}
