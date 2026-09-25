import assert from "node:assert/strict";
import test from "node:test";
import {
  ZAICODE_FREE_PROVIDERS,
  planZaicodeFreePool,
  zaicodeFreeModelsFromListing,
  zaicodeNewFreeModels,
} from "@zcode/shared";
import { describeZaicodeFreeModelsAdded } from "../src/zaicode/zaicodeRouterSetup.js";

test("free pool plan: an empty router gets every keyless provider and SAIFREN; a complete one gets nothing", () => {
  const empty = planZaicodeFreePool({ nodes: [], connections: [], pool: null });
  const keyless = ZAICODE_FREE_PROVIDERS.filter((provider) => provider.keyless);
  assert.equal(empty.filter((step) => step.kind === "create-node").length, keyless.length);
  assert.equal(empty.filter((step) => step.kind === "create-connection").length, keyless.length);
  const pool = empty.find((step) => step.kind === "create-pool");
  assert.ok(pool && pool.kind === "create-pool");
  assert.equal(pool.models[0], "kilo/kilo-auto/free", "the most reliable keyless route comes first");
  const nodes = keyless.map((provider, index) => ({ id: `n${index}`, prefix: provider.prefix, baseUrl: provider.baseUrl }));
  const connections = nodes.map((node, index) => ({ id: `c${index}`, provider: node.id }));
  assert.deepEqual(planZaicodeFreePool({ nodes, connections, pool: pool.models }), []);
});

test("free pool plan: the operator's own node for the same URL is reused, missing starters are appended", () => {
  const kilo = ZAICODE_FREE_PROVIDERS.find((provider) => provider.id === "kilo")!;
  const plan = planZaicodeFreePool({
    nodes: [{ id: "mine", prefix: "kilopass", baseUrl: `${kilo.baseUrl}/` }],
    connections: [{ id: "c", provider: "mine" }],
    pool: ["xjy/glm", "kilopass/kilo-auto/free"],
  });
  assert.equal(plan.some((step) => step.kind === "create-node" && step.provider.id === "kilo"), false);
  const add = plan.find((step) => step.kind === "add-models");
  assert.ok(add && add.kind === "add-models");
  assert.equal(add.models.includes("kilopass/kilo-auto/free"), false, "already in the pool under the operator's prefix");
});

test("free models from each provider's own list; paid and non-chat models are never picked", () => {
  const kilo = zaicodeFreeModelsFromListing("kilo", {
    data: [
      { id: "kilo-auto/free" },
      { id: "qwen/qwen3.8-27b:free" },
      { id: "nvidia/nemotron-3.5-content-safety:free" },
      { id: "paid/x", pricing: { prompt: "0.000001", completion: "0.000002" } },
      { id: "promo/y", pricing: { prompt: "0", completion: "0" } },
      { id: "google/lyria-3-pro-preview", pricing: { prompt: "0", completion: "0" } },
    ],
  });
  assert.deepEqual(kilo, ["kilo-auto/free", "qwen/qwen3.8-27b:free", "promo/y"]);
  assert.deepEqual(zaicodeFreeModelsFromListing("pollinations", [{ name: "openai-fast", tier: "anonymous" }, { name: "big", tier: "seed" }]), ["openai-fast"]);
  assert.deepEqual(zaicodeFreeModelsFromListing("opencode", { data: [{ id: "big-pickle" }, { id: "north-mini-code-free" }] }), ["north-mini-code-free"]);
  assert.deepEqual(zaicodeFreeModelsFromListing("llm7", { data: [{ id: "GLM-5.3-Flash" }] }), [], "no guessing on LLM7");
  assert.deepEqual(zaicodeFreeModelsFromListing("groq", { data: [{ id: "llama-4" }, { id: "whisper-large-v3" }] }), ["llama-4"]);
  assert.deepEqual(zaicodeFreeModelsFromListing("kilo", "junk"), []);
});

test("new free models: not in the pool and not removed by the operator", () => {
  assert.deepEqual(zaicodeNewFreeModels(["a", "b", "c"], ["a"], ["c"]), ["b"]);
});

test("the notice says what was added: 'Today free model X added to SAIFREN'", () => {
  assert.equal(describeZaicodeFreeModelsAdded([]), null);
  assert.equal(describeZaicodeFreeModelsAdded([{ id: "kilo/x:free", provider: "Kilo" }])?.title, "Today free model kilo/x:free added to SAIFREN");
  const many = describeZaicodeFreeModelsAdded(Array.from({ length: 8 }, (_, index) => ({ id: `m${index}`, provider: "P" })));
  assert.equal(many?.title, "Today 8 free models added to SAIFREN");
  assert.match(many?.body ?? "", /\+2 more$/);
});

test("app side of zero setup: an empty model list gets SAIRoute -> router, SAIFREN + SAIOPP, SAIFREN as default", async () => {
  const storage = new Map<string, string>();
  const g = globalThis as Record<string, unknown>;
  g.localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  };
  const host = { requestedMode: "auto", mode: "isolated", url: "http://127.0.0.1:20138", dataDir: "x", packageDir: "p", managed: true, running: true, pid: 1, restarts: 0, lastError: null, startedAt: 1, logFile: null };
  const asked: unknown[] = [];
  g.window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
    zcode: {
      getZaicodeRouterHost: async () => host,
      getZaicodeFreeScanInfo: async () => ({ lastScanAt: null }),
      bootstrapZaicodeRouter: async (options: unknown) => {
        asked.push(options);
        return { ok: true, host, apiKey: "sk-zaicode", steps: [], firstToken: { ok: true, detail: "answered in 1.0 s", servedBy: "m" } };
      },
    },
  };
  const providers: { providerId: string; providerName: string; personalConfig: object; effectiveConfig: object; models: { modelId: string }[] }[] = [];
  const created: unknown[] = [];
  const models: string[] = [];
  const service = {
    getView: async () => ({
      providers: providers.map((provider) => ({
        ...provider,
        templateId: undefined,
        executable: true,
        enabled: true,
        accountState: undefined,
        issues: [],
        models: provider.models.map((model) => ({ kind: "personal", modelId: model.modelId, builtin: false, effectiveBuiltinConfig: {}, personalConfig: {}, effectiveConfig: {} })),
      })),
    }),
    createPersonalProvider: async (input: { providerName: string; initialConfig: { api: object } }) => {
      created.push(input);
      providers.push({ providerId: "p1", providerName: input.providerName, personalConfig: {}, effectiveConfig: input.initialConfig, models: [] });
      return { providerId: "p1" };
    },
    addPersonalModel: async (providerId: string, modelId: string) => {
      models.push(`${providerId}/${modelId}`);
      providers[0]!.models.push({ modelId });
      return {};
    },
  };
  const { runZaicodeRouterSetup } = await import("../src/zaicode/useZaicodeRouterAutoSetup.js");
  const result = await runZaicodeRouterSetup(service as never, "setup");
  assert.equal(result?.ok, true);
  assert.deepEqual(asked, [{ needKey: true }], "no provider yet: the router is asked for ZAICODE's key");
  assert.deepEqual(created, [
    {
      providerName: "SAIRoute",
      initialConfig: { access: { type: "api-key", apiKey: "sk-zaicode" }, api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1:20138/v1" } },
    },
  ]);
  assert.deepEqual(models, ["p1/SAIFREN", "p1/SAIOPP"]);
  assert.deepEqual(JSON.parse(storage.get("zaicode-default-model") ?? "null"), { providerId: "p1", modelId: "SAIFREN" });
  // Second start: the provider is there and points at the router -> no key asked, nothing created.
  asked.length = 0;
  await runZaicodeRouterSetup(service as never, "setup");
  assert.deepEqual(asked, [{ needKey: false }]);
  assert.equal(created.length, 1);
});
