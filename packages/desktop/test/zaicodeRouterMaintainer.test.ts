import assert from "node:assert/strict";
import test from "node:test";
import * as setup from "../src/main/zaicodeRouterSetup.js";
import { discoverZaicodeRouterModels } from "../src/main/zaicodeRouterModelDiscovery.js";
import type { ZaicodeRouterCall, ZaicodeRouterResponse } from "@zcode/shared";

function fixture() {
  const requests: ZaicodeRouterCall[] = [];
  let combos = [{ id: "free", name: "SAIFREN", models: ["manual/first"] }];
  const nodes = [
    { id: "acme-node", prefix: "acme", name: "Acme", baseUrl: "https://acme.example/v1" },
  ];
  const connections = [{ id: "acme-key", provider: "acme-node", isActive: true }];
  const catalogue = [{ provider: "opencode", model: "old-free", routedModel: "oc/old-free" }];
  let rows: unknown[] = [
    { id: "free-model", pricing: { prompt: "0", completion: "0" } },
    { id: "paid-free", pricing: { prompt: "1", completion: "2" } },
  ];
  let listingFailure = false;
  let warning: string | undefined;
  let lateEdit: (() => void) | undefined;
  const custom: { providerAlias: string; id: string }[] = [];
  const call = async (request: ZaicodeRouterCall): Promise<ZaicodeRouterResponse> => {
    requests.push(structuredClone(request));
    let data: unknown;
    switch (request.path) {
      case "/api/health":
        data = { status: "ok" };
        break;
      case "/api/provider-nodes":
        data = { nodes };
        break;
      case "/api/providers":
        data = { connections };
        break;
      case "/api/models":
        data = { models: catalogue };
        break;
      case "/api/models/custom":
        if (request.method === "POST") custom.push(request.body as (typeof custom)[number]);
        data = { models: custom, success: true };
        break;
      case "/api/providers/acme-key/models":
        lateEdit?.();
        lateEdit = undefined;
        if (listingFailure)
          return {
            ok: false,
            status: 429,
            data: { error: "Rate limited" },
            message: "Rate limited",
          };
        data = { models: rows, ...(warning ? { warning } : {}) };
        break;
      case "/api/combos":
        data = { combos: structuredClone(combos) };
        break;
      case "/api/combos/free":
        combos = combos.map((combo) =>
          combo.id === "free" ? { ...combo, ...(request.body as object) } : combo,
        );
        data = { combo: combos[0] };
        break;
      default:
        throw new Error(`Unexpected ${request.method} ${request.path}`);
    }
    return { ok: true, status: 200, data, message: "" };
  };
  const fetchJson = async (url: string) => {
    assert.equal(url, "https://opencode.ai/zen/v1/models");
    return { data: [{ id: "exo-free" }, { id: "paid-model" }] };
  };
  return {
    call,
    fetchJson,
    requests,
    custom,
    models: () => combos[0]?.models,
    setModels: (models: string[]) => {
      combos[0]!.models = models;
    },
    setRows: (next: unknown[]) => {
      rows = next;
    },
    fail: (value: boolean) => {
      listingFailure = value;
    },
    warn: (value?: string) => {
      warning = value;
    },
    editDuringListing: (edit: () => void) => {
      lateEdit = edit;
    },
    deleteDuringListing: () => {
      lateEdit = () => {
        combos = [];
      };
    },
  };
}

test("native keyless oc/exo-free is appended without a zen node or connection", async () => {
  const f = fixture();
  const result = await setup.scanZaicodeFreeModels(
    f.call,
    f.fetchJson,
    { added: [], lastScanAt: null },
    100,
  );
  assert.ok(result.added.some((entry) => entry.id === "oc/exo-free"));
  assert.deepEqual(f.models(), ["manual/first", "oc/exo-free", "acme/free-model"]);
  assert.ok(f.custom.some((model) => model.providerAlias === "oc" && model.id === "exo-free"));
});

test("Add models discovers configured providers outside starter list but never treats a paid free suffix as free", async () => {
  const f = fixture();
  const result = await setup.scanZaicodeFreeModels(
    f.call,
    f.fetchJson,
    { added: [], lastScanAt: null },
    100,
  );
  assert.ok(f.requests.some((request) => request.path === "/api/providers/acme-key/models"));
  assert.ok(result.added.some((entry) => entry.id === "acme/free-model"));
  assert.equal(f.models()!.includes("acme/paid-free"), false);
  assert.ok(
    f.custom.some((model) => model.id === "paid-free"),
    "supported paid models are selectable but not auto-added to a pool",
  );
});

test("Check is read only and never submits token-generating requests", async () => {
  const f = fixture();
  const check = (
    setup as unknown as {
      checkZaicodeRouterModels?: (
        call: typeof f.call,
        fetcher: typeof f.fetchJson,
        now: number,
      ) => Promise<{ providers: unknown[] }>;
    }
  ).checkZaicodeRouterModels;
  assert.equal(typeof check, "function", "explicit zero-token Check exists");
  const result = await check!(f.call, f.fetchJson, 100);
  assert.ok(result.providers.length >= 2);
  assert.ok(f.requests.every((request) => request.method === "GET"));
  assert.deepEqual(f.models(), ["manual/first"]);
});

test("two live absences retire, transient errors and static fallbacks do not, a returned model revives", async () => {
  const f = fixture();
  f.setModels(["manual/first", "acme/gone"]);
  f.setRows([]);
  let memory: setup.ZaicodeFreeScanMemory = { added: ["acme/gone"], lastScanAt: null };
  const scan = async (now: number) => {
    const result = await setup.scanZaicodeFreeModels(f.call, f.fetchJson, memory, now);
    memory = result.memory;
    return result;
  };
  await scan(100);
  assert.ok(f.models()!.includes("acme/gone"));
  f.fail(true);
  await scan(200);
  assert.ok(f.models()!.includes("acme/gone"));
  f.fail(false);
  f.warn("Using static catalogue");
  await scan(300);
  assert.ok(f.models()!.includes("acme/gone"));
  f.warn();
  const removed = await scan(400);
  assert.ok(removed.removed.includes("acme/gone"));
  assert.equal(f.models()!.includes("acme/gone"), false);
  f.setRows([{ id: "gone", pricing: { prompt: "0", completion: "0" } }]);
  const revived = await scan(500);
  assert.ok(revived.added.some((entry) => entry.id === "acme/gone"));
  assert.ok(f.models()!.includes("acme/gone"));
});

test("discovery preserves late external ordering and additions, and operator removals remain removed", async () => {
  const f = fixture();
  f.setModels(["acme/old", "manual/first"]);
  f.setRows([
    { id: "old", pricing: { prompt: "0", completion: "0" } },
    { id: "new", pricing: { prompt: "0", completion: "0" } },
  ]);
  f.editDuringListing(() => f.setModels(["external/first", "manual/first", "acme/old"]));
  const result = await setup.scanZaicodeFreeModels(
    f.call,
    f.fetchJson,
    { added: ["acme/old"], lastScanAt: null },
    100,
  );
  assert.deepEqual(f.models()!.slice(0, 3), ["external/first", "manual/first", "acme/old"]);
  f.setModels(f.models()!.filter((model) => model !== "acme/new"));
  const next = await setup.scanZaicodeFreeModels(f.call, f.fetchJson, result.memory, 200);
  assert.equal(
    next.added.some((entry) => entry.id === "acme/new"),
    false,
  );
});

test("an in-flight discovery cannot recreate a deleted pool", async () => {
  const f = fixture();
  f.deleteDuringListing();
  await setup.scanZaicodeFreeModels(f.call, f.fetchJson, { added: [], lastScanAt: null }, 100);
  assert.equal(f.models(), undefined);
  assert.equal(
    f.requests.some(
      (request) => request.path.startsWith("/api/combos/") && request.method !== "GET",
    ),
    false,
  );
});

test("native and custom catalogue aliases produce one provider check per routed prefix", async () => {
  const f = fixture();
  const call: setup.ZaicodeRouterCaller = async (request) =>
    request.path === "/api/models"
      ? {
          ok: true,
          status: 200,
          message: "",
          data: {
            models: [
              { provider: "opencode", model: "exo-free", routedModel: "oc/exo-free" },
              { provider: "oc", model: "second-free", routedModel: "oc/second-free" },
              { provider: "acme", model: "old", routedModel: "acme/old" },
            ],
          },
        }
      : f.call(request);
  const result = await discoverZaicodeRouterModels(
    call,
    f.fetchJson,
    await setup.readZaicodeRouterState(call),
  );
  assert.equal(result.providers.filter((entry) => entry.prefix === "oc").length, 1);
  assert.equal(result.providers.filter((entry) => entry.prefix === "acme").length, 1);
});

test("empty native OAuth listings cannot retire every model when the resolver silently returns no rows", async () => {
  const result = await discoverZaicodeRouterModels(
    async () => ({
      ok: true,
      status: 200,
      message: "",
      data: { models: [] },
    }),
    async () => {
      throw new Error("No public endpoint expected");
    },
    {
      nodes: [],
      combos: [],
      connections: [{ id: "codex-key", provider: "codex", isActive: true }],
    },
  );
  assert.equal(result.providers[0]?.status, "catalogue-only");
  assert.deepEqual(result.listings, []);
});

test("an alive model excluded from chat recommendations is retained, and one account cannot prove other account models dead", async () => {
  const f = fixture();
  f.setModels(["acme/audio-live", "acme/other-plan"]);
  f.setRows([{ id: "audio-live" }]);
  let first = await setup.scanZaicodeFreeModels(
    f.call,
    f.fetchJson,
    { added: [], lastScanAt: null },
    100,
  );
  first = await setup.scanZaicodeFreeModels(f.call, f.fetchJson, first.memory, 200);
  assert.ok(f.models()!.includes("acme/audio-live"));
  assert.equal(f.models()!.includes("acme/other-plan"), false);
  f.setModels(["acme/other-plan"]);
  const multi: setup.ZaicodeRouterCaller = async (request) =>
    request.path === "/api/providers"
      ? {
          ok: true,
          status: 200,
          message: "",
          data: {
            connections: [
              { id: "acme-key", provider: "acme-node", isActive: true },
              { id: "another-key", provider: "acme-node", isActive: true },
            ],
          },
        }
      : f.call(request);
  first = await setup.scanZaicodeFreeModels(
    multi,
    f.fetchJson,
    { added: [], lastScanAt: null },
    300,
  );
  await setup.scanZaicodeFreeModels(multi, f.fetchJson, first.memory, 400);
  assert.ok(f.models()!.includes("acme/other-plan"));
});
