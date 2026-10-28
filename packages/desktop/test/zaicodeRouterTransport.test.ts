import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * ZAICODE Router transport against a fake 9router: the credential is 9router's
 * CLI token derived from its data folder, sent only on allow-listed calls.
 */
const appData = mkdtempSync(join(tmpdir(), "zaicode-router-"));
mkdirSync(join(appData, "9router", "auth"), { recursive: true });
writeFileSync(join(appData, "9router", "machine-id"), "machine-123\n");
writeFileSync(join(appData, "9router", "auth", "cli-secret"), "secret-abc\n");
const expectedToken = createHash("sha256").update("machine-123" + "9r-cli-auth" + "secret-abc").digest("hex").slice(0, 16);

const seen: { method: string; url: string; token: string | undefined; body: string }[] = [];
const server = createServer((request: IncomingMessage, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const token = request.headers["x-9r-cli-token"] as string | undefined;
    seen.push({ method: request.method ?? "", url: request.url ?? "", token, body });
    response.setHeader("Content-Type", "application/json");
    if (token !== expectedToken) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (request.url === "/api/combos" && request.method === "POST") {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "Combo name already exists" }));
      return;
    }
    response.end(JSON.stringify({ combos: [{ id: "c1", name: "SAIFREN", models: ["a/b"] }] }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.APPDATA = appData;
process.env.ZAICODE_ROUTER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const { callZaicodeRouter, zaicodeRouterCliToken } = await import("../src/main/zaicodeRouterTransport.js");

test.after(() => server.close());

test("the CLI token is derived like 9router's own CLI", () => {
  assert.equal(zaicodeRouterCliToken(), expectedToken);
});

test("an allowed call carries the token and returns 9router's JSON", async () => {
  const result = await callZaicodeRouter({ method: "GET", path: "/api/combos" });
  assert.equal(result.ok, true);
  assert.equal((result.data as { combos: unknown[] }).combos.length, 1);
  assert.equal(seen.at(-1)?.token, expectedToken);
});

test("9router's validation text comes back as the message", async () => {
  const result = await callZaicodeRouter({ method: "POST", path: "/api/combos", body: { name: "SAIFREN" } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.message, "Combo name already exists");
  assert.equal(seen.at(-1)?.body, JSON.stringify({ name: "SAIFREN" }));
});

test("a refused call never reaches 9router", async () => {
  const before = seen.length;
  const result = await callZaicodeRouter({ method: "POST", path: "/api/shutdown" });
  assert.equal(result.ok, false);
  assert.match(result.message, /Not allowed from ZAICODE/);
  assert.equal(seen.length, before);
});

test("a router that is down is reported, not thrown", async () => {
  const saved = process.env.ZAICODE_ROUTER_URL;
  process.env.ZAICODE_ROUTER_URL = "http://127.0.0.1:9";
  const result = await callZaicodeRouter({ method: "GET", path: "/api/health" });
  process.env.ZAICODE_ROUTER_URL = saved;
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.match(result.message, /not reachable/);
});

test("9router settings reach the renderer reduced to the pool strategies", async () => {
  const { pickZaicodeRouterSettings } = await import("@zcode/shared");
  assert.deepEqual(pickZaicodeRouterSettings({ comboStrategies: { A: {} }, requireLogin: true, tunnelUrl: "x", password: "h" }), {
    comboStrategies: { A: {} },
  });
  assert.equal(pickZaicodeRouterSettings([1]), null);
});
