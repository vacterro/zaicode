import type { ReactNode } from "react";
import { useZaicodeUiPrefs, type ZaicodeSaipenStatusView } from "./zaicodeUiPrefs.js";
import {
  ZaicodePrefSegment,
  ZaicodePrefStepper,
  ZaicodeRightClickSettings,
} from "./ZaicodePrefControls.js";

/**
 * The live status strip's own settings: which shape it takes (or none at all)
 * and its font size. One panel, used twice -- in Settings -> Layout & home and
 * in the right-click popover of the strip itself -- so the two never disagree.
 */
export function ZaicodeSaipenStatusSettingsPanel() {
  const view = useZaicodeUiPrefs((state) => state.saipenStatusView);
  const fontSize = useZaicodeUiPrefs((state) => state.saipenStatusFontSize);
  const update = useZaicodeUiPrefs((state) => state.update);
  return (
    <div className="flex flex-col gap-1.5" data-zaicode-saipen-status-settings>
      <ZaicodePrefSegment<ZaicodeSaipenStatusView>
        label="Status strip"
        value={view}
        onChange={(value) => update({ saipenStatusView: value })}
        options={[
          {
            value: "off",
            label: "Off",
            hint: "Nothing renders; turn it back on in Settings → Layout & home",
          },
          { value: "compact", label: "Compact", hint: "One row: status, NEXT, RESULT, ticket" },
          {
            value: "expanded",
            label: "Expanded",
            hint: "Every field in a panel, with owner and freshness",
          },
          {
            value: "collapsed",
            label: "Slim",
            hint: "A thin bar with the status word and NEED USER only",
          },
        ]}
      />
      <ZaicodePrefStepper
        label="Font size"
        value={fontSize}
        min={8}
        max={20}
        suffix=" px"
        onChange={(value) => update({ saipenStatusFontSize: value })}
        disabled={view === "off"}
      />
    </div>
  );
}

/**
 * The strip inside its own right-click settings affordance (SRC-151: every
 * control owns its settings, one implementation). Full width, so the border-b
 * of the bar inside still spans the session.
 */
export function ZaicodeSaipenStatusShell({ children }: { children: ReactNode }) {
  return (
    <ZaicodeRightClickSettings
      title="SAIPEN status strip"
      hint="Its shape, whether it shows at all, and its font size."
      panel={<ZaicodeSaipenStatusSettingsPanel />}
      className="flex w-full shrink-0"
      preferenceKey="statusStrip"
    >
      {children}
    </ZaicodeRightClickSettings>
  );
}
