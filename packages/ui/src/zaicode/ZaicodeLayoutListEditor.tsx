import { useState } from "react";
import { ChevronDown, ChevronUp, GripVertical, Pencil } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { ZaicodeIcon, setZaicodeIconOverride, useZaicodeIconOverrides, type ZaicodeIconSlot } from "./zaicodeIconSlots.js";
import {
  ZAICODE_LAYOUT_LABEL_MAX,
  ZAICODE_LAYOUT_WHENS,
  normalizeZaicodeLayoutWhen,
  type ZaicodeLayoutWhen,
  moveZaicodeLayoutEntry,
  placeZaicodeLayoutEntry,
  useZaicodeLayout,
  ZAICODE_HEADER_TOOLS,
  ZAICODE_NAV_ITEMS,
  type ZaicodeLayoutEntry,
  type ZaicodeLayoutItemDef,
} from "./zaicodeLayoutPrefs.js";

/** T-134: which icon slot each button / line draws (a button looks the same in the header and the footer). */
const TOOL_ICON_SLOTS: Readonly<Record<string, ZaicodeIconSlot>> = {
  home: "tool.home",
  back: "tool.back",
  forward: "tool.forward",
  focusCycle: "tool.focusCycle",
  cycleArrows: "tool.next",
  menu: "tool.menu",
  search: "tool.search",
  newTask: "tool.newTask",
  timers: "tool.timers",
  help: "tool.help",
  mute: "tool.mute",
  palette: "tool.palette",
  workers: "tool.workers",
  dispatch: "tool.dispatch",
  settings: "tool.settings",
  problip: "tool.problip",
  protrail: "tool.protrail",
};
const FOOTER_ICON_SLOTS: Readonly<Record<string, ZaicodeIconSlot>> = { ...TOOL_ICON_SLOTS, settings: "footer.settings" };
const NAV_ICON_SLOTS: Readonly<Record<string, ZaicodeIconSlot>> = {
  saihome: "nav.saihome",
  zaicode: "nav.zaicode",
  scheduler: "nav.scheduler",
  search: "nav.search",
  plugins: "nav.plugins",
  timers: "nav.timers",
  help: "nav.help",
  workers: "nav.workers",
  settings: "nav.settings",
};

const WHEN_LABELS: Record<ZaicodeLayoutWhen, { label: string; hint: string }> = {
  always: { label: "always", hint: "Always on screen" },
  working: { label: "working", hint: "Only while at least one session works" },
  idle: { label: "idle", hint: "Only while nothing works" },
  hover: { label: "hover", hint: "Only while the pointer is over this row: a clean sidebar, every button one move away" },
};

/** The icon cell of a row: shows the element's icon; a click opens the inline field below. */
function IconCell({ slot, open, onToggle, label }: { slot: ZaicodeIconSlot; open: boolean; onToggle: () => void; label: string }) {
  const overridden = Boolean(useZaicodeIconOverrides()[slot]);
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={`Icon of ${label}`}
      title={overridden ? "Your own icon. Click to change or reset it." : "Click to give this one your own icon (emoji, picture URL or a badge in Settings -> Icons)"}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center border text-foreground-subtle hover:bg-hover hover:text-foreground",
        overridden ? "border-[var(--zaicode-highlight,var(--color-border-hover))]" : "border-transparent",
      )}
      onClick={onToggle}
    >
      <ZaicodeIcon slot={slot} className="size-3.5" />
    </button>
  );
}

function IconField({ slot, label }: { slot: ZaicodeIconSlot; label: string }) {
  const value = useZaicodeIconOverrides()[slot] ?? "";
  return (
    <div className="flex items-center gap-1 pb-1 pl-9" data-zaicode-layout-icon={slot}>
      <input
        autoFocus
        className="min-w-0 flex-1 border border-border bg-background px-1 text-foreground"
        placeholder="emoji, text or picture URL (empty = built-in)"
        aria-label={`Own icon for ${label}`}
        value={value}
        onChange={(event) => setZaicodeIconOverride(slot, event.target.value)}
      />
      {value ? (
        <button type="button" className="border border-border px-1 text-foreground-subtle hover:bg-hover" onClick={() => setZaicodeIconOverride(slot, "")}>
          built-in
        </button>
      ) : null}
    </div>
  );
}

/**
 * Edits one ordered list of buttons / menu lines: tick to show, drag the grip
 * (or ▲▼) to move, the icon to give it your own, "when" for the moments it
 * shows (T-134). Used in the right-click panels and in Settings -> Layout.
 */
export function ZaicodeLayoutListEditor<T extends string>({
  list,
  defs,
  onChange,
  onReset,
  renamable = false,
  iconSlots,
}: {
  list: readonly ZaicodeLayoutEntry<T>[];
  defs: readonly ZaicodeLayoutItemDef<T>[];
  onChange: (next: ZaicodeLayoutEntry<T>[]) => void;
  onReset: () => void;
  /** SRC-044: lines can carry the operator's own names (double-click or ✎). */
  renamable?: boolean;
  /** T-134: id -> icon slot, for the rows that draw one. */
  iconSlots?: Readonly<Record<string, ZaicodeIconSlot>>;
}) {
  const [dragging, setDragging] = useState<T | null>(null);
  const [iconOpen, setIconOpen] = useState<T | null>(null);
  const [renaming, setRenaming] = useState<T | null>(null);
  const rename = (id: T, text: string) => {
    const label = text.trim().slice(0, ZAICODE_LAYOUT_LABEL_MAX);
    onChange(
      list.map((item) => {
        if (item.id !== id) return item;
        const { label: _old, ...rest } = item;
        return label && label !== defOf(id)?.label ? { ...rest, label } : rest;
      }),
    );
    setRenaming(null);
  };
  const [over, setOver] = useState<number | null>(null);
  const defOf = (id: T) => defs.find((def) => def.id === id);
  return (
    <div className="flex flex-col gap-px text-ui-xs">
      {list.map((entry, index) => {
        const def = defOf(entry.id);
        if (!def) return null;
        const slot = iconSlots?.[entry.id] ?? null;
        const when = normalizeZaicodeLayoutWhen(entry.when);
        return (
          <div key={entry.id} className="flex flex-col">
          <div
            draggable
            onDragStart={(event) => {
              setDragging(entry.id);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              if (dragging === null) return;
              event.preventDefault();
              setOver(index);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging !== null) onChange(placeZaicodeLayoutEntry(list, dragging, index));
              setDragging(null);
              setOver(null);
            }}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
            }}
            className={cn(
              "flex items-center gap-1 border px-1 py-px",
              over === index && dragging !== null ? "border-[var(--zaicode-highlight,var(--color-border-hover))]" : "border-transparent",
              dragging === entry.id && "opacity-50",
            )}
            title={def.hint}
          >
            <GripVertical className="size-3 shrink-0 cursor-grab text-foreground-subtlest" />
            <input
              type="checkbox"
              checked={entry.visible}
              aria-label={`Show ${def.label}`}
              onChange={(event) =>
                onChange(list.map((item) => (item.id === entry.id ? { ...item, visible: event.target.checked } : item)))
              }
            />
            {slot ? (
              <IconCell slot={slot} label={def.label} open={iconOpen === entry.id} onToggle={() => setIconOpen(iconOpen === entry.id ? null : entry.id)} />
            ) : (
              <span className="size-5 shrink-0" />
            )}
            {renaming === entry.id ? (
              <input
                autoFocus
                className="min-w-0 flex-1 border border-border bg-background px-0.5 text-foreground"
                defaultValue={entry.label ?? def.label}
                maxLength={ZAICODE_LAYOUT_LABEL_MAX}
                aria-label={`Name of ${def.label}`}
                onBlur={(event) => rename(entry.id, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") rename(entry.id, event.currentTarget.value);
                  if (event.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <span
                className={cn("min-w-0 flex-1 truncate", entry.visible ? "text-foreground" : "text-foreground-subtlest")}
                title={entry.label ? `${entry.label} (built-in name: ${def.label})` : def.hint}
                onDoubleClick={renamable ? () => setRenaming(entry.id) : undefined}
              >
                {entry.label ?? def.label}
              </span>
            )}
            {renamable && renaming !== entry.id ? (
              <button
                type="button"
                aria-label={`Rename ${def.label}`}
                title="Rename (empty = the built-in name)"
                className="flex size-4 items-center justify-center text-foreground-subtle hover:bg-hover"
                onClick={() => setRenaming(entry.id)}
              >
                <Pencil className="size-3" />
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Move up"
              disabled={index === 0}
              className="flex size-4 items-center justify-center text-foreground-subtle hover:bg-hover disabled:opacity-30"
              onClick={() => onChange(moveZaicodeLayoutEntry(list, entry.id, -1))}
            >
              <ChevronUp className="size-3" />
            </button>
            <button
              type="button"
              aria-label="Move down"
              disabled={index === list.length - 1}
              className="flex size-4 items-center justify-center text-foreground-subtle hover:bg-hover disabled:opacity-30"
              onClick={() => onChange(moveZaicodeLayoutEntry(list, entry.id, 1))}
            >
              <ChevronDown className="size-3" />
            </button>
            <select
              className={cn(
                "shrink-0 border bg-background px-0.5 text-[10px]",
                when === "always" ? "border-border text-foreground-subtlest" : "border-[var(--zaicode-highlight,var(--color-border-hover))] text-foreground",
              )}
              value={when}
              aria-label={`When ${def.label} shows`}
              title={`When it shows: ${WHEN_LABELS[when].hint}`}
              onChange={(event) => {
                const next = normalizeZaicodeLayoutWhen(event.target.value);
                onChange(
                  list.map((item) => {
                    if (item.id !== entry.id) return item;
                    const { when: _old, ...rest } = item;
                    return next === "always" ? rest : { ...rest, when: next };
                  }),
                );
              }}
            >
              {ZAICODE_LAYOUT_WHENS.map((value) => (
                <option key={value} value={value} title={WHEN_LABELS[value].hint}>
                  {WHEN_LABELS[value].label}
                </option>
              ))}
            </select>
          </div>
          {slot && iconOpen === entry.id ? <IconField slot={slot} label={def.label} /> : null}
          </div>
        );
      })}
      <div className="mt-1 flex justify-between gap-2 text-foreground-subtlest">
        <span>Tick = shown · drag or ▲▼ = order · icon = your own · when = the moments it shows{renamable ? " · double-click = rename" : ""}</span>
        <button type="button" className="border border-border px-1 text-foreground-subtle hover:bg-hover" onClick={onReset}>
          Defaults
        </button>
      </div>
    </div>
  );
}

export function ZaicodeHeaderToolsEditor() {
  const layout = useZaicodeLayout();
  return (
    <ZaicodeLayoutListEditor
      list={layout.headerTools}
      defs={ZAICODE_HEADER_TOOLS}
      onChange={layout.setHeaderTools}
      onReset={layout.resetHeaderTools}
      iconSlots={TOOL_ICON_SLOTS}
    />
  );
}

export function ZaicodeNavItemsEditor() {
  const layout = useZaicodeLayout();
  return (
    <ZaicodeLayoutListEditor
      list={layout.navItems}
      defs={ZAICODE_NAV_ITEMS}
      onChange={layout.setNavItems}
      onReset={layout.resetNavItems}
      renamable
      iconSlots={NAV_ICON_SLOTS}
    />
  );
}

/** The footer list uses the same row editor; its gear draws the footer's own slot. */
export const ZAICODE_FOOTER_ICON_SLOTS = FOOTER_ICON_SLOTS;
