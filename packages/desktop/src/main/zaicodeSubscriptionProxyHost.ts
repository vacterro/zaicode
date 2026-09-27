import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { readZaicodeRouterApiKey } from "./zaicodeRouterBootstrap.js";
import { callZaicodeRouterInternal, zaicodeRouterBaseUrl } from "./zaicodeRouterTransport.js";
import { ZaicodeSubscriptionProxy } from "./zaicodeSubscriptionProxy.js";

/**
 * Main-process side of the account proxy (SRC-061): started on first use, one
 * per app, on a fixed port when it is free so the model list's addresses stay
 * put across starts. Its token lives in the ZAICODE data folder; the router
 * key is ZAICODE's own, read through the setup that made it.
 */

const TOKEN_FILE = "zaicode-account-proxy.json";
const PREFERRED_PORT = 20190;
const KEY_TTL_MS = 60_000;

let starting: Promise<ZaicodeSubscriptionProxy> | null = null;
let token: string | null = null;
let cachedKey: { url: string; key: string; at: number } | null = null;

function proxyToken(): string {
  if (token) return token;
  const path = join(app.getPath("userData"), TOKEN_FILE);
  try {
    const stored = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { token?: unknown }).token : null;
    if (typeof stored === "string" && stored.length >= 32) return (token = stored);
  } catch {
    // unreadable: a new one below
  }
  token = randomBytes(24).toString("hex");
  writeFileSync(path, JSON.stringify({ token }, null, 2));
  return token;
}

async function routerKey(): Promise<string | null> {
  const url = zaicodeRouterBaseUrl();
  if (cachedKey && cachedKey.url === url && Date.now() - cachedKey.at < KEY_TTL_MS) return cachedKey.key;
  const key = await readZaicodeRouterApiKey();
  cachedKey = key ? { url, key, at: Date.now() } : null;
  return key;
}

/** The proxy's address and the key ZAICODE's account providers use, or null when it cannot listen. */
export async function getZaicodeSubscriptionProxy(): Promise<{ url: string; token: string } | null> {
  try {
    starting ??= (async () => {
      const proxy = new ZaicodeSubscriptionProxy({
        routerUrl: zaicodeRouterBaseUrl,
        routerKey,
        call: callZaicodeRouterInternal,
        token: proxyToken(),
      });
      await proxy.listen(PREFERRED_PORT);
      return proxy;
    })();
    const proxy = await starting;
    return { url: proxy.url, token: proxyToken() };
  } catch {
    starting = null;
    return null;
  }
}
