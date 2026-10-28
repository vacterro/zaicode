import assert from "node:assert/strict";
import test from "node:test";
import {
  isZaicodeComboNameValid,
  isZaicodeRouterCallAllowed,
  moveZaicodeComboModel,
  normalizeZaicodeRouterCombos,
  normalizeZaicodeRouterConnections,
  normalizeZaicodeRouterModels,
  normalizeZaicodeRouterNodes,
  suggestZaicodeProviderPrefix,
  withZaicodeComboStrategy,
} from "@zcode/shared";
import { readZaicodeRouterUsage } from "../src/zaicode/zaicodeRouter.js";

test("Router allow-list: the page's calls pass, shutdown / update / traversal / other settings do not", () => {
  const ok = (method: string, path: string, body?: unknown) =>
    isZaicodeRouterCallAllowed({ method: method as never, path, ...(body !== undefined ? { body } : {}) });
  assert.equal(ok("GET", "/api/providers"), true);
  assert.equal(ok("POST", "/api/provider-nodes"), true);
  assert.equal(ok("PUT", "/api/combos/07ec0cc9-ab58-416c-8c79-2285f243ea7b"), true);
  assert.equal(ok("POST", "/api/providers/openai-compatible-chat-abc/test"), true);
  assert.equal(ok("GET", "/api/usage/stats?period=today"), true);
  assert.equal(ok("GET", "/api/usage/stats?period=forever"), false);
  assert.equal(ok("POST", "/api/shutdown"), false);
  assert.equal(ok("POST", "/api/version/update"), false);
  assert.equal(ok("POST", "/api/version/shutdown"), false);
  assert.equal(ok("GET", "/api/settings/database"), false);
  assert.equal(ok("DELETE", "/api/combos/../settings"), false);
  assert.equal(ok("GET", "/api/providers/a/b/models"), false);
  assert.equal(ok("PUT", "/api/providers"), false);
  assert.equal(ok("GET", "/api/keys"), false);
  // Settings: only the pool strategies may change from ZAICODE.
  assert.equal(ok("PATCH", "/api/settings", { comboStrategies: {} }), true);
  assert.equal(ok("PATCH", "/api/settings", { requireLogin: false }), false);
  assert.equal(ok("PATCH", "/api/settings", { comboStrategies: {}, tunnelDashboardAccess: true }), false);
  assert.equal(ok("PATCH", "/api/settings"), false);
});

test("Router records: connections, nodes, pools with strategy, models", () => {
  const connections = normalizeZaicodeRouterConnections({
    connections: [
      { id: "c1", provider: "openai-compatible-chat-x", name: "AMD", isActive: true, authType: "apikey", providerSpecificData: { prefix: "amd", baseUrl: "https://x/v1" } },
      { id: "c2", provider: "codex", name: "Codex", isActive: false, authType: "oauth" },
      { provider: "no-id" },
      null,
    ],
  });
  assert.equal(connections.length, 2);
  assert.equal(connections[0]!.prefix, "amd");
  assert.equal(connections[1]!.isActive, false);
  assert.deepEqual(normalizeZaicodeRouterConnections({}), []);

  const nodes = normalizeZaicodeRouterNodes({ nodes: [{ id: "n1", type: "anthropic-compatible", name: "J", prefix: "jwa", baseUrl: "https://j" }] });
  assert.equal(nodes[0]!.prefix, "jwa");

  const combos = normalizeZaicodeRouterCombos(
    { combos: [{ id: "a", name: "SAIFREN", models: ["x/1", 2, "y/2"] }, { id: "b", name: "SAIOPP", models: [] }] },
    { comboStrategies: { SAIOPP: { fallbackStrategy: "round-robin" } } },
  );
  assert.deepEqual(combos[0]!.models, ["x/1", "y/2"]);
  assert.equal(combos[0]!.strategy, "fallback");
  assert.equal(combos[1]!.strategy, "round-robin");

  const models = normalizeZaicodeRouterModels({
    models: [
      { provider: "codex", model: "gpt-5", routedModel: "cx/gpt-5", caps: { vision: true } },
      { provider: "codex", model: "gpt-5", routedModel: "cx/gpt-5" },
      { fullModel: "ag/gemini" },
    ],
  });
  assert.deepEqual(models.map((model) => model.id), ["cx/gpt-5", "ag/gemini"]);
  assert.equal(models[0]!.vision, true);
});

test("Pool edits: strategy map like the dashboard, moves clamp, names and prefixes", () => {
  assert.deepEqual(withZaicodeComboStrategy({ A: { fallbackStrategy: "fusion", judge: "j" } }, "A", "round-robin"), {
    A: { fallbackStrategy: "round-robin", judge: "j" },
  });
  assert.deepEqual(withZaicodeComboStrategy({ A: { fallbackStrategy: "fusion" }, B: {} }, "A", "fallback"), { B: {} });
  assert.deepEqual(moveZaicodeComboModel(["a", "b", "c"], "c", -1), ["a", "c", "b"]);
  assert.deepEqual(moveZaicodeComboModel(["a", "b", "c"], "c", -2), ["c", "a", "b"]);
  assert.deepEqual(moveZaicodeComboModel(["a", "b", "c"], "a", -5), ["a", "b", "c"]);
  assert.deepEqual(moveZaicodeComboModel(["a", "b"], "zz", 1), ["a", "b"]);
  assert.equal(isZaicodeComboNameValid("SAIFREN"), true);
  assert.equal(isZaicodeComboNameValid("my pool"), false);
  assert.equal(suggestZaicodeProviderPrefix("Dahl Inference", []), "dahlinfe");
  assert.equal(suggestZaicodeProviderPrefix("AMD", ["amd"]), "amd2");
  assert.equal(suggestZaicodeProviderPrefix("!!!", []), "custom");
});

test("Usage numbers are read whatever the field names of the 9router version", () => {
  assert.deepEqual(readZaicodeRouterUsage({ totalRequests: 303, totalPromptTokens: 52927173, totalCompletionTokens: 213733 }), {
    requests: 303,
    inputTokens: 52927173,
    outputTokens: 213733,
  });
  assert.deepEqual(readZaicodeRouterUsage({ requests: 1 }), { requests: 1, inputTokens: null, outputTokens: null });
  assert.equal(readZaicodeRouterUsage(null), null);
});
