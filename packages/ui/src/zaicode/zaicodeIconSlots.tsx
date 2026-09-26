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

/** Replaces every override at once (preset / profile / import). Empty values drop the slot. */
export function applyZaicodeIconOverrides(next: Overrides): void {
  const clean: Overrides = {};
  for (const [slot, value] of Object.entries(next)) {
    if (!ZAICODE_ICON_SLOT_IDS.includes(slot as ZaicodeIconSlot)) continue;
    const trimmed = value.trim();
    if (trimmed) clean[slot as ZaicodeIconSlot] = trimmed;
  }
  writeOverrides(clean);
}

// ---------------------------------------------------------------------------
// Workshop (SRC-051): designed badges, presets, saved profiles, import/export
// ---------------------------------------------------------------------------

/** Escapes text for one SVG text node / attribute value. */
function escapeSvgText(value: string): string {
  return value.replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * Pure: a small rounded-square badge as an SVG data URI — a solid colour or a
 * two-stop gradient with up to two glyphs centred on it. This is the worker
 * icon mini-editor's output (colours / gradients, SRC-051) and works for any
 * slot.
 */
export function buildZaicodeIconBadgeDataUri(input: {
  from: string;
  to: string;
  gradient: boolean;
  glyph?: string;
}): string {
  const from = input.from.trim() || "#c8a028";
  const to = input.to.trim() || from;
  const glyph = escapeSvgText((input.glyph ?? "").trim().slice(0, 2));
  const fill = input.gradient && from !== to ? 'fill="url(#g)"' : `fill="${escapeSvgText(from)}"`;
  const stops =
    input.gradient && from !== to
      ? `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${escapeSvgText(from)}"/><stop offset="1" stop-color="${escapeSvgText(to)}"/></linearGradient></defs>`
      : "";
  const text = glyph ? `<text x="8" y="8" text-anchor="middle" dominant-baseline="central" font-family="Verdana,sans-serif" font-size="8" font-weight="bold" fill="#101010">${glyph}</text>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${stops}<rect x="1" y="1" width="14" height="14" rx="2" ${fill}/>${text}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Built-in preset packs (SRC-051): Reset is the theme's own icons. */
export interface ZaicodeIconPreset {
  id: string;
  label: string;
  hint: string;
  overrides: Overrides;
}

/** Every slot as a gold gradient badge with the slot's own initial. */
function goldBadgeOverrides(): Overrides {
  return Object.fromEntries(
    ZAICODE_ICON_SLOT_IDS.map((slot) => [
      slot,
      buildZaicodeIconBadgeDataUri({
        from: "#e8c04a",
        to: "#8a6a10",
        gradient: true,
        glyph: slot.split(".")[1]?.[0]?.toUpperCase() ?? "",
      }),
    ]),
  );
}

export const ZAICODE_ICON_PRESETS: readonly ZaicodeIconPreset[] = [
  { id: "reset", label: "Theme icons", hint: "Every slot back to its built-in icon", overrides: {} },
  {
    id: "emoji",
    label: "Emoji",
    hint: "Plain emoji for the main controls",
    overrides: {
      "workspace.dispatch": "🚀",
      "workspace.refresh": "🔄",
      "workspace.help": "❓",
      "todo.trigger": "☑",
      "todo.panel": "📋",
      "roster.agent": "🤖",
      "pool.router": "🌐",
      "footer.settings": "⚙",
      "profile.user": "🙂",
      "profile.bot": "🤖",
    },
  },
  {
    id: "gold-badges",
    label: "Gold badges",
    hint: "Gradient badge with the slot's initial, generated with the same badge builder",
    overrides: goldBadgeOverrides(),
  },
];

/** One saved profile: the operator's whole override table under a name. */
export interface ZaicodeIconProfile {
  id: string;
  name: string;
  savedAt: number;
  overrides: Overrides;
}

const PROFILES_KEY = "zaicode-icon-profiles-v1";
const MAX_PROFILES = 12;

export function readZaicodeIconProfiles(): ZaicodeIconProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const out: ZaicodeIconProfile[] = [];
    for (const entry of parsed) {
      const value = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
      if (!value || typeof value.id !== "string" || typeof value.name !== "string") continue;
      const overrides: Overrides = {};
      const table = value.overrides && typeof value.overrides === "object" ? (value.overrides as Record<string, unknown>) : {};
      for (const [slot, icon] of Object.entries(table)) {
        if (ZAICODE_ICON_SLOT_IDS.includes(slot as ZaicodeIconSlot) && typeof icon === "string" && icon.trim()) {
          overrides[slot as ZaicodeIconSlot] = icon.trim();
        }
      }
      out.push({
        id: value.id,
        name: value.name.slice(0, 40),
        savedAt: typeof value.savedAt === "number" ? value.savedAt : 0,
        overrides,
      });
    }
    return out.slice(0, MAX_PROFILES);
  } catch {
    return [];
  }
}

export function saveZaicodeIconProfile(name: string, overrides: Overrides): ZaicodeIconProfile {
  const clean: Overrides = {};
  for (const [slot, value] of Object.entries(overrides)) {
    if (ZAICODE_ICON_SLOT_IDS.includes(slot as ZaicodeIconSlot) && value.trim()) clean[slot as ZaicodeIconSlot] = value.trim();
  }
  const profile: ZaicodeIconProfile = {
    id: `profile-${Date.now().toString(36)}`,
    name: name.trim().slice(0, 40) || `Icons ${new Date().toLocaleString()}`,
    savedAt: Date.now(),
    overrides: clean,
  };
  const next = [profile, ...readZaicodeIconProfiles().filter((entry) => entry.name !== profile.name)].slice(0, MAX_PROFILES);
  try {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(next));
  } catch {
    // profile list only; the table itself still applies for this session
  }
  return profile;
}

export function deleteZaicodeIconProfile(id: string): void {
  try {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(readZaicodeIconProfiles().filter((entry) => entry.id !== id)));
  } catch {
    // nothing to remove from
  }
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
