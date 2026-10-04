import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ZaicodeRouterHealthProbe } from "../src/main/zaicodeRouterHealth.js";
import { ZaicodeRouterProcess } from "../src/main/zaicodeRouterProcess.js";
import { ZaicodeRouterSupervisor, type RouterSupervisorState } from "../src/main/zaicodeRouterSupervisor.js";
import { ZaicodeSubscriptionProxy } from "../src/main/zaicodeSubscriptionProxy.js";

// 真杀独立测试进程，避免把“模拟健康布尔值”误当成崩溃集成证据；不访问付费厂商。
const CHILD = `
const http = require('node:http');
let health = 200;
const server = http.createServer(async (req, res) => {
  if (req.url === '/api/health') { res.writeHead(health); res.end('{}'); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const status = body.model === 'quota' ? 429 : body.model === 'broken-model' ? 500 : 200;
  res.writeHead(status, {'content-type':'application/json'});
  res.end(JSON.stringify({route:'preferred', body, error:status===429?'subscription quota exhausted':status===500?'provider model failed':null}));
});
server.listen(Number(process.argv[1]), '127.0.0.1', () => process.send({port:server.address().port}));
process.on('message', message => {
  if (message === 'unhealthy') { health = 503; process.send({changed:true}); }
  if (message === 'close-api') { server.closeAllConnections(); server.close(() => process.send({changed:true})); }
});
`;

async function router(t: TestContext, port = 0) {
  const child = spawn(process.execPath, ["-e", CHILD, String(port)], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  const ready = await Promise.race([once(child, "message"), once(child, "error").then(([error]) => { throw error; })]);
  const actual = (ready[0] as { port: number }).port;
  const kill = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  };
  t.after(kill);
  const command = async (value: string) => { const ack = once(child, "message"); child.send(value); await ack; };
  return { child, url: `http://127.0.0.1:${actual}`, port: actual, kill, command };
}

function alive(child: ChildProcess): number | null {
  return child.exitCode === null && child.signalCode === null ? child.pid ?? null : null;
}
async function listen(t: TestContext, server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function post(url: string, body: object) {
  const response = await fetch(`${url}/router/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer fixture-token", "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  return { status: response.status, data: await response.json() as { route: string; body: Record<string, unknown>; error?: string } };
}

test("real local process death, unhealthy API and a living process with an unreachable API are distinct", { timeout: 15_000 }, async (t) => {
  const fixture = await router(t);
  const probe = new ZaicodeRouterHealthProbe(fixture.url, async () => alive(fixture.child));
  assert.equal(await probe.probe(), "healthy");
  await fixture.command("unhealthy");
  assert.equal(await probe.probe(), "api-unhealthy");
  await fixture.command("close-api");
  assert.equal(await probe.probe(), "connection-failure");
  await fixture.kill();
  assert.equal(await probe.probe(), "process-unavailable");
});

test("killed router recovers on attempt four with one real replacement process", { timeout: 15_000 }, async (t) => {
  let fixture = await router(t);
  const probe = new ZaicodeRouterHealthProbe(fixture.url, async () => alive(fixture.child));
  let now = 1000;
  let attempts = 0;
  let active = 0;
  const manager = new ZaicodeRouterSupervisor({ probe: () => probe.probe(), now: () => now, wait: async (ms) => { now += ms; }, persist: async () => {}, fallback: async () => { assert.fail("intermediate recovery must retain preferred"); }, recover: async () => {
    assert.equal(++active, 1);
    try { if (++attempts === 4) fixture = await router(t, fixture.port); } finally { active--; }
  } });
  assert.equal(await manager.boundary(), "preferred");
  await fixture.kill();
  const selected = await Promise.all([manager.boundary(), manager.boundary(), manager.boundary()]);
  assert.deepEqual(selected, ["preferred", "preferred", "preferred"]);
  assert.equal(attempts, 4);
  assert.equal(manager.state.status, "restored");
  assert.equal(manager.state.failure, null);
});

test("ten real outage probes fail open with unchanged work, persist across restart, and restore only after an in-flight response", { timeout: 25_000 }, async (t) => {
  let fixture = await router(t);
  const probe = new ZaicodeRouterHealthProbe(fixture.url, async () => alive(fixture.child));
  const directory = await mkdtemp(join(tmpdir(), "zaicode-continuity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "supervisor.json");
  let now = 1000;
  let attempts = 0;
  let held: (() => void) | null = null;
  let arrived: (() => void) | null = null;
  const fallback = createServer(async (request, response) => {
    if (request.url === "/api/health") { response.end("{}"); return; }
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (body.hold) await new Promise<void>((resolve) => { held = resolve; arrived?.(); });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ route: "fallback", body }));
  });
  const fallbackUrl = await listen(t, fallback);
  const ports = { probe: () => probe.probe(), now: () => now, wait: async (ms: number) => { now += ms; }, persist: (state: RouterSupervisorState) => writeFile(statePath, JSON.stringify(state)), recover: async () => { attempts++; }, fallback: async () => (await fetch(`${fallbackUrl}/api/health`)).ok };
  let manager = new ZaicodeRouterSupervisor(ports);
  assert.equal(await manager.boundary(), "preferred");
  await fixture.kill();
  const proxy = new ZaicodeSubscriptionProxy({ token: "fixture-token", routerUrl: () => fixture.url, routerKey: async () => "unused", call: async () => { assert.fail("generic inference must not change account/scheduler ownership"); }, route: async () => {
    const route = await manager.boundary();
    return route ? { url: route === "fallback" ? fallbackUrl : fixture.url, key: "fixture-key", fallback: route === "fallback" } : null;
  } });
  const proxyUrl = await proxy.listen(0);
  t.after(() => proxy.close());
  const work = { model: "preferred-model", messages: [{ role: "user", content: "Continue the existing objective" }], metadata: { project: "A", session: "canonical-main", schedulerOwner: "saipen", pendingContinuation: "continuation-123", objective: "keep this task" }, reasoning_effort: "high" };
  const answer = await post(proxyUrl, work);
  assert.equal(answer.status, 200);
  assert.equal(answer.data.route, "fallback");
  assert.deepEqual(answer.data.body, { ...work, model: "SAIFREN" });
  assert.equal(attempts, 10);
  assert.equal(manager.state.status, "fallback-active");
  manager = new ZaicodeRouterSupervisor(ports, JSON.parse(await readFile(statePath, "utf8")));
  assert.equal((await post(proxyUrl, work)).data.route, "fallback");
  assert.equal(attempts, 10, "restart must retain the exhausted recovery budget");
  const received = new Promise<void>((resolve) => { arrived = resolve; });
  const inFlight = post(proxyUrl, { ...work, hold: true });
  await received;
  fixture = await router(t, fixture.port);
  now += 60_000;
  await manager.tick();
  now += 30_000;
  await manager.tick();
  assert.equal(manager.state.route, "fallback", "healthy probes cannot move the active stream");
  assert.ok(held);
  (held as () => void)();
  assert.equal((await inFlight).data.route, "fallback");
  assert.equal((await post(proxyUrl, work)).data.route, "preferred");
  assert.equal(manager.state.status, "restored");
  assert.equal(attempts, 10);
});

test("real quota and provider/model HTTP failures behind a healthy router never consume restart budget", { timeout: 10_000 }, async (t) => {
  const fixture = await router(t);
  const probe = new ZaicodeRouterHealthProbe(fixture.url, async () => alive(fixture.child));
  const manager = new ZaicodeRouterSupervisor({ probe: () => probe.probe(), now: Date.now, wait: async () => {}, persist: async () => {}, recover: async () => { assert.fail("healthy provider failure is not router death"); }, fallback: async () => { assert.fail("healthy quota is handled by T-190, not host fallback"); } });
  const proxy = new ZaicodeSubscriptionProxy({ token: "fixture-token", routerUrl: () => fixture.url, routerKey: async () => "unused", call: async () => { assert.fail("unused"); }, route: async () => (await manager.boundary()) ? { url: fixture.url, key: "fixture-key", fallback: false } : null });
  const url = await proxy.listen(0);
  t.after(() => proxy.close());
  assert.equal((await post(url, { model: "quota", messages: [] })).status, 429);
  assert.equal((await post(url, { model: "broken-model", messages: [] })).status, 500);
  assert.equal(manager.state.attempts, 0);
  assert.equal(manager.state.status, "preferred");
});

test("stop during a pending startup health check prevents a late process spawn", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zaicode-start-cancel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const url = await listen(t, createServer(() => {}));
  const process = new ZaicodeRouterProcess({ execPath: globalThis.process.execPath, packageDir: directory, dataDir: directory, port: Number(new URL(url).port), logFile: join(directory, "test.log"), autoRestart: false });
  const starting = process.start();
  process.stop();
  assert.equal(await starting, false);
  assert.equal(process.pid, null);
  assert.equal(process.lastError, null, "a cancelled start must never attempt to locate/spawn the router script");
});
