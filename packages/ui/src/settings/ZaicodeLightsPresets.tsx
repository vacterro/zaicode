import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  ZAICODE_LIGHTS_PRESETS_MAX,
  allZaicodeLightsPresets,
  applyZaicodeLightsPreset,
  exportZaicodeLightsPresets,
  importZaicodeLightsPresets,
  overwriteZaicodeLightsPreset,
  removeZaicodeLightsPreset,
  renameZaicodeLightsPreset,
  saveZaicodeLightsPreset,
  useZaicodeLightsPresets,
  zaicodePresetFileName,
  type ZaicodeLightsPreset,
} from "@/zaicode/zaicodeLightsPresets.js";
import { downloadZaicodeTextFile } from "@/zaicode/zaicodeFiles.js";

/**
 * Settings -> Highlights & motion -> Presets (SRC-048): save the whole look
 * under a name, switch with one click, export to a file, import on another
 * machine. Built-in presets can be applied and exported; own ones also
 * overwritten, renamed and deleted.
 */

const button = "flex items-center gap-1 border border-border px-1.5 py-px text-foreground-subtle hover:bg-hover hover:text-foreground disabled:opacity-40";

function PresetRow({ preset, onMessage }: { preset: ZaicodeLightsPreset; onMessage: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(preset.name);
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-border/50 py-1" data-zaicode-lights-preset={preset.id}>
      {editing ? (
        <input
          autoFocus
          value={draft}
          aria-label="Preset name"
          className="w-48 border border-border bg-background px-1 text-foreground"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            renameZaicodeLightsPreset(preset.id, draft);
            setEditing(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(preset.name);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span
          className={cn("min-w-[12rem] flex-1 truncate text-foreground", !preset.builtIn && "cursor-text")}
          title={preset.builtIn ? "Built in" : "Double-click to rename"}
          onDoubleClick={() => {
            if (preset.builtIn) return;
            setDraft(preset.name);
            setEditing(true);
          }}
        >
          {preset.name}
          {preset.builtIn ? <span className="ml-1 text-foreground-subtlest">built in</span> : null}
        </span>
      )}
      <button
        type="button"
        className={button}
        onClick={() => {
          applyZaicodeLightsPreset(preset.id);
          onMessage(`Applied “${preset.name}”.`);
        }}
      >
        Apply
      </button>
      {!preset.builtIn ? (
        <button
          type="button"
          className={button}
          title="Replace this preset with what is set now"
          onClick={() => {
            overwriteZaicodeLightsPreset(preset.id);
            onMessage(`“${preset.name}” now holds the current settings.`);
          }}
        >
          Save here
        </button>
      ) : null}
      <button
        type="button"
        className={button}
        title="Save this preset as a file"
        onClick={() => downloadZaicodeTextFile(zaicodePresetFileName(preset.name), exportZaicodeLightsPresets([preset]))}
      >
        <Download className="size-3" />
        Export
      </button>
      {!preset.builtIn ? (
        <button
          type="button"
          className={button}
          onClick={() => {
            removeZaicodeLightsPreset(preset.id);
            onMessage(`Deleted preset “${preset.name}”.`);
          }}
        >
          Delete
        </button>
      ) : null}
    </div>
  );
}

export function ZaicodeLightsPresetsBlock() {
  const own = useZaicodeLightsPresets((state) => state.own);
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const presets = allZaicodeLightsPresets(own);
  const full = own.length >= ZAICODE_LIGHTS_PRESETS_MAX;
  return (
    <section className="flex flex-col gap-2 border border-border bg-card p-4 text-ui-xs" data-zaicode-lights-presets>
      <div>
        <h2 className="text-ui-lg text-foreground">Presets</h2>
        <p className="mt-1 max-w-[620px] text-foreground-subtle">
          The whole look under one name: Working icon, every highlight and every separate mix setting. Apply one with a
          click, export it to a file, import files from another machine. Presets are shared by all profiles.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <input
          value={name}
          aria-label="Name for the new preset"
          placeholder="Name, e.g. Night shift"
          className="w-48 border border-border bg-background px-1 text-foreground"
          onChange={(event) => setName(event.target.value)}
        />
        <button
          type="button"
          className={button}
          disabled={full}
          title={full ? `At most ${ZAICODE_LIGHTS_PRESETS_MAX} own presets: delete one first` : "Save what is set now as a new preset"}
          onClick={() => {
            const saved = saveZaicodeLightsPreset(name || "My preset");
            if (!saved) return setMessage(`At most ${ZAICODE_LIGHTS_PRESETS_MAX} own presets: delete one first.`);
            setName("");
            setMessage(saved.stored ? "Saved the current settings as a preset." : "Saved for this session only: storage is full.");
          }}
        >
          Save current as preset
        </button>
        <span className="mx-1 h-4 border-l border-border" />
        <button type="button" className={button} onClick={() => fileInput.current?.click()}>
          <Upload className="size-3" />
          Import file…
        </button>
        <button
          type="button"
          className={button}
          disabled={own.length === 0}
          title={own.length === 0 ? "No own presets yet" : "All own presets in one file"}
          onClick={() => downloadZaicodeTextFile(zaicodePresetFileName("all"), exportZaicodeLightsPresets(own))}
        >
          <Download className="size-3" />
          Export all own
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            void file.text().then((text) => setMessage(importZaicodeLightsPresets(text).message));
          }}
        />
      </div>
      {message ? (
        <div className="flex items-center gap-2 border border-border bg-background px-2 py-1 text-foreground" role="status">
          <span className="flex-1">{message}</span>
          <button type="button" className={button} onClick={() => setMessage(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      <div className="flex flex-col">
        {presets.map((preset) => (
          <PresetRow key={preset.id} preset={preset} onMessage={setMessage} />
        ))}
      </div>
    </section>
  );
}
