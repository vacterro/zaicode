import { useRef, useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import {
  ZAICODE_ICON_PRESETS,
  ZAICODE_ICON_SLOT_IDS,
  ZaicodeIcon,
  applyZaicodeIconOverrides,
  buildZaicodeIconBadgeDataUri,
  deleteZaicodeIconProfile,
  readZaicodeIconProfiles,
  resetZaicodeIconOverrides,
  saveZaicodeIconProfile,
  setZaicodeIconOverride,
  useZaicodeIconOverrides,
  type ZaicodeIconSlot,
} from "./zaicodeIconSlots.js";

/**
 * Icon workshop (SRC-051): every swappable icon in one place — grouped by
 * block, with a text/URL override per slot, a small badge designer (solid
 * colour or gradient + initials), preset packs, named profiles and
 * import/export of the whole table. Each change applies live.
 */

const GROUP_LABELS: Readonly<Record<string, string>> = {
  nav: "Navigation",
  workspace: "Workspace",
  todo: "Todo list",
  roster: "Agent roster",
  pool: "Pools",
  footer: "Footer",
  profile: "Profiles",
};

function groupOf(slot: ZaicodeIconSlot): string {
  return slot.split(".")[0] ?? "other";
}

/** The per-slot badge designer: colours / gradient / initials (SRC-051 worker-icon mini-editor, any slot). */
function BadgeDesigner({ slot, onClose }: { slot: ZaicodeIconSlot; onClose: () => void }) {
  const [from, setFrom] = useState("#c8a028");
  const [to, setTo] = useState("#8a6a10");
  const [gradient, setGradient] = useState(true);
  const [glyph, setGlyph] = useState(slot.split(".")[1]?.[0]?.toUpperCase() ?? "");
  const preview = buildZaicodeIconBadgeDataUri({ from, to, gradient, glyph });
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 border border-border bg-background p-2" data-zaicode-badge-designer={slot}>
      <img src={preview} alt="" aria-hidden className="size-4 shrink-0 [image-rendering:pixelated]" />
      <label className="flex items-center gap-1 text-foreground-subtle">
        Colour
        <input type="color" value={from} onChange={(event) => setFrom(event.target.value)} className="size-5 border border-border bg-card" />
      </label>
      <label className="flex items-center gap-1 text-foreground-subtle">
        to
        <input type="color" value={to} onChange={(event) => setTo(event.target.value)} className="size-5 border border-border bg-card" disabled={!gradient} />
      </label>
      <label className="flex items-center gap-1 text-foreground-subtle">
        <input type="checkbox" checked={gradient} onChange={(event) => setGradient(event.target.checked)} />
        gradient
      </label>
      <label className="flex items-center gap-1 text-foreground-subtle">
        Initials
        <input
          type="text"
          value={glyph}
          maxLength={2}
          onChange={(event) => setGlyph(event.target.value)}
          className="w-10 border border-border bg-card px-1 text-foreground"
        />
      </label>
      <Button size="sm" variant="outline" onClick={() => { setZaicodeIconOverride(slot, preview); onClose(); }}>
        Apply badge
      </Button>
      <Button size="sm" variant="ghost" onClick={onClose}>
        Cancel
      </Button>
    </div>
  );
}

function SlotRow({ slot }: { slot: ZaicodeIconSlot }) {
  const overrides = useZaicodeIconOverrides();
  const [designing, setDesigning] = useState(false);
  return (
    <div className="flex flex-col">
      <label className="flex items-center gap-2">
        <ZaicodeIcon slot={slot} />
        <span className="w-32 shrink-0 truncate text-ui-xs text-foreground-subtle">{slot}</span>
        <Input
          value={overrides[slot] ?? ""}
          placeholder="image URL, data: URI or short text"
          onChange={(event) => setZaicodeIconOverride(slot, event.target.value)}
        />
        <Button size="sm" variant="ghost" className="shrink-0" aria-expanded={designing} onClick={() => setDesigning((value) => !value)}>
          Design…
        </Button>
      </label>
      {designing ? <BadgeDesigner slot={slot} onClose={() => setDesigning(false)} /> : null}
    </div>
  );
}

function ImportExport() {
  const overrides = useZaicodeIconOverrides();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const payload = JSON.stringify({ kind: "zaicode-icon-overrides", version: 1, overrides }, null, 2);
  const exportFile = () => {
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "zaicode-icons.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const copyTable = async () => {
    try {
      await navigator.clipboard.writeText(payload);
      toast("Icon table copied to the clipboard.");
    } catch {
      toast("The clipboard refused; use Export file instead.");
    }
  };
  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    void file
      .text()
      .then((content) => setText(content))
      .catch(() => toast("That file could not be read."));
    event.target.value = "";
  };
  const importTable = () => {
    try {
      const parsed: unknown = JSON.parse(text);
      const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      const table =
        record && record.overrides && typeof record.overrides === "object"
          ? (record.overrides as Record<string, string>)
          : (record as Record<string, string> | null);
      if (!table || typeof table !== "object") throw new Error("bad shape");
      applyZaicodeIconOverrides(table);
      toast("Icon table imported.");
      setOpen(false);
    } catch {
      toast("That is not an icon table (expected the exported JSON).");
    }
  };
  return (
    <div className="flex flex-col gap-1" data-zaicode-icon-io>
      <div className="flex flex-wrap items-center gap-1">
        <Button size="sm" variant="outline" onClick={exportFile}>Export file</Button>
        <Button size="sm" variant="outline" onClick={() => void copyTable()}>Copy JSON</Button>
        <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen((value) => !value)}>Import…</Button>
      </div>
      {open ? (
        <div className="flex flex-col gap-1 border border-border bg-background p-2">
          <div className="flex items-center gap-2">
            <input ref={fileRef} type="file" accept="application/json,.json" onChange={onFile} className="text-ui-xs text-foreground-subtle" />
            <Button size="sm" variant="outline" onClick={importTable} disabled={!text.trim()}>Import</Button>
          </div>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="…or paste an exported icon table here"
            className="h-20 border border-border bg-card px-1 py-0.5 font-mono text-ui-xs text-foreground"
          />
        </div>
      ) : null}
    </div>
  );
}

function Profiles() {
  const overrides = useZaicodeIconOverrides();
  const [profiles, setProfiles] = useState(readZaicodeIconProfiles);
  const [name, setName] = useState("");
  const refresh = () => setProfiles(readZaicodeIconProfiles());
  return (
    <div className="flex flex-col gap-1" data-zaicode-icon-profiles>
      <div className="flex flex-wrap items-center gap-1">
        <Input
          value={name}
          placeholder="Profile name"
          onChange={(event) => setName(event.target.value)}
          className="w-36"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            saveZaicodeIconProfile(name, overrides);
            setName("");
            refresh();
          }}
        >
          Save current
        </Button>
      </div>
      {profiles.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {profiles.map((profile) => (
            <span key={profile.id} className="flex items-center gap-px border border-border">
              <button
                type="button"
                className="px-1.5 leading-5 text-foreground-subtle hover:bg-hover hover:text-foreground"
                title={`${Object.keys(profile.overrides).length} icon(s) saved ${profile.savedAt ? new Date(profile.savedAt).toLocaleString() : ""}`}
                onClick={() => applyZaicodeIconOverrides(profile.overrides)}
              >
                {profile.name}
              </button>
              <button
                type="button"
                aria-label={`Delete profile ${profile.name}`}
                className="px-1 leading-5 text-foreground-subtlest hover:bg-hover hover:text-foreground"
                onClick={() => {
                  deleteZaicodeIconProfile(profile.id);
                  refresh();
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ZaicodeIconEditor({ onClose }: { onClose: () => void }) {
  const { intl } = useZCodeIntl();
  const overrides = useZaicodeIconOverrides();
  const groups = [...new Set(ZAICODE_ICON_SLOT_IDS.map(groupOf))];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <span className="text-ui-xs font-medium uppercase tracking-wide text-foreground-subtle">
          {intl.formatMessage({ id: "zaicode.icons.title" })}
        </span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={resetZaicodeIconOverrides}>
            {intl.formatMessage({ id: "zaicode.icons.reset" })}
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>
            {intl.formatMessage({ id: "zaicode.action.close" })}
          </Button>
        </div>
      </div>
      <p className="shrink-0 px-3 pt-2 text-ui-xs text-foreground-subtlest">
        {intl.formatMessage({ id: "zaicode.icons.hint" })}
      </p>
      <div className="flex flex-wrap items-start gap-4 border-b border-border px-3 py-2">
        <div className="flex flex-col gap-1" data-zaicode-icon-presets>
          <span className="text-ui-xs text-foreground-subtle">Presets</span>
          <div className="flex flex-wrap gap-1">
            {ZAICODE_ICON_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                title={preset.hint}
                className={cn(
                  "border border-border px-1.5 leading-5 text-foreground-subtle hover:bg-hover hover:text-foreground",
                  preset.id !== "reset" &&
                    Object.keys(preset.overrides).length === Object.keys(overrides).length &&
                    Object.entries(preset.overrides).every(([slot, value]) => overrides[slot as ZaicodeIconSlot] === value)
                    ? "border-[var(--zaicode-highlight,var(--color-border-hover))] text-foreground"
                    : "",
                )}
                onClick={() => applyZaicodeIconOverrides(preset.overrides)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
        <Profiles />
        <ImportExport />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {groups.map((group) => (
          <div key={group} className="flex flex-col gap-1" data-zaicode-icon-group={group}>
            <span className="text-ui-xs font-medium uppercase tracking-wide text-foreground-subtlest">
              {GROUP_LABELS[group] ?? group}
            </span>
            {ZAICODE_ICON_SLOT_IDS.filter((slot) => groupOf(slot) === group).map((slot) => (
              <SlotRow key={slot} slot={slot} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
