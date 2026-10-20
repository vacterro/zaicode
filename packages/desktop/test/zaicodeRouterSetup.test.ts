import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import { ZAICODE_FREE_POOL, ZAICODE_OWN_POOL, ZAICODE_KEYLESS_API_KEY } from "@zcode/shared";
import {
  addZaicodeFreeKeyProvider,
  ensureZaicodeFreePool,
  ensureZaicodeRouterKey,
  findZaicodeRouterKey,
  proposeZaicodeRouterKeyCleanup,
  probeZaicodeRouterModel,
  readZaicodeRouterState,
  scanZaicodeFreeModels,
  type ZaicodeRouterCaller,
} from "../src/main/zaicodeRouterSetup.js";
import { callZaicodeRouterInternal, setZaicodeRouterTarget } from "../src/main/zaicodeRouterTransport.js";
import { ZaicodeRouterProcess, isZaicodeRouterHealthy } from "../src/main/zaicodeRouterProcess.js";

/**
 * Zero-setup router against a REAL, fresh 9router (T-46): an empty data folder,
 * the server run by the same supervisor ZAICODE's router host uses (here with
 * node instead of ZAICODE's own executable), then the setup chain -- pool,
 * key, first token through SAIFREN, scan, free key -- and the repairs:
 * a crashed router comes back by itself, a stopped one and a deleted pool are
 * repaired. Skipped when no 9router package is on this machine.
 * The first-token step talks to the real free providers (network).
 */

const PORT = 20149;
const URL = `http://127.0.0.1:${PORT}`;

function findPackage(): string | null {
  const dirs = [
    process.env.ZAICODE_ROUTER_PACKAGE,
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "9router") : undefined,
    ...(process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, "node_modules", "9router")),
  ];
  return dirs.find((dir) => dir && existsSync(join(dir, "app", "server.js"))) ?? null;
}

const packageDir = findPackage();
const dataDir = mkdtempSync(join(tmpdir(), "zaicode-router-setup-"));
let router: ZaicodeRouterProcess | null = null;
const healthy = () => isZaicodeRouterHealthy(URL);

before(async () => {
  if (!packageDir) return;
  router = new ZaicodeRouterProcess({ execPath: process.execPath, packageDir, dataDir, port: PORT, logFile: join(dataDir, "router.log") });
  await router.start();
  setZaicodeRouterTarget({ url: URL, dataDir });
});

after(() => {
  router?.stop();
  setZaicodeRouterTarget(null);
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // the server may still hold the database for a moment
  }
});

const skip = packageDir ? false : "no 9router package on this machine";
let apiKey = "";

test("an empty router gets the keyless free providers, SAIFREN and SAIOPP; a second run changes nothing", { skip }, async () => {
  assert.ok(await healthy(), "the fresh router answers");
  const first = await ensureZaicodeFreePool(callZaicodeRouterInternal);
  assert.ok(first.steps.some((step) => step.id === "pool:free" && step.status === "fixed"));
  assert.ok(first.steps.some((step) => step.id === "pool:own" && step.status === "fixed"));
  const state = await readZaicodeRouterState(callZaicodeRouterInternal);
  const pool = state.combos.find((combo) => combo.name === ZAICODE_FREE_POOL);
  assert.deepEqual(pool?.models.slice(0, 2), ["kilo/kilo-auto/free", "pol/openai-fast"]);
  assert.ok(state.combos.some((combo) => combo.name === ZAICODE_OWN_POOL));
  assert.equal(state.connections.length, 3);
  const second = await ensureZaicodeFreePool(callZaicodeRouterInternal, first.added);
  assert.ok(second.steps.every((step) => step.status === "ok"), JSON.stringify(second.steps));
  assert.equal((await readZaicodeRouterState(callZaicodeRouterInternal)).connections.length, 3);
});

test("a starter the operator removed from SAIFREN is not put back", { skip }, async () => {
  const state = await readZaicodeRouterState(callZaicodeRouterInternal);
  const pool = state.combos.find((combo) => combo.name === ZAICODE_FREE_POOL)!;
  const trimmed = pool.models.filter((model) => model !== "llm7/codestral-latest");
  await callZaicodeRouterInternal({ method: "PUT", path: `/api/combos/${pool.id}`, body: { models: trimmed } });
  await ensureZaicodeFreePool(callZaicodeRouterInternal, pool.models);
  const after = (await readZaicodeRouterState(callZaicodeRouterInternal)).combos.find((combo) => combo.name === ZAICODE_FREE_POOL)!;
  assert.equal(after.models.includes("llm7/codestral-latest"), false);
});

test("ZAICODE's key is created once and reused while 9router has it", { skip }, async () => {
  const created = await ensureZaicodeRouterKey(callZaicodeRouterInternal, null);
  assert.equal(created.created, true);
  const reused = await ensureZaicodeRouterKey(callZaicodeRouterInternal, created.key);
  assert.deepEqual(reused, { key: created.key, created: false });
  const replaced = await ensureZaicodeRouterKey(callZaicodeRouterInternal, "sk-not-in-this-router");
  assert.equal(replaced.created, true);
  apiKey = replaced.key;
});

test("first token through SAIFREN with no key, account or provider set up (real free providers)", { skip }, async () => {
  const probe = await probeZaicodeRouterModel(URL, apiKey, ZAICODE_FREE_POOL);
  assert.ok(probe.ok, probe.detail);
});

test("the daily scan appends a newly free model once, says so, and respects a removal", { skip }, async () => {
  const listing = { data: [{ id: "kilo-auto/free" }, { id: "brand/new-model:free" }, { id: "paid/model", pricing: { prompt: "0.1", completion: "0.2" } }] };
  const fetchJson = async (url: string) => (url.includes("kilo") ? listing : url.includes("pollinations") ? [{ name: "openai-fast", tier: "anonymous" }] : { data: [] });
  const first = await scanZaicodeFreeModels(callZaicodeRouterInternal, fetchJson, { added: [], lastScanAt: null }, 1);
  assert.deepEqual(first.added.map((entry) => entry.id), ["kilo/brand/new-model:free"]);
  const again = await scanZaicodeFreeModels(callZaicodeRouterInternal, fetchJson, first.memory, 2);
  assert.equal(again.added.length, 0);
  // The operator takes it out: the next scan leaves it out.
  const pool = (await readZaicodeRouterState(callZaicodeRouterInternal)).combos.find((combo) => combo.name === ZAICODE_FREE_POOL)!;
  await callZaicodeRouterInternal({ method: "PUT", path: `/api/combos/${pool.id}`, body: { models: pool.models.filter((model) => !model.includes("brand/new-model")) } });
  const respected = await scanZaicodeFreeModels(callZaicodeRouterInternal, fetchJson, again.memory, 3);
  assert.equal(respected.added.length, 0);
});

test("a bad free key is refused and leaves nothing behind", { skip }, async () => {
  const before = (await readZaicodeRouterState(callZaicodeRouterInternal)).connections.length;
  const result = await addZaicodeFreeKeyProvider(callZaicodeRouterInternal, "groq", "gsk_not_a_real_key");
  assert.equal(result.ok, false, result.message);
  assert.equal((await readZaicodeRouterState(callZaicodeRouterInternal)).connections.length, before);
});

async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

test("a crashed router comes back by itself (supervisor restart with backoff)", { skip }, async () => {
  const pid = router!.pid!;
  process.kill(pid);
  assert.ok(await waitFor(async () => router!.restarts > 0, 10_000), "the crash was noticed");
  assert.ok(await waitFor(async () => (await healthy()) && router!.pid !== pid, 45_000), "a new process answers");
  assert.equal((await readZaicodeRouterState(callZaicodeRouterInternal)).combos.some((combo) => combo.name === ZAICODE_FREE_POOL), true, "data survived");
});

test("Autotroubleshoot repairs: a stopped router is started again, a deleted pool is rebuilt", { skip }, async () => {
  router!.stop();
  assert.equal(await waitFor(async () => !(await healthy()), 10_000), true, "stopped for real");
  assert.equal(router!.restarts > 1, false, "a clean stop is not treated as a crash");
  assert.equal(await router!.restart(), true);
  const pool = (await readZaicodeRouterState(callZaicodeRouterInternal)).combos.find((combo) => combo.name === ZAICODE_FREE_POOL)!;
  await callZaicodeRouterInternal({ method: "DELETE", path: `/api/combos/${pool.id}` });
  const repaired = await ensureZaicodeFreePool(callZaicodeRouterInternal);
  assert.ok(repaired.steps.some((step) => step.id === "pool:free" && step.status === "fixed"));
  const probe = await probeZaicodeRouterModel(URL, apiKey, ZAICODE_FREE_POOL);
  assert.ok(probe.ok, `first token after the repair: ${probe.detail}`);
});

/**
 * REQ-014: one stable ZAICODE router credential (T-279). Fake 9router key
 * listings, so these run with no router on the machine: lookup never
 * creates, concurrent acquisition shares one creation, failures stay
 * explicit, and cleanup proposals carry no secret material.
 */
function fakeKeyCaller(
  entries: unknown[],
  options?: { failList?: string; failCreate?: string; delayMs?: number },
): { call: ZaicodeRouterCaller; posts: () => number } {
  let posts = 0;
  const call: ZaicodeRouterCaller = async (request) => {
    if (request.method === "GET" && request.path === "/api/keys") {
      if (options?.failList)
        return { ok: false, status: 500, message: options.failList, data: null };
      if (options?.delayMs) await new Promise((done) => setTimeout(done, options.delayMs));
      return { ok: true, status: 200, message: "", data: { keys: entries } };
    }
    if (request.method === "POST" && request.path === "/api/keys") {
      posts += 1;
      if (options?.failCreate)
        return { ok: false, status: 500, message: options.failCreate, data: null };
      return { ok: true, status: 200, message: "", data: { key: `sk-fake-${posts}` } };
    }
    throw new Error(`unexpected ${request.method} ${request.path}`);
  };
  return { call, posts: () => posts };
}

test("loopback router acquisition uses no client keys and changes only API-key authentication", async () => {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let requiresKey = true;
  const call: ZaicodeRouterCaller = async (request) => {
    calls.push(request);
    if (request.method === "GET" && request.path === "/api/settings")
      return { ok: true, status: 200, message: "", data: { requireApiKey: requiresKey, requireLogin: true } };
    if (request.method === "PATCH" && request.path === "/api/settings") {
      assert.deepEqual(request.body, { requireApiKey: false });
      requiresKey = false;
      return { ok: true, status: 200, message: "", data: {} };
    }
    throw new Error(`client-key route must not be called: ${request.method} ${request.path}`);
  };
  for (const url of ["http://127.0.0.1:20128", "http://localhost:20138", "http://[::1]:20138"]) {
    assert.deepEqual(await ensureZaicodeRouterKey(call, null, url), { key: ZAICODE_KEYLESS_API_KEY, created: false });
  }
  assert.equal(calls.filter((request) => request.method === "PATCH").length, 1);
  assert.ok(calls.every((request) => request.path === "/api/settings"));
});

test("loopback setup failures cannot create a fallback key or weaken remote authentication", async () => {
  const unavailable: ZaicodeRouterCaller = async () => ({ ok: false, status: 503, data: null, message: "offline" });
  await assert.rejects(ensureZaicodeRouterKey(unavailable, null, "http://127.0.0.1:20128"), /offline/);
  const remote = fakeKeyCaller([]);
  assert.equal((await ensureZaicodeRouterKey(remote.call, null, "https://router.example")).created, true);
  assert.equal(remote.posts(), 1);
});

test("independent router callers never share a newly created credential", async () => {
  const first = fakeKeyCaller([], { delayMs: 10 });
  const second = fakeKeyCaller([], { delayMs: 10 });
  await Promise.all([ensureZaicodeRouterKey(first.call, null), ensureZaicodeRouterKey(second.call, null)]);
  assert.equal(first.posts(), 1);
  assert.equal(second.posts(), 1);
});

test("separate stored credentials at the same remote endpoint cannot be coalesced", async () => {
  const first = fakeKeyCaller([{ key: "sk-first", isActive: true }], { delayMs: 10 });
  const second = fakeKeyCaller([{ key: "sk-second", isActive: true }], { delayMs: 10 });
  const results = await Promise.all([
    ensureZaicodeRouterKey(first.call, "sk-first", "https://router.example"),
    ensureZaicodeRouterKey(second.call, "sk-second", "https://router.example"),
  ]);
  assert.deepEqual(results.map((entry) => entry.key), ["sk-first", "sk-second"]);
  assert.equal(first.posts() + second.posts(), 0);
});

test("lookup reuses an active stored key and never creates; inactive or revoked stored keys fall to one controlled creation", async () => {
  const stored = "sk-live-1";
  const reuse = fakeKeyCaller([{ id: "k1", name: "ZAICODE", key: stored, isActive: true }]);
  assert.deepEqual(await ensureZaicodeRouterKey(reuse.call, stored), {
    key: stored,
    created: false,
  });
  assert.equal(reuse.posts(), 0);
  for (const dead of [
    [{ id: "k1", name: "ZAICODE", key: stored, isActive: false }],
    [{ id: "k1", name: "ZAICODE", key: stored, revoked: true }],
    [{ id: "k1", name: "ZAICODE", key: stored, active: false }],
    [],
  ]) {
    const fake = fakeKeyCaller(dead);
    const result = await ensureZaicodeRouterKey(fake.call, stored);
    assert.equal(result.created, true);
    assert.equal(fake.posts(), 1);
  }
});

test("masked listings without full key material create once and say so; ZAICODE-named entries are reported, never adopted or deleted", async () => {
  const entries = [
    { id: "k1", name: "ZAICODE", keyPrefix: "sk-abc", isActive: true },
    { id: "k2", name: "ZAICODE", keyPrefix: "sk-def", isActive: true },
    { id: "k3", name: "operator", keyPrefix: "sk-xyz", isActive: true },
  ];
  assert.equal(findZaicodeRouterKey(entries, "sk-abc-full"), false);
  const fake = fakeKeyCaller(entries);
  const result = await ensureZaicodeRouterKey(fake.call, "sk-abc-full");
  assert.equal(result.created, true);
  assert.equal(fake.posts(), 1);
  const proposal = proposeZaicodeRouterKeyCleanup(entries);
  assert.equal(proposal.total, 3);
  assert.equal(proposal.duplicateNamed, 1);
  assert.deepEqual(
    proposal.zaicodeNamed.map((entry) => entry.id),
    ["k1", "k2"],
  );
  assert.ok(!JSON.stringify(proposal).includes("sk-"));
});

test("concurrent reads for one slot share a single acquisition; list and create failures stay explicit with no stuck gate", async () => {
  const fake = fakeKeyCaller([], { delayMs: 20 });
  const [first, second, third] = await Promise.all([
    ensureZaicodeRouterKey(fake.call, null),
    ensureZaicodeRouterKey(fake.call, null),
    ensureZaicodeRouterKey(fake.call, null),
  ]);
  assert.equal(first.key, second.key);
  assert.equal(second.key, third.key);
  assert.equal(fake.posts(), 1);
  const failing = fakeKeyCaller([], { failList: "router down" });
  await assert.rejects(ensureZaicodeRouterKey(failing.call, "sk-x"), /router down/);
  assert.equal(failing.posts(), 0);
  const refused = fakeKeyCaller([], { failCreate: "quota" });
  await assert.rejects(ensureZaicodeRouterKey(refused.call, null), /quota/);
  const retry = await ensureZaicodeRouterKey(fakeKeyCaller([]).call, "sk-retry-slot");
  assert.equal(retry.created, true);
});
