/* eslint-disable max-lines -- ZAICODE engines contract: vendor parsers, config normalizers and autostart planning share one pure module used by main and UI. */
/**
 * ZAICODE engines: every subscription the operator already owns (Claude Code,
 * Codex, Antigravity, ZCode plan) as a worker engine next to the in-app model
 * pools, with its live quota.
 *
 * This module is the shared vocabulary and the pure rules. The desktop main
 * process discovers accounts and reads quota; the renderer only consumes the
 * records defined here. Reading quota never spends quota: every source is the
 * vendor's own read-only answer (a local slash command, a JSON-RPC read, a
 * billing monitor endpoint). Nothing here invents a percentage — a window the
 * vendor did not state is absent, never guessed.
 */

import type { ZaicodeResetCredits } from "./zaicode-reset-credits.js";

export const ZAICODE_ENGINE_VENDORS = ["claude", "codex", "antigravity", "zcode", "freebuff"] as const;
export type ZaicodeEngineVendor = (typeof ZAICODE_ENGINE_VENDORS)[number];

export const ZAICODE_ENGINE_VENDOR_LABELS: Record<ZaicodeEngineVendor, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  zcode: "ZCode",
  freebuff: "Freebuff",
};

/**
 * Vendors ZAICODE only measures (SRC-043: "Freebuff only as a metric"): their
 * quota shows in the meters, the clock and SAIHOME, but they never launch a
 * worker, never appear in an engine / scheduler / dispatch picker.
 */
export const ZAICODE_METRICS_ONLY_VENDORS: readonly ZaicodeEngineVendor[] = ["freebuff"];

/** Button code per vendor: A1 = Claude, C1 = Codex, AG / ZC / FB for the single-login ones. */
export const ZAICODE_ENGINE_VENDOR_SHORTS: Readonly<Record<ZaicodeEngineVendor, string>> = Object.freeze({
  claude: "A",
  codex: "C",
  antigravity: "AG",
  zcode: "ZC",
  freebuff: "FB",
});

/**
 * Vendors whose CLI takes a per-account home directory (CLAUDE_CONFIG_DIR /
 * CODEX_HOME), so one vendor can hold several accounts and a shared profile
 * directory is launchable here.
 *
 * The others keep exactly one local identity. A second row for them would
 * launch the very same single install under a second name, which is the
 * "old mechanic that confuses it" (SRC-151:R007), so a shared record for one
 * of these is shown and measured but never started.
 */
export const ZAICODE_MULTI_HOME_VENDORS: readonly ZaicodeEngineVendor[] = ["claude", "codex"];

/** Home directory name an operator's own second account gets (`~/.claude-account2`). */
export const ZAICODE_VENDOR_HOME_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  claude: ".claude-account",
  codex: ".codex-account",
});

/**
 * SAI Accounts origin (SRC-151:R007). Absent = local discovery only, which is
 * what every machine without the control plane keeps seeing.
 *
 * The plane owns the canonical `accountId` and the global lifecycle state;
 * ZAICODE keeps the local half (config overlay, entitlement, presentation).
 * The two id namespaces differ, so a shared id can never pose as a ZAICODE
 * provider id.
 */
export interface ZaicodeSharedOrigin {
  /** Canonical id in the plane's own namespace. */
  accountId: string;
  /** The locator that proved the match: a profile directory, a windows user or a context label. */
  locator: string;
}

export function isZaicodeMetricsOnlyAccount(
  account: Pick<ZaicodeEngineAccount, "vendor"> &
    Partial<Pick<ZaicodeEngineAccount, "home" | "shared" | "planeOnly">>,
): boolean {
  if (ZAICODE_METRICS_ONLY_VENDORS.includes(account.vendor)) return true;
  // SRC-161:REQ-001: the question is "did the plane INVENT this row?", not "does
  // this row know the plane?". A locally discovered account the plane merely
  // enriched still IS the local install and keeps every local launch fact --
  // marking it metrics-only for carrying a plane id is how a working
  // Antigravity login would quietly stop being offered as a worker.
  // A vendor that cannot keep several local logins still gets the same treatment
  // for its plane-only rows: a second name for the same single install.
  return account.planeOnly === true && !ZAICODE_MULTI_HOME_VENDORS.includes(account.vendor);
}

/**
 * The one merge key for the federation: provider + locator, case-folded.
 *
 * An empty provider or an empty locator returns "" -- that is "cannot be
 * proven", and it must never become a key: a key built from "" would collapse
 * every locator-less account into a single row. A display name is never a key
 * either; two subscriptions may answer to the same name.
 */
export function zaicodeSharedIdentityKey(providerId: string, locator: string): string {
  const provider = (providerId ?? "").trim().toLowerCase();
  const value = (locator ?? "").trim().toLowerCase();
  if (!provider || !value) return "";
  return `${provider}|${value}`;
}

/** One shared record, already reduced to what a merge needs. */
export interface ZaicodeSharedAccountInput {
  accountId: string;
  providerId: string;
  displayName: string;
  /** Locator exactly as the plane gave it; "" when it has none. */
  locator: string;
  /** Absolute existing profile directory this locator names; null when it names no local path. */
  home: string | null;
}

function normalizeSharedLocator(value: string): string {
  return (value ?? "")
    .trim()
    .replace(/\//g, "\\")
    .replace(/\\+$/, "")
    .toLowerCase();
}

/** The next free A<n> / C<n>, or the vendor's single fixed code when it takes no homes. */
function nextSharedShort(vendor: ZaicodeEngineVendor, existing: readonly ZaicodeEngineAccount[]): string {
  const letters = ZAICODE_ENGINE_VENDOR_SHORTS[vendor];
  if (!ZAICODE_MULTI_HOME_VENDORS.includes(vendor)) return letters;
  const pattern = new RegExp(`^${letters}(\\d+)$`);
  let highest = 0;
  for (const account of existing) {
    if (account.vendor !== vendor) continue;
    const hit = pattern.exec(account.short);
    if (hit?.[1]) highest = Math.max(highest, Number(hit[1]));
  }
  return `${letters}${highest + 1}`;
}

function sharedAccountRow(
  vendor: ZaicodeEngineVendor,
  origin: ZaicodeSharedOrigin,
  entry: ZaicodeSharedAccountInput,
  existing: readonly ZaicodeEngineAccount[],
): ZaicodeEngineAccount {
  const launchable = entry.home !== null && ZAICODE_MULTI_HOME_VENDORS.includes(vendor);
  const label = entry.displayName.trim();
  return {
    // The plane's id inside a namespace of its own: it can collide with nothing.
    id: `${vendor}:shared:${origin.accountId}`,
    vendor,
    short: nextSharedShort(vendor, existing),
    label: label || `${ZAICODE_ENGINE_VENDOR_LABELS[vendor]} (SAI)`,
    source: launchable ? entry.home! : `SAI Accounts · ${origin.locator || "no locator"}`,
    home: launchable ? entry.home : null,
    isDefaultHome: false,
    // The plane already filtered to ENABLED and not hidden, so this identity is
    // live by the plane's own judgement; ZAICODE does not second-guess it with a
    // second login check. Same CLI as the local row -- the vendor ships one.
    cli: existing.find((account) => account.vendor === vendor)?.cli ?? null,
    status: "ready",
    statusDetail: "",
    fixCommand: null,
    shared: origin,
    // The plane made this row up: nothing local backs it, so it is measured and
    // shown but never offered as a worker (SRC-161:REQ-001).
    planeOnly: true,
  };
}

/**
 * Fold the shared registry into the locally discovered accounts (SRC-151:R007).
 *
 * STANDALONE -- no control plane, `shared` is empty -- returns the local list
 * untouched, byte for byte. FEDERATED -- a shared record whose locator names an
 * already discovered home IS that account: the local row gains the plane's id
 * and is read through the plane afterwards, so there is one row, not two.
 * HYBRID -- a record that matches nothing becomes its own row: launchable when
 * its vendor keeps several homes and the locator is a real directory here,
 * otherwise measured through the plane and never started.
 */
export function mergeZaicodeSharedAccounts(
  accounts: readonly ZaicodeEngineAccount[],
  shared: readonly ZaicodeSharedAccountInput[],
): ZaicodeEngineAccount[] {
  const merged: ZaicodeEngineAccount[] = accounts.map((account) => ({ ...account }));
  // Keyed by vendor too (SRC-162): a locator only ever identifies an account of its own vendor,
  // so an OS user name shared by two vendors' records can never fold one into the other.
  const locators = new Map<string, number>();
  const at = (vendor: string, locator: string) => `${vendor}|${normalizeSharedLocator(locator)}`;
  merged.forEach((account, index) => {
    if (account.home) {
      locators.set(at(account.vendor, account.home), index);
      return;
    }
    // SRC-162: a home-less row that reads the running OS user's own credential store (local
    // Antigravity) IS the plane's `windows_user` record for that same user -- the plane names
    // it by the user ("vac34"), never by the credential target, so without this alias the one
    // subscription still showed twice: "Antigravity" and "Antigravity 1" with equal numbers.
    if (account.osUser) locators.set(at(account.vendor, account.osUser), index);
    // An account with no home directory has no directory to be identified by:
    // Antigravity's whole non-secret identity IS its credential target name
    // ("gemini:antigravity"), ZCode's is its config entry. Without this the
    // plane's own record for that same install could never match, so it became
    // its own row and one subscription read as two -- the generic "Antigravity"
    // beside the plane's own name (SRC-161:REQ-001). Only home-less accounts
    // are indexed here: for the multi-home vendors the directory already is the
    // identity, and their `source` is a display path rather than a locator.
    if (normalizeSharedLocator(account.source)) locators.set(at(account.vendor, account.source), index);
  });
  const claimed = new Set<string>();
  for (const entry of shared) {
    const vendor = ZAICODE_ENGINE_VENDORS.find((id) => id === entry.providerId.trim().toLowerCase());
    if (!vendor) continue; // a provider ZAICODE has no engine for
    const key = zaicodeSharedIdentityKey(entry.providerId, entry.locator);
    if (!key || claimed.has(key)) continue; // cannot be proven, or the plane sent it twice
    claimed.add(key);
    const origin: ZaicodeSharedOrigin = { accountId: entry.accountId.trim(), locator: entry.locator.trim() };
    const index = locators.get(at(vendor, entry.locator));
    if (index !== undefined && !merged[index]!.shared) {
      merged[index] = { ...merged[index]!, shared: origin };
      continue;
    }
    merged.push(sharedAccountRow(vendor, origin, entry, merged));
    if (entry.home !== null) locators.set(at(vendor, entry.home), merged.length - 1);
  }
  return merged;
}

/**
 * Antigravity's `/usage` lists its two independent pools in a fixed order (parseAntigravityUsage
 * reads the names: "Gemini Models", then "Claude and GPT models"). The shared-account plane keeps
 * only that order as `pool_index`.
 */
const ANTIGRAVITY_POOL_ORDER = ["Gemini", "Claude & GPT"] as const;

/**
 * Short display name of a quota pool id ("gemini" -> "Gemini"); "" for the account's only pool.
 * A numeric id is the plane's pool index: index 0 of a single-pool vendor names nothing, an
 * Antigravity index maps to its known pool, any other index reads "Pool N".
 */
export function zaicodeQuotaPoolLabel(group: string, vendor?: string): string {
  const id = group.trim();
  if (!id) return "";
  if (/^\d+$/.test(id)) {
    const index = Number(id);
    if (vendor === "antigravity") return ANTIGRAVITY_POOL_ORDER[index] ?? `Pool ${index + 1}`;
    return index === 0 ? "" : `Pool ${index + 1}`;
  }
  if (/gemini/i.test(id)) return "Gemini";
  if (/claude|gpt/i.test(id)) return "Claude & GPT";
  return id.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** One plane window -> the window shape every ZAICODE surface already reads. */
export function zaicodeWindowFromShared(input: {
  readonly kind: string;
  readonly label: string;
  readonly remainingFraction: number;
  readonly resetTime: string | null;
  readonly quotaBucket: string;
}, vendor?: string): ZaicodeLimitWindow {
  const kind = input.kind.trim() || "window";
  const group = input.quotaBucket.trim();
  const parsed = input.resetTime ? Date.parse(input.resetTime) : Number.NaN;
  const resetsAt = Number.isFinite(parsed) ? parsed : null;
  const base = input.label.trim() || zaicodeWindowLabel(kind);
  const pool = zaicodeQuotaPoolLabel(group, vendor);
  return {
    key: group ? `${kind}@${group}` : kind,
    // SRC-162: two pools of one account (Antigravity: Gemini vs Claude & GPT) both arrive as
    // "weekly" / "5h"; without the pool in the label the card read as duplicated rows.
    label: pool && !base.toLowerCase().includes(pool.toLowerCase()) ? `${pool} ${base}` : base,
    group,
    groupLabel: pool,
    remainingPercent: Math.max(0, Math.min(100, input.remainingFraction * 100)),
    resetsAt,
    durationMinutes: WINDOW_MINUTES[kind] ?? null,
    gatedBy: null,
    assumedFull: false,
    startsOnUse: false,
  };
}

/** Minutes a known window lasts, or null when the key is not one of the known ones. */
export function zaicodeWindowMinutes(key: string): number | null {
  return WINDOW_MINUTES[key] ?? null;
}

/** Why an account can or cannot work right now; `ready` is the only launchable state. */
export type ZaicodeEngineStatus = "ready" | "cli-missing" | "login-required" | "no-plan";

export interface ZaicodeEngineAccount {
  /** Stable identity: vendor + canonical source. Never an ordinal, never a display name. */
  id: string;
  vendor: ZaicodeEngineVendor;
  /** Button label: A1/A2 = Claude, C1/C2/C3 = Codex, AG = Antigravity, ZC = ZCode. */
  short: string;
  /** "Claude 1", "Codex 3", "Antigravity", "ZCode". */
  label: string;
  /** Non-secret account source: a config directory, a credential target name or a config entry id. */
  source: string;
  /** Account home handed to the CLI (CLAUDE_CONFIG_DIR / CODEX_HOME); null = the CLI default. */
  home: string | null;
  /** True when `home` is the vendor's default account and the env override must be cleared. */
  isDefaultHome: boolean;
  /**
   * The OS account whose own credential store this home-less row reads (local Antigravity).
   * The shared-account plane names that same identity by the user, so it is a merge alias.
   */
  osUser?: string;
  /** Resolved executable (or script for ZCode) used to launch workers; null when not installed. */
  cli: string | null;
  status: ZaicodeEngineStatus;
  /** One human sentence: what is wrong and what fixes it. Empty when ready. */
  statusDetail: string;
  /**
   * T-134: never set up on this machine (the vendor's default login home does
   * not exist). Listed so it can be signed in any time, but not "needs you":
   * a first install runs on the free pool and nags about nothing.
   */
  optional?: boolean;
  /** Exact command that fixes the state, shown before it runs (login / install). */
  fixCommand: string | null;
  /**
   * SAI Accounts owns this identity when it is present (SRC-151:R007). Absent
   * means local discovery only, which is every machine without the control
   * plane -- nothing about the account changes there.
   */
  shared?: ZaicodeSharedOrigin;
  /**
   * SRC-161:REQ-001: the plane invented this row -- no local discovery backs it.
   * Distinct from `shared`: a plane record that FOLDS into a locally discovered
   * account carries `shared` but not this, because the row still IS that
   * account and must keep its local launch facts.
   */
  planeOnly?: boolean;
}

export interface ZaicodeLimitWindow {
  /** Stable window key: five_hour, weekly, monthly, weekly_sonnet, ... */
  key: string;
  /** Short label: "5h", "weekly", "monthly", "weekly Sonnet". */
  label: string;
  /** Independent quota pool (Antigravity: Gemini vs Claude/GPT). Empty = the account's only pool. */
  group: string;
  groupLabel: string;
  /** 0..100 as the vendor stated it, or null when the vendor gave no number. */
  remainingPercent: number | null;
  /** Epoch milliseconds of the vendor's reset time, or null. */
  resetsAt: number | null;
  durationMinutes: number | null;
  /** Label of the longer window in the same pool that makes this one unusable right now. */
  gatedBy: string | null;
  /** The window's own reset time passed after the read: refill assumed until the next read. */
  assumedFull: boolean;
  /**
   * Not running (SRC-048): the vendor put the reset a full window after the
   * read, i.e. the window starts with the first request. Such a reset slides
   * forward with every read ("5 h" again every 5 minutes) and is no refill.
   * Absent in snapshots read before this field existed.
   */
  startsOnUse?: boolean;
  /**
   * A successful start timestamp backed by the matching vendor reset. Legacy
   * locally synthesized anchors are discarded on the next read without that proof.
   */
  rollingFrom?: number;
}

export interface ZaicodeLimitSnapshot {
  accountId: string;
  /** Windows from the last successful read (kept when a later read fails). */
  windows: ZaicodeLimitWindow[];
  plan: string | null;
  /** Epoch ms of the last successful read; null = never read. */
  fetchedAt: number | null;
  /** Epoch ms of the last attempt, successful or not. */
  checkedAt: number | null;
  /** Why the last attempt failed, in the vendor's words when possible; null after a success. */
  error: string | null;
  source: string;
  /**
   * Resets the account can spend on demand (Codex hands them out; T-130). Kept from the last read that sent the block;
   * null / absent = the vendor sent none, which is not the same as "0 left".
   */
  resetCredits?: ZaicodeResetCredits | null;
  /** T-136: the last time ZAICODE started an idle window of this account with a tiny request. */
  windowStart?: ZaicodeWindowStartRecord | null;
  /** Per-window attempts: another pool's result must not erase this pool's admission. */
  windowStarts?: Record<string, ZaicodeWindowStartRecord>;
}

/** One start of an idle window (T-136): when, whether the vendor answered, in a few words. */
export interface ZaicodeWindowStartRecord {
  at: number;
  ok: boolean;
  detail: string;
  /** SRC-116: which window this start was for, so one account's cooldown cannot hide a second pool's start. */
  windowKey?: string;
}

export interface ZaicodeEnginesConfig {
  /** Minutes between automatic quota sweeps; 0 = only on demand. */
  intervalMinutes: number;
  /** Read ZCode's plan key (only the plan entry, only sent to the vendor's own host). */
  readZcodeConfig: boolean;
  /** Read Freebuff Desktop's sign-in and ask Freebuff's own host for the quota (read-only GET). */
  readFreebuff: boolean;
  /** Accounts the operator hid from the bar and the meter (still discovered). */
  hiddenAccounts: string[];
  /** First words typed into a new worker (the kick prompt). */
  workerPrompt: string;
  /** Launch workers in YOLO mode (skip per-tool permission prompts), like AUDAPACK consoles. */
  workerYolo: boolean;
  /**
   * T-136: when a window "starts at first use" (not running yet), start it at once with the
   * smallest request the account's CLI can make, so the 5 hours run instead of waiting for you.
   */
  keepWindowsRolling: boolean;
}

export const ZAICODE_ENGINES_DEFAULT_CONFIG: ZaicodeEnginesConfig = {
  intervalMinutes: 5,
  readZcodeConfig: true,
  readFreebuff: true,
  hiddenAccounts: [],
  workerPrompt: "saipen continue",
  workerYolo: true,
  keepWindowsRolling: true,
};

export const ZAICODE_ENGINE_INTERVAL_CHOICES = [0, 2, 5, 10, 15, 30, 60] as const;

export interface ZaicodeEnginesState {
  accounts: ZaicodeEngineAccount[];
  limits: Record<string, ZaicodeLimitSnapshot>;
  sweeping: boolean;
  /** Accounts being read right now. */
  probing: string[];
  lastSweepAt: number | null;
  nextSweepAt: number | null;
  config: ZaicodeEnginesConfig;
}

export function normalizeZaicodeEnginesConfig(raw: unknown): ZaicodeEnginesConfig {
  const record = (raw && typeof raw === "object" ? raw : {}) as Partial<ZaicodeEnginesConfig>;
  const interval = Number(record.intervalMinutes);
  const hidden = Array.isArray(record.hiddenAccounts)
    ? record.hiddenAccounts.filter((value): value is string => typeof value === "string").slice(0, 64)
    : [];
  const prompt = typeof record.workerPrompt === "string" ? record.workerPrompt.slice(0, ZAICODE_PROMPT_MAX_CHARS) : null;
  return {
    intervalMinutes: (ZAICODE_ENGINE_INTERVAL_CHOICES as readonly number[]).includes(interval)
      ? interval
      : ZAICODE_ENGINES_DEFAULT_CONFIG.intervalMinutes,
    readZcodeConfig:
      typeof record.readZcodeConfig === "boolean"
        ? record.readZcodeConfig
        : ZAICODE_ENGINES_DEFAULT_CONFIG.readZcodeConfig,
    hiddenAccounts: [...new Set(hidden)],
    workerPrompt: prompt ?? ZAICODE_ENGINES_DEFAULT_CONFIG.workerPrompt,
    workerYolo:
      typeof record.workerYolo === "boolean" ? record.workerYolo : ZAICODE_ENGINES_DEFAULT_CONFIG.workerYolo,
    readFreebuff:
      typeof record.readFreebuff === "boolean" ? record.readFreebuff : ZAICODE_ENGINES_DEFAULT_CONFIG.readFreebuff,
    keepWindowsRolling:
      typeof record.keepWindowsRolling === "boolean"
        ? record.keepWindowsRolling
        : ZAICODE_ENGINES_DEFAULT_CONFIG.keepWindowsRolling,
  };
}

// ---------------------------------------------------------------------------
// Rolling windows (T-136)
// ---------------------------------------------------------------------------

/**
 * Vendors whose idle window ZAICODE can start with one bounded request.
 * ZCode uses its Coding Plan endpoint; the other vendors use their own CLI.
 */
export const ZAICODE_WINDOW_STARTER_VENDORS: readonly ZaicodeEngineVendor[] = ["claude", "codex", "antigravity", "zcode"];
/** A started window is not started again for this long (the next reads show it running). */
export const ZAICODE_WINDOW_START_COOLDOWN_MS = 15 * 60_000;
/** A start the vendor refused waits this long before the next try. */
export const ZAICODE_WINDOW_START_RETRY_MS = 60 * 60_000;

/**
 * True when this account has a window that waits for its first request and ZAICODE should
 * start it now: the setting is on, the account is visible, ready and read without error, the
 * window is not held shut by a longer one and not spent, and no start ran recently for THAT
 * window.
 *
 * SRC-116: the cooldown used to be per account, so a second Antigravity pool going idle behind
 * the first one could never be started. This returns the window so the guard can be per window;
 * {@link zaicodeShouldStartIdleWindow} is the boolean form of it.
 */
export function zaicodeIdleWindowToStart(params: {
  account: Pick<ZaicodeEngineAccount, "id" | "vendor" | "status">;
  snapshot: ZaicodeLimitSnapshot | undefined;
  config: Pick<ZaicodeEnginesConfig, "keepWindowsRolling" | "hiddenAccounts">;
  now: number;
}): ZaicodeLimitWindow | null {
  const { account, snapshot, config, now } = params;
  if (!config.keepWindowsRolling) return null;
  if (!ZAICODE_WINDOW_STARTER_VENDORS.includes(account.vendor)) return null;
  if (account.status !== "ready" || config.hiddenAccounts.includes(account.id)) return null;
  if (!snapshot || snapshot.error !== null) return null;
  const holdsWindow = (window: ZaicodeLimitWindow): boolean => {
    const last = windowStartFor(window.key, snapshot.windowStart, snapshot.windowStarts);
    if (!last) return false;
    // 成功请求按真实窗口去重；15 分钟账户级冷却会在另一池刷新后反复花额度。
    const wait = last.ok && last.windowKey
      ? Math.max((window.durationMinutes ?? 0) * 60_000, ZAICODE_WINDOW_START_COOLDOWN_MS)
      : last.ok ? ZAICODE_WINDOW_START_COOLDOWN_MS : ZAICODE_WINDOW_START_RETRY_MS;
    return now - last.at < wait;
  };
  const idle = [...snapshot.windows].sort((left, right) => (left.durationMinutes ?? Infinity) - (right.durationMinutes ?? Infinity)).find(
    (window) =>
      !isZaicodeReserveWindow(window) &&
      isZaicodeWindowWaitingForFirstUse(window) &&
      window.gatedBy === null &&
      window.remainingPercent !== 0 &&
      !holdsWindow(window),
  );
  if (!idle) return null;
  // 主额度耗尽时不能为待命储备触发默认模型请求；储备只供支持它的模型使用。
  if (effectiveZaicodeWindows(snapshot.windows, now).some(
    (window) => !isZaicodeReserveWindow(window) && !isScopedZaicodeWindow(window) && window.remainingPercent === 0,
  )) return null;
  return idle;
}

export function zaicodeShouldStartIdleWindow(params: {
  account: Pick<ZaicodeEngineAccount, "id" | "vendor" | "status">;
  snapshot: ZaicodeLimitSnapshot | undefined;
  config: Pick<ZaicodeEnginesConfig, "keepWindowsRolling" | "hiddenAccounts">;
  now: number;
}): boolean {
  return zaicodeIdleWindowToStart(params) !== null;
}

// ---------------------------------------------------------------------------
// Window labels
// ---------------------------------------------------------------------------

const BASE_WINDOW_LABELS: Record<string, string> = {
  five_hour: "5h",
  weekly: "weekly",
  monthly: "monthly",
  spend_limit: "spend",
};

const WINDOW_MINUTES: Record<string, number> = { five_hour: 300, weekly: 10080, monthly: 43200 };

export function zaicodeWindowLabel(key: string): string {
  const base = BASE_WINDOW_LABELS[key];
  if (base) return base;
  const scoped = /^weekly_(.+)$/.exec(key);
  if (scoped?.[1]) return `weekly ${scoped[1].replace(/_/g, " ")}`;
  const generic = /^window_(\d+)m$/.exec(key);
  if (generic?.[1]) return formatDurationMinutes(Number(generic[1]));
  return key.replace(/_/g, " ");
}

function formatDurationMinutes(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function makeWindow(partial: Partial<ZaicodeLimitWindow> & { key: string }): ZaicodeLimitWindow {
  return {
    key: partial.key,
    label: partial.label ?? zaicodeWindowLabel(partial.key),
    group: partial.group ?? "",
    groupLabel: partial.groupLabel ?? "",
    remainingPercent:
      typeof partial.remainingPercent === "number" && Number.isFinite(partial.remainingPercent)
        ? clampPercent(partial.remainingPercent)
        : null,
    resetsAt:
      typeof partial.resetsAt === "number" && Number.isFinite(partial.resetsAt) ? partial.resetsAt : null,
    durationMinutes: partial.durationMinutes ?? WINDOW_MINUTES[partial.key] ?? null,
    gatedBy: partial.gatedBy ?? null,
    assumedFull: partial.assumedFull ?? false,
    startsOnUse: partial.startsOnUse ?? false,
    ...(typeof partial.rollingFrom === "number" ? { rollingFrom: partial.rollingFrom } : {}),
  };
}

/** How close to "read time + one full window" a reset must be to count as not started. */
export const ZAICODE_IDLE_WINDOW_TOLERANCE_MS = 3 * 60_000;

function windowStartFor(
  key: string,
  latest?: ZaicodeWindowStartRecord | null,
  starts?: Record<string, ZaicodeWindowStartRecord> | null,
): ZaicodeWindowStartRecord | null {
  const record = starts?.[key] ?? latest;
  return record && Number.isFinite(record.at) && (!record.windowKey || record.windowKey === key) ? record : null;
}

/**
 * The one definition of "this window is full", and it is the number the surfaces
 * actually RENDER: `ZaicodeLimitViews` prints `Math.round(remainingPercent)`.
 *
 * T-188: admission used to test the raw number instead, so a vendor reporting
 * 99.8240 for a window it had barely touched was read as spent while the same
 * window DISPLAYED "100%". Antigravity never reports a literal 100 again after
 * the first bounded request, so that disagreement made every automatic starter
 * unreachable on the one vendor that ships rolling windows -- the user watched a
 * full window refuse to start. One rounding, one meaning.
 */
export function zaicodeWindowIsFull(window: Pick<ZaicodeLimitWindow, "remainingPercent">): boolean {
  return window.remainingPercent === null || Math.round(window.remainingPercent) >= 100;
}

/**
 * Marks windows that have not started (SRC-048). A vendor that has seen no
 * request in the current window reports its reset as read time + the window's
 * length; read again five minutes later, it says the same "5 h" again. That is
 * not a coming refill, it is a window that starts with the first request.
 *
 * An idle read is not a successful start. Only a matching completion followed by
 * the vendor's fixed reset can make a rounded-full window count down.
 */
export function markZaicodeWindowsStartingOnUse(
  windows: readonly ZaicodeLimitWindow[],
  readAt: number,
  previousStart?: ZaicodeWindowStartRecord | null,
  _previousWindows?: readonly ZaicodeLimitWindow[] | null,
  previousStarts?: Record<string, ZaicodeWindowStartRecord> | null,
): ZaicodeLimitWindow[] {
  return windows.map((window) => {
    const previous = windowStartFor(window.key, previousStart, previousStarts);
    const minutes = window.durationMinutes;
    const looksIdle =
      window.resetsAt !== null &&
      minutes !== null &&
      minutes > 0 &&
      Math.abs(window.resetsAt - (readAt + minutes * 60_000)) <= ZAICODE_IDLE_WINDOW_TOLERANCE_MS;
    const durationMs = (minutes ?? 0) * 60_000;
    // 首次消费可能被供应商四舍五入成 0%；成功请求后的固定 reset 时间才证明窗口已启动。
    const anchoredAfterStart =
      previous?.ok === true &&
      window.resetsAt !== null &&
      readAt - previous.at >= 10_000 &&
      readAt - previous.at < durationMs &&
      window.resetsAt > readAt &&
      window.resetsAt <= previous.at + durationMs + 5_000;
    // 旧缓存的本地锚点不是供应商启动证据；必须保留待启动状态让 admission 可达。
    const waitingFromCache = window.startsOnUse === true && !anchoredAfterStart;
    // T-188: a ROLLING vendor (Antigravity) has no starts-on-use shape at all. It
    // reports resetsAt = last real start + the window length, so a cycle nobody has
    // touched still carries the PREVIOUS cycle's reset, already in the past.
    // Neither looksIdle nor waitingFromCache can see that, which is how every
    // automatic starter on that vendor became unreachable. A vendor reset that has
    // passed while the window still reads full IS the untouched new cycle.
    const rolledOverUntouched = window.resetsAt !== null && window.resetsAt <= readAt && zaicodeWindowIsFull(window);
    const idle =
      (looksIdle || waitingFromCache || rolledOverUntouched) &&
      zaicodeWindowIsFull(window) &&
      !anchoredAfterStart;
    if (!idle) {
      if (window.startsOnUse === false && window.rollingFrom === undefined && !anchoredAfterStart) return window;
      const { rollingFrom: _dropped, ...started } = window;
      return {
        ...started,
        startsOnUse: false,
        ...(anchoredAfterStart && zaicodeWindowIsFull(window) ? { rollingFrom: previous!.at } : {}),
      };
    }
    const { rollingFrom: _dropped, ...waiting } = window;
    return { ...waiting, startsOnUse: true };
  });
}

/** A rounded-full window with a vendor-backed start has a real coming reset. */
export function isZaicodeRollingWindow(window: Pick<ZaicodeLimitWindow, "startsOnUse" | "rollingFrom">): boolean {
  return typeof window.rollingFrom === "number";
}

/**
 * SRC-116: the ONE definition of "this window has nobody using it yet". Every surface
 * (reset text, refill time, scheduler trigger, topbar clock, SAIHOME) asked this question in
 * its own words and gave different answers, which is how a window could be "started 13 min ago"
 * in one tooltip and "starts on first use" in the row below it.
 */
export function isZaicodeWindowWaitingForFirstUse(
  window: Pick<ZaicodeLimitWindow, "startsOnUse" | "rollingFrom">,
): boolean {
  return window.startsOnUse === true && window.rollingFrom === undefined;
}

/** A reset that is a real coming refill: known, ahead, not waiting on a request, not gated. */
export function isZaicodeRealReset(window: ZaicodeLimitWindow, now: number): boolean {
  return (
    window.resetsAt !== null &&
    window.resetsAt > now &&
    !isZaicodeWindowWaitingForFirstUse(window) &&
    window.gatedBy === null
  );
}

/**
 * SRC-116: whether a window deserves a countdown in the surfaces that show the next reset.
 * A window ZAICODE rolls itself sits at 100% by construction (0% consumed), so the old
 * "skip anything at 100%" filter hid every rolling window from the topbar clock and SAIHOME
 * while the engine tile still counted it down.
 */
export function zaicodeWindowShowsLiveCountdown(window: ZaicodeLimitWindow, now: number): boolean {
  if (!isZaicodeRealReset(window, now)) return false;
  // The RAW figure on purpose, and deliberately not zaicodeWindowIsFull. Admission rounds
  // because it decides whether a cycle may be started again; this decides whether a reset
  // the vendor itself reported may be shown. Antigravity reports 99.9487 for a window it
  // has barely touched: that IS a vendor-backed window with a real future reset, and
  // rounding it to 100 here would delete a truthful countdown from the topbar and SAIHOME.
  return window.remainingPercent === null || window.remainingPercent < 100 || isZaicodeRollingWindow(window);
}

// ---------------------------------------------------------------------------
// Parsers (pure; every one drops what it cannot read instead of guessing)
// ---------------------------------------------------------------------------

const CLAUDE_LINE =
  /^(?<title>[^:]+):\s*(?<pct>\d{1,3})%\s*used(?:\s*[··-]\s*resets\s*(?<when>[^(\n]+?)\s*(?:\((?<tz>[^)]*)\))?)?\s*$/;
const CLAUDE_WHEN =
  /^(?<month>[A-Z][a-z]{2})\s+(?<day>\d{1,2})(?:,\s*(?<year>\d{4}))?,\s*(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<ampm>[ap]m)$/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const CLAUDE_TITLES: Record<string, string> = {
  "current session": "five_hour",
  "current week (all models)": "weekly",
  "spend limit": "spend_limit",
};

/** Offset of `timeZone` from UTC at `epoch`, in ms (null when the zone is unknown to Intl). */
function zoneOffsetMs(epoch: number, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(epoch));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return Number.isFinite(asUtc) ? asUtc - Math.floor(epoch / 1000) * 1000 : null;
  } catch {
    return null;
  }
}

/** Wall-clock time in an IANA zone -> epoch ms (two passes settle a DST edge). */
export function zonedWallTimeToEpoch(
  wall: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): number | null {
  const guess = Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute);
  const first = zoneOffsetMs(guess, timeZone);
  if (first === null) return null;
  const second = zoneOffsetMs(guess - first, timeZone);
  return guess - (second ?? first);
}

/**
 * "Sep 3, 4:49pm" -> epoch ms, or null. The CLI prints the zone it used in
 * parentheses ("(Europe/Tallinn)"); that zone wins, so a ZAICODE started
 * with a different TZ reads the same instant. Without a zone: local time.
 */
export function parseClaudeResetTime(text: string, now: number = Date.now(), timeZone?: string | null): number | null {
  const match = CLAUDE_WHEN.exec(text.trim());
  if (!match?.groups) return null;
  const month = MONTHS.indexOf((match.groups.month ?? "").toLowerCase());
  if (month < 0) return null;
  let hour = Number(match.groups.hour) % 12;
  if ((match.groups.ampm ?? "").toLowerCase() === "pm") hour += 12;
  const year = match.groups.year ? Number(match.groups.year) : new Date(now).getFullYear();
  const wall = { year, month, day: Number(match.groups.day), hour, minute: Number(match.groups.minute ?? 0) };
  const zone = timeZone?.trim();
  if (zone) {
    const zoned = zonedWallTimeToEpoch(wall, zone);
    if (zoned !== null) return zoned;
  }
  const moment = new Date(wall.year, wall.month, wall.day, wall.hour, wall.minute);
  return Number.isFinite(moment.getTime()) ? moment.getTime() : null;
}

/**
 * A reset further away than the window itself (plus slack) is a misread
 * (wrong zone, wrong year), not a fact: drop it rather than show "5h window
 * resets in 6h 30m".
 */
export function plausibleZaicodeReset(resetsAt: number | null, durationMinutes: number | null, now: number): number | null {
  if (resetsAt === null) return null;
  if (durationMinutes === null) return resetsAt;
  return resetsAt - now > (durationMinutes + 15) * 60_000 ? null : resetsAt;
}

/** Claude Code's `/usage` answer -> windows. Unparseable lines are dropped. */
export function parseClaudeUsageText(text: string, now: number = Date.now()): ZaicodeLimitWindow[] {
  const windows: ZaicodeLimitWindow[] = [];
  for (const rawLine of (text ?? "").split(/\r?\n/)) {
    const match = CLAUDE_LINE.exec(rawLine.trim());
    if (!match?.groups) continue;
    const title = (match.groups.title ?? "").split(/\s+/).join(" ").toLowerCase();
    let key = CLAUDE_TITLES[title];
    if (!key) {
      const scoped = /^current week \((.+)\)$/.exec(title);
      if (!scoped?.[1]) continue;
      key = `weekly_${scoped[1].replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
    }
    if (windows.some((window) => window.key === key)) continue;
    const used = clampPercent(Number(match.groups.pct));
    const durationMinutes = key.startsWith("weekly") ? 10080 : (WINDOW_MINUTES[key] ?? null);
    const resetsAt = match.groups.when ? parseClaudeResetTime(match.groups.when, now, match.groups.tz) : null;
    windows.push(
      makeWindow({
        key,
        remainingPercent: 100 - used,
        resetsAt: plausibleZaicodeReset(resetsAt, durationMinutes, now),
        durationMinutes,
      }),
    );
  }
  return windows;
}

const CODEX_DURATIONS: Record<number, string> = { 300: "five_hour", 10080: "weekly", 43200: "monthly" };

function codexWindowKey(duration: unknown): string | null {
  const minutes = Number(duration);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return CODEX_DURATIONS[minutes] ?? `window_${Math.round(minutes)}m`;
}

function epochMs(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e11 ? value : value * 1000;
    return ms > 1e12 && ms < 1e14 ? ms : null;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function humanize(raw: string): string {
  return raw
    .split(/[_\-.\s]+/)
    .filter(Boolean)
    .map((word) =>
      ["gpt", "ai", "llm", "api"].includes(word.toLowerCase())
        ? word.toUpperCase()
        : /[A-Z]/.test(word)
          ? word
          : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

export interface ZaicodeCodexParse {
  windows: ZaicodeLimitWindow[];
  plan: string | null;
}

/** `account/rateLimits/read` result -> windows (default pool plus named pools). */
export function parseCodexRateLimits(result: unknown): ZaicodeCodexParse {
  const record = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const snapshot = (record.rateLimits && typeof record.rateLimits === "object"
    ? record.rateLimits
    : {}) as Record<string, unknown>;
  const byId = record.rateLimitsByLimitId;
  const pools =
    byId && typeof byId === "object" && !Array.isArray(byId)
      ? Object.entries(byId as Record<string, unknown>)
      : [];
  const windows: ZaicodeLimitWindow[] = [];
  const add = (source: unknown, group: string, groupLabel: string) => {
    if (!source || typeof source !== "object") return;
    const bucket = source as Record<string, unknown>;
    const key = codexWindowKey(bucket.windowDurationMins);
    if (!key) return;
    const fullKey = group ? `${key}@${group}` : key;
    if (windows.some((window) => window.key === fullKey)) return;
    const used = typeof bucket.usedPercent === "number" ? bucket.usedPercent : null;
    windows.push(
      makeWindow({
        key: fullKey,
        label: groupLabel ? `${groupLabel} ${zaicodeWindowLabel(key)}` : zaicodeWindowLabel(key),
        group,
        groupLabel,
        remainingPercent: used === null ? null : 100 - used,
        resetsAt: epochMs(bucket.resetsAt),
        durationMinutes: Number(bucket.windowDurationMins) || null,
      }),
    );
  };
  const codexPool = pools.find(([id]) => id.toLowerCase() === "codex");
  if (!codexPool) {
    add(snapshot.primary, "", "");
    add(snapshot.secondary, "", "");
  }
  // 后端对象插入顺序不保证主额度在前；主池先显示，备用池始终放最后。
  for (const [id, raw] of [...pools].sort(([left], [right]) => Number(left.toLowerCase() !== "codex") - Number(right.toLowerCase() !== "codex"))) {
    if (!raw || typeof raw !== "object") continue;
    const pool = raw as Record<string, unknown>;
    const isDefault = id.toLowerCase() === "codex";
    const label = isDefault
      ? ""
      : typeof pool.limitName === "string" && pool.limitName.trim()
        ? humanize(pool.limitName)
        : humanize(id);
    add(pool.primary, isDefault ? "" : id, label);
    add(pool.secondary, isDefault ? "" : id, label);
  }
  let plan = typeof snapshot.planType === "string" ? snapshot.planType : null;
  if (!plan) {
    for (const [, raw] of pools) {
      const candidate = (raw as Record<string, unknown> | null)?.planType;
      if (typeof candidate === "string" && candidate) {
        plan = candidate;
        break;
      }
    }
  }
  return { windows, plan };
}

const ANTIGRAVITY_WINDOWS: Record<string, string> = {
  "5h": "five_hour",
  five_hour: "five_hour",
  weekly: "weekly",
  "7d": "weekly",
  monthly: "monthly",
  "30d": "monthly",
};

/**
 * `agy -p "/usage" --output-format json` -> windows. Groups are independent
 * pools. A `disabled` bucket is superseded by its pool's spent weekly window:
 * it is kept at ZERO remaining (never believed as "100% free").
 */
export function parseAntigravityUsage(payload: unknown): ZaicodeLimitWindow[] {
  const command = (payload as { command?: { data?: { groups?: unknown } } } | null)?.command;
  const groups = command?.data?.groups;
  if (!Array.isArray(groups)) return [];
  const windows: ZaicodeLimitWindow[] = [];
  groups.forEach((rawGroup, index) => {
    if (!rawGroup || typeof rawGroup !== "object") return;
    const group = rawGroup as { name?: unknown; buckets?: unknown };
    const label = typeof group.name === "string" && group.name.trim() ? group.name.trim() : `Pool ${index + 1}`;
    const groupId = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || `pool${index + 1}`;
    if (!Array.isArray(group.buckets)) return;
    for (const rawBucket of group.buckets) {
      if (!rawBucket || typeof rawBucket !== "object") continue;
      const bucket = rawBucket as Record<string, unknown>;
      const key = ANTIGRAVITY_WINDOWS[String(bucket.window ?? "").trim().toLowerCase()];
      if (!key) continue;
      const disabled = bucket.disabled === true;
      const fraction = typeof bucket.remaining_fraction === "number" ? bucket.remaining_fraction : null;
      const remaining =
        fraction !== null && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 ? fraction * 100 : null;
      const resetTime = epochMs(bucket.reset_time);
      // T-143: a bucket with a reset time but no fraction is a window at 0% consumed,
      // not a bucket to hide. Antigravity omits the fraction until the first request.
      if (remaining === null && !disabled && resetTime === null) continue;
      const shortGroup = /gemini/i.test(label) ? "Gemini" : /claude|gpt/i.test(label) ? "Claude & GPT" : label;
      windows.push(
        makeWindow({
          key: `${key}@${groupId}`,
          label: `${shortGroup} ${zaicodeWindowLabel(key)}`,
          group: groupId,
          groupLabel: label,
          remainingPercent: disabled ? 0 : (remaining ?? 100),
          resetsAt: resetTime,
          durationMinutes: WINDOW_MINUTES[key] ?? null,
        }),
      );
    }
  });
  return windows;
}

export interface ZaicodeZcodeParse {
  windows: ZaicodeLimitWindow[];
  level: string | null;
  error: string | null;
}

/**
 * ZCode monitor envelope -> windows. `unit` selects the window (3/5 = 5h,
 * 6 = weekly); `currentValue + remaining` is the honest total on both payload
 * shapes, so a row without both halves is dropped.
 */
export function parseZcodeQuota(envelope: unknown): ZaicodeZcodeParse {
  if (!envelope || typeof envelope !== "object") {
    return { windows: [], level: null, error: "ZCode quota endpoint did not return an object" };
  }
  const record = envelope as Record<string, unknown>;
  const code = record.code;
  const success = record.success !== false && (code === undefined || code === null || code === 0 || code === 200);
  if (!success) {
    const message = [record.msg, record.message].find((value) => typeof value === "string" && value.trim());
    const text = typeof message === "string" ? message.trim() : "";
    if (/不存在coding plan|没有资格|no coding plan/i.test(text)) {
      return { windows: [], level: null, error: "no active Coding Plan on this account" };
    }
    return { windows: [], level: null, error: text ? `ZCode refused: ${text.slice(0, 120)}` : "ZCode refused" };
  }
  const data = (record.data && typeof record.data === "object" ? record.data : {}) as Record<string, unknown>;
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const windows: ZaicodeLimitWindow[] = [];
  for (const raw of limits) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const type = String(entry.type ?? "").toUpperCase();
    const unit = Number(entry.unit);
    const number = Number(entry.number);
    let key: string | null = null;
    if (type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT") {
      if (unit === 3 && number === 5) key = "five_hour";
      else if (unit === 6) key = "weekly";
    } else if (type === "TIME_LIMIT" && unit === 5 && number === 1) {
      key = "monthly";
    }
    if (!key || windows.some((window) => window.key === key)) continue;
    const spent = typeof entry.currentValue === "number" ? entry.currentValue : null;
    const left = typeof entry.remaining === "number" ? entry.remaining : null;
    if (spent === null || left === null) continue;
    // T-143: 0 of 0 is a window at exactly 0% consumed, not a row to throw away.
    const total = spent + left;
    windows.push(
      makeWindow({ key, remainingPercent: total <= 0 ? 100 : (left / total) * 100, resetsAt: epochMs(entry.nextResetTime) }),
    );
  }
  windows.sort((left, right) => (left.durationMinutes ?? 1e9) - (right.durationMinutes ?? 1e9));
  const level = typeof data.level === "string" && data.level.trim() ? data.level.trim() : null;
  return { windows, level, error: windows.length ? null : "ZCode reported no readable quota window" };
}

export interface ZaicodeFreebuffParse {
  windows: ZaicodeLimitWindow[];
  plan: string | null;
  error: string | null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function trimAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

const FREEBUFF_LEGACY_WINDOWS: readonly [pool: "plan" | "free", key: string, minutes: number, used: string, limit: string, reset: string | null][] = [
  ["plan", "day", 1440, "dayUsed", "dayLimit", "dayResetAt"],
  ["plan", "five_day", 7200, "fiveDayUsed", "fiveDayLimit", null],
  ["plan", "month", 43200, "monthUsed", "monthLimit", "periodEndsAt"],
  ["free", "day", 1440, "dayUsed", "dayLimit", "dayResetAt"],
  ["free", "week", 10080, "weekUsed", "weekLimit", null],
  ["free", "month", 43200, "monthUsed", "monthLimit", null],
];

/**
 * Freebuff Desktop's own session read (`GET /api/v1/freebuff/session`, the
 * call its header refreshes with; FastPrompter's provider is the reference)
 * -> windows. Two account models, never merged:
 * - Freebucks: one daily pool, `daily.remaining` of `daily.limit` (REMAINING,
 *   the vendor says "X of today's Y left"), plus a wallet that never resets
 *   (a balance, so it goes into the plan line, not into a meter);
 * - legacy sessions: the plan's premium sessions and the free sessions are
 *   two independent pools (a spent plan never zeroes the free one).
 */
export function parseFreebuffSession(body: unknown): ZaicodeFreebuffParse {
  if (!body || typeof body !== "object") {
    return { windows: [], plan: null, error: "Freebuff session endpoint did not return an object" };
  }
  const session = body as Record<string, unknown>;
  const freebucks = session.freebucks as Record<string, unknown> | undefined;
  const daily = freebucks && typeof freebucks === "object" ? (freebucks.daily as Record<string, unknown> | undefined) : undefined;
  if (daily && typeof daily === "object") {
    const remaining = finiteNumber(daily.remaining);
    const limit = finiteNumber(daily.limit);
    if (remaining !== null && limit !== null && limit > 0) {
      const wallet = (freebucks!.wallet as Record<string, unknown> | undefined) ?? undefined;
      const walletBalance = wallet && typeof wallet === "object" ? finiteNumber(wallet.balance) : null;
      const planId = typeof freebucks!.planId === "string" && freebucks!.planId.trim() ? freebucks!.planId.trim() : "Freebucks";
      const plan = [
        planId,
        `${trimAmount(Math.max(0, remaining))}/${trimAmount(limit)} FB today`,
        walletBalance !== null ? `wallet ${trimAmount(walletBalance)} FB` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        windows: [
          makeWindow({
            key: "daily",
            label: "daily",
            remainingPercent: (Math.max(0, Math.min(remaining, limit)) / limit) * 100,
            resetsAt: epochMs(daily.resetAt),
            durationMinutes: 1440,
          }),
        ],
        plan,
        error: null,
      };
    }
  }
  const windows: ZaicodeLimitWindow[] = [];
  const subscription = session.subscription as Record<string, unknown> | undefined;
  const pools: Record<"plan" | "free", Record<string, unknown> | undefined> = {
    plan: subscription && typeof subscription.usage === "object" ? (subscription.usage as Record<string, unknown>) : undefined,
    free: session.freeWindows && typeof session.freeWindows === "object" ? (session.freeWindows as Record<string, unknown>) : undefined,
  };
  for (const [pool, key, minutes, usedField, limitField, resetField] of FREEBUFF_LEGACY_WINDOWS) {
    const source = pools[pool];
    if (!source) continue;
    const used = finiteNumber(source[usedField]);
    const limit = finiteNumber(source[limitField]);
    if (used === null || limit === null || limit <= 0) continue;
    const label = `${pool === "plan" ? "Plan" : "Free"} ${key === "five_day" ? "5 days" : key}`;
    windows.push(
      makeWindow({
        key: `${key}@${pool}`,
        label,
        group: pool,
        groupLabel: pool === "plan" ? "Plan sessions" : "Free sessions",
        remainingPercent: ((limit - Math.max(0, Math.min(used, limit))) / limit) * 100,
        resetsAt: resetField ? epochMs(source[resetField]) : null,
        durationMinutes: minutes,
      }),
    );
  }
  if (windows.length === 0) {
    return { windows, plan: null, error: "Freebuff reported neither Freebucks nor session quota for this account" };
  }
  const tier = subscription && typeof subscription.tierId === "string" && subscription.tierId ? subscription.tierId : "Legacy sessions";
  return { windows, plan: tier, error: null };
}

// ---------------------------------------------------------------------------
// Effective quota (gating, elapsed resets, bottleneck)
// ---------------------------------------------------------------------------

/**
 * The windows as they stand NOW: a window whose own reset time passed reads
 * full (the clock proved it), and a spent longer window zeroes the shorter
 * windows of ITS OWN pool only (a spent Claude weekly never fakes a dead
 * Gemini 5h window).
 */
export function effectiveZaicodeWindows(
  windows: readonly ZaicodeLimitWindow[],
  now: number = Date.now(),
): ZaicodeLimitWindow[] {
  const refreshed = windows.map((window) =>
    window.resetsAt !== null && window.resetsAt <= now && window.remainingPercent !== null
      ? { ...window, remainingPercent: 100, assumedFull: true, gatedBy: null }
      : { ...window, gatedBy: null },
  );
  return refreshed.map((window) => {
    const blocker = refreshed.find(
      (other) =>
        other !== window &&
        !isScopedZaicodeWindow(other) &&
        other.group === window.group &&
        (other.durationMinutes ?? 0) > (window.durationMinutes ?? 0) &&
        other.remainingPercent !== null &&
        other.remainingPercent <= 0,
    );
    return blocker ? { ...window, remainingPercent: 0, gatedBy: blocker.label } : window;
  }).sort((left, right) => Number(isZaicodeReserveWindow(left)) - Number(isZaicodeReserveWindow(right)));
}

/**
 * Per-model scoped windows (Claude "Current week (Sonnet)") and spend caps
 * only limit part of an account; they are shown but never decide whether the
 * engine as a whole can work.
 */
export function isScopedZaicodeWindow(window: ZaicodeLimitWindow): boolean {
  return window.key.startsWith("weekly_") || window.key.startsWith("spend_limit");
}

/** Codex standby quota is a fallback pool, not a reason to start its primary window. */
export function isZaicodeReserveWindow(window: Pick<ZaicodeLimitWindow, "group" | "groupLabel">): boolean {
  return /reserve/i.test(`${window.group} ${window.groupLabel}`);
}

/** The window that runs out first — what decides whether an engine can work now. */
export function zaicodeBottleneck(
  windows: readonly ZaicodeLimitWindow[],
  now: number = Date.now(),
): ZaicodeLimitWindow | null {
  const effective = effectiveZaicodeWindows(windows, now).filter((window) => window.remainingPercent !== null && !isScopedZaicodeWindow(window));
  if (windows.some(isZaicodeReserveWindow)) {
    const primaryLimit = bestZaicodeQuotaPool(effective.filter((window) => !isZaicodeReserveWindow(window)));
    // Reserve is only usable after a primary limit has actually run out.
    if (primaryLimit?.remainingPercent !== 0) return primaryLimit;
  }
  return bestZaicodeQuotaPool(effective);
}

/** Independent pools need one usable pool; within each pool the tightest window wins. */
function bestZaicodeQuotaPool(windows: readonly ZaicodeLimitWindow[]): ZaicodeLimitWindow | null {
  const pools = new Map<string, ZaicodeLimitWindow>();
  for (const window of windows) {
    const previous = pools.get(window.group);
    if (!previous || window.remainingPercent! < previous.remainingPercent!) pools.set(window.group, window);
  }
  let bestPool: ZaicodeLimitWindow | null = null;
  for (const poolWorst of pools.values()) {
    if (!bestPool || poolWorst.remainingPercent! > bestPool.remainingPercent!) {
      bestPool = poolWorst;
    }
  }
  return bestPool;
}

export type ZaicodeEngineAvailability = "available" | "low" | "blocked" | "unknown";

export const ZAICODE_LOW_QUOTA_PERCENT = 20;

export function zaicodeEngineAvailability(
  snapshot: ZaicodeLimitSnapshot | undefined,
  now: number = Date.now(),
): ZaicodeEngineAvailability {
  if (!snapshot || snapshot.windows.length === 0) return "unknown";
  const bottleneck = zaicodeBottleneck(snapshot.windows, now);
  if (!bottleneck || bottleneck.remainingPercent === null) return "unknown";
  if (bottleneck.remainingPercent <= 0) return "blocked";
  if (bottleneck.remainingPercent < ZAICODE_LOW_QUOTA_PERCENT) return "low";
  return "available";
}

/** When a blocked engine comes back: the reset of the window that gates it. */
export function zaicodeNextRefillAt(
  snapshot: ZaicodeLimitSnapshot | undefined,
  now: number = Date.now(),
): number | null {
  if (!snapshot) return null;
  const effective = effectiveZaicodeWindows(snapshot.windows, now);
  const spent = effective.filter((window) => window.remainingPercent !== null && window.remainingPercent <= 0);
  let latest: number | null = null;
  for (const window of spent) {
    const gate = window.gatedBy ? effective.find((other) => other.label === window.gatedBy) : window;
    // T-143: a window ZAICODE rolls itself has a local end time; only a window still
    // waiting on somebody's first request has none.
    const at = gate && !isZaicodeWindowWaitingForFirstUse(gate) ? gate.resetsAt : null;
    if (at !== null && at > now && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

/** "now", "12m", "3h 05m", "2d 4h". */
export function formatZaicodeDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * The reset text of one window: blocked by a longer one, waiting for first
 * use, refilled, or the vendor's reset time.
 */
export function formatZaicodeWindowReset(window: ZaicodeLimitWindow, now: number = Date.now()): string {
  if (window.gatedBy) return `blocked by ${window.gatedBy}`;
  if (window.assumedFull) return "refilled";
  if (isZaicodeWindowWaitingForFirstUse(window)) {
    return window.durationMinutes ? `starts on first use (${zaicodeWindowLabel(window.key)} window)` : "starts on first use";
  }
  return formatZaicodeReset(window.resetsAt, now);
}

/** "resets in 2h 13m" within two days, otherwise "resets Wed 09:41". */
export function formatZaicodeReset(resetsAt: number | null, now: number = Date.now()): string {
  if (resetsAt === null) return "reset unknown";
  const delta = resetsAt - now;
  if (delta <= 0) return "reset due";
  if (delta < 48 * 3_600_000) return `resets in ${formatZaicodeDuration(delta)}`;
  const date = new Date(resetsAt);
  const day = date.toLocaleDateString("en-US", { weekday: "short" });
  return `resets ${day} ${formatZaicodeTimeOfDay(date)}`;
}

// ---------------------------------------------------------------------------
// Time of day (one 12/24-hour switch for every ZAICODE time display)
// ---------------------------------------------------------------------------

let hour12Preference = false;

/** The clock setting "12-hour clock"; the renderer's timer store keeps it current. */
export function setZaicodeHour12(hour12: boolean): void {
  hour12Preference = hour12;
}

export function readZaicodeHour12(): boolean {
  return hour12Preference;
}

/** "17:05" / "17:05:09", or "5:05 pm" / "5:05:09 pm" on the 12-hour clock. Local time. */
export function formatZaicodeTimeOfDay(date: Date, options: { seconds?: boolean; hour12?: boolean } = {}): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = date.getHours();
  const tail = `${pad(date.getMinutes())}${options.seconds ? `:${pad(date.getSeconds())}` : ""}`;
  if (!(options.hour12 ?? hour12Preference)) return `${pad(hours)}:${tail}`;
  return `${hours % 12 || 12}:${tail} ${hours < 12 ? "am" : "pm"}`;
}

/** ISO-8601 week number (weeks start on Monday; week 1 holds the first Thursday). */
export function zaicodeIsoWeek(date: Date): number {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  return Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

/** Short name of the local time zone ("GMT+3", "EEST", "UTC"), as Intl reports it. */
export function zaicodeTimeZoneName(date: Date): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZoneName: "short" }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Autostart (prepared launches) — pure scheduling
// ---------------------------------------------------------------------------

/**
 * at        run once at a wall-clock time
 * daily     run every day at HH:MM
 * interval  run every N minutes
 * reset     run once when the engine's quota window refills
 * everyReset run after EVERY refill of that window
 */
export type ZaicodeAutostartTrigger = "at" | "daily" | "interval" | "reset" | "everyReset";

/** One run the scheduler started through the queue (so a stop rule can end it). */
export interface ZaicodeScheduledRun {
  /** Queue job id, or `session:<sessionId>` for a MAIN / marked session the schedule continued. */
  jobId: string;
  workspaceKey: string;
  at: number;
}

/**
 * Prompts carry whole audits (SRC-046): no practical cap, only a guard that
 * keeps one schedule inside the renderer's settings storage.
 */
export const ZAICODE_PROMPT_MAX_CHARS = 1_000_000;

/** What a schedule clears out of its target projects before it starts (SRC-046 worker conditions). */
export type ZaicodeScheduleBeforeRun = "none" | "stopWeaker" | "stopAll";
/** Order a section schedule works through its projects in. */
export type ZaicodeScheduleOrder = "problems" | "list";

export interface ZaicodeAutostartJob {
  id: string;
  name: string;
  enabled: boolean;
  /** Project root the worker starts in (`targetKind: "project"`). */
  projectPath: string;
  /** SRC-038: one project, or every project in a sidebar section (MAIN0, MAIN1, ...). */
  targetKind: "project" | "section";
  /** Sidebar section for `targetKind: "section"`. */
  section: string;
  /**
   * Who does the work: a subscription account id (CLI worker), "pool:start"
   * (START in a fresh MAIN session), "pool:<providerId>/<modelId>" (an in-app
   * model) or "agent:<agentId>" (a ZAICODE agent through the queue).
   */
  engineId: string;
  /**
   * The engine whose quota window the reset triggers watch and whose quota
   * gates the start; empty = `engineId` when that is a subscription.
   */
  watchEngineId: string;
  /** "HH:MM": runs this schedule started through the queue are stopped then. Empty = until done. */
  stopAt: string;
  /** Queue runs this schedule started (newest last, at most 20). */
  runs: ZaicodeScheduledRun[];
  trigger: ZaicodeAutostartTrigger;
  /** Epoch ms for `at`. */
  at: number | null;
  /** "HH:MM" local time for `daily`. */
  dailyTime: string;
  intervalMinutes: number;
  /** Window key for reset triggers (five_hour / weekly). */
  window: string;
  /** Prompt the worker starts with. Empty = the engines default kick prompt. */
  prompt: string;
  /**
   * Conditions (SRC-046): before starting, stop the stopgap work in the target
   * projects (sessions on a free pool, workers of a weaker engine) or everything
   * that runs there.
   */
  beforeRun: ZaicodeScheduleBeforeRun;
  /** Skip a target project where something still runs (checked after `beforeRun`). */
  onlyWhenIdle: boolean;
  /** Section schedules: the projects with the most blocked / open tickets go first. */
  order: ZaicodeScheduleOrder;
  /** In-app runners: continue only the sessions the operator marked for the SCHEDULER. */
  onlyMarked: boolean;
  /** Seconds to wait after a reset before firing (the vendor's clock is not ours). */
  safetyDelaySeconds: number;
  /** A due moment later than this many seconds ago is MISSED, never fired late. */
  catchUpSeconds: number;
  /** Skip (retry later) when the engine has no quota at fire time. */
  requireQuota: boolean;
  /** Event ids already fired: one event never fires twice, across restarts. */
  firedEvents: string[];
  lastRunAt: number | null;
  lastResult: string;
  createdAt: number;
}

export type ZaicodeAutostartState =
  | "disabled"
  | "waiting-time"
  | "waiting-reset"
  | "waiting-quota"
  | "due"
  | "missed"
  | "done"
  | "invalid";

export interface ZaicodeAutostartDecision {
  state: ZaicodeAutostartState;
  /** Epoch ms the job is due (or was due), when known. */
  dueAt: number | null;
  /** Unique id of the occurrence, used for exactly-once firing. */
  eventId: string;
  reason: string;
}

export function createZaicodeAutostartJob(
  partial: Partial<ZaicodeAutostartJob> & { id: string; projectPath: string; engineId: string },
  now: number = Date.now(),
): ZaicodeAutostartJob {
  return {
    name: "",
    enabled: true,
    targetKind: "project",
    section: "MAIN0",
    watchEngineId: "",
    stopAt: "",
    runs: [],
    trigger: "reset",
    at: null,
    dailyTime: "08:00",
    intervalMinutes: 60,
    window: "five_hour",
    prompt: "",
    beforeRun: "none",
    onlyWhenIdle: false,
    order: "problems",
    onlyMarked: false,
    safetyDelaySeconds: 60,
    catchUpSeconds: 900,
    requireQuota: true,
    firedEvents: [],
    lastRunAt: null,
    lastResult: "",
    createdAt: now,
    ...partial,
  };
}

function dailyDueAt(time: string, now: number): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const today = new Date(now);
  today.setHours(hours, minutes, 0, 0);
  return today.getTime();
}

/**
 * Pure decision for one job. Safe to call every few seconds, after sleep,
 * after a clock jump and after a restart: the event id makes firing
 * exactly-once, and the catch-up window turns a long-missed moment into
 * MISSED instead of a surprise launch hours later.
 */
export function evaluateZaicodeAutostartJob(
  job: ZaicodeAutostartJob,
  snapshot: ZaicodeLimitSnapshot | undefined,
  now: number = Date.now(),
): ZaicodeAutostartDecision {
  if (!job.enabled) return { state: "disabled", dueAt: null, eventId: "", reason: "disarmed" };
  const catchUp = Math.max(0, job.catchUpSeconds) * 1000;
  const quotaGate = (dueAt: number, eventId: string): ZaicodeAutostartDecision => {
    if (job.firedEvents.includes(eventId)) {
      return { state: "done", dueAt, eventId, reason: "already ran" };
    }
    if (now > dueAt + catchUp) return { state: "missed", dueAt, eventId, reason: "catch-up window passed" };
    if (job.requireQuota && zaicodeAutostartWatchedEngine(job)) {
      const availability = zaicodeEngineAvailability(snapshot, now);
      if (availability === "blocked") {
        return { state: "waiting-quota", dueAt, eventId, reason: "engine has no quota left" };
      }
    }
    return { state: "due", dueAt, eventId, reason: "due now" };
  };

  switch (job.trigger) {
    case "at": {
      if (job.at === null) return { state: "invalid", dueAt: null, eventId: "", reason: "no time set" };
      const eventId = `at:${job.at}`;
      if (now < job.at) return { state: "waiting-time", dueAt: job.at, eventId, reason: "time not reached" };
      return quotaGate(job.at, eventId);
    }
    case "daily": {
      const today = dailyDueAt(job.dailyTime, now);
      if (today === null) return { state: "invalid", dueAt: null, eventId: "", reason: "bad time" };
      const todayEvent = `daily:${new Date(today).toDateString()}`;
      if (now < today || job.firedEvents.includes(todayEvent) || now > today + catchUp) {
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const next = now < today ? today : tomorrow.getTime();
        return { state: "waiting-time", dueAt: next, eventId: `daily:${new Date(next).toDateString()}`, reason: "next run" };
      }
      return quotaGate(today, todayEvent);
    }
    case "interval": {
      const minutes = Math.max(5, Math.round(job.intervalMinutes));
      const base = job.lastRunAt ?? job.createdAt;
      const dueAt = base + minutes * 60_000;
      const eventId = `interval:${dueAt}`;
      if (now < dueAt) return { state: "waiting-time", dueAt, eventId, reason: "interval running" };
      // An interval job never goes MISSED: the next tick is simply now.
      if (job.requireQuota && zaicodeEngineAvailability(snapshot, now) === "blocked" && zaicodeAutostartWatchedEngine(job)) {
        return { state: "waiting-quota", dueAt, eventId, reason: "engine has no quota left" };
      }
      return { state: "due", dueAt, eventId, reason: "interval elapsed" };
    }
    case "reset":
    case "everyReset": {
      const prefix = `reset:${encodeURIComponent(zaicodeAutostartWatchedEngine(job) ?? "none")}:${job.window}:`;
      if (job.trigger === "reset" && job.firedEvents.some((id) => id.startsWith(prefix))) {
        return { state: "done", dueAt: null, eventId: "", reason: "ran after a refill" };
      }
      const window = snapshot?.windows.find((candidate) => candidate.key === job.window)
        ?? snapshot?.windows.find((candidate) => candidate.key.startsWith(`${job.window}@`));
      if (!window || window.resetsAt === null) {
        return { state: "waiting-reset", dueAt: null, eventId: "", reason: "reset time not known yet" };
      }
      // SRC-048: an untouched window reports "read time + 5 h" on every read; waiting for it never ends.
      // T-143: unless ZAICODE is rolling it locally, which gives it a real end time.
      if (isZaicodeWindowWaitingForFirstUse(window)) {
        return { state: "waiting-reset", dueAt: null, eventId: "", reason: "window not started: it starts on first use" };
      }
      const dueAt = window.resetsAt + Math.max(0, job.safetyDelaySeconds) * 1000;
      const eventId = `${prefix}${window.resetsAt}`;
      if (now < dueAt) return { state: "waiting-reset", dueAt, eventId, reason: "waiting for refill" };
      if (job.firedEvents.includes(eventId)) {
        return { state: "waiting-reset", dueAt: null, eventId, reason: "waiting for the next refill" };
      }
      if (now > dueAt + catchUp) return { state: "missed", dueAt, eventId, reason: "catch-up window passed" };
      return { state: "due", dueAt, eventId, reason: "window refilled" };
    }
    default:
      return { state: "invalid", dueAt: null, eventId: "", reason: "unknown trigger" };
  }
}

/**
 * The subscription engine a schedule watches (reset triggers, quota gate), or
 * null when it runs on an in-app pool or an agent and watches nothing.
 */
export function zaicodeAutostartWatchedEngine(job: Pick<ZaicodeAutostartJob, "engineId" | "watchEngineId">): string | null {
  return job.engineId.startsWith("pool:") || job.engineId.startsWith("agent:")
    ? job.watchEngineId || null
    : job.engineId;
}

/** "HH:MM" of a stop rule -> the stop moment for a run that started at `startedAt` (same or next day). */
export function zaicodeScheduleStopAt(stopAt: string, startedAt: number): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(stopAt.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const stop = new Date(startedAt);
  stop.setHours(hours, minutes, 0, 0);
  if (stop.getTime() <= startedAt) stop.setDate(stop.getDate() + 1);
  return stop.getTime();
}

function normalizeScheduledRuns(raw: unknown): ZaicodeScheduledRun[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (run): run is ZaicodeScheduledRun =>
        Boolean(run) &&
        typeof (run as ZaicodeScheduledRun).jobId === "string" &&
        typeof (run as ZaicodeScheduledRun).workspaceKey === "string" &&
        typeof (run as ZaicodeScheduledRun).at === "number",
    )
    .map((run) => ({ jobId: run.jobId, workspaceKey: run.workspaceKey, at: run.at }))
    .slice(-20);
}

export function normalizeZaicodeAutostartJobs(raw: unknown): ZaicodeAutostartJob[] {
  if (!Array.isArray(raw)) return [];
  const jobs: ZaicodeAutostartJob[] = [];
  const triggers: readonly ZaicodeAutostartTrigger[] = ["at", "daily", "interval", "reset", "everyReset"];
  for (const item of raw.slice(0, 64)) {
    if (!item || typeof item !== "object") continue;
    const job = item as Partial<ZaicodeAutostartJob>;
    if (typeof job.id !== "string" || typeof job.projectPath !== "string" || typeof job.engineId !== "string") continue;
    jobs.push(
      createZaicodeAutostartJob({
        id: job.id,
        projectPath: job.projectPath,
        engineId: job.engineId,
        name: typeof job.name === "string" ? job.name.slice(0, 120) : "",
        enabled: job.enabled !== false,
        targetKind: job.targetKind === "section" ? "section" : "project",
        section: typeof job.section === "string" && job.section ? job.section : "MAIN0",
        watchEngineId: typeof job.watchEngineId === "string" ? job.watchEngineId : "",
        stopAt: typeof job.stopAt === "string" && /^\d{1,2}:\d{2}$/.test(job.stopAt.trim()) ? job.stopAt.trim() : "",
        runs: normalizeScheduledRuns(job.runs),
        trigger: triggers.includes(job.trigger as ZaicodeAutostartTrigger) ? job.trigger : "reset",
        at: typeof job.at === "number" && Number.isFinite(job.at) ? job.at : null,
        dailyTime: typeof job.dailyTime === "string" ? job.dailyTime : "08:00",
        intervalMinutes:
          typeof job.intervalMinutes === "number" && job.intervalMinutes >= 5 ? Math.round(job.intervalMinutes) : 60,
        window: typeof job.window === "string" && job.window ? job.window : "five_hour",
        prompt: typeof job.prompt === "string" ? job.prompt.slice(0, ZAICODE_PROMPT_MAX_CHARS) : "",
        beforeRun: job.beforeRun === "stopWeaker" || job.beforeRun === "stopAll" ? job.beforeRun : "none",
        onlyWhenIdle: job.onlyWhenIdle === true,
        order: job.order === "list" ? "list" : "problems",
        onlyMarked: job.onlyMarked === true,
        safetyDelaySeconds:
          typeof job.safetyDelaySeconds === "number" ? Math.min(3600, Math.max(0, job.safetyDelaySeconds)) : 60,
        catchUpSeconds:
          typeof job.catchUpSeconds === "number" ? Math.min(86_400, Math.max(60, job.catchUpSeconds)) : 900,
        requireQuota: job.requireQuota !== false,
        firedEvents: Array.isArray(job.firedEvents)
          ? job.firedEvents.filter((id): id is string => typeof id === "string").slice(-40).map((id) => {
            // 旧事件按当时实际 Watch 归属迁移，不能把 A1 历史误认作新选择的 A2。
            const legacy = /^reset:([^:]+):(\d+)$/.exec(id);
            const oldWatch = job.watchEngineId || zaicodeAutostartWatchedEngine(job as ZaicodeAutostartJob) || "none";
            return legacy ? `reset:${encodeURIComponent(oldWatch)}:${legacy[1]}:${legacy[2]}` : id;
          })
          : [],
        lastRunAt: typeof job.lastRunAt === "number" ? job.lastRunAt : null,
        lastResult: typeof job.lastResult === "string" ? job.lastResult.slice(0, 300) : "",
        createdAt: typeof job.createdAt === "number" ? job.createdAt : Date.now(),
      }),
    );
  }
  return jobs;
}
