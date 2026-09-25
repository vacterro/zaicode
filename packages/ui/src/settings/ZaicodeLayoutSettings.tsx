import type { ReactNode } from "react";
import { FolderOpen, MessageSquare, TextAlignCenter, TextAlignEnd, TextAlignStart } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Switch } from "@/components/ui/switch.js";
import { ZaicodeHeaderToolsEditor, ZaicodeNavItemsEditor } from "@/zaicode/ZaicodeLayoutListEditor.js";
import { ZaicodeGreetingSettingsPanel } from "@/zaicode/ZaicodeHomeScreen.js";
import { ZaicodeHomeSettingsPanel } from "@/zaicode/home/ZaicodeHomeSettings.js";
import { useZaicodeSidebarPrefs, type ZaicodeSlotLabelAlign } from "@/zaicode/zaicodeSidebarPrefs.js";
import { ZaicodeFancyZonesSettings } from "./ZaicodeFancyZonesSettings.js";
import { ZaicodeComposerPartsPanel } from "@/zaicode/ZaicodeComposerPartsPanel.js";
import { ZaicodePrefCheck, ZaicodePrefSegment } from "@/zaicode/ZaicodePrefControls.js";
import { isZaicodeCalm, useZaicodeUiPrefs, type ZaicodeClearMode } from "@/zaicode/zaicodeUiPrefs.js";

/**
 * Settings -> Layout & home: SAIHOME (the operator home), what the sidebar
 * header and menu hold, how the project list is arranged, what the New task
 * screen says, and window zones. Every block here is also editable in place
 * with a right-click on the thing itself.
 */

function Block({ title, hint, children, testId }: { title: string; hint: string; children: ReactNode; testId?: string }) {
  return (
    <section className="flex flex-col gap-2 border border-border bg-card p-4 text-ui-xs" data-zaicode-layout-block={testId}>
      <div>
        <h2 className="text-ui-lg text-foreground">{title}</h2>
        <p className="mt-1 max-w-[580px] text-foreground-subtle">{hint}</p>
      </div>
      {children}
    </section>
  );
}

const ALIGNS: readonly { value: ZaicodeSlotLabelAlign; label: string; Icon: typeof TextAlignStart }[] = [
  { value: "left", label: "Left", Icon: TextAlignStart },
  { value: "center", label: "Middle", Icon: TextAlignCenter },
  { value: "right", label: "Right", Icon: TextAlignEnd },
];

/** SRC-038: where project names and session titles sit in their row, picked by looking at it. */
export function ZaicodeTitleAlignPicker() {
  const projectAlign = useZaicodeSidebarPrefs((state) => state.projectTitleAlign);
  const sessionAlign = useZaicodeSidebarPrefs((state) => state.sessionTitleAlign);
  const update = useZaicodeSidebarPrefs((state) => state.update);
  const rows = [
    { key: "projectTitleAlign", label: "Project names", sample: "_ZAICODE", Icon: FolderOpen, value: projectAlign },
    { key: "sessionTitleAlign", label: "Session titles", sample: "PHASE BUILD T-49", Icon: MessageSquare, value: sessionAlign },
  ] as const;
  return (
    <div className="flex flex-col gap-2" data-zaicode-title-align>
      {rows.map((row) => (
        <div key={row.key} className="flex flex-wrap items-center gap-2">
          <span className="w-28 shrink-0 text-foreground-subtle">{row.label}</span>
          <div className="flex gap-px" role="radiogroup" aria-label={row.label}>
            {ALIGNS.map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={row.value === value}
                title={label}
                className={cn(
                  "flex size-7 items-center justify-center border",
                  row.value === value
                    ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
                    : "border-border text-foreground-subtle hover:bg-hover hover:text-foreground",
                )}
                onClick={() => update({ [row.key]: value })}
              >
                <Icon className="size-4" />
              </button>
            ))}
          </div>
          <span className="flex w-56 items-center gap-2 border border-border bg-background px-2 py-1 text-ui-base text-foreground">
            <row.Icon className="size-4 shrink-0 text-foreground-subtle" />
            <span className="min-w-0 flex-1 truncate" style={{ textAlign: row.value }}>
              {row.sample}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

export function ZaicodeLayoutSettings() {
  const sidebarPrefs = useZaicodeSidebarPrefs();
  const clearMode = useZaicodeUiPrefs((state) => state.clearMode);
  const noMotion = useZaicodeUiPrefs((state) => state.noMotion);
  const noDim = useZaicodeUiPrefs((state) => state.noDim);
  const noHoverPopups = useZaicodeUiPrefs((state) => state.noHoverPopups);
  const calm = { noMotion, noDim, noHoverPopups };
  const updateUiPrefs = useZaicodeUiPrefs((state) => state.update);
  return (
    <div className="flex flex-col gap-4" data-zaicode-layout-settings>
      <Block
        title="SAIHOME"
        hint="The operator home: what is happening (clock, limits, projects, agents, statistics). It is not New task: opening it starts nothing. Alt+H, the SAIHOME menu line or the tray menu open it."
        testId="saihome"
      >
        <ZaicodeHomeSettingsPanel />
      </Block>
      <Block
        title="Sidebar header buttons"
        hint="The row at the top of the sidebar. Tick what shows, drag to order. Right-click the row itself for the same list."
        testId="header"
      >
        <ZaicodeHeaderToolsEditor />
      </Block>
      <Block
        title="Sidebar menu"
        hint="The lines under the header (New task, ZAICODE, …). Right-click the menu for the same list; the header's menu button hides the whole block."
        testId="menu"
      >
        <ZaicodeNavItemsEditor />
      </Block>
      <Block title="Project list" hint="How projects and sessions are arranged in the sidebar." testId="list">
        <div className="flex flex-col gap-1.5 text-foreground">
          {(
            [
              ["compact", "Compact: tight rows, no empty vertical space"],
              ["slots", "Priority slots: group projects as MAIN0 / MAIN1 / SIDE0 / SIDE1 / SIDE2"],
              ["liveFirst", "Working first: projects with a running session move to the top, closest to done first"],
              ["navOpen", "Show the sidebar menu block"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center justify-between gap-3">
              <span>{label}</span>
              <Switch checked={sidebarPrefs[key]} onCheckedChange={(checked) => sidebarPrefs.update({ [key]: checked })} />
            </label>
          ))}
        </div>
        <div className="mt-1 border-t border-border pt-2">
          <span className="mb-1 block text-foreground-subtle">Title position</span>
          <ZaicodeTitleAlignPicker />
        </div>
      </Block>
      <Block
        title="New task screen"
        hint="What an empty new session (the composer) shows: the welcome text and when, the faint “Empty” marker, the SAIMAIL line. Quiet by default; right-click that screen for the same panel. SAIHOME is configured above."
        testId="home"
      >
        <div className="flex max-w-[420px] flex-col gap-1.5">
          <ZaicodeGreetingSettingsPanel />
        </div>
      </Block>
      <Block
        title="Calm interface"
        hint="Less visual noise: switch off movement, dimming and hover pop-ups. Each one alone, or all at once (also a hotkey in Hotkeys → Interface)."
        testId="calm"
      >
        <div className="flex max-w-[480px] flex-col gap-1.5">
          <ZaicodePrefCheck
            checked={isZaicodeCalm(calm)}
            onChange={(on) => updateUiPrefs({ noMotion: on, noDim: on, noHoverPopups: on })}
            label="Calm: all three below"
          />
          <ZaicodePrefCheck
            checked={calm.noMotion}
            onChange={(on) => updateUiPrefs({ noMotion: on })}
            label="No animations or transitions"
            hint="Nothing fades, slides, pulses or spins; panels and menus appear at once"
          />
          <ZaicodePrefCheck
            checked={calm.noDim}
            onChange={(on) => updateUiPrefs({ noDim: on })}
            label="No dimming or blur"
            hint="Dialogs do not darken the window; no frosted, see-through panels"
          />
          <ZaicodePrefCheck
            checked={calm.noHoverPopups}
            onChange={(on) => updateUiPrefs({ noHoverPopups: on })}
            label="No pop-ups on hover"
            hint="ZAICODE tooltips and hover cards stay hidden (the small system hint some buttons have still shows); right-click menus and clicks work as before"
          />
        </div>
      </Block>
      <Block
        title="Message box"
        hint="Most of the work happens here, so all of it is yours: compact mode folds the SAIPEN strip into one row of small square buttons (also the ⇕ button at the end of the strip; right-click it for this list), and every line can be hidden. START and the model: the model you pick in a message box is what START runs next; a subscription engine picked on the sidebar is released by that pick."
        testId="composer"
      >
        <div className="max-w-[480px]">
          <ZaicodeComposerPartsPanel />
        </div>
        <ZaicodePrefSegment<ZaicodeClearMode>
          label="CLEAR"
          value={clearMode}
          onChange={(value) => updateUiPrefs({ clearMode: value })}
          options={[
            { value: "session", label: "Empty this session", hint: "Stops the running turn, drops the goal and the queue; the session stays where it is" },
            { value: "new", label: "Open a new session", hint: "Leaves this session as it is and starts an empty one in the same project" },
          ]}
        />
      </Block>
      <ZaicodeFancyZonesSettings />
    </div>
  );
}
