import { useSyncExternalStore } from "react";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Boxes,
  Cat,
  CheckCircle2,
  Circle,
  Cpu,
  Flame,
  Ghost,
  Grip,
  Layers,
  ListChecks,
  Network,
  Pin,
  PinOff,
  RefreshCw,
  Rocket,
  Settings,
  Shield,
  Star,
  Terminal,
  User,
  Users,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";

/**
 * ZAICODE icon slots: every swappable icon/element placeholder lives here.
 *
 * Two ways to swap an icon:
 *  1. Code (hot reload in dev): change the default component in ZAICODE_ICON_SLOTS.
 *  2. Runtime: set an override (image URL, data: URI, or a short text/emoji) through
 *     the "Icons" panel in the ZAICODE workspace. Overrides are stored per machine
 *     and applied live without restart.
 */
export const ZAICODE_ICON_SLOTS = {
  "nav.zaicode": Boxes,
  "workspace.dispatch": Rocket,
  "workspace.refresh": RefreshCw,
  "workspace.help": Layers,
  "todo.trigger": ListChecks,
  "todo.panel": ListChecks,
  "todo.done": CheckCircle2,
  "todo.pending": Circle,
  "todo.drag": Grip,
  "todo.dock": Pin,
  "todo.detach": PinOff,
  "todo.close": X,
  "roster.agent": Bot,
  "pool.router": Network,
  "pool.other": Layers,
  "footer.settings": Settings,
  "footer.profiles": Users,
  "profile.user": User,
  "profile.bot": Bot,
  "profile.cpu": Cpu,
  "profile.terminal": Terminal,
  "profile.wrench": Wrench,
  "profile.rocket": Rocket,
  "profile.ghost": Ghost,
  "profile.cat": Cat,
  "profile.star": Star,
  "profile.flame": Flame,
  "profile.zap": Zap,
  "profile.shield": Shield,
} as const satisfies Record<string, LucideIcon>;

export type ZaicodeIconSlot = keyof typeof ZAICODE_ICON_SLOTS;

export const ZAICODE_ICON_SLOT_IDS = Object.keys(ZAICODE_ICON_SLOTS) as ZaicodeIconSlot[];

/** Generic profile icons offered in the profile switcher. */
export const ZAICODE_PROFILE_ICON_SLOTS = ZAICODE_ICON_SLOT_IDS.filter((slot) =>
  slot.startsWith("profile."),
);

const STORAGE_KEY = "zaicode-icon-overrides";
const CHANGE_EVENT = "zaicode-icon-overrides-changed";

type Overrides = Partial<Record<ZaicodeIconSlot, string>>;

let cached: Overrides | null = null;

function readOverrides(): Overrides {
  if (cached) return cached;
  try {
    const raw = readZaicodeSetting(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    cached = parsed && typeof parsed === "object" ? (parsed as Overrides) : {};
  } catch {
    cached = {};
  }
  return cached;
}

function writeOverrides(next: Overrides): void {
  cached = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable: keep the in-memory override for this session
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    cached = null;
    listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useZaicodeIconOverrides(): Overrides {
  return useSyncExternalStore(subscribe, readOverrides, readOverrides);
}

export function setZaicodeIconOverride(slot: ZaicodeIconSlot, value: string): void {
  const trimmed = value.trim();
  const next = { ...readOverrides() };
  if (trimmed) next[slot] = trimmed;
  else delete next[slot];
  writeOverrides(next);
}

export function resetZaicodeIconOverrides(): void {
  writeOverrides({});
}

function isImageSource(value: string): boolean {
  return /^(https?:|data:image\/|file:|\/|\.{0,2}\/)/i.test(value);
}

/** Renders the slot's override when set, otherwise its default icon. */
export function ZaicodeIcon({ slot, className }: { slot: ZaicodeIconSlot; className?: string }) {
  const override = useZaicodeIconOverrides()[slot];
  if (override) {
    if (isImageSource(override)) {
      return (
        <img
          src={override}
          alt=""
          aria-hidden
          className={cn("size-4 shrink-0 object-contain [image-rendering:pixelated]", className)}
        />
      );
    }
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center leading-none",
          className,
        )}
      >
        {override}
      </span>
    );
  }
  const Icon = ZAICODE_ICON_SLOTS[slot];
  return <Icon data-zaicode-icon="" className={cn("size-4 shrink-0", className)} />;
}
