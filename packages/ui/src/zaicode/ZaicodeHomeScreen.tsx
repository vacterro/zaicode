import { Mail, Settings2 } from "lucide-react";
import { openZaicodeSettings } from "./zaicodeActions.js";
import { cn } from "@/components/lib/utils.js";
import {
  ZaicodePrefCheck,
  ZaicodePrefHeading,
  ZaicodePrefSegment,
  ZaicodePrefStepper,
} from "./ZaicodePrefControls.js";
import { useZaicodeSaimailDesk } from "./zaicodeSaimail.js";
import { useZaicodeProfiles } from "./zaicodeProfiles.js";
import {
  formatZaicodeGreeting,
  isZaicodeGreetingHour,
  useZaicodeUiPrefs,
} from "./zaicodeUiPrefs.js";
import { getAtmosphericSaimailEmptyText, readSaimailHistory } from "./zaicodeSaimailModel.js";

/**
 * ZAICODE New task (empty draft) screen pieces: the greeting as configured,
 * the neutral "Empty" marker (no sad face) and a one-line SAIMAIL summary.
 * SAIHOME, the operator home, is a view of its own (zaicode/home/).
 */

/** The greeting to show now, or null when it is switched off / outside its hours. */
export function useZaicodeHomeGreeting(timeGreeting: string, now: Date): string | null {
  const prefs = useZaicodeUiPrefs();
  const { active } = useZaicodeProfiles();
  if (!prefs.showGreeting) return null;
  if (!isZaicodeGreetingHour(now.getHours(), prefs.greetingFromHour, prefs.greetingToHour)) return null;
  if (prefs.greetingMode === "custom") {
    const text = formatZaicodeGreeting(prefs.greetingText, { name: active.name, time: timeGreeting });
    return text || null;
  }
  return timeGreeting;
}

export function ZaicodeEmptyMarker() {
  const show = useZaicodeUiPrefs((prefs) => prefs.showEmptyMarker);
  if (!show) return null;
  return (
    <div aria-hidden="true" data-zaicode-empty-state className="select-none text-2xl text-foreground-subtlest/50">
      Empty
    </div>
  );
}

/**
 * A faint "New task screen" link that shows only while the pointer is over
 * the block (it keeps its space, so nothing moves): the way to the settings
 * for people who do not right-click.
 */
export function ZaicodeHomeSettingsLink() {
  return (
    <button
      type="button"
      className="flex items-center gap-1 text-ui-xs text-foreground-subtlest opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/home:opacity-100"
      title="Welcome text, its hours, the Empty marker and the SAIMAIL line (right-clicking here opens them too)"
      data-zaicode-home-settings-link
      onClick={() => void openZaicodeSettings("zaicodeLayout")}
    >
      <Settings2 className="size-3" />
      New task screen
    </button>
  );
}

/** Settings panel for the greeting + Empty marker (right-click the home screen). */
export function ZaicodeGreetingSettingsPanel() {
  const prefs = useZaicodeUiPrefs();
  const hour = (value: number) => `${String(value).padStart(2, "0")}:00`;
  return (
    <>
      <ZaicodePrefCheck
        checked={prefs.showGreeting}
        onChange={(showGreeting) => prefs.update({ showGreeting })}
        label="Show the welcome text"
      />
      <ZaicodePrefSegment
        label="Text"
        value={prefs.greetingMode}
        disabled={!prefs.showGreeting}
        options={[
          { value: "time", label: "By time of day", hint: "Good morning / afternoon / evening" },
          { value: "custom", label: "My own text" },
        ]}
        onChange={(greetingMode) => prefs.update({ greetingMode })}
      />
      {prefs.greetingMode === "custom" ? (
        <label className="flex flex-col gap-0.5">
          <span className="text-foreground-subtle">
            Your text — <code>{"{name}"}</code> = profile name, <code>{"{time}"}</code> = time-of-day greeting
          </span>
          <input
            className="border border-border bg-background px-1 py-0.5 text-foreground"
            value={prefs.greetingText}
            disabled={!prefs.showGreeting}
            onKeyDown={(event) => event.stopPropagation()}
            onChange={(event) => prefs.update({ greetingText: event.target.value })}
          />
        </label>
      ) : null}
      <ZaicodePrefHeading>WHEN IT APPEARS</ZaicodePrefHeading>
      <ZaicodePrefStepper
        label="From"
        value={prefs.greetingFromHour}
        min={0}
        max={23}
        format={hour}
        disabled={!prefs.showGreeting}
        onChange={(greetingFromHour) => prefs.update({ greetingFromHour })}
      />
      <ZaicodePrefStepper
        label="Until"
        value={prefs.greetingToHour}
        min={1}
        max={24}
        format={hour}
        disabled={!prefs.showGreeting}
        onChange={(greetingToHour) => prefs.update({ greetingToHour })}
      />
      <span className="text-foreground-subtlest">
        00:00–24:00 = always. A window past midnight (e.g. 22:00–06:00) works too.
      </span>
      <ZaicodePrefHeading>EMPTY SCREEN</ZaicodePrefHeading>
      <ZaicodePrefCheck
        checked={prefs.showEmptyMarker}
        onChange={(showEmptyMarker) => prefs.update({ showEmptyMarker })}
        label={'Show the faint "Empty" marker'}
      />
      <ZaicodePrefCheck
        checked={prefs.saimailOnHome}
        onChange={(saimailOnHome) => prefs.update({ saimailOnHome })}
        label="Show SAIMAIL on this screen"
      />
    </>
  );
}

/** One line on the home screen: SAIMAIL unread count, or "Empty" when nothing waits. */
export function ZaicodeHomeSaimailLine() {
  const prefs = useZaicodeUiPrefs();
  const { mailbox, desk } = useZaicodeSaimailDesk(null);
  if (!prefs.saimailOnHome || !mailbox || !desk) return null;
  const unread = desk.unread.length;
  if (unread === 0 && !prefs.saimailHomeShowEmpty) return null;
  return (
    <div
      className={cn(
        "flex select-none items-center gap-1.5 text-ui-sm",
        unread > 0
          ? "text-[var(--zaicode-highlight,var(--color-warning))]"
          : "text-foreground-subtlest/70",
      )}
      data-zaicode-home-saimail={unread}
      title="SAIMAIL — right-click the envelope in the title bar for its settings"
    >
      <Mail className="size-3.5" />
      {unread > 0 ? (
        `SAIMAIL · ${unread} unread`
      ) : (
        <>
          SAIMAIL · Empty.
          <span className="italic">{getAtmosphericSaimailEmptyText(readSaimailHistory().opened).subtitle}</span>
        </>
      )}
    </div>
  );
}

/** SAIMAIL envelope settings (right-click the envelope). */
export function ZaicodeSaimailSettingsPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  const prefs = useZaicodeUiPrefs();
  return (
    <>
      <ZaicodePrefHeading>HOME SCREEN</ZaicodePrefHeading>
      <ZaicodePrefCheck
        checked={prefs.saimailOnHome}
        onChange={(saimailOnHome) => prefs.update({ saimailOnHome })}
        label="Show SAIMAIL on the home screen"
      />
      <ZaicodePrefCheck
        checked={prefs.saimailHomeShowEmpty}
        disabled={!prefs.saimailOnHome}
        onChange={(saimailHomeShowEmpty) => prefs.update({ saimailHomeShowEmpty })}
        label={'…also when nothing is unread ("Empty")'}
      />
      <ZaicodePrefHeading>ENVELOPE</ZaicodePrefHeading>
      <ZaicodePrefCheck
        checked={prefs.saimailShowCount}
        onChange={(saimailShowCount) => prefs.update({ saimailShowCount })}
        label="Unread count next to the envelope"
      />
      <ZaicodePrefCheck
        checked={prefs.saimailUnreadRing}
        onChange={(saimailUnreadRing) => prefs.update({ saimailUnreadRing })}
        label="Gold ring while something is unread"
      />
      <ZaicodePrefCheck
        checked={prefs.saimailHoverPreview}
        onChange={(saimailHoverPreview) => prefs.update({ saimailHoverPreview })}
        label="Show headers on hover"
      />
      <ZaicodePrefStepper
        label="Headers in the hover list"
        value={prefs.saimailPreviewRows}
        min={1}
        max={30}
        disabled={!prefs.saimailHoverPreview}
        onChange={(saimailPreviewRows) => prefs.update({ saimailPreviewRows })}
      />
      <ZaicodePrefSegment
        label="Left click on the envelope"
        value={prefs.saimailClick}
        options={[
          { value: "brief", label: "Ask the agent to read the desk", hint: "Drafts (does not send) the brief request" },
          { value: "settings", label: "Open SAIMAIL settings" },
        ]}
        onChange={(saimailClick) => prefs.update({ saimailClick })}
      />
      <div className="mt-1 flex justify-end">
        <button
          type="button"
          className="border border-border px-1.5 text-foreground-subtle hover:bg-hover hover:text-foreground"
          onClick={onOpenSettings}
        >
          Mailbox folder… (Settings → ZAICODE)
        </button>
      </div>
    </>
  );
}
