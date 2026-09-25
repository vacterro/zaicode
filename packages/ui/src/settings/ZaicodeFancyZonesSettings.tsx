import { Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  FANCYZONE_MAX_PRESETS,
  applyFancyZone,
  cycleFastFancyZone,
  deleteFancyPreset,
  fancyZoneLayouts,
  saveCurrentWindowAsFancyPreset,
  useZaicodeFancyZones,
  writeZaicodeFancyZonesSettings,
} from "@/zaicode/zaicodeFancyZones.js";

interface ZaicodeFancyZonesSettingsProps {
  onOpenPicker?: () => void;
}

function Row({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border/40 pt-2">
      <div>
        <div className="text-ui-base font-semibold text-foreground">{label}</div>
        <p className="text-ui-xs text-foreground-subtle">{hint}</p>
      </div>
      {children}
    </div>
  );
}

export function ZaicodeFancyZonesSettings({ onOpenPicker }: ZaicodeFancyZonesSettingsProps) {
  const settings = useZaicodeFancyZones();
  const layouts = fancyZoneLayouts(settings);

  return (
    <section className="border border-border bg-card p-4" data-zaicode-fancyzones-settings>
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-ui-lg text-foreground">Window zones (Ctrl+Q)</h2>
          <p className="mt-1 text-ui-xs text-foreground-subtle">
            FastPrompter&apos;s zone picker: a small map under the pointer. Quarters, Columns and your own Presets;
            Tab switches pages, 1-9 / 0 snaps, S saves this window, Del removes a preset, Esc / Q closes. Works on any
            keyboard layout.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onOpenPicker ? (
            <Button size="sm" variant="outline" onClick={onOpenPicker}>
              Open picker
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => void cycleFastFancyZone(1)}>
            Snap next zone
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2 font-mono">
        <Row label="Ctrl+Q hotkey" hint="Off: Ctrl+Q is left alone for other apps and editors.">
          <Switch checked={settings.enabled} onCheckedChange={(enabled) => writeZaicodeFancyZonesSettings({ enabled })} />
        </Row>
        <Row label="Page" hint="Remembered page: where the picker opens and what fast mode walks through.">
          <div className="flex gap-px">
            {layouts.map((layout) => (
              <button
                key={layout.id}
                type="button"
                className={cn(
                  "border px-2 py-0.5 text-ui-xs",
                  layout.id === settings.layoutId
                    ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
                    : "border-border text-foreground-subtle hover:text-foreground",
                )}
                onClick={() => writeZaicodeFancyZonesSettings({ layoutId: layout.id, fastIndex: -1 })}
              >
                {layout.name} ({layout.zones.length})
              </button>
            ))}
          </div>
        </Row>
        <Row label="Fast mode" hint="Ctrl+Q moves straight to the next zone of the page, no picker.">
          <Switch checked={settings.fastMode} onCheckedChange={(fastMode) => writeZaicodeFancyZonesSettings({ fastMode })} />
        </Row>
        <Row label="Snap sound cue" hint="Plays the Window → Snap sound (Settings → Sounds) when the window lands.">
          <Switch
            checked={settings.soundEnabled}
            onCheckedChange={(soundEnabled) => writeZaicodeFancyZonesSettings({ soundEnabled })}
          />
        </Row>
        <Row label="Presets page" hint={`Your saved window places (position, size, maximized), up to ${FANCYZONE_MAX_PRESETS}.`}>
          <Switch
            checked={settings.presetsEnabled}
            onCheckedChange={(presetsEnabled) => writeZaicodeFancyZonesSettings({ presetsEnabled })}
          />
        </Row>
        {settings.presetsEnabled ? (
          <div className="flex flex-col gap-1 border-t border-border/40 pt-2 text-ui-xs">
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void saveCurrentWindowAsFancyPreset()}>
                Save this window as a preset
              </Button>
              <span className="text-foreground-subtlest">
                {settings.presets.length}/{FANCYZONE_MAX_PRESETS}
              </span>
            </div>
            {settings.presets.map((preset, index) => (
              <div key={index} className="flex items-center gap-2">
                <button
                  type="button"
                  className="border border-border px-1.5 hover:bg-hover"
                  onClick={() => void applyFancyZone(preset)}
                  title="Apply now"
                >
                  {index === 9 ? 0 : index + 1}
                </button>
                <span className="tabular-nums text-foreground-subtle">
                  {preset.state === "maximized"
                    ? "maximized"
                    : `${Math.round(preset.fx * 100)}%,${Math.round(preset.fy * 100)}% · ${Math.round(preset.fw * 100)}×${Math.round(preset.fh * 100)}%`}
                </span>
                <button
                  type="button"
                  className="ml-auto flex size-5 items-center justify-center text-foreground-subtlest hover:text-foreground"
                  title="Remove preset"
                  onClick={() => deleteFancyPreset(index)}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
