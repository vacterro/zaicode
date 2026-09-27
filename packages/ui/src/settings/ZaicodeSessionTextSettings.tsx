import { useRef, useState } from "react";
import { Download, RotateCcw, Save, Trash2, Upload } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { toast } from "@/components/ui/toast.js";
import { ZaicodePrefCheck } from "@/zaicode/ZaicodePrefControls.js";
import { useZaicodeSessionText } from "@/zaicode/zaicodeSessionText.js";
import {
  ZAICODE_SESSION_TEXT_ELEMENTS,
  type ZaicodeSessionTextElement,
  type ZaicodeSessionTextPrefs,
  type ZaicodeTextStyle,
} from "@/zaicode/zaicodeSessionTextModel.js";
import {
  ZAICODE_SESSION_TEXT_BUILT_INS,
  exportZaicodeSessionTextPresets,
  parseZaicodeSessionTextPresets,
  type ZaicodeSessionTextPreset,
} from "@/zaicode/zaicodeSessionTextPresets.js";
import { ZaicodeRuleEditor, ZaicodeSessionTextExtras, ZaicodeTextStyleEditor } from "./ZaicodeSessionTextEditors.js";

/**
 * Settings -> Session text (SRC-062): "full control over the main text in
 * sessions, like in Word". Pick an element on the left, shape it in the
 * middle, see a real agent answer change on the right; presets apply a whole
 * look at once and export / import as a file.
 */

const SAMPLE = `# Heading 1 — the plan
Here is the **main point** the agent stresses, a word in *italics*, something ~~crossed out~~, a [link to the docs](https://example.com) and a \`functionName()\` in the text.

## Heading 2 — what changed
1. First step, with **bold** inside
2. Second step
   - a nested bullet
   - another one

### Heading 3 — details
> A quote: the agent cites what you wrote before.

| File | Added | Removed |
| --- | ---: | ---: |
| sidebar.tsx | +12 | -3 |
| README.md | +4 | -0 |

---

#### Heading 4
##### Heading 5
###### Heading 6
The end of the answer.`;

const FIRST_SIZE: Partial<Record<ZaicodeSessionTextElement, number>> = { h1: 24, h2: 20, h3: 17, h4: 15, h5: 14, h6: 13 };

function styleOf(prefs: ZaicodeSessionTextPrefs, element: ZaicodeSessionTextElement): ZaicodeTextStyle | null {
  if (element === "rule") return null;
  if (element in prefs.headings) return prefs.headings[element as keyof ZaicodeSessionTextPrefs["headings"]];
  return prefs[element as Exclude<ZaicodeSessionTextElement, "rule" | keyof ZaicodeSessionTextPrefs["headings"]>];
}

function withStyle(prefs: ZaicodeSessionTextPrefs, element: ZaicodeSessionTextElement, patch: Partial<ZaicodeTextStyle>): ZaicodeSessionTextPrefs {
  if (element in prefs.headings) {
    const level = element as keyof ZaicodeSessionTextPrefs["headings"];
    return { ...prefs, headings: { ...prefs.headings, [level]: { ...prefs.headings[level], ...patch } } };
  }
  const key = element as Exclude<ZaicodeSessionTextElement, "rule" | keyof ZaicodeSessionTextPrefs["headings"]>;
  return { ...prefs, [key]: { ...prefs[key], ...patch } } as ZaicodeSessionTextPrefs;
}

function PresetButton({ preset, active, onApply, onDelete }: { preset: ZaicodeSessionTextPreset; active: boolean; onApply: () => void; onDelete?: () => void }) {
  return (
    <span className="flex items-stretch">
      <button
        type="button"
        className={`border px-1.5 py-px ${active ? "border-[var(--zaicode-highlight,var(--color-warning))] text-foreground" : "border-border text-foreground-subtle hover:bg-hover hover:text-foreground"}`}
        title={preset.hint || preset.name}
        aria-pressed={active}
        onClick={onApply}
      >
        {preset.name}
      </button>
      {onDelete ? (
        <button type="button" className="border border-l-0 border-border px-0.5 text-foreground-subtlest hover:bg-hover" title={`Delete "${preset.name}"`} onClick={onDelete}>
          <Trash2 className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

export function ZaicodeSessionTextSettings() {
  const store = useZaicodeSessionText();
  const { prefs } = store;
  const [element, setElement] = useState<ZaicodeSessionTextElement>("body");
  const importRef = useRef<HTMLInputElement | null>(null);
  const patch = (next: ZaicodeSessionTextPrefs) => store.set(next);
  const style = styleOf(prefs, element);
  const current = ZAICODE_SESSION_TEXT_ELEMENTS.find((entry) => entry.id === element)!;

  const saveAs = () => {
    const name = window.prompt("Name of the new preset", "My text");
    if (name) {
      store.savePreset(name);
      toast(`Saved the preset "${name.trim()}"`);
    }
  };
  const exportFile = () => {
    const blob = new Blob([exportZaicodeSessionTextPresets(store.presets)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "zaicode-session-text-presets.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const importFile = async (file: File) => {
    try {
      const presets = parseZaicodeSessionTextPresets(await file.text(), [...ZAICODE_SESSION_TEXT_BUILT_INS, ...store.presets].map((preset) => preset.name));
      store.addPresets(presets);
      toast(presets.length > 0 ? `Imported ${presets.length} preset(s)` : "The file had no presets");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { variant: "warning" });
    }
  };

  return (
    <section className="flex flex-col gap-2 border border-border bg-card p-4 text-ui-xs" data-zaicode-session-text-settings data-zaicode-help="sessiontext">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-ui-lg text-foreground">Session text</h2>
          <p className="mt-1 max-w-[720px] text-foreground-subtle">
            How the agent's answers read, like styles in Word: the font and size of the text, each heading, what bold,
            italics, underlines, links, quotes, lists and tables look like. Pick a part on the left, change it in the
            middle, watch the sample answer on the right. Everything left at "as app" keeps the ZAICODE look.
          </p>
        </div>
        <button type="button" className="flex shrink-0 items-center gap-1 border border-border px-1.5 py-0.5 text-foreground-subtle hover:bg-hover hover:text-foreground" onClick={() => store.reset()}>
          <RotateCcw className="size-3" />
          Default
        </button>
      </div>

      <ZaicodePrefCheck checked={prefs.enabled} onChange={(enabled) => patch({ ...prefs, enabled })} label="Use these settings (off = the app's own look, nothing is lost)" />

      <div className="flex flex-wrap items-center gap-1" data-zaicode-session-text-presets>
        <span className="mr-1 text-foreground-subtle">Presets:</span>
        {ZAICODE_SESSION_TEXT_BUILT_INS.map((preset) => (
          <PresetButton key={preset.id} preset={preset} active={store.activePresetId === preset.id} onApply={() => store.set(preset.prefs, preset.id)} />
        ))}
        {store.presets.map((preset) => (
          <PresetButton key={preset.id} preset={preset} active={store.activePresetId === preset.id} onApply={() => store.set(preset.prefs, preset.id)} onDelete={() => store.deletePreset(preset.id)} />
        ))}
        <span className="ml-1 flex gap-1">
          <button type="button" className="flex items-center gap-1 border border-border px-1.5 py-px text-foreground-subtle hover:bg-hover" onClick={saveAs}>
            <Save className="size-3" /> Save as preset
          </button>
          <button type="button" className="flex items-center gap-1 border border-border px-1.5 py-px text-foreground-subtle hover:bg-hover disabled:opacity-40" disabled={store.presets.length === 0} onClick={exportFile}>
            <Download className="size-3" /> Export
          </button>
          <button type="button" className="flex items-center gap-1 border border-border px-1.5 py-px text-foreground-subtle hover:bg-hover" onClick={() => importRef.current?.click()}>
            <Upload className="size-3" /> Import
          </button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importFile(file);
              event.target.value = "";
            }}
          />
        </span>
      </div>

      <div className={`grid grid-cols-1 gap-3 lg:grid-cols-[140px_minmax(240px,300px)_minmax(0,1fr)] ${prefs.enabled ? "" : "opacity-60"}`}>
        <div className="flex flex-col gap-px" role="listbox" aria-label="Part of the text">
          {ZAICODE_SESSION_TEXT_ELEMENTS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="option"
              aria-selected={entry.id === element}
              title={entry.hint}
              className={`border px-1.5 py-0.5 text-left ${entry.id === element ? "border-[var(--zaicode-highlight,var(--color-warning))] bg-selected text-foreground" : "border-transparent text-foreground-subtle hover:bg-hover"}`}
              onClick={() => setElement(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2 border border-border/60 p-2">
          <div>
            <div className="text-ui-sm text-foreground">{current.label}</div>
            <div className="text-foreground-subtlest">{current.hint}</div>
          </div>
          {style ? (
            <ZaicodeTextStyleEditor style={style} firstSize={FIRST_SIZE[element] ?? 14} onChange={(next) => patch(withStyle(prefs, element, next))}>
              <ZaicodeSessionTextExtras element={element} prefs={prefs} patch={patch} />
            </ZaicodeTextStyleEditor>
          ) : (
            <ZaicodeRuleEditor prefs={prefs} patch={patch} />
          )}
        </div>
        <div className="min-w-0 border border-border/60 bg-background p-3" data-zaicode-session-text-preview>
          <div className="mb-2 text-foreground-subtlest">Sample answer (the real renderer; changes show at once in every session)</div>
          <MessageResponse>{SAMPLE}</MessageResponse>
        </div>
      </div>
    </section>
  );
}
