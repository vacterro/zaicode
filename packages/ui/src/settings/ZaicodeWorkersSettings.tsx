import { useEffect, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useServices } from "@/hooks/useServices.js";
import { ZaicodePrefCheck, ZaicodePrefSegment, ZaicodePrefStepper } from "@/zaicode/ZaicodePrefControls.js";
import {
  ZAICODE_TERMINUS_SIZES,
  ZAICODE_WORKERS_PANEL_MIN,
  ZAICODE_WORKERS_PANEL_MIN_WIDTH,
  useZaicodeWorkerPrefs,
  zaicodeWorkerFontFamily,
  type ZaicodeWorkersTrayAnchor,
} from "@/zaicode/zaicodeWorkerPrefs.js";
import { openZaicodeWorkersPanel, useZaicodeWorkers } from "@/zaicode/zaicodeWorkers.js";
import { ZaicodeDispatchSettings } from "./ZaicodeDispatchSettings.js";
import { useZaicodeUiPrefs } from "@/zaicode/zaicodeUiPrefs.js";

/**
 * Settings -> Workers: where subscription CLI workers open and how their
 * panel, windows, chips and terminal face behave. Also the integrated
 * terminal font (it used to sit alone in General).
 */

const ANCHORS: readonly { value: ZaicodeWorkersTrayAnchor; label: string }[] = [
  { value: "left", label: "Left, middle" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "bottom-center", label: "Bottom centre" },
  { value: "bottom-right", label: "Bottom right" },
  { value: "right", label: "Right, middle" },
];

function AnchorPicker({ value, onChange }: { value: ZaicodeWorkersTrayAnchor; onChange: (value: ZaicodeWorkersTrayAnchor) => void }) {
  // A small screen sketch: click where the chips should stack.
  const spot: Record<ZaicodeWorkersTrayAnchor, string> = {
    left: "left-0.5 top-1/2 -translate-y-1/2 h-6 w-1.5",
    "bottom-left": "bottom-0.5 left-1 h-1.5 w-6",
    "bottom-center": "bottom-0.5 left-1/2 -translate-x-1/2 h-1.5 w-6",
    "bottom-right": "bottom-0.5 right-1 h-1.5 w-6",
    right: "right-0.5 top-1/2 -translate-y-1/2 h-6 w-1.5",
  };
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-16 w-28 border border-border bg-background" role="radiogroup" aria-label="Where minimized workers stack">
        {ANCHORS.map((anchor) => (
          <button
            key={anchor.value}
            type="button"
            role="radio"
            aria-checked={value === anchor.value}
            title={anchor.label}
            className={cn(
              "absolute border",
              spot[anchor.value],
              value === anchor.value
                ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-[var(--zaicode-highlight,var(--color-border-hover))]"
                : "border-border bg-card hover:bg-hover",
            )}
            onClick={() => onChange(anchor.value)}
          />
        ))}
      </div>
      <span className="text-foreground">{ANCHORS.find((anchor) => anchor.value === value)?.label}</span>
    </div>
  );
}

function TerminalFontSetting() {
  const services = useServices();
  const [saved, setSaved] = useState("");
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    void services.settingService
      .get()
      .then((settings) => {
        setSaved(settings.terminalFontFamily ?? "");
        setDraft(settings.terminalFontFamily ?? "");
      })
      .catch(() => undefined);
  }, [services.settingService]);
  const dirty = draft.trim() !== saved;
  const save = () =>
    void services.settingService
      .update({ terminalFontFamily: draft.trim() })
      .then(() => {
        setSaved(draft.trim());
        setMessage("Saved. New terminals use it.");
      })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)));
  return (
    <div className="flex flex-col gap-1">
      <span className="text-foreground-subtle">
        Integrated terminal font (the Terminal panel; workers use the face above unless it says “profile font”). Blank = the
        system terminal&apos;s font.
      </span>
      <div className="flex items-center gap-2">
        <input
          className="min-w-0 flex-1 border border-border bg-background px-1 py-0.5 font-mono text-foreground"
          value={draft}
          placeholder="e.g. Terminus (TTF) for Windows, Consolas, monospace"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && dirty) save();
          }}
        />
        <Button size="sm" variant="outline" disabled={!dirty} onClick={save}>
          Save
        </Button>
      </div>
      {message ? <span className="text-foreground-subtlest">{message}</span> : null}
    </div>
  );
}

/** SRC-044: what happens after ZAICODE died (crash, kill, power) and starts again. */
function CrashSettings() {
  const resumeAfterCrash = useZaicodeUiPrefs((state) => state.resumeAfterCrash);
  const resumeAfterCrashHours = useZaicodeUiPrefs((state) => state.resumeAfterCrashHours);
  const relaunchWorkersAfterCrash = useZaicodeUiPrefs((state) => state.relaunchWorkersAfterCrash);
  const update = useZaicodeUiPrefs((state) => state.update);
  return (
    <section className="flex flex-col gap-2 border border-border bg-card p-4" data-zaicode-crash-settings>
      <h2 className="text-ui-lg text-foreground">After a crash</h2>
      <p className="max-w-[580px] text-foreground-subtle">
        The work itself survives: sessions, their goals and SAIPEN&apos;s board are on disk. A session the dead process cut
        off mid-turn shows INTERRUPTED (never DONE) and ▶ continues it. With the switches below ZAICODE continues them by
        itself about half a minute after it is back, one at a time. A session you stopped yourself is never restarted.
      </p>
      <ZaicodePrefCheck
        checked={resumeAfterCrash}
        onChange={(value) => update({ resumeAfterCrash: value })}
        label="Auto-continue sessions a crash cut off"
        hint="Its goal again, else SAIPEN's cc (continue outside SAIPEN)"
      />
      <ZaicodePrefStepper
        label="Only sessions cut off within"
        value={resumeAfterCrashHours}
        min={1}
        max={168}
        suffix=" h"
        disabled={!resumeAfterCrash}
        onChange={(value) => update({ resumeAfterCrashHours: value })}
      />
      <ZaicodePrefCheck
        checked={relaunchWorkersAfterCrash}
        onChange={(value) => update({ relaunchWorkersAfterCrash: value })}
        label="Start the workers that were running again"
        hint="Same engine, project and prompt; a clean close forgets them"
      />
    </section>
  );
}

/** SRC-046: what the watcher does with the CLI's own questions and limit messages. */
function WatchSettings() {
  const prefs = useZaicodeWorkerPrefs();
  return (
    <section className="flex flex-col gap-2 border border-border bg-card p-4" data-zaicode-worker-watch-settings>
      <h2 className="text-ui-lg text-foreground">Watching the CLI</h2>
      <ZaicodePrefCheck
        checked={prefs.autoTrust}
        onChange={(autoTrust) => prefs.update({ autoTrust })}
        label="Answer “Trust this folder?” with yes"
        hint="Claude Code and Codex ask it once per new folder; a scheduled worker would wait for hours. Only in a worker's first 15 minutes."
      />
      <ZaicodePrefSegment
        label="When a worker hits its limit"
        value={prefs.onLimit}
        options={[
          { value: "keep", label: "Keep it", hint: "You are told; the CLI waits for its reset itself" },
          { value: "close", label: "Close it", hint: "Frees the place for another engine" },
          { value: "closeAndResume", label: "Close, start again after the reset", hint: "A one-shot SCHEDULER entry on the same engine and project" },
        ]}
        onChange={(onLimit) => prefs.update({ onLimit })}
      />
    </section>
  );
}

export function ZaicodeWorkersSettings() {
  const prefs = useZaicodeWorkerPrefs();
  const workers = useZaicodeWorkers();
  const family = zaicodeWorkerFontFamily(prefs);
  const crisp = (ZAICODE_TERMINUS_SIZES as readonly number[]).includes(prefs.fontSize);
  const stepSize = (direction: 1 | -1) => {
    if (prefs.font !== "terminus") return prefs.fontSize + direction;
    const sizes = ZAICODE_TERMINUS_SIZES as readonly number[];
    const index = sizes.findIndex((size) => size >= prefs.fontSize);
    const next = sizes[Math.max(0, Math.min(sizes.length - 1, (index < 0 ? sizes.length - 1 : index) + direction))];
    return next ?? prefs.fontSize;
  };
  return (
    <div className="flex flex-col gap-4 text-ui-xs" data-zaicode-workers-settings>
      <section className="flex flex-col gap-2 border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-ui-lg text-foreground">Workers</h2>
            <p className="mt-1 max-w-[580px] text-foreground-subtle">
              A worker is one of your subscription CLIs (Claude Code, Codex, Antigravity, ZCode) or a shell, running in a
              terminal inside ZAICODE. By default workers dock in the WORKERS panel under the chat, like a normal
              terminal; any of them can move to its own window and back. Hiding, minimizing or moving never stops one.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => openZaicodeWorkersPanel()}>
            Show panel ({workers.workers.length})
          </Button>
        </div>
        <ZaicodePrefSegment
          label="A new worker opens"
          value={prefs.defaultPlacement}
          options={[
            { value: "panel", label: "Docked in the WORKERS panel", hint: "Under the chat, like the terminal" },
            { value: "window", label: "In its own window", hint: "Movable, snappable, above everything" },
          ]}
          onChange={(defaultPlacement) => prefs.update({ defaultPlacement })}
        />
        <ZaicodePrefCheck
          checked={prefs.openPanelOnLaunch}
          onChange={(openPanelOnLaunch) => prefs.update({ openPanelOnLaunch })}
          label="Starting a worker shows the panel"
        />
        <ZaicodePrefCheck
          checked={prefs.sidebarList}
          onChange={(sidebarList) => prefs.update({ sidebarList })}
          label="List workers in the sidebar under the engine tiles"
          hint="One click shows a worker; hover shows its buttons; right-click has everything."
        />
        <ZaicodePrefCheck
          checked={prefs.confirmClose}
          onChange={(confirmClose) => prefs.update({ confirmClose })}
          label="Ask before stopping a running worker"
        />
      </section>

      <section className="flex flex-col gap-2 border border-border bg-card p-4">
        <h2 className="text-ui-lg text-foreground">Panel</h2>
        <ZaicodePrefSegment
          label="Layout"
          value={prefs.panelLayout}
          options={[
            { value: "split", label: "Split — all side by side", hint: "Dividers drag; double-click a divider = even" },
            { value: "tabs", label: "Tabs — one at a time" },
          ]}
          onChange={(panelLayout) => prefs.update({ panelLayout })}
        />
        <ZaicodePrefSegment
          label="Split"
          value={prefs.splitDirection}
          disabled={prefs.panelLayout !== "split"}
          options={[
            { value: "row", label: "Side by side" },
            { value: "column", label: "Stacked" },
            { value: "grid", label: "Grid" },
          ]}
          onChange={(splitDirection) => prefs.update({ splitDirection })}
        />
        <ZaicodePrefSegment
          label="Docked at"
          value={prefs.panelDock}
          options={[
            { value: "bottom", label: "Bottom" },
            { value: "right", label: "Right (vertical)" },
            { value: "left", label: "Left (vertical)" },
            { value: "top", label: "Top" },
          ]}
          onChange={(panelDock) => prefs.update({ panelDock })}
        />
        <ZaicodePrefStepper
          label="Panel width (left / right)"
          value={prefs.panelWidth}
          min={ZAICODE_WORKERS_PANEL_MIN_WIDTH}
          max={2000}
          step={20}
          suffix=" px"
          disabled={prefs.panelDock !== "left" && prefs.panelDock !== "right"}
          onChange={(panelWidth) => prefs.update({ panelWidth })}
        />
        <ZaicodePrefStepper
          label="Panel height (bottom / top)"
          value={prefs.panelHeight}
          min={ZAICODE_WORKERS_PANEL_MIN}
          max={1200}
          step={20}
          suffix=" px"
          onChange={(panelHeight) => prefs.update({ panelHeight })}
        />
        <span className="text-foreground-subtlest">
          Drag the panel&apos;s inner edge to resize, double-click it to maximize. Drag the WORKERS title to an edge to
          dock it there (or right-click it). Double-click a pane title to let it fill the panel.
        </span>
      </section>

      <section className="flex flex-col gap-2 border border-border bg-card p-4">
        <h2 className="text-ui-lg text-foreground">Windows and chips</h2>
        <ZaicodePrefCheck
          checked={prefs.snapWindows}
          onChange={(snapWindows) => prefs.update({ snapWindows })}
          label="Snap worker windows"
          hint="Drag to a side edge = half, to a corner = quarter, to the top = maximize, to the bottom = dock into the panel. Edges stick to other worker windows."
        />
        <ZaicodePrefStepper
          label="Snap distance"
          value={prefs.snapDistance}
          min={4}
          max={48}
          step={2}
          suffix=" px"
          disabled={!prefs.snapWindows}
          onChange={(snapDistance) => prefs.update({ snapDistance })}
        />
        <div className="flex flex-col gap-1">
          <span className="text-foreground-subtle">Minimized workers stack as chips named “engine · project” here:</span>
          <AnchorPicker value={prefs.trayAnchor} onChange={(trayAnchor) => prefs.update({ trayAnchor })} />
        </div>
        <ZaicodePrefCheck
          checked={prefs.trayShowsHiddenPanel}
          onChange={(trayShowsHiddenPanel) => prefs.update({ trayShowsHiddenPanel })}
          label="While the panel is hidden, show its workers as chips too"
        />
      </section>

      <section className="flex flex-col gap-2 border border-border bg-card p-4">
        <h2 className="text-ui-lg text-foreground">Terminal face</h2>
        <ZaicodePrefSegment
          label="Workers use"
          value={prefs.font}
          options={[
            { value: "terminus", label: "Terminus (crisp bitmap)", hint: "Bundled with ZAICODE" },
            { value: "profile", label: "The terminal profile font" },
            { value: "custom", label: "My own font" },
          ]}
          onChange={(font) =>
            prefs.update({
              font,
              ...(font === "terminus" && !crisp ? { fontSize: 14 } : {}),
            })
          }
        />
        {prefs.font === "custom" ? (
          <input
            className="border border-border bg-background px-1 py-0.5 font-mono text-foreground"
            value={prefs.customFont}
            placeholder="Font name installed on this computer"
            onChange={(event) => prefs.update({ customFont: event.target.value })}
          />
        ) : null}
        <ZaicodePrefStepper
          label={prefs.font === "terminus" ? "Size (Terminus is sharp at 12–32 px steps)" : "Size"}
          value={prefs.fontSize}
          min={8}
          max={40}
          suffix=" px"
          disabled={prefs.font === "profile"}
          onChange={(value) => prefs.update({ fontSize: stepSize(value > prefs.fontSize ? 1 : -1) })}
        />
        <div
          className="border border-border bg-background px-2 py-1 text-foreground"
          style={family ? { fontFamily: family, fontSize: prefs.fontSize, lineHeight: 1.15 } : undefined}
        >
          PS C:\project&gt; claude --dangerously-skip-permissions &quot;saipen continue&quot;
          <br />● Bash(saipen status) — 0O Il1 |{"{}"} ~ ✓
        </div>
        <TerminalFontSetting />
      </section>
      <WatchSettings />
      <CrashSettings />
      <ZaicodeDispatchSettings />
    </div>
  );
}
