import { useEffect, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { Switch } from "@/components/ui/switch.js";
import {
  findZaicodeHotkeyConflicts,
  resetZaicodeHotkeys,
  setZaicodeHotkeyBinding,
  setZaicodeHotkeySettings,
  useZaicodeHotkeySettings,
  zaicodeBindingFromEvent,
  zaicodeHotkeyAction,
  ZAICODE_HOTKEY_ACTIONS,
  type ZaicodeFKeysMode,
  type ZaicodeHotkeyAction,
} from "@/zaicode/zaicodeHotkeys.js";
import { useZaicodeGlobalHotkeyStatus } from "@/zaicode/ZaicodeAppRuntime.js";
import { openZaicodeSettings } from "@/zaicode/zaicodeActions.js";
import { ZaicodeFancyZonesSettings } from "./ZaicodeFancyZonesSettings.js";

/**
 * FastPrompter's "Configure Hotkeys", for ZAICODE: Global (work anywhere),
 * In-app, and the F-keys block. Every action has two bindings; Bind listens
 * for the next combination (Esc cancels, Backspace clears).
 */

type Tab = "global" | "app" | "fkeys";

function BindingCell({ id, slot, value }: { id: string; slot: 0 | 1; value: string }) {
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setListening(false);
        return;
      }
      if (event.key === "Backspace" && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        setZaicodeHotkeyBinding(id, slot, "");
        setListening(false);
        return;
      }
      const binding = zaicodeBindingFromEvent(event);
      if (!binding) return; // a bare modifier: keep listening
      setZaicodeHotkeyBinding(id, slot, binding);
      setListening(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [id, listening, slot]);
  return (
    <span className="flex items-center gap-1" {...(listening ? { "data-zaicode-hotkey-recording": "" } : {})}>
      <span
        className={cn(
          "min-w-[92px] border px-1 py-px text-center tabular-nums",
          listening ? "border-[var(--zaicode-highlight,#f0c040)] text-[#f0c850]" : "border-border text-foreground",
          !value && !listening && "text-foreground-subtlest",
        )}
      >
        {listening ? "press keys…" : value || "—"}
      </span>
      <button
        type="button"
        className="border border-border bg-card px-1 leading-4 text-foreground hover:bg-hover"
        title="Press the combination next. Esc cancels, Backspace clears."
        onClick={() => setListening((current) => !current)}
      >
        {listening ? "…" : "Bind"}
      </button>
      {value ? (
        <button type="button" className="px-0.5 text-foreground-subtlest hover:text-foreground" title="Clear" onClick={() => setZaicodeHotkeyBinding(id, slot, "")}>
          ✕
        </button>
      ) : null}
    </span>
  );
}

function ActionRows({ actions }: { actions: readonly ZaicodeHotkeyAction[] }) {
  const settings = useZaicodeHotkeySettings();
  const status = useZaicodeGlobalHotkeyStatus();
  const groups = [...new Set(actions.map((action) => action.group))];
  return (
    <div className="flex flex-col gap-2">
      {groups.map((group) => (
        <div key={group} className="flex flex-col gap-1">
          <span className="border-b border-border/60 text-foreground-subtle">{group}</span>
          {actions
            .filter((action) => action.group === group)
            .map((action) => {
              const row = settings.bindings[action.id] ?? ["", ""];
              const state = action.scope === "global" && (row[0] || row[1]) ? status[action.id] : undefined;
              return (
                <div key={action.id} className="grid grid-cols-[minmax(160px,1fr)_auto_auto_70px] items-center gap-2">
                  <span className="min-w-0" title={action.hint}>
                    <span className="text-foreground">{action.label}</span>
                    <span className="block truncate text-[10px] text-foreground-subtlest">{action.hint}</span>
                  </span>
                  <BindingCell id={action.id} slot={0} value={row[0]} />
                  <BindingCell id={action.id} slot={1} value={row[1]} />
                  <span
                    className={cn(
                      "text-[10px]",
                      state === "ok" ? "text-[#8fd46a]" : state === "taken" ? "text-[#ff9a66]" : state === "invalid" ? "text-[#ff7b6b]" : "text-foreground-subtlest",
                    )}
                    title={state === "taken" ? "Another app already owns this combination. Pick another one." : undefined}
                  >
                    {state === "ok" ? "active" : state === "taken" ? "taken by another app" : state === "invalid" ? "not a valid key" : ""}
                  </span>
                </div>
              );
            })}
        </div>
      ))}
    </div>
  );
}

const FKEY_MODES: readonly { value: ZaicodeFKeysMode; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "F1–F10 do what the app and your editors expect (F1 = Help, F2 = rename)" },
  { value: "projects", label: "Projects 1–10", hint: "F1 opens the first project in the sidebar, F2 the second, …" },
  { value: "sessions", label: "Sessions 1–10", hint: "F1 opens the most recent session of this project, F2 the next, …" },
];

export function ZaicodeHotkeysSettings() {
  const settings = useZaicodeHotkeySettings();
  const [tab, setTab] = useState<Tab>("app");
  const conflicts = findZaicodeHotkeyConflicts(settings);
  const name = (id: string) =>
    id.startsWith("fkeys.") ? `F-keys (${id.slice(6)})` : (zaicodeHotkeyAction(id)?.label ?? id);
  return (
    <div className="flex flex-col gap-3 text-ui-xs" data-zaicode-hotkeys-settings>
      <section className="border border-border bg-card p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-ui-lg text-foreground">Hotkeys</h2>
            <p className="text-foreground-subtle">
              Two bindings per action. Keys follow their physical place, so they work on any keyboard layout.
            </p>
          </div>
          <label className="flex items-center gap-2 text-foreground">
            All ZAICODE hotkeys
            <Switch checked={settings.enabled} onCheckedChange={(enabled) => setZaicodeHotkeySettings({ enabled })} />
          </label>
        </div>
        {conflicts.length > 0 ? (
          <div className="mt-2 border border-[#ff9a66]/60 px-2 py-1 text-[#ff9a66]">
            {conflicts.map((conflict) => (
              <div key={conflict.binding}>
                {conflict.binding}:{" "}
                {[...conflict.actions.map(name), ...(conflict.upstream ? [`app shortcut “${conflict.upstream}”`] : [])].join(" + ")}
              </div>
            ))}
            <div className="text-foreground-subtlest">The first one wins; change one of them to use both.</div>
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-2">
          {(
            [
              ["global", "Global / anywhere"],
              ["app", "In-app shortcuts"],
              ["fkeys", "F-keys"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={cn(
                "border px-2 py-0.5",
                tab === id ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground" : "border-border text-foreground-subtle hover:bg-hover",
              )}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
          <span className="flex-1" />
          <button type="button" className="border border-border px-2 text-foreground-subtle hover:bg-hover" onClick={resetZaicodeHotkeys}>
            Reset defaults
          </button>
          <button type="button" className="border border-border px-2 text-foreground-subtle hover:bg-hover" onClick={() => openZaicodeSettings("shortcuts")}>
            Other app shortcuts…
          </button>
        </div>
      </section>
      <section className="border border-border bg-card p-3">
        {tab === "global" ? (
          <>
            <p className="mb-2 text-foreground-subtle">
              These work while another program has the focus (like FastPrompter&apos;s Alt+X). A combination another app already owns shows “taken”.
            </p>
            <ActionRows actions={ZAICODE_HOTKEY_ACTIONS.filter((action) => action.scope === "global")} />
          </>
        ) : null}
        {tab === "app" ? <ActionRows actions={ZAICODE_HOTKEY_ACTIONS.filter((action) => action.scope === "app")} /> : null}
        {tab === "fkeys" ? (
          <div className="flex flex-col gap-2">
            <p className="text-foreground-subtle">F-Keys navigation, FastPrompter style: F1–F10 as one block.</p>
            {FKEY_MODES.map((mode) => (
              <label key={mode.value} className="flex items-start gap-2 text-foreground">
                <input type="radio" name="zaicode-fkeys" checked={settings.fKeys === mode.value} onChange={() => setZaicodeHotkeySettings({ fKeys: mode.value })} />
                <span>
                  {mode.label}
                  <span className="block text-foreground-subtlest">{mode.hint}</span>
                </span>
              </label>
            ))}
          </div>
        ) : null}
      </section>
      <ZaicodeFancyZonesSettings />
    </div>
  );
}
