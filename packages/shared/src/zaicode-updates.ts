/**
 * ZAICODE updates (T-134): ZAICODE is four GitHub repositories that work as
 * one -- the workspace (root launcher, installer), the app, SAIPEN and
 * SAIMAIL -- and each one updates on its own. The work is done by
 * install\Update-ZAICODE.ps1 (the installer's own library, so an update and a
 * repair are the same code); this module is the shared shape of its JSON
 * report, the per-part "update by itself" preference and the schedule rules.
 * Pure: no electron, no fs.
 */

export const ZAICODE_UPDATE_COMPONENTS = ["workspace", "app", "saipen", "saimail"] as const;
export type ZaicodeUpdateComponentId = (typeof ZAICODE_UPDATE_COMPONENTS)[number];

export type ZaicodeUpdateStatus =
  | "current"
  | "available"
  | "ahead"
  | "diverged"
  | "local-changes"
  | "missing"
  | "offline"
  | "updated"
  | "failed";

export interface ZaicodeUpdateComponent {
  id: ZaicodeUpdateComponentId;
  title: string;
  dir: string;
  branch: string;
  version: string;
  head: string | null;
  remote: string | null;
  behind: number;
  ahead: number;
  dirty: boolean;
  status: ZaicodeUpdateStatus;
  detail: string;
  /** Subjects of the commits waiting (newest first, at most 8). */
  subjects: string[];
}

export type ZaicodeUpdateAuto = Record<ZaicodeUpdateComponentId, boolean>;

export interface ZaicodeUpdatesState {
  /** The folder with install\Update-ZAICODE.ps1, or null (a build without the workspace). */
  installRoot: string | null;
  /** Installed by the installer (install\install-state.json): parts may update by themselves. */
  managed: boolean;
  busy: "check" | "update" | null;
  busyComponents: ZaicodeUpdateComponentId[];
  lastCheckAt: number | null;
  lastUpdateAt: number | null;
  components: ZaicodeUpdateComponent[];
  auto: ZaicodeUpdateAuto;
  error: string | null;
  log: string | null;
}

/** First look a few minutes after the start (the app is busy starting), then every six hours. */
export const ZAICODE_UPDATE_FIRST_CHECK_MS = 3 * 60 * 1000;
export const ZAICODE_UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const STATUSES: readonly ZaicodeUpdateStatus[] = [
  "current",
  "available",
  "ahead",
  "diverged",
  "local-changes",
  "missing",
  "offline",
  "updated",
  "failed",
];

export function isZaicodeUpdateComponentId(value: unknown): value is ZaicodeUpdateComponentId {
  return typeof value === "string" && (ZAICODE_UPDATE_COMPONENTS as readonly string[]).includes(value);
}

/**
 * An installer-made ZAICODE updates every part by itself unless told not to;
 * a developer checkout (no install-state.json) only reports: its clones are
 * someone's working copies.
 */
export function defaultZaicodeUpdateAuto(managed: boolean): ZaicodeUpdateAuto {
  return { workspace: managed, app: managed, saipen: managed, saimail: managed };
}

export function normalizeZaicodeUpdateAuto(raw: unknown, managed: boolean): ZaicodeUpdateAuto {
  const base = defaultZaicodeUpdateAuto(managed);
  if (!raw || typeof raw !== "object") return base;
  const value = raw as Record<string, unknown>;
  for (const id of ZAICODE_UPDATE_COMPONENTS) {
    if (typeof value[id] === "boolean") base[id] = value[id] as boolean;
  }
  return base;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function component(raw: unknown): ZaicodeUpdateComponent | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (!isZaicodeUpdateComponentId(value.id)) return null;
  const status = STATUSES.includes(value.status as ZaicodeUpdateStatus) ? (value.status as ZaicodeUpdateStatus) : "failed";
  // PowerShell 5.1's ConvertTo-Json writes a one-element array as the element itself.
  const subjects = Array.isArray(value.subjects) ? value.subjects : typeof value.subjects === "string" ? [value.subjects] : [];
  return {
    id: value.id,
    title: text(value.title, value.id),
    dir: text(value.dir),
    branch: text(value.branch),
    version: text(value.version, "unknown"),
    head: typeof value.head === "string" && value.head ? value.head : null,
    remote: typeof value.remote === "string" && value.remote ? value.remote : null,
    behind: count(value.behind),
    ahead: count(value.ahead),
    dirty: value.dirty === true,
    status,
    detail: text(value.detail),
    subjects: subjects.filter((line): line is string => typeof line === "string" && line.length > 0).slice(0, 8),
  };
}

export interface ZaicodeUpdateReport {
  managed: boolean;
  mode: "check" | "update";
  log: string | null;
  components: ZaicodeUpdateComponent[];
}

/**
 * Update-ZAICODE.ps1 -Json prints one JSON document; anything a tool printed
 * before it is skipped, so the last line that parses as a report wins.
 */
export function parseZaicodeUpdateReport(output: string): ZaicodeUpdateReport | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (!line.startsWith("{")) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const rawComponents = Array.isArray(value.components) ? value.components : value.components ? [value.components] : null;
      if (!rawComponents) continue;
      return {
        managed: value.managed === true,
        mode: value.mode === "update" ? "update" : "check",
        log: typeof value.log === "string" ? value.log : null,
        components: rawComponents.map(component).filter((entry): entry is ZaicodeUpdateComponent => entry !== null),
      };
    } catch {
      // not the report line
    }
  }
  return null;
}

/** Which parts to update by themselves now: set to auto and with something new. */
export function zaicodeUpdatesDue(auto: ZaicodeUpdateAuto, components: readonly ZaicodeUpdateComponent[]): ZaicodeUpdateComponentId[] {
  return components.filter((entry) => entry.status === "available" && auto[entry.id]).map((entry) => entry.id);
}

/** A newer report replaces the parts it names and keeps the others (an update of one part reports only that part). */
export function mergeZaicodeUpdateComponents(
  previous: readonly ZaicodeUpdateComponent[],
  next: readonly ZaicodeUpdateComponent[],
): ZaicodeUpdateComponent[] {
  const byId = new Map(previous.map((entry) => [entry.id, entry]));
  for (const entry of next) byId.set(entry.id, entry);
  return ZAICODE_UPDATE_COMPONENTS.map((id) => byId.get(id)).filter((entry): entry is ZaicodeUpdateComponent => Boolean(entry));
}

/** One line for a card / the tray: what changed since the last report. */
export function describeZaicodeUpdateNews(components: readonly ZaicodeUpdateComponent[]): { available: string[]; updated: string[]; failed: string[] } {
  return {
    available: components.filter((entry) => entry.status === "available").map((entry) => entry.title),
    updated: components.filter((entry) => entry.status === "updated").map((entry) => entry.title),
    failed: components.filter((entry) => entry.status === "failed").map((entry) => entry.title),
  };
}
