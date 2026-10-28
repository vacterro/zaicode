import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  zaicodeSubscriptionBaseUrl,
  type ZaicodeRouterCall,
  type ZaicodeRouterConnection,
  type ZaicodeRouterResponse,
} from "@zcode/shared";
import {
  ZaicodeAccountGates,
  ZaicodeSubscriptionProxy,
  zaicodeAccountFirstWrites,
} from "../src/main/zaicodeSubscriptionProxy.js";

// SRC-061: "Codex 1 / GPT ... -> effort" in the model menu. 9router picks the
// account for a chat request itself (fill-first), so the proxy puts the named
// account first before each request and holds the vendor until 9router answered.

function connection(id: string, provider: string, priority: number | null): ZaicodeRouterConnection {
  return { id, provider, name: id, authType: "oauth", isActive: true, priority, testStatus: null, lastError: null, baseUrl: null, prefix: null };
}

test("the chosen account goes to priority 1, the others keep their order behind it", () => {
  const list = [connection("a", "codex", 1), connection("b", "codex", 2), connection("c", "codex", 3), connection("x", "claude", 1)];
  assert.deepEqual(zaicodeAccountFirstWrites(list, "c"), [
    { id: "c", priority: 1 },
    { id: "a", priority: 2 },
    { id: "b", priority: 3 },
  ]);
  assert.deepEqual(zaicodeAccountFirstWrites(list, "a"), [], "already first: nothing to write");
  assert.deepEqual(zaicodeAccountFirstWrites([connection("a", "codex", null), connection("b", "codex", null)], "b"), [
    { id: "b", priority: 1 },
    { id: "a", priority: 2 },
  ]);
  assert.equal(zaicodeAccountFirstWrites(list, "gone"), null);
});

test("the gate: one account of a vendor at a time, many requests for it, first come first served", async () => {
  const gates = new ZaicodeAccountGates();
  const order: string[] = [];
  const a1 = await gates.acquire("codex", "A");
  const a2 = await gates.acquire("codex", "A");
  assert.deepEqual(gates.holders("codex"), { account: "A", holders: 2, waiting: 0 });
  const b = gates.acquire("codex", "B").then((release) => {
    order.push("B");
    return release;
  });
  // Another A after B asked: waits behind B (no starvation).
  const a3 = gates.acquire("codex", "A").then((release) => {
    order.push("A3");
    return release;
  });
  const other = await gates.acquire("claude", "X");
  other();
  a1();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [], "B waits while A still has a request in flight");
  a2();
  (await b)();
  (await a3)();
  assert.deepEqual(order, ["B", "A3"]);
  assert.deepEqual(gates.holders("codex"), { account: null, holders: 0, waiting: 0 });
});

// --- the proxy against a fake 9router ---------------------------------------

interface Seen {
  path: string;
  auth: string;
  model: string | null;
  firstInLine: string | null;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {}));
  });
}

function fakeRouter(connections: ZaicodeRouterConnection[], answerAfterMs = 0) {
  const seen: Seen[] = [];
  const writes: { id: string; priority: number }[] = [];
  const firstInLine = (provider: string) =>
    [...connections].filter((entry) => entry.provider === provider).sort((l, r) => (l.priority ?? 999) - (r.priority ?? 999))[0]?.id ?? null;
  const call = async (request: ZaicodeRouterCall): Promise<ZaicodeRouterResponse> => {
    if (request.method === "GET" && request.path === "/api/providers") {
      return { ok: true, status: 200, data: { connections: connections.map((entry) => ({ ...entry })) }, message: "" };
    }
    const id = /^\/api\/providers\/(.+)$/.exec(request.path)?.[1];
    const target = connections.find((entry) => entry.id === id);
    if (request.method === "PUT" && target) {
      target.priority = (request.body as { priority: number }).priority;
      writes.push({ id: target.id, priority: target.priority });
      return { ok: true, status: 200, data: {}, message: "" };
    }
    return { ok: false, status: 404, data: null, message: "not found" };
  };
  const server = createServer((request, response) => {
    void readJson(request).then((body) => {
      const model = typeof body.model === "string" ? body.model : null;
      // Like 9router: the account in front of the vendor answers.
      const provider = model?.startsWith("cc/") ? "claude" : "codex";
      seen.push({ path: request.url ?? "", auth: request.headers.authorization ?? "", model, firstInLine: firstInLine(provider) });
      const served = firstInLine(provider);
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `served by ${served}` } }] }));
      }, answerAfterMs);
    });
  });
  return { call, seen, writes, server };
}

async function ask(proxyUrl: string, connectionId: string, token: string, model = "gpt-5.5") {
  const response = await fetch(`${zaicodeSubscriptionBaseUrl(proxyUrl, connectionId)}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" }),
  });
  const text = await response.text();
  return { status: response.status, text };
}

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

test("a request for Codex 2 is served by Codex 2: priority first, bare model routed, ZAICODE's key", async () => {
  const connections = [connection("c1", "codex", 1), connection("c2", "codex", 2), connection("k1", "claude", 1)];
  const router = fakeRouter(connections);
  const routerPort = await listen(router.server);
  cleanups.push(() => void router.server.close());
  const proxy = new ZaicodeSubscriptionProxy({
    routerUrl: () => `http://127.0.0.1:${routerPort}`,
    routerKey: async () => "router-key",
    call: router.call,
    token: "proxy-token",
  });
  const url = await proxy.listen(0);
  cleanups.push(() => proxy.close());

  const answer = await ask(url, "c2", "proxy-token");
  assert.equal(answer.status, 200);
  assert.match(answer.text, /served by c2/);
  assert.deepEqual(router.seen[0], { path: "/v1/chat/completions", auth: "Bearer router-key", model: "cx/gpt-5.5", firstInLine: "c2" });
  assert.deepEqual(router.writes, [
    { id: "c2", priority: 1 },
    { id: "c1", priority: 2 },
  ]);
  // Claude is another vendor: its order is not touched.
  assert.equal(connections.find((entry) => entry.id === "k1")?.priority, 1);

  assert.equal((await ask(url, "c2", "wrong")).status, 401, "only ZAICODE's own providers get through");
  assert.equal((await ask(url, "nope", "proxy-token")).status, 404, "an account that left 9router says so");
  assert.equal(router.seen.length, 1, "refused requests never reach 9router");
});

test("two chats on two accounts of one vendor at once: each is served by its own account", async () => {
  const connections = [connection("c1", "codex", 1), connection("c2", "codex", 2)];
  const router = fakeRouter(connections, 150);
  const routerPort = await listen(router.server);
  cleanups.push(() => void router.server.close());
  const proxy = new ZaicodeSubscriptionProxy({
    routerUrl: () => `http://127.0.0.1:${routerPort}`,
    routerKey: async () => "router-key",
    call: router.call,
    token: "t",
  });
  const url = await proxy.listen(0);
  cleanups.push(() => proxy.close());

  const answers = await Promise.all([ask(url, "c1", "t"), ask(url, "c2", "t"), ask(url, "c1", "t"), ask(url, "c2", "t")]);
  assert.deepEqual(
    answers.map((answer) => /served by (\w+)/.exec(answer.text)?.[1]),
    ["c1", "c2", "c1", "c2"],
  );
  for (const seen of router.seen) assert.ok(seen.firstInLine, "every request met a settled order");
});

// --- against a real 9router (ZAICODE_ROUTER_PACKAGE) ---------------------------

const packageDir = process.env.ZAICODE_ROUTER_PACKAGE;
const real = packageDir && existsSync(join(packageDir, "app", "server.js")) ? packageDir : null;

test("real 9router: the account named in the path is the one whose key reaches the vendor", { skip: !real && "set ZAICODE_ROUTER_PACKAGE to run" }, async () => {
  const { ZaicodeRouterProcess } = await import("../src/main/zaicodeRouterProcess.js");
  const { callZaicodeRouterInternal, setZaicodeRouterTarget } = await import("../src/main/zaicodeRouterTransport.js");
  const { ensureZaicodeRouterKey } = await import("../src/main/zaicodeRouterSetup.js");
  const PORT = 20152;
  const dataDir = mkdtempSync(join(tmpdir(), "zaicode-account-proxy-"));
  const server = new ZaicodeRouterProcess({ execPath: process.execPath, packageDir: real!, dataDir, port: PORT, logFile: join(dataDir, "router.log") });
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  cleanups.push(() => server.stop());
  cleanups.push(() => setZaicodeRouterTarget(null));
  await server.start();
  setZaicodeRouterTarget({ url: `http://127.0.0.1:${PORT}`, dataDir });

  // The "vendor": answers with the key it was called with, slowly enough for requests to overlap.
  const keysSeen: string[] = [];
  const vendor = createServer((request, response) => {
    void readJson(request).then(() => {
      const key = (request.headers.authorization ?? "").replace(/^Bearer /, "");
      keysSeen.push(key);
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "x",
            object: "chat.completion",
            created: 1,
            model: "m1",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `key ${key}` } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      }, 200);
    });
  });
  const vendorPort = await listen(vendor);
  cleanups.push(() => void vendor.close());

  const node = await callZaicodeRouterInternal({
    method: "POST",
    path: "/api/provider-nodes",
    body: { type: "openai-compatible", name: "Account test", prefix: "zt", apiType: "chat", baseUrl: `http://127.0.0.1:${vendorPort}/v1` },
  });
  assert.ok(node.ok, `node: ${node.message}`);
  const nodeId = (node.data as { node?: { id?: string }; id?: string }).node?.id ?? (node.data as { id?: string }).id;
  assert.ok(nodeId, JSON.stringify(node.data));
  const made: string[] = [];
  for (const key of ["key-A", "key-B"]) {
    const created = await callZaicodeRouterInternal({ method: "POST", path: "/api/providers", body: { provider: nodeId, apiKey: key, name: key } });
    assert.ok(created.ok, `connection: ${created.message}`);
    made.push((created.data as { connection?: { id?: string } }).connection?.id ?? "");
  }
  const [idA, idB] = made as [string, string];
  const routerKey = (await ensureZaicodeRouterKey(callZaicodeRouterInternal, null)).key;

  const proxy = new ZaicodeSubscriptionProxy({
    routerUrl: () => `http://127.0.0.1:${PORT}`,
    routerKey: async () => routerKey,
    call: callZaicodeRouterInternal,
    token: "t",
  });
  const url = await proxy.listen(0);
  cleanups.push(() => proxy.close());

  const first = await ask(url, idB, "t", "m1");
  assert.equal(first.status, 200, first.text);
  assert.match(first.text, /key key-B/, "B named, B served");
  const second = await ask(url, idA, "t", "m1");
  assert.match(second.text, /key key-A/, "A named, A served");
  const parallel = await Promise.all([ask(url, idA, "t", "m1"), ask(url, idB, "t", "m1"), ask(url, idA, "t", "m1")]);
  assert.deepEqual(
    parallel.map((answer) => /key (key-\w)/.exec(answer.text)?.[1]),
    ["key-A", "key-B", "key-A"],
    parallel.map((answer) => answer.text).join("\n"),
  );
});
