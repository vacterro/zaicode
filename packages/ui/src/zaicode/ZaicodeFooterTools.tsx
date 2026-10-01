import { useState, type ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { ZaicodeProblipButton } from "./ZaicodeAudioPanels.js";
import { useZaicodeUiPrefs } from "./zaicodeUiPrefs.js";
import { isZaicodeCommonTool, useZaicodeCommonTools } from "./ZaicodeCommonTools.js";
import { ZAICODE_FOOTER_ICON_SLOTS, ZaicodeLayoutListEditor } from "./ZaicodeLayoutListEditor.js";
import { ZaicodeOverflowRow } from "./ZaicodeOverflowRow.js";
import { ZaicodePrefSegment, ZaicodeRightClickSettings } from "./ZaicodePrefControls.js";
import { openZaicodeSettings } from "./zaicodeActions.js";
import { ZAICODE_FOOTER_TOOLS, isZaicodeLayoutEntryShown, useZaicodeLayout, type ZaicodeFooterToolId } from "./zaicodeLayoutPrefs.js";
import { useZaicodeRunningSessions } from "./zaicodeSidebarPrefs.js";
import { useZaicodeProtrail } from "./protrail/zaicodeProtrailStore.js";
import { ZaicodeIcon } from "./zaicodeIconSlots.js";

/**
 * The sidebar footer's button row (SRC-062): "make the ProTrail on/off
 * visible next to Problip -- left click toggles, right click opens the full
 * settings -- and make the footer fully configurable: the profile can be just
 * the avatar, and the freed space takes my own buttons, as usual."
 */

export function ZaicodeProtrailFooterButton() {
  const enabled = useZaicodeProtrail((state) => state.config.enabled);
  const set = useZaicodeProtrail((state) => state.set);
  const title = `ProTrail — ${enabled ? "on" : "off"}. Click: turn ${enabled ? "off" : "on"}. Right-click: ProTrail settings.`;
  return (
    <ControlHintTooltip title={title} side="top">
      <button
        type="button"
        aria-label={`ProTrail ${enabled ? "on" : "off"}`}
        aria-pressed={enabled}
        onClick={() => set({ enabled: !enabled })}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openZaicodeSettings("zaicodeProtrail");
        }}
        className={cn(
          "flex size-8 items-center justify-center text-foreground-subtle hover:bg-hover hover:text-foreground",
          enabled && "text-[var(--color-success)]",
        )}
        data-zaicode-protrail-button={enabled ? "on" : "off"}
        data-zaicode-help="protrail"
      >
        <ZaicodeIcon slot="tool.protrail" />
      </button>
    </ControlHintTooltip>
  );
}

export function ZaicodeFooterEditor() {
  const layout = useZaicodeLayout();
  return (
    <div className="flex flex-col gap-2">
      <ZaicodePrefSegment
        label="Profile"
        value={layout.footerProfile}
        options={[
          { value: "full", label: "Avatar and name" },
          { value: "avatar", label: "Avatar only", hint: "The freed width goes to the buttons" },
        ]}
        onChange={layout.setFooterProfile}
      />
      <ZaicodeLayoutListEditor
        list={layout.footerTools}
        defs={ZAICODE_FOOTER_TOOLS}
        onChange={layout.setFooterTools}
        onReset={layout.resetFooter}
        iconSlots={ZAICODE_FOOTER_ICON_SLOTS}
      />
    </div>
  );
}

/**
 * The row itself. `settingsButton` is the footer's own gear (it turns into
 * "back" inside Settings). With the avatar-only profile the row takes the
 * whole width and whatever does not fit moves into ⋯.
 */
export function ZaicodeFooterTools({ settingsButton }: { settingsButton: ReactNode }) {
  const tools = useZaicodeLayout((state) => state.footerTools);
  const fill = useZaicodeLayout((state) => state.footerProfile === "avatar");
  const common = useZaicodeCommonTools("top");
  const working = useZaicodeRunningSessions((state) => state.sessions.length);
  const [hover, setHover] = useState(false);
  const actionView = useZaicodeUiPrefs((state) => state.actionView);
  const render = (id: ZaicodeFooterToolId): ReactNode => {
    if (isZaicodeCommonTool(id)) return common(id);
    if (id === "problip") return <ZaicodeProblipButton key={id} />;
    if (id === "protrail") return <ZaicodeProtrailFooterButton key={id} />;
    if (id === "settings") return <span key={id} className="flex">{settingsButton}</span>;
    return null;
  };
  const items = tools
    .filter((tool) => isZaicodeLayoutEntryShown(tool, { working, hover, view: actionView }))
    .map((tool) => ({ key: tool.id, node: render(tool.id) }))
    .filter((item) => item.node !== null);
  return (
    <ZaicodeRightClickSettings
      title="Footer"
      hint="The profile (avatar and name, or the avatar alone) and the buttons next to it, in your order. Settings -> Sidebar has the same list."
      panel={<ZaicodeFooterEditor />}
      side="top"
      align="end"
      className={cn("items-center", fill ? "min-w-0 flex-1" : "shrink-0")}
    >
      <div className={cn("flex items-center", fill && "min-w-0 flex-1")} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
        {fill ? (
          <ZaicodeOverflowRow className="flex-1" items={items} />
        ) : (
          <div className="flex min-h-8 min-w-8 items-center gap-1.5" data-zaicode-footer-tools>
            {items.map((item) => item.node)}
          </div>
        )}
      </div>
    </ZaicodeRightClickSettings>
  );
}
