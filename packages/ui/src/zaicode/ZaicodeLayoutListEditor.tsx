import { useState } from "react";
import { ChevronDown, ChevronUp, GripVertical, Pencil } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  ZAICODE_LAYOUT_LABEL_MAX,
  moveZaicodeLayoutEntry,
  placeZaicodeLayoutEntry,
  useZaicodeLayout,
  ZAICODE_HEADER_TOOLS,
  ZAICODE_NAV_ITEMS,
  type ZaicodeLayoutEntry,
  type ZaicodeLayoutItemDef,
} from "./zaicodeLayoutPrefs.js";

/**
 * Edits one ordered list of buttons / menu lines: tick to show, drag the grip
 * (or ▲▼) to move. Used in the right-click panels and in Settings -> Layout.
 */
export function ZaicodeLayoutListEditor<T extends string>({
  list,
  defs,
  onChange,
  onReset,
  renamable = false,
}: {
  list: readonly ZaicodeLayoutEntry<T>[];
  defs: readonly ZaicodeLayoutItemDef<T>[];
  onChange: (next: ZaicodeLayoutEntry<T>[]) => void;
  onReset: () => void;
  /** SRC-044: lines can carry the operator's own names (double-click or ✎). */
  renamable?: boolean;
}) {
  const [dragging, setDragging] = useState<T | null>(null);
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
        return (
          <div
            key={entry.id}
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
          </div>
        );
      })}
      <div className="mt-1 flex justify-between gap-2 text-foreground-subtlest">
        <span>Tick = shown · drag or ▲▼ = order{renamable ? " · double-click = rename" : ""}</span>
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
    />
  );
}
