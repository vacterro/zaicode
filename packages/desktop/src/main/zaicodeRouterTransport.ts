import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isZaicodeRouterCallAllowed,
  pickZaicodeRouterSettings,
  ZAICODE_ROUTER_DEFAULT_URL,
  type ZaicodeRouterCall,
  type ZaicodeRouterResponse,
} from "@zcode/shared";

/**
 * ZAICODE Router transport (no Electron): the 9router CLI credential and one
 * allow-listed HTTP call. The credential is what 9router's own CLI sends as
 * `x-9r-cli-token`: sha256(machine id + CLI salt + per-install secret), first
 * 16 hex characters, read from 9router's data folder. It never leaves main.
 */

const CLI_SALT = "9r-cli-auth";
const REQUEST_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 60_000;

/**
 * Which 9router ZAICODE talks to (T-46): the operator's shared one (default)
 * or ZAICODE's own isolated instance; set by the router host in main.
 */
let target: { url: string; dataDir: string } | null = null;

export function setZaicodeRouterTarget(next: { url: string; dataDir: string } | null): void {
  target = next;
  cachedToken = null;
}

export function zaicodeRouterDataDir(): string {
  if (target) return target.dataDir;
  const appData = process.env.APPDATA || join(process.env.USERPROFILE || "", "AppData", "Roaming");
  return join(appData, "9router");
}

let cachedToken: string | null = null;

/** 9router's CLI token for this machine, or null when 9router was never started here. */
export function zaicodeRouterCliToken(): string | null {
  if (cachedToken) return cachedToken;
  try {
    const dir = zaicodeRouterDataDir();
    const raw = readFileSync(join(dir, "machine-id"), "utf8").trim();
    const secret = readFileSync(join(dir, "auth", "cli-secret"), "utf8").trim();
    if (!raw || !secret) return null;
    cachedToken = createHash("sha256").update(raw + CLI_SALT + secret).digest("hex").slice(0, 16);
    return cachedToken;
  } catch {
    return null;
  }
}

export function zaicodeRouterBaseUrl(): string {
  if (process.env.ZAICODE_ROUTER_URL) return process.env.ZAICODE_ROUTER_URL.replace(/\/+$/, "");
  return (target?.url ?? ZAICODE_ROUTER_DEFAULT_URL).replace(/\/+$/, "");
}

function describeFailure(status: number, data: unknown, fallback: string): string {
  const text = (data as { error?: unknown; message?: unknown } | null)?.error ?? (data as { message?: unknown } | null)?.message;
  if (typeof text === "string" && text) return text;
  if (status === 401) return "9router refused the CLI credential (restart 9router once, then try again)";
  return fallback;
}

/** Renderer door: only the allow-listed calls, settings reduced to what ZAICODE edits. */
export async function callZaicodeRouter(call: ZaicodeRouterCall): Promise<ZaicodeRouterResponse> {
  if (!isZaicodeRouterCallAllowed(call)) {
    return { ok: false, status: 0, data: null, message: `Not allowed from ZAICODE: ${call?.method} ${call?.path}` };
  }
  const response = await callZaicodeRouterInternal(call);
  // 9router's settings also hold login and tunnel values: only the allowed keys reach the renderer.
  return call.path === "/api/settings" && response.data !== null ? { ...response, data: pickZaicodeRouterSettings(response.data) } : response;
}

/**
 * Main-process only (router setup: pool provisioning, ZAICODE's own API key).
 * Never exposed over IPC: it reaches routes the renderer must not.
 */
export async function callZaicodeRouterInternal(call: ZaicodeRouterCall): Promise<ZaicodeRouterResponse> {
  const token = zaicodeRouterCliToken();
  const isTest = call.path.endsWith("/test");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), isTest ? TEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${zaicodeRouterBaseUrl()}${call.path}`, {
      method: call.method,
      headers: {
        ...(token ? { "x-9r-cli-token": token } : {}),
        ...(call.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (response.status === 401) cachedToken = null;
    return {
      ok: response.ok,
      status: response.status,
      data,
      message: response.ok ? "" : describeFailure(response.status, data, `9router answered ${response.status}`),
    };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      status: 0,
      data: null,
      message: aborted
        ? "9router did not answer in time"
        : `9router is not reachable at ${zaicodeRouterBaseUrl()} (${error instanceof Error ? error.message : String(error)})`,
    };
  } finally {
    clearTimeout(timer);
  }
}
