import { useEffect, useMemo, useRef, useState } from "react";
import { Download, RefreshCw, Trash2, Undo2, Upload } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { downloadZaicodeTextFile, pickZaicodeJsonFile } from "@/zaicode/zaicodeFiles.js";
import {
  adoptPresetFile,
  applyPreset,
  describeOutcome,
  exportPresetText,
  previewPresetFile,
  refreshPreset,
  resetSection,
  saveCurrentPreset,
  undoLastApply,
  type ApplyOutcome,
  type ImportPreview,
  type PresetEnv,
} from "@/zaicode/zaicodePresetApply.js";
import { placeExportedPreset, type PresetFolder } from "@/zaicode/zaicodeCustomPresets.js";
import { cleanPresetName, presetFilePrefix, type ZaicodePreset } from "@/zaicode/zaicodePresetFile.js";
import { missingSoundsNote, presetMeta } from "@/zaicode/zaicodePresetLabels.js";
import { zaicodePresetSection, type ZaicodePresetSectionId } from "@/zaicode/zaicodePresetSections.js";
import {
  ZAICODE_PRESETS_MAX_PER_SECTION,
  addZaicodePreset,
  presetsOfSection,
  removeZaicodePreset,
  renameZaicodePreset,
  replaceZaicodePreset,
  useZaicodePresets,
} from "@/zaicode/zaicodePresetStore.js";
import { ZaicodePresetFolderList } from "./ZaicodePresetFolderList.js";
import { ZaicodePresetImportPreview } from "./ZaicodePresetImportPreview.js";

/**
 * Presets for one Settings page (T-125), the panel inside the menu: save what the page is set to now under a
 * name, switch between saved sets with a click, export one as a file (own sound files travel inside it) and
 * import a file somebody sent. Applying always leaves a way back: one Undo per page, and it survives the
 * window reload some pages need.
 *
 * Every destructive click (replace a preset, delete it, reset the page) asks twice: the first click arms the
 * button for a few seconds. No dialogs, nothing to dismiss.
 */

const button = "flex items-center gap-1 border border-border px-1.5 py-px text-ui-xs text-foreground-subtle hover:bg-hover hover:text-foreground disabled:opacity-40";
const armedButton = "flex items-center gap-1 border border-red-500/70 px-1.5 py-px text-ui-xs text-red-500 hover:bg-hover disabled:opacity-40";

interface Say {
  tone: "ok" | "warn";
  text: string;
  /** A file saved in the presets folder: the message offers to show it there. */
  file?: string;
}

/** A destructive button asks twice: the first click arms it for a few seconds. */
function useArmed(): [string | null, (key: string | null) => void] {
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(null), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return [armed, setArmed];
}

function PresetRow({
  preset,
  busy,
  armed,
  onArm,
  onApply,
  onUpdate,
  onExport,
  onDelete,
  onRename,
}: {
  preset: ZaicodePreset;
  busy: boolean;
  armed: string | null;
  onArm: (key: string | null) => void;
  onApply: () => void;
  onUpdate: () => void;
  onExport: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // Escape leaves through a real blur (deterministic while the input is still there); this says "do not rename".
  const cancelled = useRef(false);
  const updateKey = `update:${preset.id}`;
  const deleteKey = `delete:${preset.id}`;
  return (
    <div role="listitem" className="flex items-center gap-1 border-b border-border/50 py-1 last:border-b-0" data-zaicode-preset={preset.id}>
      <div className="min-w-0 flex-1">
        {draft !== null ? (
          <input
            autoFocus
            value={draft}
            maxLength={60}
            aria-label="Preset name"
            className="w-full border border-border bg-background px-1 text-foreground"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              if (!cancelled.current) onRename(draft);
              setDraft(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                cancelled.current = true;
                event.currentTarget.blur();
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="block w-full truncate text-left text-foreground hover:underline"
            title="Click to rename"
            onClick={() => {
              cancelled.current = false;
              setDraft(preset.name);
            }}
          >
            {preset.name}
          </button>
        )}
        <div className="truncate text-foreground-subtlest">{presetMeta(preset)}</div>
      </div>
      <button type="button" className={button} disabled={busy} title="Put this preset in place" onClick={onApply}>
        Apply
      </button>
      <button
        type="button"
        className={armed === updateKey ? armedButton : button}
        disabled={busy}
        aria-label={`Replace ${preset.name} with the current settings`}
        title="Replace this preset with what the page is set to now"
        onClick={() => (armed === updateKey ? (onArm(null), onUpdate()) : onArm(updateKey))}
      >
        {armed === updateKey ? "Replace?" : <RefreshCw className="size-3" />}
      </button>
      <button type="button" className={button} disabled={busy} aria-label={`Export ${preset.name} as a file`} title="Save this preset as a file to share" onClick={onExport}>
        <Download className="size-3" />
      </button>
      <button
        type="button"
        className={armed === deleteKey ? armedButton : button}
        disabled={busy}
        aria-label={`Delete ${preset.name}`}
        title="Delete this preset"
        onClick={() => (armed === deleteKey ? (onArm(null), onDelete()) : onArm(deleteKey))}
      >
        {armed === deleteKey ? "Delete?" : <Trash2 className="size-3" />}
      </button>
    </div>
  );
}

/**
 * The panel takes its environment as a prop, so it renders and runs without a window behind it (tests pass a
 * memory one); ZaicodePresetsMenu hands it the real one.
 */
export function ZaicodePresetsPanel({
  section,
  env,
  prune,
  folder = null,
}: {
  section: ZaicodePresetSectionId;
  env: PresetEnv;
  prune: () => Promise<void>;
  /** The customization folder's presets folder (desktop only): exports land there, imports can read from it. */
  folder?: PresetFolder | null;
}) {
  const title = zaicodePresetSection(section)?.title ?? section;
  const all = useZaicodePresets((state) => state.presets);
  const undo = useZaicodePresets((state) => state.undos[section] ?? null);
  const presets = useMemo(() => presetsOfSection(all, section), [all, section]);
  const [name, setName] = useState("");
  const [message, setMessage] = useState<Say | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useArmed();
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewName, setPreviewName] = useState("");

  const say = (tone: Say["tone"], text: string, file?: string) => setMessage(file ? { tone, text, file } : { tone, text });
  const full = () => say("warn", `${title} already has ${ZAICODE_PRESETS_MAX_PER_SECTION} presets: delete one first.`);
  const saidOutcome = (done: string, outcome: ApplyOutcome) => {
    // A reloading page says it itself once it is back; this window is going away.
    if (outcome.live) say(outcome.missing.length > 0 ? "warn" : "ok", describeOutcome(done, outcome));
  };

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      say("warn", `That did not work: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Sounds that no preset and no undo record needs any more (a cancelled save, a deleted preset) go now,
      // while the buttons are still off: a save that starts during the clean-up could lose its own sound.
      await prune().catch(() => undefined);
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      const { preset, missing } = await saveCurrentPreset(env, section, cleanPresetName(name, `${title} preset`));
      const added = addZaicodePreset(preset);
      if (!added) return full();
      setName("");
      say(
        added.stored && missing.length === 0 ? "ok" : "warn",
        `Saved “${added.preset.name}”.${missingSoundsNote(missing, "saved")}${added.stored ? "" : " Storage is full, so it lasts only until this window closes."}`,
      );
    });

  const apply = (preset: ZaicodePreset) =>
    run(async () => saidOutcome(`Applied “${preset.name}”`, await applyPreset(env, preset)));

  const update = (preset: ZaicodePreset) =>
    run(async () => {
      const { preset: next, missing } = await refreshPreset(env, preset);
      replaceZaicodePreset(next);
      say(missing.length > 0 ? "warn" : "ok", `“${preset.name}” now holds what ${title} is set to.${missingSoundsNote(missing, "saved")}`);
    });

  const exportOne = (preset: ZaicodePreset) =>
    run(async () => {
      const { fileName, text, missing } = await exportPresetText(env, preset);
      const placed = await placeExportedPreset(folder, fileName, text, downloadZaicodeTextFile);
      const tone = missing.length > 0 ? "warn" : "ok";
      const notes = missingSoundsNote(missing, "exported");
      if (placed.where === "folder") return say(tone, `Saved “${preset.name}” in the presets folder as ${placed.name}.${notes}`, placed.name);
      const why = placed.fallback ? " The presets folder could not be written, so it was downloaded instead." : "";
      say(placed.fallback ? "warn" : tone, `Saved “${preset.name}” as ${fileName}.${why}${notes}`);
    });

  const remove = (preset: ZaicodePreset) =>
    run(async () => {
      removeZaicodePreset(preset.id);
      say("ok", `Deleted “${preset.name}”.`);
    });

  const showText = (text: string) => {
    const read = previewPresetFile(env, text);
    if (!read.ok) return say("warn", read.error);
    const target = read.preview.file.section;
    if (target !== section) {
      const other = zaicodePresetSection(target)?.title ?? target;
      return say("warn", `This preset is for ${other}. Open Settings → ${other} and import it there.`);
    }
    setMessage(null);
    setPreviewName(read.preview.file.name);
    setPreview(read.preview);
  };

  const pick = () => pickZaicodeJsonFile(showText);

  const pickFromFolder = (name: string) =>
    run(async () => {
      const text = await folder?.read(name);
      if (text === null || text === undefined) return say("warn", `Could not read ${name}.`);
      showText(text);
    });

  const adopt = (thenApply: boolean) =>
    run(async () => {
      if (!preview) return;
      const { preset, notes } = await adoptPresetFile(env, preview.file, cleanPresetName(previewName, preview.file.name));
      const added = addZaicodePreset(preset);
      if (!added) return full();
      setPreview(null);
      const problems = notes.length > 0 ? ` ${notes.join(" ")}` : "";
      if (!thenApply) return say(notes.length > 0 ? "warn" : "ok", `Added “${added.preset.name}” to the list.${problems}`);
      saidOutcome(`Added and applied “${added.preset.name}”`, await applyPreset(env, added.preset));
    });

  const reset = () => run(async () => saidOutcome(`${title} reset to the release defaults`, await resetSection(env, section)));

  const takeBack = () =>
    run(async () => {
      const outcome = await undoLastApply(env, section);
      if (outcome) saidOutcome(`Undid “${undo?.label ?? "the last change"}”`, outcome);
    });

  return (
    <div className="flex flex-col gap-2 text-ui-xs" data-zaicode-presets-panel={section}>
      <div>
        <div className="text-ui-base text-foreground">Presets · {title}</div>
        <p className="mt-0.5 text-foreground-subtle">
          Save what this page is set to now, switch with one click, or share a preset as a file.
          {section === "zaicodeSounds" ? " Your own sound files travel inside it." : ""}
        </p>
      </div>
      {preview ? (
        <ZaicodePresetImportPreview
          preview={preview}
          sectionTitle={title}
          name={previewName}
          busy={busy}
          onName={setPreviewName}
          onAdd={() => void adopt(false)}
          onAddAndApply={() => void adopt(true)}
          onCancel={() => setPreview(null)}
        />
      ) : (
        <>
          <form
            className="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <input
              value={name}
              maxLength={60}
              aria-label="Name for the new preset"
              placeholder="Name, e.g. Night shift"
              className="min-w-0 flex-1 border border-border bg-background px-1 py-px text-foreground"
              onChange={(event) => setName(event.target.value)}
            />
            <button type="submit" className={button} disabled={busy} title="Save what this page is set to now as a new preset">
              Save current
            </button>
          </form>
          {message ? (
            <div role="status" className={cn("border bg-background px-2 py-1 text-foreground", message.tone === "warn" ? "border-amber-500/70" : "border-border")}>
              {message.text}
              {message.file && folder ? (
                <button type="button" className={cn(button, "mt-1")} onClick={() => folder.show(message.file!)}>
                  Show in folder
                </button>
              ) : null}
            </div>
          ) : null}
          <div role="list" className="flex max-h-72 flex-col overflow-y-auto border-y border-border/50">
            {presets.length === 0 ? (
              <div className="py-2 text-foreground-subtlest">No presets yet. Save the current settings above, or import a file.</div>
            ) : (
              presets.map((preset) => (
                <PresetRow
                  key={preset.id}
                  preset={preset}
                  busy={busy}
                  armed={armed}
                  onArm={setArmed}
                  onApply={() => void apply(preset)}
                  onUpdate={() => void update(preset)}
                  onExport={() => void exportOne(preset)}
                  onDelete={() => void remove(preset)}
                  onRename={(next) => renameZaicodePreset(preset.id, next)}
                />
              ))
            )}
          </div>
          {folder ? <ZaicodePresetFolderList folder={folder} prefix={presetFilePrefix(section)} disabled={busy} onPick={(name) => void pickFromFolder(name)} /> : null}
          <div className="flex flex-wrap items-center gap-1">
            <button type="button" className={button} disabled={busy} onClick={pick}>
              <Upload className="size-3" />
              Import file…
            </button>
            <button
              type="button"
              className={armed === "reset" ? armedButton : button}
              disabled={busy}
              title={`Every ${title} setting back to the release default; Undo brings the current ones back`}
              onClick={() => (armed === "reset" ? (setArmed(null), void reset()) : setArmed("reset"))}
            >
              {armed === "reset" ? "Click again to reset" : "Reset to defaults"}
            </button>
            {undo ? (
              <button type="button" className={cn(button, "ml-auto max-w-[14rem]")} disabled={busy} title="Put back what the last apply replaced" onClick={() => void takeBack()}>
                <Undo2 className="size-3 shrink-0" />
                <span className="truncate">Undo “{undo.label}”</span>
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
