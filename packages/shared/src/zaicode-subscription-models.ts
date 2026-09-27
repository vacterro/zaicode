/**
 * Subscriptions as models (SRC-061): every subscription account connected in
 * 9router (Codex, Claude Code, Antigravity, ...) is a provider of its own in
 * ZAICODE's model menu -- "Codex 1", "Claude 2" -- with that vendor's models
 * under it and a real reasoning effort next to it. Pick the account, then the
 * model, then the effort.
 *
 * 9router has no per-request account pin for chat: it serves a vendor with
 * the connection that has the lowest priority and is not resting after a
 * limit hit ("fill-first"), and falls through to the next one when that one
 * is out. So each account provider points at ZAICODE's own small proxy with
 * the account in the path (`/acct/<connectionId>/v1`); the proxy (desktop
 * main) puts that account first before it hands the request to 9router. The
 * other accounts of the vendor stay behind it as fuel.
 *
 * This module is the pure half: which accounts, their names, their models
 * and efforts, what to change in the model list, and how ready an account is.
 */

import {
  zaicodeRouterAliasOf,
  type ZaicodeRouterConnection,
  type ZaicodeRouterModel,
} from "./zaicode-router.js";

// ---------------------------------------------------------------------------
// The proxy address: the account rides in the path
// ---------------------------------------------------------------------------

const ACCOUNT_SEGMENT = "acct";

/** Base URL of one account's provider: `<proxy>/acct/<connectionId>/v1`. */
export function zaicodeSubscriptionBaseUrl(proxyUrl: string, connectionId: string): string {
  return `${proxyUrl.replace(/\/+$/, "")}/${ACCOUNT_SEGMENT}/${encodeURIComponent(connectionId)}/v1`;
}

/** The account a provider's base URL names, or null when it is not an account provider. */
export function zaicodeSubscriptionConnectionOf(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  const match = /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/acct\/([^/]+)\/v1\/?$/i.exec(baseUrl.trim());
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

/** A request path the proxy received -> the account and the 9router path (`/v1/...`). */
export function parseZaicodeSubscriptionPath(path: string): { connectionId: string; rest: string } | null {
  const match = /^\/acct\/([^/?#]+)(\/v1(?:[/?#].*)?)$/.exec(path);
  if (!match) return null;
  try {
    const connectionId = decodeURIComponent(match[1]!);
    return connectionId ? { connectionId, rest: match[2]! } : null;
  } catch {
    return null;
  }
}

/**
 * What 9router routes: `cx/gpt-5.5`. The menu shows the bare id; the proxy
 * adds the vendor back (a custom 9router node routes under its own prefix).
 */
export function zaicodeRoutedModelId(provider: string, modelId: string, prefix?: string | null): string {
  const alias = prefix || zaicodeRouterAliasOf(provider);
  return modelId.startsWith(`${alias}/`) || modelId.startsWith(`${provider}/`) ? modelId : `${alias}/${modelId}`;
}

// ---------------------------------------------------------------------------
// Vendors: names and the efforts 9router really passes on
// ---------------------------------------------------------------------------

const VENDOR_LABELS: Readonly<Record<string, string>> = {
  antigravity: "Antigravity",
  claude: "Claude",
  cline: "Cline",
  codex: "Codex",
  cursor: "Cursor",
  "gemini-cli": "Gemini CLI",
  github: "Copilot",
  "grok-cli": "Grok",
  iflow: "iFlow",
  kilocode: "Kilo",
  kiro: "Kiro",
  opencode: "OpenCode",
  qoder: "Qoder",
  qwen: "Qwen",
};

export function zaicodeSubscriptionVendorLabel(provider: string): string {
  return VENDOR_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/**
 * The efforts a thinking model of this vendor takes, weakest first. 9router
 * reads `reasoning_effort` and turns it into each vendor's own knob (Codex
 * `reasoning.effort`, Claude's thinking budget, Gemini's thinking level); it
 * clamps what a vendor does not have, so only levels that change something
 * are offered.
 */
export function zaicodeSubscriptionEfforts(provider: string): readonly string[] {
  if (provider === "codex" || provider === "github" || provider === "cursor") return ["low", "medium", "high", "xhigh"];
  return ["low", "medium", "high"];
}

/** The request field the chosen effort becomes (ZCode option map language). */
export const ZAICODE_SUBSCRIPTION_EFFORT_MAP = '{"reasoning_effort": reasoningLevel}';

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface ZaicodeSubscriptionAccount {
  connectionId: string;
  /** 9router provider id: codex, claude, antigravity, ... */
  provider: string;
  /** The name in the model menu: "Codex 1", or "Antigravity" when it is the only one. */
  label: string;
  /** Who the account is (email or 9router's name for it). */
  identity: string;
  active: boolean;
}

/**
 * Every OAuth account in 9router, numbered per vendor in the order they were
 * connected, so a name does not move when priorities change.
 */
export function zaicodeSubscriptionAccounts(connections: readonly ZaicodeRouterConnection[]): ZaicodeSubscriptionAccount[] {
  const byProvider = new Map<string, ZaicodeRouterConnection[]>();
  for (const connection of connections) {
    if (connection.authType !== "oauth") continue;
    byProvider.set(connection.provider, [...(byProvider.get(connection.provider) ?? []), connection]);
  }
  const accounts: ZaicodeSubscriptionAccount[] = [];
  for (const [provider, list] of byProvider) {
    const connectedAt = (connection: ZaicodeRouterConnection) => {
      const at = connection.createdAt ? Date.parse(connection.createdAt) : Number.NaN;
      return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
    };
    const ordered = [...list].sort((left, right) => {
      const a = connectedAt(left);
      const b = connectedAt(right);
      return a !== b ? (a < b ? -1 : 1) : left.id.localeCompare(right.id);
    });
    const vendor = zaicodeSubscriptionVendorLabel(provider);
    ordered.forEach((connection, index) => {
      accounts.push({
        connectionId: connection.id,
        provider,
        label: ordered.length > 1 ? `${vendor} ${index + 1}` : vendor,
        identity: connection.email || connection.name,
        active: connection.isActive,
      });
    });
  }
  return accounts.sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true }));
}

// ---------------------------------------------------------------------------
// Models of an account
// ---------------------------------------------------------------------------

export interface ZaicodeSubscriptionModelSpec {
  /** What the menu shows and the request carries: the id without the vendor prefix. */
  modelId: string;
  /** What 9router routes. */
  routedId: string;
  config: {
    enabled: true;
    properties?: { contextWindow?: number; inputFormat?: { supportsImage: boolean; supportsVideo: boolean; supportsPdf: boolean } };
    optionSpecs?: {
      maxOutputTokens?: { max: number };
      reasoningLevel?: { values: string[]; map: string };
    };
  };
}

function bareModelId(provider: string, routedId: string): string {
  for (const prefix of [`${zaicodeRouterAliasOf(provider)}/`, `${provider}/`]) {
    if (routedId.startsWith(prefix)) return routedId.slice(prefix.length);
  }
  return routedId;
}

export function zaicodeSubscriptionModelSpecs(
  provider: string,
  models: readonly ZaicodeRouterModel[],
): ZaicodeSubscriptionModelSpec[] {
  const alias = zaicodeRouterAliasOf(provider);
  const seen = new Set<string>();
  return models.flatMap((model): ZaicodeSubscriptionModelSpec[] => {
    if (model.provider !== provider && model.provider !== alias) return [];
    const modelId = bareModelId(provider, model.id);
    if (!modelId || seen.has(modelId)) return [];
    seen.add(modelId);
    const properties: NonNullable<ZaicodeSubscriptionModelSpec["config"]["properties"]> = {};
    if (model.contextWindow) properties.contextWindow = model.contextWindow;
    if (model.vision) properties.inputFormat = { supportsImage: true, supportsVideo: false, supportsPdf: false };
    const optionSpecs: NonNullable<ZaicodeSubscriptionModelSpec["config"]["optionSpecs"]> = {};
    if (model.maxOutput) optionSpecs.maxOutputTokens = { max: model.maxOutput };
    if (model.reasoning) optionSpecs.reasoningLevel = { values: [...zaicodeSubscriptionEfforts(provider)], map: ZAICODE_SUBSCRIPTION_EFFORT_MAP };
    return [
      {
        modelId,
        routedId: model.id,
        config: {
          enabled: true,
          ...(Object.keys(properties).length > 0 ? { properties } : {}),
          ...(Object.keys(optionSpecs).length > 0 ? { optionSpecs } : {}),
        },
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// What to change in the model list
// ---------------------------------------------------------------------------

/** An account provider already in ZAICODE's model list. */
export interface ZaicodeSubscriptionProviderState {
  providerId: string;
  providerName: string;
  baseUrl: string;
  apiKey: string | null;
  modelIds: readonly string[];
}

export interface ZaicodeSubscriptionSyncPlan {
  create: { account: ZaicodeSubscriptionAccount; baseUrl: string; models: ZaicodeSubscriptionModelSpec[] }[];
  update: {
    providerId: string;
    account: ZaicodeSubscriptionAccount;
    /** New name, address or key; null when those stay. */
    overlay: { providerName: string; baseUrl: string } | null;
    add: ZaicodeSubscriptionModelSpec[];
    remove: string[];
  }[];
  /** Account providers whose account left 9router. */
  remove: string[];
}

/**
 * The difference between what 9router has and what the model list shows.
 * New accounts and models come in, gone ones go out. A vendor for which
 * 9router lists no models at all keeps what it had (a failed read is not "all
 * models retired"). Models the operator switched off stay listed and off.
 */
export function planZaicodeSubscriptionSync(input: {
  accounts: readonly ZaicodeSubscriptionAccount[];
  models: readonly ZaicodeRouterModel[];
  proxyUrl: string;
  existing: readonly ZaicodeSubscriptionProviderState[];
  apiKey: string;
}): ZaicodeSubscriptionSyncPlan {
  const plan: ZaicodeSubscriptionSyncPlan = { create: [], update: [], remove: [] };
  const byConnection = new Map<string, ZaicodeSubscriptionProviderState>();
  for (const state of input.existing) {
    const connectionId = zaicodeSubscriptionConnectionOf(state.baseUrl);
    if (!connectionId) continue;
    // A second provider for the same account (two windows raced) is removed.
    if (byConnection.has(connectionId)) plan.remove.push(state.providerId);
    else byConnection.set(connectionId, state);
  }
  const wanted = new Set(input.accounts.map((account) => account.connectionId));
  for (const [connectionId, state] of byConnection) {
    if (!wanted.has(connectionId)) plan.remove.push(state.providerId);
  }
  for (const account of input.accounts) {
    const specs = zaicodeSubscriptionModelSpecs(account.provider, input.models);
    const baseUrl = zaicodeSubscriptionBaseUrl(input.proxyUrl, account.connectionId);
    const state = byConnection.get(account.connectionId);
    if (!state) {
      if (specs.length > 0) plan.create.push({ account, baseUrl, models: specs });
      continue;
    }
    const listed = new Set(state.modelIds);
    const add = specs.filter((spec) => !listed.has(spec.modelId));
    const offered = new Set(specs.map((spec) => spec.modelId));
    const remove = specs.length > 0 ? state.modelIds.filter((modelId) => !offered.has(modelId)) : [];
    const moved = state.baseUrl !== baseUrl || state.providerName !== account.label || state.apiKey !== input.apiKey;
    if (moved || add.length > 0 || remove.length > 0) {
      plan.update.push({
        providerId: state.providerId,
        account,
        overlay: moved ? { providerName: account.label, baseUrl } : null,
        add,
        remove,
      });
    }
  }
  return plan;
}

export function isZaicodeSubscriptionPlanEmpty(plan: ZaicodeSubscriptionSyncPlan): boolean {
  return plan.create.length === 0 && plan.update.length === 0 && plan.remove.length === 0;
}

// ---------------------------------------------------------------------------
// Readiness: the bar next to an account in the model menu
// ---------------------------------------------------------------------------

export type ZaicodeSubscriptionTone = "good" | "warn" | "bad" | "blocked" | "offline" | "unknown";

export interface ZaicodeSubscriptionReadiness {
  /** Remaining percent of the tightest window, null when 9router gave no number. */
  remaining: number | null;
  tone: ZaicodeSubscriptionTone;
  /** Short: "72%", "rests to 14:05", "off". */
  text: string;
  /** One line for the tooltip: who, what is left in which window, when it resets. */
  title: string;
}

const WINDOW_LABELS: Readonly<Record<string, string>> = { session: "5h", weekly: "week", monthly: "month", daily: "day" };

function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function windowRemaining(value: Record<string, unknown>): number | null {
  if (value.unlimited === true) return 100;
  if (typeof value.remainingPercentage === "number") return value.remainingPercentage;
  const total = typeof value.total === "number" ? value.total : null;
  if (total && total > 0 && typeof value.remaining === "number") return (value.remaining / total) * 100;
  if (total && total > 0 && typeof value.used === "number") return Math.max(0, 100 - (value.used / total) * 100);
  return null;
}

/**
 * How ready one account is, from 9router's connection record and its quota
 * read (`GET /api/usage/<connectionId>`: `{quotas: {session: {used, total,
 * remaining, resetAt}, weekly: ...}}`, or `{message}` when the vendor has no
 * numbers).
 */
export function zaicodeSubscriptionReadiness(
  account: Pick<ZaicodeSubscriptionAccount, "label" | "identity" | "active">,
  connection: Pick<ZaicodeRouterConnection, "testStatus" | "lockedUntil"> | null,
  usage: unknown,
  now: number = Date.now(),
): ZaicodeSubscriptionReadiness {
  const who = `${account.label} (${account.identity})`;
  if (!account.active) return { remaining: null, tone: "offline", text: "off", title: `${who}: switched off in 9router` };
  if (connection?.testStatus && /expired|unauthori[sz]ed|invalid|revoked/i.test(connection.testStatus)) {
    return { remaining: null, tone: "offline", text: "sign in", title: `${who}: sign in again in 9router` };
  }
  const quotas = (usage as { quotas?: unknown } | null)?.quotas;
  const windows: { label: string; remaining: number; resetAt: number | null }[] = [];
  if (quotas && typeof quotas === "object" && !Array.isArray(quotas)) {
    for (const [key, raw] of Object.entries(quotas as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const value = raw as Record<string, unknown>;
      const remaining = windowRemaining(value);
      if (remaining === null) continue;
      const resetAt = typeof value.resetAt === "string" ? Date.parse(value.resetAt) : Number.NaN;
      windows.push({
        label: WINDOW_LABELS[key] ?? key.replace(/_/g, " "),
        remaining: Math.max(0, Math.min(100, remaining)),
        resetAt: Number.isFinite(resetAt) ? resetAt : null,
      });
    }
  }
  const tightest = windows.length > 0 ? windows.reduce((low, next) => (next.remaining < low.remaining ? next : low)) : null;
  const detail = windows.map((window) => `${window.label} ${Math.round(window.remaining)}%`).join(", ");
  const lockedUntil = connection?.lockedUntil ?? null;
  if (lockedUntil !== null && lockedUntil > now) {
    return {
      remaining: tightest?.remaining ?? null,
      tone: "blocked",
      text: `rests to ${clock(lockedUntil)}`,
      title: `${who}: 9router rests it after a limit hit until ${clock(lockedUntil)}; the next account of this vendor answers meanwhile${detail ? ` (${detail})` : ""}`,
    };
  }
  if (!tightest) {
    return { remaining: null, tone: "unknown", text: "?", title: `${who}: the vendor gives no quota numbers` };
  }
  const remaining = tightest.remaining;
  const tone: ZaicodeSubscriptionTone = remaining <= 0 ? "blocked" : remaining < 20 ? "bad" : remaining < 50 ? "warn" : "good";
  const reset = tightest.resetAt ? `, ${tightest.label} resets ${clock(tightest.resetAt)}` : "";
  return { remaining, tone, text: `${Math.round(remaining)}%`, title: `${who}: ${detail}${reset}` };
}
