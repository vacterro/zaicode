import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { ZaicodePrefSegment } from "@/zaicode/ZaicodePrefControls.js";
import {
  ZAICODE_DISPATCH_DEFAULT_LAUNCHERS,
  useZaicodeDispatch,
  type ZaicodeDispatchLauncher,
  type ZaicodeDispatchWhere,
} from "@/zaicode/zaicodeDispatch.js";

/**
 * Settings -> Workers & terminal -> Dispatch: where Dispatch opens things and
 * the operator's own launchers (label, tile text, command line).
 */
export function ZaicodeDispatchSettings() {
  const prefs = useZaicodeDispatch();
  const [draft, setDraft] = useState<Omit<ZaicodeDispatchLauncher, "id">>({ label: "", short: "", command: "" });

  const replace = (index: number, patch: Partial<ZaicodeDispatchLauncher>) =>
    prefs.update({
      launchers: prefs.launchers.map((launcher, at) => (at === index ? { ...launcher, ...patch } : launcher)),
    });
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= prefs.launchers.length) return;
    const next = [...prefs.launchers];
    [next[index], next[target]] = [next[target]!, next[index]!];
    prefs.update({ launchers: next });
  };
  const inputClass = "min-w-0 border border-border bg-background px-1 py-0.5 text-foreground";

  return (
    <section className="flex flex-col gap-2 border border-border bg-card p-4 text-ui-xs" data-zaicode-dispatch-settings>
      <div>
        <h2 className="text-ui-lg text-foreground">Dispatch</h2>
        <p className="mt-1 max-w-[580px] text-foreground-subtle">
          The header's Dispatch button (Alt+D) opens a terminal or a CLI straight in any project, each click one more
          instance. Engines come from Engines &amp; limits; the launchers below are yours: any command line typed into
          PowerShell in the project folder (empty = a plain terminal).
        </p>
      </div>
      <ZaicodePrefSegment<ZaicodeDispatchWhere>
        label="Opens in"
        value={prefs.where}
        onChange={(where) => prefs.update({ where })}
        options={[
          { value: "external", label: "Own window" },
          { value: "panel", label: "WORKERS panel" },
          { value: "window", label: "In-app window" },
        ]}
      />
      <div className="flex flex-col gap-1">
        {prefs.launchers.map((launcher, index) => (
          <div key={launcher.id} className="grid grid-cols-[4rem_7rem_1fr_auto] items-center gap-1">
            <input className={inputClass} value={launcher.short} maxLength={4} aria-label="Tile text" onChange={(event) => replace(index, { short: event.target.value })} />
            <input className={inputClass} value={launcher.label} aria-label="Name" onChange={(event) => replace(index, { label: event.target.value })} />
            <input
              className={`${inputClass} font-mono`}
              value={launcher.command}
              placeholder="(plain terminal)"
              aria-label="Command line"
              onChange={(event) => replace(index, { command: event.target.value })}
            />
            <span className="flex gap-px">
              <Button type="button" size="sm" variant="ghost" className="h-5 px-1" onClick={() => move(index, -1)} aria-label="Move up">
                ↑
              </Button>
              <Button type="button" size="sm" variant="ghost" className="h-5 px-1" onClick={() => move(index, 1)} aria-label="Move down">
                ↓
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-5 px-1"
                onClick={() => prefs.update({ launchers: prefs.launchers.filter((_, at) => at !== index) })}
                aria-label={`Remove ${launcher.label}`}
              >
                ✕
              </Button>
            </span>
          </div>
        ))}
        <div className="grid grid-cols-[4rem_7rem_1fr_auto] items-center gap-1 border-t border-border pt-1">
          <input className={inputClass} value={draft.short} maxLength={4} placeholder="GM" onChange={(event) => setDraft({ ...draft, short: event.target.value })} />
          <input className={inputClass} value={draft.label} placeholder="Gemini" onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
          <input
            className={`${inputClass} font-mono`}
            value={draft.command}
            placeholder="gemini --yolo"
            onChange={(event) => setDraft({ ...draft, command: event.target.value })}
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-5 px-2"
            disabled={!draft.label.trim()}
            onClick={() => {
              prefs.update({ launchers: [...prefs.launchers, { ...draft, id: `launcher-${Date.now()}` }] });
              setDraft({ label: "", short: "", command: "" });
            }}
          >
            Add
          </Button>
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="self-start"
        onClick={() => prefs.update({ launchers: [...ZAICODE_DISPATCH_DEFAULT_LAUNCHERS] })}
      >
        Reset launchers to Terminal + OpenCode
      </Button>
    </section>
  );
}
