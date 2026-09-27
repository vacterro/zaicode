import { timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  normalizeZaicodeRouterConnections,
  parseZaicodeSubscriptionPath,
  zaicodeRoutedModelId,
  type ZaicodeRouterCall,
  type ZaicodeRouterConnection,
  type ZaicodeRouterResponse,
} from "@zcode/shared";

/**
 * The account pin for subscriptions as models (SRC-061). A provider "Codex 1"
 * in the model menu sends its requests here as `/acct/<connectionId>/v1/...`.
 * 9router has no per-request account choice for chat -- it serves a vendor
 * with its lowest-priority connection that is not resting ("fill-first") -- so
 * this proxy puts the named account first for its vendor and then hands the
 * request to 9router unchanged, except for the model (the menu shows
 * `gpt-5.5`, 9router routes `cx/gpt-5.5`) and the key (ZAICODE's own).
 *
 * The order is global per vendor, so a request holds its vendor's gate until
 * 9router answers with headers (it has picked the account by then). Requests
 * for the same account share the gate; a request for another account of that
 * vendor waits only for that moment. An account at its limit still falls
 * through to the next one inside 9router: the fuel the operator asked for.
 * No Electron here: main wires it (zaicodeSubscriptionProxyHost.ts).
 */

export interface ZaicodeSubscriptionProxyOptions {
  /** 9router's address, read per request (the router can move between shared and isolated). */
  routerUrl(): string;
  /** ZAICODE's key for 9router's /v1, or null while there is none. */
  routerKey(): Promise<string | null>;
  /** Main-process 9router management call (priorities, connections). */
  call(call: ZaicodeRouterCall): Promise<ZaicodeRouterResponse>;
  /** What account providers send as their API key; nothing else is let through. */
  token: string;
  /** Longest a request holds its vendor's gate when 9router is slow to answer. */
  holdMs?: number;
  /** Biggest request body accepted (a long conversation is megabytes). */
  maxBodyBytes?: number;
}

/** The priority writes that put one account in front of its vendor's others, or null when it is not there. */
export function zaicodeAccountFirstWrites(
  connections: readonly ZaicodeRouterConnection[],
  connectionId: string,
): { id: string; priority: number }[] | null {
  const chosen = connections.find((connection) => connection.id === connectionId);
  if (!chosen) return null;
  const rank = (connection: ZaicodeRouterConnection) => connection.priority ?? 999;
  const others = connections
    .filter((connection) => connection.provider === chosen.provider && connection.id !== chosen.id)
    .sort((left, right) => rank(left) - rank(right) || left.id.localeCompare(right.id));
  // 9router reads a missing or zero priority as 999, so the order starts at 1.
  return [chosen, ...others].flatMap((connection, index) =>
    connection.priority === index + 1 ? [] : [{ id: connection.id, priority: index + 1 }],
  );
}

interface Gate {
  account: string | null;
  holders: number;
  waiters: { account: string; admit: () => void }[];
}

/** Per-vendor gate: one account at a time, any number of requests for it. */
export class ZaicodeAccountGates {
  readonly #gates = new Map<string, Gate>();

  acquire(vendor: string, account: string): Promise<() => void> {
    const gate = this.#gates.get(vendor) ?? { account: null, holders: 0, waiters: [] };
    this.#gates.set(vendor, gate);
    return new Promise((resolve) => {
      const admit = () => {
        gate.account = account;
        gate.holders += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          gate.holders -= 1;
          if (gate.holders === 0) this.#next(vendor, gate);
        });
      };
      // Same account and nobody else queued: go along. Otherwise wait in line (no starvation).
      if (gate.holders === 0 || (gate.account === account && gate.waiters.length === 0)) admit();
      else gate.waiters.push({ account, admit });
    });
  }

  /** Who holds each vendor now (tests, diagnostics). */
  holders(vendor: string): { account: string | null; holders: number; waiting: number } {
    const gate = this.#gates.get(vendor);
    return { account: gate?.account ?? null, holders: gate?.holders ?? 0, waiting: gate?.waiters.length ?? 0 };
  }

  #next(vendor: string, gate: Gate): void {
    const first = gate.waiters[0];
    if (!first) {
      this.#gates.delete(vendor);
      return;
    }
    const admitted = gate.waiters.filter((waiter) => waiter.account === first.account);
    gate.waiters = gate.waiters.filter((waiter) => waiter.account !== first.account);
    for (const waiter of admitted) waiter.admit();
  }
}

function sendError(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = JSON.stringify({ error: { message, type: status === 401 ? "authentication_error" : "zaicode_account_proxy" } });
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`request larger than ${Math.round(limit / 1_048_576)} MB`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `cx/` goes in front of a bare model id; anything that is not JSON with a model passes untouched. */
function withRoutedModel(body: Buffer, vendor: { provider: string; prefix: string | null }): Buffer {
  if (body.length === 0) return body;
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;
    const record = parsed as Record<string, unknown>;
    if (typeof record.model !== "string" || !record.model) return body;
    const routed = zaicodeRoutedModelId(vendor.provider, record.model, vendor.prefix);
    return routed === record.model ? body : Buffer.from(JSON.stringify({ ...record, model: routed }));
  } catch {
    return body;
  }
}

const HOP_HEADERS = new Set(["host", "connection", "content-length", "authorization", "transfer-encoding", "keep-alive"]);

export class ZaicodeSubscriptionProxy {
  readonly #options: ZaicodeSubscriptionProxyOptions;
  readonly #gates = new ZaicodeAccountGates();
  /** connectionId -> its 9router provider id and route prefix (never change for an id). */
  readonly #vendorOf = new Map<string, { provider: string; prefix: string | null }>();
  #server: Server | null = null;
  #port = 0;

  constructor(options: ZaicodeSubscriptionProxyOptions) {
    this.#options = options;
  }

  get url(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  get gates(): ZaicodeAccountGates {
    return this.#gates;
  }

  /** Listens on 127.0.0.1 only: the preferred port, else any free one. */
  async listen(preferredPort = 0): Promise<string> {
    if (this.#server) return this.url;
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) =>
        sendError(response, 502, error instanceof Error ? error.message : String(error)),
      );
    });
    const bind = (port: number) =>
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", onError);
          resolve();
        });
      });
    try {
      await bind(preferredPort);
    } catch (error) {
      if (preferredPort === 0) throw error;
      await bind(0);
    }
    this.#server = server;
    this.#port = (server.address() as AddressInfo).port;
    return this.url;
  }

  close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  async #connections(): Promise<ZaicodeRouterConnection[] | null> {
    const response = await this.#options.call({ method: "GET", path: "/api/providers" });
    return response.ok ? normalizeZaicodeRouterConnections(response.data) : null;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    const target = parseZaicodeSubscriptionPath(request.url ?? "");
    if (!target) return sendError(response, 404, "Not a ZAICODE account path (/acct/<account>/v1/...)");
    const auth = request.headers.authorization ?? "";
    const given = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    if (!sameSecret(given, this.#options.token)) return sendError(response, 401, "Wrong key for the ZAICODE account proxy");
    const body = await readBody(request, this.#options.maxBodyBytes ?? 64 * 1_048_576);
    const key = await this.#options.routerKey();
    if (!key) return sendError(response, 503, "9router has no ZAICODE key yet: open Settings -> Router and run Autotroubleshoot");

    let vendor = this.#vendorOf.get(target.connectionId) ?? null;
    if (!vendor) {
      const connections = await this.#connections();
      if (!connections) return sendError(response, 503, "9router does not answer (Settings -> Router -> Autotroubleshoot)");
      const connection = connections.find((entry) => entry.id === target.connectionId);
      if (!connection) {
        return sendError(response, 404, "This subscription account is no longer connected in 9router; pick another account in the model menu");
      }
      vendor = { provider: connection.provider, prefix: connection.prefix };
      this.#vendorOf.set(target.connectionId, vendor);
    }

    const release = await this.#gates.acquire(vendor.provider, target.connectionId);
    const cap = setTimeout(release, this.#options.holdMs ?? 20_000);
    const done = () => {
      clearTimeout(cap);
      release();
    };
    try {
      const connections = await this.#connections();
      const writes = connections ? zaicodeAccountFirstWrites(connections, target.connectionId) : null;
      if (connections && !writes) {
        done();
        this.#vendorOf.delete(target.connectionId);
        return sendError(response, 404, "This subscription account is no longer connected in 9router; pick another account in the model menu");
      }
      // A failed write still forwards: 9router answers with some account of this vendor.
      for (const write of writes ?? []) {
        await this.#options.call({ method: "PUT", path: `/api/providers/${write.id}`, body: { priority: write.priority } });
      }
    } catch {
      // same: forward anyway
    }
    this.#forward(request, response, target.rest, withRoutedModel(body, vendor), key, done);
  }

  #forward(request: IncomingMessage, response: ServerResponse, path: string, body: Buffer, key: string, done: () => void): void {
    const url = new URL(path, `${this.#options.routerUrl().replace(/\/+$/, "")}/`);
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined && !HOP_HEADERS.has(name)) headers[name] = value;
    }
    headers.authorization = `Bearer ${key}`;
    if (body.length > 0 || (request.method !== "GET" && request.method !== "HEAD")) headers["content-length"] = String(body.length);
    const upstream = httpRequest(url, { method: request.method, headers }, (answer) => {
      done();
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    });
    upstream.on("error", (error) => {
      done();
      sendError(response, 502, `9router did not answer: ${error.message}`);
    });
    // The client went away (Stop, closed tab): stop the upstream request too.
    response.on("close", () => {
      if (!response.writableFinished) upstream.destroy();
      done();
    });
    upstream.end(body);
  }
}
