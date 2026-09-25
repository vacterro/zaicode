import { useState } from "react";
import { ZAICODE_STREAK_MEASURES, type ZaicodeStreakMeasure } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { ZaicodePrefCheck, ZaicodePrefHeading, ZaicodePrefSegment } from "../ZaicodePrefControls.js";
import { refreshZaicodeHome } from "./zaicodeHomeFeed.js";
import { clearZaicodeHomeJournal } from "./zaicodeHomeJournal.js";
import {
  ZAICODE_HOME_PRESETS,
  useZaicodeHomePrefs,
  type ZaicodeHomeClockPrefs,
  type ZaicodeHomePreset,
  type ZaicodeStartupView,
} from "./zaicodeHomePrefs.js";

/**
 * Settings -> Layout & home -> SAIHOME (T-56): startup, layout, clock,
 * statistics, refresh and privacy in one place. The widgets themselves carry
 * no settings of their own (except the range / measure toggles that are part
 * of reading them).
 */

const MEASURE_LABEL: Record<ZaicodeStreakMeasure, string> = {
  activity: "Activity (any recorded work)",
  tokens: "Tokens",
  tasks: "Tasks done",
  runs: "Runs (turns, queue runs, worker sessions)",
  runtime: "Runtime",
};

export function ZaicodeHomeSettingsPanel() {
  const prefs = useZaicodeHomePrefs();
  const { zaicodeStatsService } = useServices();
  const platform = usePlatform();
  const [privacy, setPrivacy] = useState<string>("");
  const [confirmClear, setConfirmClear] = useState(false);
  const clock = (key: keyof ZaicodeHomeClockPrefs, label: string, hint?: string) => (
    <ZaicodePrefCheck
      key={key}
      checked={Boolean(prefs.clock[key])}
      onChange={(value) => prefs.setClock({ [key]: value })}
      label={label}
      {...(hint ? { hint } : {})}
    />
  );
  const exportStats = async () => {
    if (!zaicodeStatsService) return setPrivacy("Statistics need the local desktop host.");
    const json = await zaicodeStatsService.exportEvents();
    if (platform.saveFile) {
      const bytes = new TextEncoder().encode(json);
      const result = await platform.saveFile({
        data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        suggestedName: `zaicode-statistics-${new Date().toISOString().slice(0, 10)}.json`,
      });
      setPrivacy(result.canceled ? "Export cancelled." : result.success ? `Exported${result.path ? ` to ${result.path}` : ""}.` : `Export failed: ${result.error ?? "unknown error"}`);
    } else {
      await navigator.clipboard.writeText(json);
      setPrivacy("Copied to the clipboard (no file dialog here).");
    }
  };
  return (
    <div className="flex max-w-[520px] flex-col gap-1.5" data-zaicode-home-settings>
      <ZaicodePrefSegment<ZaicodeStartupView>
        label="When ZAICODE starts, show"
        value={prefs.startup}
        onChange={(startup) => prefs.update({ startup })}
        options={[
          { value: "home", label: "SAIHOME", hint: "What is happening: clock, limits, projects, agents, statistics" },
          { value: "last", label: "Last active", hint: "SAIHOME, the composer or the ZAICODE workspace, whichever was open" },
          { value: "newTask", label: "New task", hint: "The composer" },
        ]}
      />
      <ZaicodePrefHeading>LAYOUT</ZaicodePrefHeading>
      <ZaicodePrefSegment<ZaicodeHomePreset>
        label="Preset"
        value={prefs.preset}
        onChange={(preset) => prefs.update({ preset })}
        options={[
          ...(Object.keys(ZAICODE_HOME_PRESETS) as Exclude<ZaicodeHomePreset, "custom">[]).map((preset) => ({
            value: preset,
            label: ZAICODE_HOME_PRESETS[preset].label,
            hint: ZAICODE_HOME_PRESETS[preset].widgets.join(", "),
          })),
          { value: "custom" as const, label: "CUSTOM", hint: "Your own order, visibility and sizes (Edit layout on SAIHOME)" },
        ]}
      />
      <ZaicodePrefSegment<"compact" | "normal">
        label="Density"
        value={prefs.density}
        onChange={(density) => prefs.update({ density })}
        options={[
          { value: "normal", label: "Normal" },
          { value: "compact", label: "Compact", hint: "Narrower columns, more of them" },
        ]}
      />
      <div>
        <button type="button" className="border border-border px-1.5 text-foreground-subtle hover:bg-hover hover:text-foreground" onClick={prefs.resetLayout}>
          Reset layout
        </button>
        <span className="ml-2 text-foreground-subtlest">Layout only: statistics stay.</span>
      </div>
      <ZaicodePrefHeading>CLOCK</ZaicodePrefHeading>
      <ZaicodePrefSegment<ZaicodeHomeClockPrefs["size"]>
        label="Size"
        value={prefs.clock.size}
        onChange={(size) => prefs.setClock({ size })}
        options={[
          { value: "small", label: "Small" },
          { value: "medium", label: "Medium" },
          { value: "large", label: "Large" },
        ]}
      />
      {clock("secondHand", "Second hand")}
      {clock("smooth", "Smooth second hand", "Only while movement is allowed (calm interface off, no reduced motion); otherwise it ticks")}
      {clock("numerals", "Hour numerals")}
      {clock("date", "Date")}
      {clock("timeZone", "Time zone")}
      <ZaicodePrefSegment<ZaicodeHomeClockPrefs["digital"]>
        label="Digital time under the face"
        value={prefs.clock.digital}
        onChange={(digital) => prefs.setClock({ digital })}
        options={[
          { value: "24", label: "24-hour" },
          { value: "12", label: "12-hour" },
          { value: "off", label: "None" },
        ]}
      />
      <label className="flex items-center gap-2">
        <span className="text-foreground-subtle">Second time zone</span>
        <input
          className="w-48 border border-border bg-background px-1 py-0.5 text-foreground"
          placeholder="e.g. Asia/Tokyo (empty = none)"
          value={prefs.clock.secondZone}
          onKeyDown={(event) => event.stopPropagation()}
          onChange={(event) => prefs.setClock({ secondZone: event.target.value })}
        />
      </label>
      <ZaicodePrefHeading>STATISTICS</ZaicodePrefHeading>
      <ZaicodePrefSegment<ZaicodeStreakMeasure>
        label="Activity squares and streak count"
        value={prefs.streakMeasure}
        onChange={(streakMeasure) => {
          prefs.update({ streakMeasure });
          void refreshZaicodeHome();
        }}
        options={ZAICODE_STREAK_MEASURES.map((value) => ({ value, label: MEASURE_LABEL[value] }))}
      />
      <ZaicodePrefSegment<"1" | "0">
        label="Week starts on"
        value={String(prefs.weekStartsOn) as "1" | "0"}
        onChange={(value) => {
          prefs.update({ weekStartsOn: value === "0" ? 0 : 1 });
          void refreshZaicodeHome();
        }}
        options={[
          { value: "1", label: "Monday" },
          { value: "0", label: "Sunday" },
        ]}
      />
      <ZaicodePrefSegment<"91" | "182" | "371">
        label="Days in the activity grid"
        value={(["91", "182", "371"].includes(String(prefs.gridDays)) ? String(prefs.gridDays) : "182") as "91" | "182" | "371"}
        onChange={(value) => {
          prefs.update({ gridDays: Number(value) });
          void refreshZaicodeHome();
        }}
        options={[
          { value: "91", label: "3 months" },
          { value: "182", label: "6 months" },
          { value: "371", label: "1 year" },
        ]}
      />
      <ZaicodePrefSegment<"30" | "60" | "180">
        label="Refresh while SAIHOME is open"
        value={(["30", "60", "180"].includes(String(prefs.refreshSeconds)) ? String(prefs.refreshSeconds) : "60") as "30" | "60" | "180"}
        onChange={(value) => prefs.update({ refreshSeconds: Number(value) })}
        options={[
          { value: "30", label: "30 s" },
          { value: "60", label: "1 min" },
          { value: "180", label: "3 min" },
        ]}
      />
      <ZaicodePrefHeading>PRIVACY</ZaicodePrefHeading>
      <p className="text-foreground-subtle">
        Statistics are local: they live in this profile's task database and are never sent anywhere. Tokens come from the agent's own usage store
        (in-app model requests; shared with ZCode on this machine); queue runs from the ZAICODE queue; CLI worker sessions are recorded when they end,
        without token counts (the subscription CLIs do not report them).
      </p>
      <div className="flex flex-wrap items-center gap-1">
        <button type="button" className="border border-border px-1.5 text-foreground-subtle hover:bg-hover hover:text-foreground" onClick={() => void exportStats().catch((error: unknown) => setPrivacy(String(error)))}>
          Export statistics (JSON)
        </button>
        {confirmClear ? (
          <>
            <span className="text-foreground">Delete every local statistic of this profile? The sources are not read back.</span>
            <button
              type="button"
              className="border border-destructive px-1.5 text-destructive hover:bg-hover"
              onClick={() => {
                setConfirmClear(false);
                void zaicodeStatsService
                  ?.clear()
                  .then(() => {
                    clearZaicodeHomeJournal();
                    setPrivacy("Local statistics deleted.");
                    void refreshZaicodeHome();
                  })
                  .catch((error: unknown) => setPrivacy(String(error)));
              }}
            >
              Delete statistics
            </button>
            <button type="button" autoFocus className="border border-border px-1.5 hover:bg-hover" onClick={() => setConfirmClear(false)}>
              Keep them
            </button>
          </>
        ) : (
          <button type="button" className="border border-border px-1.5 text-foreground-subtle hover:bg-hover hover:text-foreground" onClick={() => setConfirmClear(true)}>
            Clear local statistics…
          </button>
        )}
      </div>
      {privacy ? <span className="text-foreground-subtle">{privacy}</span> : null}
    </div>
  );
}
