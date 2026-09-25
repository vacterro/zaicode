import { useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  ArrowLeftRight,
  BatteryCharging,
  Check,
  Clock,
  Copy,
  Cpu,
  Dot,
  FolderOpen,
  Grid3x3,
  Hand,
  HelpCircle,
  Keyboard,
  List,
  Mail,
  Move,
  Pencil,
  Pin,
  Play,
  Plus,
  RefreshCw,
  Save,
  Send,
  Settings,
  Square,
  Star,
  StepForward,
  ToggleLeft,
  Undo2,
  Upload,
  Wrench,
  X,
  ChevronsDownUp,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { ZaicodeSoundPicker } from "@/zaicode/ZaicodeSoundPicker.js";
import { ZaicodeAmbienceCompact, ZaicodeProblipPanel } from "@/zaicode/ZaicodeAudioPanels.js";
import {
  ZAICODE_SOUND_EVENTS,
  ZAICODE_SOUND_GAIN_MAX,
  ZAICODE_SOUND_GAIN_MIN,
  importZaicodeSoundFile,
  playZaicodeSound,
  readZaicodeCustomSoundNames,
  resetZaicodeSoundSettings,
  setAllZaicodeSoundEvents,
  setZaicodeSoundEvent,
  setZaicodeSoundSettings,
  stopAllZaicodeSounds,
  useZaicodeSoundSettings,
  zaicodeSoundDiagnostics,
  type ZaicodeSoundEventDef,
} from "@/zaicode/zaicodeSoundEvents.js";

const GLYPHS: Record<string, LucideIcon> = {
  check: Check,
  cross: X,
  question: HelpCircle,
  hand: Hand,
  dot: Dot,
  play: Play,
  plus: Plus,
  swap: ArrowLeftRight,
  box: Archive,
  undo: Undo2,
  pen: Pencil,
  pin: Pin,
  send: Send,
  step: StepForward,
  grid: Grid3x3,
  folder: FolderOpen,
  move: Move,
  list: List,
  fold: ChevronsDownUp,
  save: Save,
  engine: Cpu,
  wrench: Wrench,
  battery: BatteryCharging,
  warn: AlertTriangle,
  refresh: RefreshCw,
  clock: Clock,
  mail: Mail,
  gear: Settings,
  copy: Copy,
  key: Keyboard,
  toggle: ToggleLeft,
  star: Star,
};

function formatDb(value: number): string {
  const rounded = Math.round(value * 2) / 2;
  return `${rounded > 0 ? "+" : ""}${rounded} dB`;
}

/**
 * FastPrompter's Sound Settings for ZAICODE: every action one row — on/off,
 * sound (type to filter the whole library), your own file, mix/cut, gain in
 * dB relative to the master volume (double-click = 0 dB) and a preview.
 */
export function ZaicodeSoundSettings() {
  const settings = useZaicodeSoundSettings();
  const [filter, setFilter] = useState("");
  const [customNames, setCustomNames] = useState(() => readZaicodeCustomSoundNames());
  const importTarget = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const needle = filter.trim().toLowerCase();
  const rows = ZAICODE_SOUND_EVENTS.filter(
    (event) =>
      !needle ||
      event.label.toLowerCase().includes(needle) ||
      event.group.toLowerCase().includes(needle) ||
      event.id.includes(needle) ||
      (settings.events[event.id]?.sound ?? "").toLowerCase().includes(needle),
  );
  const groups = [...new Set(rows.map((row) => row.group))];

  return (
    <div className="flex flex-col gap-3" data-zaicode-sound-settings>
      <section className="border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-3 text-ui-xs">
          <span className="text-ui-lg text-foreground">Sounds</span>
          <span className="text-foreground-subtle">
            Every action has its own row. Gain is relative to the master volume: 0 dB = master.
          </span>
        </div>
        <div className="mt-2 grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 text-ui-xs">
          <span className="text-foreground-subtle">Master volume</span>
          <input
            type="range"
            min={0}
            max={100}
            value={settings.masterVolume}
            onChange={(event) => setZaicodeSoundSettings({ masterVolume: Number(event.target.value) })}
          />
          <span className="w-10 text-right tabular-nums text-foreground">{settings.masterVolume}%</span>
          <span className="text-foreground-subtle">Mute everything</span>
          <Switch checked={settings.muted} onCheckedChange={(muted) => setZaicodeSoundSettings({ muted })} />
          <span />
          <span className="text-foreground-subtle">Also while ZAICODE is focused</span>
          <Switch
            checked={settings.whenFocused}
            onCheckedChange={(whenFocused) => setZaicodeSoundSettings({ whenFocused })}
          />
          <span />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={stopAllZaicodeSounds}>
            <Square className="size-3.5" />
            STOP ALL SOUNDS
          </Button>
          <Button size="sm" variant="outline" onClick={() => setAllZaicodeSoundEvents(true)}>
            Enable all
          </Button>
          <Button size="sm" variant="outline" onClick={() => setAllZaicodeSoundEvents(false)}>
            Disable all
          </Button>
          <Button size="sm" variant="outline" onClick={resetZaicodeSoundSettings}>
            Reset to defaults
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void navigator.clipboard
                .writeText(zaicodeSoundDiagnostics())
                .then(() => toast("Sound diagnostics copied."))
            }
          >
            <Copy className="size-3.5" />
            Copy sound diagnostics
          </Button>
        </div>
      </section>

      <section className="border border-border bg-card p-3" data-zaicode-background-audio>
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-ui-lg text-foreground">Background</span>
          <span className="text-ui-xs text-foreground-subtle">
            Problip keeps a rhythm with a short cue; Ambience is a quiet loop only while agents work.
          </span>
        </div>
        <div className="mt-2 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="flex flex-col gap-1 border border-border p-2">
            <span className="text-ui-sm text-foreground">Problip</span>
            <ZaicodeProblipPanel />
          </div>
          <div className="flex flex-col gap-1 border border-border p-2">
            <span className="text-ui-sm text-foreground">Ambience</span>
            <ZaicodeAmbienceCompact />
          </div>
        </div>
      </section>

      <section className="border border-border bg-card p-2">
        <input
          className="mb-2 w-full border border-border bg-background px-2 py-1 text-ui-xs text-foreground"
          placeholder="Filter events…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <div className="grid grid-cols-[18px_minmax(120px,1.2fr)_28px_minmax(120px,1fr)_22px_58px_minmax(110px,1fr)_52px_22px] items-center gap-x-1.5 gap-y-1 text-ui-xs">
          <span />
          <span className="text-foreground-subtlest">Event</span>
          <span className="text-center text-foreground-subtlest">On</span>
          <span className="text-foreground-subtlest">Sound</span>
          <span />
          <span className="text-foreground-subtlest">Mode</span>
          <span className="text-foreground-subtlest">Gain</span>
          <span />
          <span />
          {groups.map((group) => (
            <SoundGroup
              key={group}
              group={group}
              rows={rows.filter((row) => row.group === group)}
              settings={settings}
              customNames={customNames}
              onImport={(id) => {
                importTarget.current = id;
                fileInput.current?.click();
              }}
            />
          ))}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".wav,.mp3,.ogg,audio/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            const id = importTarget.current;
            event.target.value = "";
            if (!file || !id) return;
            void importZaicodeSoundFile(id, file)
              .then(() => {
                setCustomNames(readZaicodeCustomSoundNames());
                playZaicodeSound(id, { preview: true });
              })
              .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error)));
          }}
        />
      </section>
    </div>
  );
}

function SoundGroup({
  group,
  rows,
  settings,
  customNames,
  onImport,
}: {
  group: string;
  rows: readonly ZaicodeSoundEventDef[];
  settings: ReturnType<typeof useZaicodeSoundSettings>;
  customNames: Record<string, string>;
  onImport: (id: string) => void;
}) {
  return (
    <>
      <span className="col-span-9 mt-1 border-b border-border/60 pb-0.5 font-semibold text-foreground-subtle">
        {group}
      </span>
      {rows.map((event) => {
        const row = settings.events[event.id]!;
        const Glyph = GLYPHS[event.glyph] ?? Dot;
        return (
          <SoundRow
            key={event.id}
            event={event}
            row={row}
            Glyph={Glyph}
            ownFileLabel={customNames[event.id] ?? null}
            onImport={onImport}
          />
        );
      })}
    </>
  );
}

function SoundRow({
  event,
  row,
  Glyph,
  ownFileLabel,
  onImport,
}: {
  event: ZaicodeSoundEventDef;
  row: { enabled: boolean; sound: string; gainDb: number; mode: "overlay" | "replace" };
  Glyph: LucideIcon;
  ownFileLabel: string | null;
  onImport: (id: string) => void;
}) {
  return (
    <>
      <Glyph className={cn("size-3.5", row.enabled ? "text-foreground-subtle" : "text-foreground-subtlest")} />
      <span className={cn("truncate", row.enabled ? "text-foreground" : "text-foreground-subtlest")} title={event.hint}>
        {event.label}
      </span>
      <input
        type="checkbox"
        className="mx-auto"
        checked={row.enabled}
        onChange={(change) => setZaicodeSoundEvent(event.id, { enabled: change.target.checked })}
        aria-label={`${event.label} on`}
      />
      <ZaicodeSoundPicker
        className="min-w-0"
        value={row.sound}
        allowDefault
        ownFileLabel={ownFileLabel}
        previewGainDb={row.gainDb}
        onImportOwn={() => onImport(event.id)}
        onChange={(sound) => {
          setZaicodeSoundEvent(event.id, { sound });
          playZaicodeSound(event.id, { preview: true, sound });
        }}
      />
      <button
        type="button"
        className="flex size-5 items-center justify-center border border-border text-foreground-subtle hover:bg-hover hover:text-foreground"
        title="Use your own WAV / MP3 / OGG for this event"
        onClick={() => onImport(event.id)}
      >
        <Upload className="size-3" />
      </button>
      <div className="flex gap-px">
        {(["overlay", "replace"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            title={mode === "overlay" ? "Mix: sounds may overlap" : "Cut: a new one stops this event's previous sound"}
            className={cn(
              "flex-1 border px-0.5 text-[10px]",
              row.mode === mode
                ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
                : "border-border text-foreground-subtlest hover:text-foreground",
            )}
            onClick={() => setZaicodeSoundEvent(event.id, { mode })}
          >
            {mode === "overlay" ? "mix" : "cut"}
          </button>
        ))}
      </div>
      <input
        type="range"
        min={ZAICODE_SOUND_GAIN_MIN}
        max={ZAICODE_SOUND_GAIN_MAX}
        step={0.5}
        value={row.gainDb}
        title="Double-click: 0 dB (= master volume)"
        onChange={(change) => setZaicodeSoundEvent(event.id, { gainDb: Number(change.target.value) })}
        onMouseUp={() => playZaicodeSound(event.id, { preview: true })}
        onDoubleClick={() => setZaicodeSoundEvent(event.id, { gainDb: 0 })}
      />
      <span className="text-right tabular-nums text-foreground-subtle">{formatDb(row.gainDb)}</span>
      <button
        type="button"
        className="flex size-5 items-center justify-center border border-border text-foreground-subtle hover:bg-hover hover:text-foreground"
        title="Preview at the real volume"
        onClick={() => playZaicodeSound(event.id, { preview: true })}
      >
        <Play className="size-3" />
      </button>
    </>
  );
}

