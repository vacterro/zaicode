/**
 * ZAICODE Router: the operator's local 9router (SAIRoute) managed from
 * ZAICODE. 9router owns providers, keys, models and pools (combos); ZAICODE
 * reads and edits them through 9router's own dashboard API, authenticated
 * the way 9router's own CLI is (the per-machine CLI token), so nothing is
 * duplicated and the dashboard and ZAICODE always show the same truth.
 *
 * This module is the pure half shared by the desktop main process and the
 * renderer: the route allow-list (the renderer can reach exactly these
 * calls, nothing that shuts the router down or reads secrets), the record
 * shapes ZAICODE uses, and small helpers. Transport lives in desktop main.
 */

export const ZAICODE_ROUTER_DEFAULT_URL = "http://127.0.0.1:20128";

export type ZaicodeRouterMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ZaicodeRouterCall {
  method: ZaicodeRouterMethod;
  /** Path + optional query, e.g. `/api/usage/stats?period=today`. */
  path: string;
  body?: unknown;
}

export interface ZaicodeRouterResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  /** Human-readable failure: router down, 401, validation text from 9router, ... */
  message: string;
}

const ID = "[A-Za-z0-9_.:-]{1,160}";

/**
 * The calls ZAICODE makes. Anything else is refused before it leaves the
 * app: no shutdown/update/database routes, no OAuth flows, no tunnel.
 */
const ALLOWED: readonly { method: ZaicodeRouterMethod; pattern: RegExp }[] = [
  { method: "GET", pattern: /^\/api\/health$/ },
  { method: "GET", pattern: /^\/api\/version$/ },
  { method: "GET", pattern: /^\/api\/providers$/ },
  { method: "POST", pattern: /^\/api\/providers$/ },
  { method: "PUT", pattern: new RegExp(`^/api/providers/${ID}$`) },
  { method: "DELETE", pattern: new RegExp(`^/api/providers/${ID}$`) },
  { method: "POST", pattern: new RegExp(`^/api/providers/${ID}/test$`) },
  { method: "GET", pattern: new RegExp(`^/api/providers/${ID}/models$`) },
  { method: "GET", pattern: /^\/api\/provider-nodes$/ },
  { method: "POST", pattern: /^\/api\/provider-nodes$/ },
  { method: "DELETE", pattern: new RegExp(`^/api/provider-nodes/${ID}$`) },
  { method: "GET", pattern: /^\/api\/combos$/ },
  { method: "POST", pattern: /^\/api\/combos$/ },
  { method: "PUT", pattern: new RegExp(`^/api/combos/${ID}$`) },
  { method: "DELETE", pattern: new RegExp(`^/api/combos/${ID}$`) },
  { method: "GET", pattern: /^\/api\/models$/ },
  { method: "GET", pattern: /^\/api\/settings$/ },
  { method: "PATCH", pattern: /^\/api\/settings$/ },
  { method: "GET", pattern: /^\/api\/usage\/stats\?period=(today|24h|7d|30d|60d|all)$/ },
];

/** Settings keys ZAICODE may read and change; everything else in 9router's settings stays in 9router. */
export const ZAICODE_ROUTER_SETTINGS_KEYS: readonly string[] = ["comboStrategies"];

export function isZaicodeRouterCallAllowed(call: ZaicodeRouterCall): boolean {
  if (typeof call?.path !== "string" || call.path.length > 400) return false;
  if (call.path.includes("..") || call.path.includes("//")) return false;
  if (!ALLOWED.some((rule) => rule.method === call.method && rule.pattern.test(call.path))) return false;
  if (call.method === "PATCH" && call.path === "/api/settings") {
    const body = call.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    return Object.keys(body).every((key) => ZAICODE_ROUTER_SETTINGS_KEYS.includes(key));
  }
  return true;
}

/** 9router's settings reduced to the keys ZAICODE may see (applied in main, before the renderer). */
export function pickZaicodeRouterSettings(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  return Object.fromEntries(ZAICODE_ROUTER_SETTINGS_KEYS.filter((key) => key in value).map((key) => [key, value[key]]));
}

// ---------------------------------------------------------------------------
// Records (the subset of 9router's shapes ZAICODE reads)
// ---------------------------------------------------------------------------

export interface ZaicodeRouterConnection {
  id: string;
  provider: string;
  name: string;
  authType: string | null;
  isActive: boolean;
  priority: number | null;
  testStatus: string | null;
  lastError: string | null;
  baseUrl: string | null;
  prefix: string | null;
}

export interface ZaicodeRouterNode {
  id: string;
  type: "openai-compatible" | "anthropic-compatible" | "custom-embedding" | string;
  name: string;
  prefix: string;
  baseUrl: string;
  apiType: string | null;
}

export type ZaicodeComboStrategy = "fallback" | "round-robin" | "fusion";

export interface ZaicodeRouterCombo {
  id: string;
  name: string;
  models: string[];
  kind: string | null;
  strategy: ZaicodeComboStrategy;
}

export interface ZaicodeRouterModel {
  /** `alias/model` as 9router routes it, e.g. `agentrouter/claude-opus-4-8`. */
  id: string;
  provider: string;
  name: string;
  vision: boolean;
  contextWindow: number | null;
  maxOutput: number | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function normalizeZaicodeRouterConnections(raw: unknown): ZaicodeRouterConnection[] {
  const list = (raw as { connections?: unknown })?.connections;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): ZaicodeRouterConnection[] => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const id = str(value.id);
    const provider = str(value.provider);
    if (!id || !provider) return [];
    const specific = (value.providerSpecificData ?? {}) as Record<string, unknown>;
    return [
      {
        id,
        provider,
        name: str(value.name) ?? provider,
        authType: str(value.authType),
        isActive: value.isActive !== false,
        priority: typeof value.priority === "number" ? value.priority : null,
        testStatus: str(value.testStatus),
        lastError: str(value.lastError),
        baseUrl: str(specific.baseUrl),
        prefix: str(specific.prefix),
      },
    ];
  });
}

export function normalizeZaicodeRouterNodes(raw: unknown): ZaicodeRouterNode[] {
  const list = (raw as { nodes?: unknown })?.nodes;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): ZaicodeRouterNode[] => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const id = str(value.id);
    if (!id) return [];
    return [
      {
        id,
        type: str(value.type) ?? "openai-compatible",
        name: str(value.name) ?? id,
        prefix: str(value.prefix) ?? "",
        baseUrl: str(value.baseUrl) ?? "",
        apiType: str(value.apiType),
      },
    ];
  });
}

export function normalizeZaicodeRouterCombos(raw: unknown, settings: unknown): ZaicodeRouterCombo[] {
  const list = (raw as { combos?: unknown })?.combos;
  if (!Array.isArray(list)) return [];
  const strategies = ((settings as { comboStrategies?: unknown })?.comboStrategies ?? {}) as Record<string, unknown>;
  return list.flatMap((item): ZaicodeRouterCombo[] => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const id = str(value.id);
    const name = str(value.name);
    if (!id || !name) return [];
    const strategy = (strategies[name] as { fallbackStrategy?: unknown } | undefined)?.fallbackStrategy;
    return [
      {
        id,
        name,
        models: Array.isArray(value.models) ? value.models.filter((model): model is string => typeof model === "string") : [],
        kind: str(value.kind),
        strategy: strategy === "round-robin" || strategy === "fusion" ? strategy : "fallback",
      },
    ];
  });
}

export function normalizeZaicodeRouterModels(raw: unknown): ZaicodeRouterModel[] {
  const list = (raw as { models?: unknown })?.models;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  return list.flatMap((item): ZaicodeRouterModel[] => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const id = str(value.routedModel) ?? str(value.fullModel);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const caps = (value.caps ?? {}) as Record<string, unknown>;
    return [
      {
        id,
        provider: str(value.provider) ?? id.split("/")[0] ?? "",
        name: str(value.name) ?? id,
        vision: caps.vision === true,
        contextWindow: typeof caps.contextWindow === "number" && caps.contextWindow > 0 ? caps.contextWindow : null,
        maxOutput: typeof caps.maxOutput === "number" && caps.maxOutput > 0 ? caps.maxOutput : null,
      },
    ];
  });
}

/**
 * The comboStrategies settings map after one combo's strategy changes:
 * "fallback" (9router's default) drops the entry, the way the dashboard does.
 */
export function withZaicodeComboStrategy(
  current: Record<string, unknown> | null | undefined,
  comboName: string,
  strategy: ZaicodeComboStrategy,
): Record<string, unknown> {
  const next = { ...current };
  if (strategy === "fallback") {
    delete next[comboName];
    return next;
  }
  const previous = (next[comboName] && typeof next[comboName] === "object" ? next[comboName] : {}) as Record<string, unknown>;
  next[comboName] = { ...previous, fallbackStrategy: strategy };
  return next;
}

/** Moves `model` inside a combo's list by `delta` (clamped); unknown model = unchanged copy. */
export function moveZaicodeComboModel(models: readonly string[], model: string, delta: number): string[] {
  const index = models.indexOf(model);
  if (index < 0) return [...models];
  const target = Math.max(0, Math.min(models.length - 1, index + delta));
  const next = [...models];
  next.splice(index, 1);
  next.splice(target, 0, model);
  return next;
}

/**
 * The 9router models of the operator's connected subscriptions (OAuth
 * connections: Codex, Antigravity, Claude Code, ...), grouped by connection
 * provider. These become ordinary ZAICODE models by being listed under the
 * SAIRoute provider: 9router serves them over its OpenAI-compatible endpoint.
 */
/**
 * 9router routes OAuth providers under short aliases (`codex` -> `cx/...`).
 * Copied from 9router 0.5.65-extra `OAUTH_ALIASES` (open-sse/config/providerModels.js);
 * a provider missing here routes under its own id, as 9router itself does.
 */
export const ZAICODE_ROUTER_OAUTH_ALIASES: Readonly<Record<string, string>> = {
  antigravity: "ag",
  claude: "cc",
  cline: "cl",
  "codebuddy-cn": "cbcn",
  "codebuddy-intl": "cbai",
  codex: "cx",
  cursor: "cu",
  "gemini-cli": "gc",
  github: "gh",
  "grok-cli": "gcli",
  iflow: "if",
  kilocode: "kc",
  kiro: "kr",
  opencode: "oc",
  qoder: "qd",
  workbuddy: "wb",
  zed: "zd",
};

export function zaicodeRouterAliasOf(providerId: string): string {
  return ZAICODE_ROUTER_OAUTH_ALIASES[providerId] ?? providerId;
}

export function zaicodeSubscriptionModels(
  connections: readonly ZaicodeRouterConnection[],
  models: readonly ZaicodeRouterModel[],
): { provider: string; label: string; active: boolean; models: ZaicodeRouterModel[] }[] {
  const byProvider = new Map<string, { provider: string; label: string; active: boolean; models: ZaicodeRouterModel[] }>();
  for (const connection of connections) {
    if (connection.authType !== "oauth") continue;
    const entry = byProvider.get(connection.provider);
    if (entry) {
      entry.active = entry.active || connection.isActive;
      continue;
    }
    byProvider.set(connection.provider, {
      provider: connection.provider,
      label: connection.name,
      active: connection.isActive,
      models: models.filter(
        (model) => model.provider === connection.provider || model.provider === zaicodeRouterAliasOf(connection.provider),
      ),
    });
  }
  return [...byProvider.values()].sort((left, right) => left.label.localeCompare(right.label));
}

/** 9router combo names: letters, digits, `-`, `_`, `.`. */
export function isZaicodeComboNameValid(name: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,64}$/.test(name);
}

/** A custom provider's prefix becomes the model alias (`prefix/model`); keep it short and plain. */
export function suggestZaicodeProviderPrefix(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 8) || "custom";
  let candidate = base;
  for (let n = 2; taken.includes(candidate); n += 1) candidate = `${base}${n}`;
  return candidate;
}
