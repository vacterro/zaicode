import { ZAICODE_KEYLESS_API_KEY } from "@zcode/shared";
import type { ZaicodeRouterCaller } from "./zaicodeRouterSetup.js";

function list<T>(data: unknown, key: string): T[] {
  const value = (data as Record<string, unknown> | null)?.[key];
  return Array.isArray(value) ? value as T[] : [];
}

/**
 * One 9router key entry as returned by GET /api/keys. Field shapes vary by
 * build and full key material is often absent (masked/id-only listings), so
 * every field is defensive: lookup matches full values only, reports carry
 * non-secret identifiers only. Key material never enters logs or errors.
 */
export interface ZaicodeRouterKeyEntry {
  id?: unknown;
  name?: unknown;
  key?: unknown;
  isActive?: unknown;
  active?: unknown;
  revoked?: unknown;
  disabled?: unknown;
}

function zaicodeRouterKeyActive(entry: ZaicodeRouterKeyEntry): boolean {
  if (entry.isActive === false || entry.active === false) return false;
  if (entry.revoked === true || entry.disabled === true) return false;
  return true;
}

/**
 * Lookup only, never creation: is the stored full key still an active entry?
 * A ZAICODE-named entry without its full value cannot be adopted (its secret
 * is unrecoverable), so name matches alone never count here; they are
 * reported by proposeZaicodeRouterKeyCleanup for explicit operator review.
 */
export function findZaicodeRouterKey(
  entries: readonly ZaicodeRouterKeyEntry[],
  stored: string | null,
): boolean {
  if (!stored) return false;
  return entries.some((entry) => entry.key === stored && zaicodeRouterKeyActive(entry));
}

export interface ZaicodeRouterKeyCleanupCandidate {
  id: string;
  name: string;
  active: boolean;
}

/**
 * Dry-run cleanup proposal over a key listing. Counts ZAICODE-labelled keys
 * and names the non-secret identifiers (id/name only, never key material).
 * Nothing is deleted here; deletion needs proven ownership, proven non-use
 * and explicit operator authorization.
 */
export function proposeZaicodeRouterKeyCleanup(entries: readonly ZaicodeRouterKeyEntry[]) {
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const zaicodeNamed = entries
    .filter((entry) => text(entry.name) === "ZAICODE")
    .map((entry, index) => ({
      id: text(entry.id) || `#${index}`,
      name: "ZAICODE",
      active: zaicodeRouterKeyActive(entry),
    }));
  return {
    total: entries.length,
    zaicodeNamed,
    duplicateNamed: Math.max(0, zaicodeNamed.length - 1),
  };
}

/**
 * In-flight credential acquisitions by stored slot. Concurrent startup,
 * reload, usage polling and proxy reads for the same slot share one
 * acquisition instead of minting one key each; different slots stay
 * independent (never assume one URL means one credential store).
 */
type RouterKeyResult = { key: string; created: boolean };
const zaicodeRouterKeyInflight = new Map<string, Promise<RouterKeyResult>>();
const zaicodeRouterCallerInflight = new WeakMap<ZaicodeRouterCaller, Map<string, Promise<RouterKeyResult>>>();

function isLoopbackRouter(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  } catch { return false; }
}

/** ZAICODE's own key for 9router's OpenAI endpoint: the stored one while 9router still has it, else a new one. */
export async function ensureZaicodeRouterKey(
  call: ZaicodeRouterCaller,
  stored: string | null,
  routerUrl?: string,
): Promise<{ key: string; created: boolean }> {
  // 本地路由器不需要创建客户端密钥；原来每个入口传 null 会不断生成 ZAICODE。
  // 未给端点的调用按 caller 隔离，避免两个路由器拿到彼此的凭据。
  let inflight = routerUrl ? zaicodeRouterKeyInflight : zaicodeRouterCallerInflight.get(call);
  if (!inflight) { inflight = new Map(); zaicodeRouterCallerInflight.set(call, inflight); }
  const slot = routerUrl ? `${routerUrl}\u0000${isLoopbackRouter(routerUrl) ? "" : stored ?? ""}` : stored ?? "";
  const running = inflight.get(slot);
  if (running) return running;
  const task = (async () => {
    if (routerUrl && isLoopbackRouter(routerUrl)) {
      const settings = await call({ method: "GET", path: "/api/settings" });
      if (!settings.ok) throw new Error(`9router local settings: ${settings.message}`);
      if ((settings.data as { requireApiKey?: boolean } | null)?.requireApiKey !== false) {
        const saved = await call({ method: "PATCH", path: "/api/settings", body: { requireApiKey: false } });
        if (!saved.ok) throw new Error(`9router local settings: ${saved.message}`);
      }
      return { key: ZAICODE_KEYLESS_API_KEY, created: false };
    }
    const keys = await call({ method: "GET", path: "/api/keys" });
    if (!keys.ok) throw new Error(`9router keys: ${keys.message}`);
    const existing = list<ZaicodeRouterKeyEntry>(keys.data, "keys");
    if (findZaicodeRouterKey(existing, stored)) return { key: stored as string, created: false };
    const created = await call({ method: "POST", path: "/api/keys", body: { name: "ZAICODE" } });
    const key = (created.data as { key?: string } | null)?.key;
    if (!created.ok || typeof key !== "string" || !key)
      throw new Error(`9router key: ${created.message || "no key returned"}`);
    return { key, created: true };
  })();
  inflight.set(slot, task);
  try {
    return await task;
  } finally {
    if (inflight.get(slot) === task) inflight.delete(slot);
  }
}

