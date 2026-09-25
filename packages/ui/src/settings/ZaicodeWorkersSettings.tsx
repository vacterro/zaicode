import { useEffect, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useServices } from "@/hooks/useServices.js";
import { ZaicodePrefCheck, ZaicodePrefSegment, ZaicodePrefStepper } from "@/zaicode/ZaicodePrefControls.js";
import {
  ZAICODE_TERMINUS_SIZES,
  ZAICODE_WORKERS_PANEL_MIN,
  useZaicodeWorkerPrefs,
  zaicodeWorkerFontFamily,
  type ZaicodeWorkersTrayAnchor,
} from "@/zaicode/zaicodeWorkerPrefs.js";
import { openZaicodeWorkersPanel, useZaicodeWorkers } from "@/zaicode/zaicodeWorkers.js";
import { ZaicodeDispatchSettings } from "./ZaicodeDispatchSettings.js";

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
        <ZaicodePrefStepper
          label="Panel height"
          value={prefs.panelHeight}
          min={ZAICODE_WORKERS_PANEL_MIN}
          max={1200}
          step={20}
          suffix=" px"
          onChange={(panelHeight) => prefs.update({ panelHeight })}
        />
        <span className="text-foreground-subtlest">
          Drag the panel&apos;s top edge to resize, double-click it to maximize. Double-click a pane title to let it fill
          the panel.
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
      <ZaicodeDispatchSettings />
    </div>
  );
}
