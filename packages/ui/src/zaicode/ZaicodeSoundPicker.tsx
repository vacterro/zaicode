/* eslint-disable max-lines -- the picker, its list and its audition keys share one popover state; splitting them would scatter that state. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, Play, Square, Star, Upload } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import {
  formatZaicodeSoundLength,
  listZaicodeSoundCatalog,
  zaicodeSoundDisplayName,
  zaicodeSoundEntry,
  ZAICODE_SOUND_KINDS,
  type ZaicodeSoundEntry,
  type ZaicodeSoundKind,
} from "./zaicodeSoundCatalog.js";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import { playZaicodeSoundFile, stopZaicodeSoundChannel } from "./zaicodeSoundEvents.js";
import {
  dragZaicodeSoundTabs,
  nextZaicodeSoundTabs,
  zaicodeSoundInTabs,
  type ZaicodeSoundTab,
} from "./zaicodeSoundTabs.js";

/**
 * Sound picker: the library sorted by kind and length instead of one
 * alphabetical wall. A click on a row plays it (that is the test); the mouse
 * wheel and the arrow keys step through the list and play while "listen" is
 * on. Hovering never plays and never scrolls. Double-click, Enter or "use"
 * picks. Shift+wheel over the CLOSED picker steps the selection itself, like
 * FastPrompter's sound combo; a plain wheel keeps scrolling the page.
 * Favourites (★) and a 10-slot quick bar sit on top; right-click a quick slot
 * to store the current sound there.
 */

const PREVIEW_CHANNEL = "picker";
const PREFS_KEY = "zaicode-sound-picker-v1";
const PREFS_EVENT = "zaicode-sound-picker-changed";
const MAX_ROWS = 400;

interface PickerPrefs {
  audition: boolean;
  favorites: string[];
  quick: string[];
  /** A multi-tab choice (Shift / Ctrl / drag) is remembered and comes back next time. */
  tabs: ZaicodeSoundTab[];
}

const fp = (file: string) => `fastprompter:${file}`;
const DEFAULT_QUICK = ["NEWDAY.wav", "NEWMONTH.wav", "NEWWEEK.wav", "NOMAD.wav", "OBELISK.wav", "GENIE.wav", "PICKUP01.wav", "QUEST.wav", "ROGUE.wav", "tick_on.wav"].map(fp);

let prefsCache: PickerPrefs | null = null;

function readPrefs(): PickerPrefs {
  if (prefsCache) return prefsCache;
  let raw: Partial<PickerPrefs> = {};
  try {
    raw = (JSON.parse(readZaicodeSetting(PREFS_KEY) ?? "null") as Partial<PickerPrefs> | null) ?? {};
  } catch {
    raw = {};
  }
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : null);
  const quick = strings(raw.quick);
  prefsCache = {
    audition: raw.audition !== false,
    favorites: strings(raw.favorites) ?? [],
    quick: quick && quick.length === 10 ? quick : DEFAULT_QUICK,
    tabs: (strings(raw.tabs) ?? []) as ZaicodeSoundTab[],
  };
  return prefsCache;
}

function writePrefs(patch: Partial<PickerPrefs>): void {
  prefsCache = { ...readPrefs(), ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefsCache));
  } catch {
    // this session only
  }
  window.dispatchEvent(new Event(PREFS_EVENT));
}

function usePickerPrefs(): PickerPrefs {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener(PREFS_EVENT, listener);
      return () => window.removeEventListener(PREFS_EVENT, listener);
    },
    readPrefs,
    readPrefs,
  );
}

type Tab = ZaicodeSoundTab;

/** React wheel listeners are passive; stepping through sounds must cancel the page scroll. */
function useWheelStep(
  element: HTMLElement | null,
  onStep: ((direction: 1 | -1) => void) | null,
  options: { requireShift?: boolean } = {},
) {
  const handler = useRef(onStep);
  handler.current = onStep;
  const requireShift = Boolean(options.requireShift);
  useEffect(() => {
    if (!element) return;
    const listener = (event: WheelEvent) => {
      // Shift+wheel is horizontal on some mice: read whichever axis moved.
      const delta = event.deltaY || event.deltaX;
      if (!handler.current || delta === 0) return;
      // A closed picker in a scrolling page steps only with Shift; a plain wheel keeps scrolling the page.
      if (requireShift && !event.shiftKey) return;
      event.preventDefault();
      handler.current(delta > 0 ? 1 : -1);
    };
    element.addEventListener("wheel", listener, { passive: false });
    return () => element.removeEventListener("wheel", listener);
  }, [element, requireShift]);
}

export interface ZaicodeSoundPickerProps {
  value: string;
  onChange: (sound: string) => void;
  /** Preview loudness, 0..1 (timers) ... */
  previewVolume?: number;
  /** ... or dB relative to master (event rows). */
  previewGainDb?: number;
  /** Offer the stock "notification pop" as the first entry. */
  allowDefault?: boolean;
  /** Label for an own file already chosen for this row. */
  ownFileLabel?: string | null;
  /** Shows "Own file…" at the bottom of the list. */
  onImportOwn?: () => void;
  className?: string;
  disabled?: boolean;
  /** Tab to open on when the current sound has no kind (e.g. ambience pickers). */
  preferKind?: ZaicodeSoundKind;
}

function previewSound(sound: string, props: Pick<ZaicodeSoundPickerProps, "previewVolume" | "previewGainDb">) {
  void playZaicodeSoundFile(sound, {
    preview: true,
    channel: PREVIEW_CHANNEL,
    ...(props.previewVolume !== undefined ? { volume: props.previewVolume } : {}),
    ...(props.previewGainDb !== undefined ? { gainDb: props.previewGainDb } : {}),
  });
}

export function ZaicodeSoundPicker(props: ZaicodeSoundPickerProps) {
  const { value, onChange, allowDefault, ownFileLabel, onImportOwn, className, disabled, preferKind } = props;
  const [open, setOpen] = useState(false);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const catalog = listZaicodeSoundCatalog();
  const current = zaicodeSoundEntry(value);
  const label = value.startsWith("custom:")
    ? `★ ${ownFileLabel ?? "own file"}`
    : value === "default"
      ? "(notification pop)"
      : zaicodeSoundDisplayName(value);

  /** Shift+wheel over the closed picker: next / previous sound of the same kind, played at once. */
  const stepClosed = (direction: 1 | -1) => {
    const kind = current?.kind ?? preferKind ?? "alert";
    const list = catalog.filter((entry) => entry.kind === kind);
    if (list.length === 0) return;
    const index = list.findIndex((entry) => entry.id === value);
    const next = list[(index + direction + list.length) % list.length]!;
    onChange(next.id);
    previewSound(next.id, props);
  };
  useWheelStep(trigger, disabled || open ? null : stepClosed, { requireShift: true });

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) stopZaicodeSoundChannel(PREVIEW_CHANNEL);
      }}
    >
      <PopoverTrigger asChild disabled={disabled}>
        <button
          ref={setTrigger}
          type="button"
          className={cn(
            "flex min-w-0 items-center gap-1 border border-border bg-background px-1 py-0.5 text-left text-ui-xs text-foreground hover:border-[var(--zaicode-highlight,var(--color-border-hover))]",
            disabled && "opacity-50",
            className,
          )}
          title={`${value}\nShift+wheel: previous / next sound of this kind (plays it). Click: browse and listen.`}
          data-zaicode-sound-picker
        >
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {current ? (
            <span className="shrink-0 text-[10px] tabular-nums text-foreground-subtlest">
              {formatZaicodeSoundLength(current.seconds)}
            </span>
          ) : null}
          <ChevronDown className="size-3 shrink-0 text-foreground-subtle" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={6}
        className="max-h-[var(--radix-popover-content-available-height)] w-[380px] gap-1.5 rounded-none border border-[var(--zaicode-highlight,var(--color-border))] p-1.5 text-ui-xs"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {open ? (
          <PickerBody
            {...props}
            current={current}
            onPick={(sound) => {
              onChange(sound);
              setOpen(false);
              stopZaicodeSoundChannel(PREVIEW_CHANNEL);
            }}
            allowDefault={Boolean(allowDefault)}
            {...(onImportOwn
              ? {
                  onImportOwn: () => {
                    setOpen(false);
                    onImportOwn();
                  },
                }
              : {})}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function PickerBody(
  props: ZaicodeSoundPickerProps & {
    current: ZaicodeSoundEntry | undefined;
    onPick: (sound: string) => void;
    allowDefault: boolean;
  },
) {
  const { value, current, onPick, allowDefault, onImportOwn, preferKind } = props;
  const prefs = usePickerPrefs();
  const catalog = listZaicodeSoundCatalog();
  const [tabs, setTabs] = useState<Tab[]>(() =>
    prefs.tabs.length > 1 ? prefs.tabs : [current?.kind ?? preferKind ?? "all"],
  );
  const selectTabs = (next: Tab[]) => {
    setTabs(next);
    writePrefs({ tabs: next.length > 1 ? next : [] });
  };
  // Press on a tab and drag across others: they all join (released anywhere).
  const dragging = useRef(false);
  useEffect(() => {
    const stop = () => {
      dragging.current = false;
    };
    window.addEventListener("pointerup", stop);
    return () => window.removeEventListener("pointerup", stop);
  }, []);
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Only keyboard / wheel moves scroll the list; a pointer never moves the list under itself.
  const scrollToCursor = useRef(true);

  const counts = useMemo(() => {
    const byKind = new Map<string, number>();
    for (const entry of catalog) byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + 1);
    return byKind;
  }, [catalog]);

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const favorites = new Set(prefs.favorites);
    const list = catalog.filter((entry) => {
      if (!zaicodeSoundInTabs(entry, tabs, favorites)) return false;
      return !needle || entry.name.toLowerCase().includes(needle) || entry.folder.toLowerCase().includes(needle);
    });
    return list;
  }, [catalog, filter, prefs.favorites, tabs]);

  const shown = rows.slice(0, MAX_ROWS);
  const defaultRow = allowDefault && tabs.includes("all") && !filter.trim();
  const ids = [...(defaultRow ? ["default"] : []), ...shown.map((entry) => entry.id)];

  useEffect(() => {
    const index = ids.indexOf(value);
    scrollToCursor.current = true;
    setCursor(index >= 0 ? index : 0);
    // only when the list itself changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.join(" "), filter]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!scrollToCursor.current) return;
    listRef.current?.querySelector(`[data-row="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  /** Wheel and arrows listen while "listen" is on; a click always plays (that is the test). */
  const audition = (index: number, force = false) => {
    const id = ids[index];
    if (!id || id === "default" || (!force && !prefs.audition)) return;
    previewSound(id, props);
  };

  const move = (delta: number) => {
    if (ids.length === 0) return;
    const next = Math.max(0, Math.min(ids.length - 1, cursor + delta));
    scrollToCursor.current = true;
    setCursor(next);
    audition(next);
  };

  // Wheel = listen through the list one sound per notch (plain scrolling while "listen" is off).
  useWheelStep(listElement, prefs.audition ? (direction) => move(direction) : null);

  const toggleFavorite = (id: string) => {
    const favorites = new Set(prefs.favorites);
    if (favorites.has(id)) favorites.delete(id);
    else favorites.add(id);
    writePrefs({ favorites: [...favorites] });
  };

  /** Clicks inside the picker never take the caret or the selection out of the search box. */
  const keepSearchFocus = (event: { preventDefault: () => void }) => {
    if (document.activeElement === searchRef.current) event.preventDefault();
  };

  const tabList: { id: Tab; label: string; hint: string; count: number }[] = [
    { id: "all", label: "All", hint: "Every sound", count: catalog.length },
    { id: "favorites", label: "★", hint: "Your favourites (click the star on a row)", count: prefs.favorites.length },
    ...ZAICODE_SOUND_KINDS.map((kind) => ({ ...kind, count: counts.get(kind.id) ?? 0 })),
  ];

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-1.5"
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          move(-1);
        } else if (event.key === "PageDown") {
          event.preventDefault();
          move(10);
        } else if (event.key === "PageUp") {
          event.preventDefault();
          move(-10);
        } else if (event.key === "Enter") {
          event.preventDefault();
          const id = ids[cursor];
          if (id) onPick(id);
        } else if (event.key === " " && event.target === listRef.current) {
          event.preventDefault();
          audition(cursor, true);
        }
      }}
    >
      <div className="flex items-center gap-1">
        <input
          ref={searchRef}
          className="min-w-0 flex-1 border border-border bg-background px-1.5 py-0.5 text-foreground"
          placeholder="Search sounds… (↑↓ listen, Enter pick)"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <button
          type="button"
          className={cn(
            "flex shrink-0 items-center gap-1 border px-1 py-0.5",
            prefs.audition
              ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
              : "border-border text-foreground-subtle",
          )}
          title="Play each sound as the wheel or the arrow keys reach it (hovering never plays)"
          onClick={() => writePrefs({ audition: !prefs.audition })}
        >
          <Play className="size-3" />
          listen
        </button>
        <button
          type="button"
          className="flex size-5 shrink-0 items-center justify-center border border-border text-foreground-subtle hover:bg-hover"
          title="Stop the preview"
          onClick={() => stopZaicodeSoundChannel(PREVIEW_CHANNEL)}
        >
          <Square className="size-3" />
        </button>
      </div>
      <div className="flex flex-wrap gap-px" role="tablist" aria-multiselectable="true">
        {tabList.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tabs.includes(entry.id)}
            title={`${entry.hint}\nShift / Ctrl + click: add or remove · press and drag across tabs: several at once`}
            className={cn(
              "select-none whitespace-nowrap border px-1 leading-4",
              tabs.includes(entry.id)
                ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
                : "border-border text-foreground-subtle hover:bg-hover hover:text-foreground",
            )}
            onMouseDown={keepSearchFocus}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const additive = event.shiftKey || event.ctrlKey || event.metaKey;
              dragging.current = entry.id !== "all";
              selectTabs(nextZaicodeSoundTabs(tabs, entry.id, additive));
            }}
            onPointerEnter={() => {
              if (dragging.current) selectTabs(dragZaicodeSoundTabs(tabs, entry.id));
            }}
          >
            {entry.label}
            <span className="ml-0.5 text-[10px] text-foreground-subtlest">{entry.count}</span>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-5 gap-px">
        {prefs.quick.map((id, index) => (
          <button
            key={`${index}-${id}`}
            type="button"
            className={cn(
              "truncate border px-0.5 text-[10px] leading-4",
              id === value
                ? "border-[var(--zaicode-highlight,var(--color-border-hover))] text-foreground"
                : "border-border text-foreground-subtle hover:bg-hover hover:text-foreground",
            )}
            title={`Quick slot ${index + 1}: ${zaicodeSoundDisplayName(id)}\nClick: use it (plays once). Right-click: store the current sound here.`}
            onMouseDown={keepSearchFocus}
            onClick={() => onPick(id)}
            onContextMenu={(event) => {
              event.preventDefault();
              const quick = [...prefs.quick];
              quick[index] = value;
              writePrefs({ quick });
            }}
          >
            {zaicodeSoundDisplayName(id).split(" · ")[0]}
          </button>
        ))}
      </div>
      <div
        ref={(element) => {
          listRef.current = element;
          setListElement(element);
        }}
        tabIndex={0}
        className="flex max-h-[320px] min-h-[96px] flex-1 flex-col overflow-y-auto border border-border bg-background outline-none"
        role="listbox"
        aria-label="Sounds"
      >
        {ids.length === 0 ? <div className="px-2 py-1 text-foreground-subtlest">Nothing matches.</div> : null}
        {ids.map((id, index) => {
          const entry = id === "default" ? null : (shown[defaultRow ? index - 1 : index] ?? null);
          const favorite = prefs.favorites.includes(id);
          return (
            <div
              key={id}
              data-row={index}
              role="option"
              aria-selected={id === value}
              className={cn(
                "flex cursor-default items-center gap-1 px-1 leading-5 hover:bg-hover",
                index === cursor ? "bg-selected text-foreground" : "text-foreground-subtle",
                id === value && "font-semibold text-foreground",
              )}
              onMouseDown={keepSearchFocus}
              onClick={() => {
                scrollToCursor.current = false;
                setCursor(index);
                audition(index, true);
              }}
              onDoubleClick={() => onPick(id)}
              title="Click: listen. Double-click or Enter: use this sound"
            >
              <span className="w-3 shrink-0 text-center">{id === value ? "✓" : ""}</span>
              <span className="min-w-0 flex-1 truncate">{entry ? entry.name : "(notification pop)"}</span>
              {entry?.folder ? (
                <span className="shrink-0 text-[10px] text-foreground-subtlest">{entry.folder.replace(/^_vault\//, "")}</span>
              ) : null}
              {entry ? (
                <span
                  className={cn(
                    "w-9 shrink-0 text-right text-[10px] tabular-nums",
                    entry.seconds > 15 ? "text-[#e0a040]" : "text-foreground-subtlest",
                  )}
                >
                  {formatZaicodeSoundLength(entry.seconds)}
                </span>
              ) : (
                <span className="w-9 shrink-0" />
              )}
              {index === cursor ? (
                <button
                  type="button"
                  className="shrink-0 border border-[var(--zaicode-highlight,var(--color-border-hover))] px-1 text-[10px] leading-4 text-foreground hover:bg-hover"
                  title="Use this sound for the row"
                  onClick={(event) => {
                    event.stopPropagation();
                    onPick(id);
                  }}
                  data-zaicode-sound-use
                >
                  use
                </button>
              ) : null}
              {entry ? (
                <button
                  type="button"
                  className={cn("shrink-0 px-0.5", favorite ? "text-[#f0c040]" : "text-foreground-subtlest hover:text-foreground")}
                  title={favorite ? "Remove from favourites" : "Add to favourites"}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleFavorite(id);
                  }}
                >
                  <Star className="size-3" fill={favorite ? "currentColor" : "none"} />
                </button>
              ) : null}
            </div>
          );
        })}
        {rows.length > MAX_ROWS ? (
          <div className="px-2 py-1 text-foreground-subtlest">
            {rows.length - MAX_ROWS} more — type to narrow the list.
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2 text-[10px] text-foreground-subtlest">
        <span>Click listens · wheel / ↑↓ listen while “listen” is on · double-click, Enter or “use” picks · Esc closes</span>
        {onImportOwn ? (
          <button
            type="button"
            className="flex items-center gap-1 border border-border px-1 text-foreground-subtle hover:bg-hover hover:text-foreground"
            onClick={onImportOwn}
          >
            <Upload className="size-3" />
            Own file…
          </button>
        ) : null}
      </div>
    </div>
  );
}
