import { cn } from "@/components/lib/utils.js";
import { Switch } from "@/components/ui/switch.js";
import {
  markZaicodeFresh,
  notifyZaicode,
  resetZaicodeNotifySettings,
  setZaicodeNotifyScenario,
  setZaicodeNotifySettings,
  showZaicodeSystemNotification,
  useZaicodeNotifySettings,
  ZAICODE_NOTIFY_SCENARIOS,
  type ZaicodeGlowRules,
  type ZaicodeNotifyDelivery,
  type ZaicodeNotifyPosition,
  type ZaicodeNotifySettings,
} from "@/zaicode/zaicodeNotifications.js";
import { openZaicodeSettings } from "@/zaicode/zaicodeActions.js";
import { ZaicodeTimeField } from "@/zaicode/ZaicodeTimeFields.js";

/**
 * Notification scenarios: for every kind of moment, whether a card shows, for
 * how long, whether Windows gets a notification too, and whether the thing
 * that changed glows afterwards (which subscription refilled, which window).
 */

const POSITIONS: readonly { value: ZaicodeNotifyPosition; label: string }[] = [
  { value: "bottom-right", label: "Bottom right" },
  { value: "top-right", label: "Top right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "top-center", label: "Top center" },
];

const DELIVERIES: readonly { value: ZaicodeNotifyDelivery; label: string; hint: string }[] = [
  { value: "custom", label: "Per moment", hint: "Each moment's Card / Windows ticks in the table below decide" },
  { value: "in-app", label: "In-app cards", hint: "Every moment that is on shows a ZAICODE card, never a Windows notification" },
  { value: "windows", label: "Windows", hint: "Every moment that is on goes to the Windows notification area, also while ZAICODE is in front" },
  { value: "both", label: "Both", hint: "Every moment that is on shows a card and a Windows notification" },
];

const GLOW_RULES: readonly { key: keyof ZaicodeGlowRules; label: string; hint: string }[] = [
  { key: "timed", label: "after its minutes", hint: "Ends after the moment's Glow min (table below); off = no time limit" },
  { key: "hover", label: "when I rest the pointer on it", hint: "Seen: the pointer stays on the glowing thing for a moment" },
  { key: "click", label: "when I click it", hint: "Acknowledged: one click on the glowing tile, meter or row" },
  { key: "use", label: "when that quota starts going down", hint: "The fresh quota is being used: the glow has done its job" },
];

const inputClass = "w-14 border border-border bg-background px-1 py-px text-right tabular-nums text-foreground";

function sample(id: string) {
  if (id === "limits.refill" || id === "limits.low") {
    // A real account key is unknown here: glow the whole meter demo key so the colour can be judged.
    markZaicodeFresh(["demo"], 1, "test");
  }
  notifyZaicode(id, {
    title: ZAICODE_NOTIFY_SCENARIOS.find((scenario) => scenario.id === id)?.label ?? id,
    body: "This is how this moment will look.",
    status: "Test",
    key: `test:${id}`,
  });
}

export function ZaicodeNotificationsSettings() {
  const settings = useZaicodeNotifySettings();
  const groups = [...new Set(ZAICODE_NOTIFY_SCENARIOS.map((scenario) => scenario.group))];
  return (
    <div className="flex flex-col gap-3 text-ui-xs" data-zaicode-notifications-settings>
      <section className="border border-border bg-card p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-ui-lg text-foreground">Notifications</h2>
            <p className="text-foreground-subtle">
              One row per moment. Sounds for the same moments live in{" "}
              <button type="button" className="underline" onClick={() => openZaicodeSettings("zaicodeSounds")}>
                Sounds
              </button>
              ; the Windows pop-up for finished agent turns is in General → Notifications.
            </p>
          </div>
          <label className="flex items-center gap-2 text-foreground">
            Cards on
            <Switch checked={settings.enabled} onCheckedChange={(enabled) => setZaicodeNotifySettings({ enabled })} />
          </label>
        </div>
        <div className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5">
          <span className="text-foreground-subtle">Where cards appear</span>
          <div className="flex flex-wrap gap-px">
            {POSITIONS.map((position) => (
              <button
                key={position.value}
                type="button"
                className={cn(
                  "border px-1.5 leading-4",
                  settings.position === position.value
                    ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
                    : "border-border text-foreground-subtle hover:bg-hover",
                )}
                onClick={() => setZaicodeNotifySettings({ position: position.value })}
              >
                {position.label}
              </button>
            ))}
          </div>
          <span className="text-foreground-subtle">Cards at once</span>
          <input type="number" min={1} max={10} className={inputClass} value={settings.maxVisible} onChange={(event) => setZaicodeNotifySettings({ maxVisible: Number(event.target.value) || 1 })} />
          <span className="text-foreground-subtle">Quiet hours</span>
          <div className="flex flex-wrap items-center gap-2">
            <Switch checked={settings.quietEnabled} onCheckedChange={(quietEnabled) => setZaicodeNotifySettings({ quietEnabled })} />
            <ZaicodeTimeField minute={settings.quietFrom} disabled={!settings.quietEnabled} ariaLabel="Quiet from" onChange={(quietFrom) => setZaicodeNotifySettings({ quietFrom })} />
            <span className="text-foreground-subtle">to</span>
            <ZaicodeTimeField minute={settings.quietTo} disabled={!settings.quietEnabled} ariaLabel="Quiet until" onChange={(quietTo) => setZaicodeNotifySettings({ quietTo })} />
            <label className="flex items-center gap-1 text-foreground">
              <input type="checkbox" disabled={!settings.quietEnabled} checked={settings.quietSounds} onChange={(event) => setZaicodeNotifySettings({ quietSounds: event.target.checked })} />
              also mute sounds
            </label>
          </div>
        </div>
        <div className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 border-t border-border/60 pt-2">
          <span className="text-foreground-subtle">Deliver to</span>
          <div className="flex flex-wrap gap-px" role="radiogroup" aria-label="Deliver notifications to">
            {DELIVERIES.map((delivery) => (
              <button
                key={delivery.value}
                type="button"
                role="radio"
                aria-checked={settings.delivery === delivery.value}
                title={delivery.hint}
                className={cn(
                  "border px-1.5 leading-4",
                  settings.delivery === delivery.value
                    ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
                    : "border-border text-foreground-subtle hover:bg-hover",
                )}
                onClick={() => setZaicodeNotifySettings({ delivery: delivery.value })}
              >
                {delivery.label}
              </button>
            ))}
          </div>
          <span className="text-foreground-subtle">Windows</span>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-foreground" title="Off: Windows notifications only while ZAICODE is in the background">
              <input
                type="checkbox"
                disabled={settings.delivery === "windows" || settings.delivery === "in-app"}
                checked={settings.delivery === "windows" || settings.systemWhenFocused}
                onChange={(event) => setZaicodeNotifySettings({ systemWhenFocused: event.target.checked })}
              />
              also while ZAICODE is in front
            </label>
            <button
              type="button"
              className="border border-border px-1.5 text-foreground-subtle hover:bg-hover"
              onClick={() => showZaicodeSystemNotification("ZAICODE", "This is how a Windows notification from ZAICODE looks.", true)}
            >
              Test Windows
            </button>
            <button
              type="button"
              className="border border-border px-1.5 text-foreground-subtle hover:bg-hover"
              onClick={() =>
                notifyZaicode("agent.question", { title: "ZAICODE", body: "This is how an in-app card looks.", status: "Test", key: "test:card", seconds: 6 })
              }
            >
              Test card
            </button>
          </div>
          <span className="text-foreground-subtle">Glow ends</span>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-zaicode-glow-rules>
            {GLOW_RULES.map((rule) => (
              <label key={rule.key} className="flex items-center gap-1 text-foreground" title={rule.hint}>
                <input type="checkbox" checked={settings.glow[rule.key]} onChange={(event) => setZaicodeNotifySettings({ glow: { ...settings.glow, [rule.key]: event.target.checked } })} />
                {rule.label}
              </label>
            ))}
          </div>
          <span className="text-foreground-subtle">Glow look</span>
          <label className="flex items-center gap-1 text-foreground" title="The glow gets fainter as it ages; off = full strength until it ends">
            <input type="checkbox" checked={settings.glow.fade} onChange={(event) => setZaicodeNotifySettings({ glow: { ...settings.glow, fade: event.target.checked } })} />
            fade out as it ages
          </label>
        </div>
        <div className="mt-2 flex gap-2">
          <button type="button" className="border border-border px-2 text-foreground-subtle hover:bg-hover" onClick={resetZaicodeNotifySettings}>
            Reset to defaults
          </button>
        </div>
      </section>
      <section className="border border-border bg-card p-3">
        <div className="grid grid-cols-[minmax(150px,1fr)_40px_52px_64px_40px_64px_40px] items-center gap-x-2 gap-y-1">
          <span className="text-foreground-subtlest">Moment</span>
          <span className="text-center text-foreground-subtlest" title="In-app card">Card</span>
          <span className="text-center text-foreground-subtlest" title="Windows notification (with Deliver to: Per moment); with the other choices either tick just means on">Windows</span>
          <span className="text-center text-foreground-subtlest" title="Seconds on screen; 0 = until you dismiss it">Seconds</span>
          <span className="text-center text-foreground-subtlest" title="The thing that changed glows for a while">Glow</span>
          <span className="text-center text-foreground-subtlest" title="Minutes the glow lasts">Glow min</span>
          <span />
          {groups.map((group) => (
            <GroupRows key={group} group={group} settings={settings} />
          ))}
        </div>
        <p className="mt-2 text-foreground-subtlest">
          Glow: after a reset the engine tile, the title-bar meter cell and the exact window row (5h, weekly, …) keep a warm outline for the set minutes; hover shows when it happened.
        </p>
      </section>
    </div>
  );

}

function GroupRows({ group, settings }: { group: string; settings: ZaicodeNotifySettings }) {
  return (
    <>
      <span className="col-span-7 mt-1 border-b border-border/60 text-foreground-subtle">{group}</span>
      {ZAICODE_NOTIFY_SCENARIOS.filter((scenario) => scenario.group === group).map((scenario) => {
        const row = settings.scenarios[scenario.id] ?? scenario.defaults;
        return (
          <div key={scenario.id} className="contents">
            <span className="min-w-0" title={scenario.hint}>
              <span className="text-foreground">{scenario.label}</span>
              <span className="block truncate text-[10px] text-foreground-subtlest">{scenario.hint}</span>
            </span>
            <input type="checkbox" className="mx-auto" checked={row.toast} onChange={(event) => setZaicodeNotifyScenario(scenario.id, { toast: event.target.checked })} />
            <input type="checkbox" className="mx-auto" checked={row.system} onChange={(event) => setZaicodeNotifyScenario(scenario.id, { system: event.target.checked })} />
            <input type="number" min={0} max={600} className={cn(inputClass, "mx-auto")} value={row.seconds} disabled={!row.toast} onChange={(event) => setZaicodeNotifyScenario(scenario.id, { seconds: Number(event.target.value) || 0 })} />
            {scenario.canHighlight ? (
              <>
                <input type="checkbox" className="mx-auto" checked={row.highlight} onChange={(event) => setZaicodeNotifyScenario(scenario.id, { highlight: event.target.checked })} />
                <input type="number" min={0} max={240} className={cn(inputClass, "mx-auto")} value={row.highlightMinutes} disabled={!row.highlight} onChange={(event) => setZaicodeNotifyScenario(scenario.id, { highlightMinutes: Number(event.target.value) || 0 })} />
              </>
            ) : (
              <>
                <span />
                <span />
              </>
            )}
            <button type="button" className="border border-border px-1 text-foreground-subtle hover:bg-hover" onClick={() => sample(scenario.id)}>
              Test
            </button>
          </div>
        );
      })}
    </>
  );
}
